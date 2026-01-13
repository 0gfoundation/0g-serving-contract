// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.22;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Initializable} from "../utils/Initializable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IServing {
    function accountExists(address user, address provider) external view returns (bool);

    function getPendingRefund(address user, address provider) external view returns (uint);

    function addAccount(address user, address provider, string memory additionalInfo) external payable;

    function depositFund(address user, address provider, uint cancelRetrievingAmount) external payable;

    function requestRefundAll(address user, address provider) external;

    function processRefund(
        address user,
        address provider
    ) external returns (uint totalAmount, uint balance, uint pendingRefund);

    function deleteAccount(address user, address provider) external;
}

// Simplified ledger structure
struct Ledger {
    address user;
    uint availableBalance;
    uint totalBalance;
    string additionalInfo;
}

// Service information structure
struct ServiceInfo {
    address serviceAddress;
    IServing serviceContract;
    string serviceType; // "inference" or "fine-tuning"
    string version; // "v1.0", "v2.0" etc.
    string fullName; // "inference-v2.0"
    string description;
    bool isRecommended; // Whether this is the recommended version for this service type
    uint256 registeredAt;
}

interface ILedger {
    function spendFund(address user, uint amount) external;

    function depositFundFor(address recipient) external payable;
}

contract LedgerManager is Ownable, Initializable, ReentrancyGuard {
    using EnumerableSet for EnumerableSet.Bytes32Set;
    using EnumerableSet for EnumerableSet.AddressSet;
    using ERC165Checker for address;

    // @custom:storage-location erc7201:0g.serving.ledger
    struct LedgerManagerStorage {
        // Service registry (using address as key)
        mapping(address => ServiceInfo) registeredServices;
        mapping(string => address) serviceNameToAddress; // "inference-v2.0" => address
        EnumerableSet.AddressSet serviceAddresses;
        mapping(bytes32 => address) recommendedByType; // per-type recommended service pointer
        LedgerMap ledgerMap;
        // DEPRECATED: Keep for storage layout compatibility only. Data migrated to userServiceProvidersByAddress.
        // DO NOT USE THIS FIELD IN NEW CODE.
        mapping(address => mapping(string => EnumerableSet.AddressSet)) userServiceProviders;
        // Current mapping: user => serviceAddress => providers
        mapping(address => mapping(address => EnumerableSet.AddressSet)) userServiceProvidersByAddress;
    }

    // keccak256(abi.encode(uint256(keccak256("0g.serving.ledger")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant LEDGER_MANAGER_STORAGE_LOCATION =
        0x0bb5d42557ea6926c17416c5b1c1c29c28d9006d6f713295a2d385f07156ed00;

    function _getLedgerManagerStorage() private pure returns (LedgerManagerStorage storage $) {
        assembly {
            $.slot := LEDGER_MANAGER_STORAGE_LOCATION
        }
    }

    // Constants
    uint public constant MAX_PROVIDERS_PER_BATCH = 20;
    uint public constant MAX_SERVICES = 500;
    uint public constant MAX_PROVIDERS_PER_USER_PER_SERVICE = 50; // Limit to prevent unbounded gas in _deleteAllServiceAccounts
    uint public constant MAX_ADDITIONAL_INFO_LENGTH = 4096; // 4KB limit for JSON configuration data
    uint public constant MIN_ACCOUNT_BALANCE = 3 ether; // 3 0G minimum account balance
    uint public constant MIN_TRANSFER_AMOUNT = 1 ether; // 1 0G minimum transfer for new service account
    bytes4 private constant SERVING_INTERFACE_ID = type(IServing).interfaceId;

    // Events
    event ServiceRegistered(address indexed serviceAddress, string serviceName);
    event RecommendedServiceUpdated(string serviceType, string version, address serviceAddress);
    event LedgerInfoUpdated(address indexed user, string additionalInfo);
    event FundSpent(address indexed user, address indexed service, uint256 amount);
    event UserServiceProvidersMigrated(
        address indexed user,
        address indexed serviceAddress,
        uint256 providerCount
    );

    // Errors
    error LedgerNotExists(address user);
    error LedgerExists(address user);
    error InsufficientBalance(address user);
    error TooManyProviders(uint requested, uint maximum);
    error TooManyProvidersForService(uint current, uint maximum);
    error InvalidServiceType(string serviceType);
    error ServiceNotRegistered(address serviceAddress);
    error ServiceNameExists(string serviceName);
    error InvalidServiceAddress(address serviceAddress);
    error LedgerLocked();
    error CallerNotRegisteredService(address caller);
    error ServiceNotFound(address serviceAddress);
    error MinimumDepositRequired(uint256 provided, uint256 required);
    error AdditionalInfoTooLong(uint256 length, uint256 max);
    error ZeroAmountNotAllowed();
    error ZeroAddressNotAllowed();
    error InsufficientAvailableBalance(uint256 available, uint256 required);
    error TransferFailed();
    error CallFailed();
    error MustWithdrawAllFundsFirst(uint256 remainingBalance);
    error ServiceTypeRequired();
    error VersionRequired();
    error ServiceAlreadyRegistered(address serviceAddress);
    error ServiceMustImplementIServing(address serviceAddress);
    error ServiceRegistryLimitReached(uint256 limit);
    error NoRecommendedService(string serviceType);
    error NoServicesRegistered();

    struct LedgerMap {
        EnumerableSet.Bytes32Set _keys;
        mapping(bytes32 => Ledger) _values;
        // Operation locks to prevent reentrancy
        mapping(bytes32 => bool) _operationLocks;
    }

    // Prevent reentrancy on ledger operations
    modifier withLedgerLock(address user) {
        LedgerManagerStorage storage $ = _getLedgerManagerStorage();
        bytes32 key = _key(user);
        if ($.ledgerMap._operationLocks[key]) {
            revert LedgerLocked();
        }
        $.ledgerMap._operationLocks[key] = true;
        _;
        $.ledgerMap._operationLocks[key] = false;
    }

    /**
     * @dev Constructor that disables initialization on the logic contract.
     * This prevents the initialize function from being called on the logic contract itself.
     * Only proxy contracts can call initialize.
     *
     * This is the recommended approach for upgradeable contracts to prevent
     * unauthorized initialization of the logic contract.
     */
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address owner) public onlyInitializeOnce {
        _transferOwnership(owner);
    }

    modifier onlyServing() {
        LedgerManagerStorage storage $ = _getLedgerManagerStorage();
        if ($.registeredServices[msg.sender].serviceAddress == address(0)) {
            revert CallerNotRegisteredService(msg.sender);
        }
        _;
    }

    function getLedger(address user) public view returns (Ledger memory) {
        LedgerManagerStorage storage $ = _getLedgerManagerStorage();
        return _get($, user);
    }

    function getAllLedgers(uint offset, uint limit) public view returns (Ledger[] memory ledgers, uint total) {
        total = _length();

        if (offset >= total) {
            return (new Ledger[](0), total);
        }

        uint end = Math.min(offset + (limit == 0 ? 50 : limit), total);
        uint resultLen = end - offset;
        ledgers = new Ledger[](resultLen);

        for (uint i = 0; i < resultLen; i++) {
            ledgers[i] = _at(offset + i);
        }

        return (ledgers, total);
    }

    // Get providers for a specific user and service
    function getLedgerProviders(address user, string memory serviceName) public view returns (address[] memory) {
        LedgerManagerStorage storage $ = _getLedgerManagerStorage();
        address serviceAddress = $.serviceNameToAddress[serviceName];
        if (serviceAddress == address(0)) {
            revert ServiceNotFound(serviceAddress);
        }

        // Use new serviceAddress-based mapping
        EnumerableSet.AddressSet storage providers = $.userServiceProvidersByAddress[user][serviceAddress];

        uint256 providersLen = providers.length();
        address[] memory providerList = new address[](providersLen);
        for (uint256 i = 0; i < providersLen; i++) {
            providerList[i] = providers.at(i);
        }

        return providerList;
    }

    function addLedger(string memory additionalInfo) external payable withLedgerLock(msg.sender) returns (uint, uint) {
        if (msg.value < MIN_ACCOUNT_BALANCE) {
            revert MinimumDepositRequired(msg.value, MIN_ACCOUNT_BALANCE);
        }
        if (bytes(additionalInfo).length > MAX_ADDITIONAL_INFO_LENGTH) {
            revert AdditionalInfoTooLong(bytes(additionalInfo).length, MAX_ADDITIONAL_INFO_LENGTH);
        }
        LedgerManagerStorage storage $ = _getLedgerManagerStorage();
        bytes32 key = _key(msg.sender);
        if (_contains($, key)) {
            revert LedgerExists(msg.sender);
        }
        _set($, key, msg.sender, msg.value, additionalInfo);
        return (msg.value, 0);
    }

    /// @notice Update additional info for an existing ledger
    /// @param additionalInfo New additional info (max 4KB)
    function updateAdditionalInfo(string memory additionalInfo) external withLedgerLock(msg.sender) {
        if (bytes(additionalInfo).length > MAX_ADDITIONAL_INFO_LENGTH) {
            revert AdditionalInfoTooLong(bytes(additionalInfo).length, MAX_ADDITIONAL_INFO_LENGTH);
        }
        LedgerManagerStorage storage $ = _getLedgerManagerStorage();
        Ledger storage ledger = _get($, msg.sender);
        ledger.additionalInfo = additionalInfo;
        emit LedgerInfoUpdated(msg.sender, additionalInfo);
    }

    function depositFund() external payable withLedgerLock(msg.sender) {
        _depositFundInternal(msg.sender, msg.value);
    }

    // Internal function for deposit logic without modifier
    function _depositFundInternal(address user, uint256 amount) internal {
        if (amount == 0) {
            revert ZeroAmountNotAllowed();
        }

        LedgerManagerStorage storage $ = _getLedgerManagerStorage();
        bytes32 key = _key(user);

        // Create account if it doesn't exist (with empty additionalInfo, can be updated later via updateAdditionalInfo)
        if (!_contains($, key)) {
            if (amount < MIN_ACCOUNT_BALANCE) {
                revert MinimumDepositRequired(amount, MIN_ACCOUNT_BALANCE);
            }
            _set($, key, user, amount, "");  // Empty additionalInfo by design
        } else {
            Ledger storage ledger = $.ledgerMap._values[key];
            ledger.availableBalance += amount;
            ledger.totalBalance += amount;
        }
    }

    function depositFundFor(address recipient) external payable withLedgerLock(recipient) {
        if (recipient == address(0)) {
            revert ZeroAddressNotAllowed();
        }
        if (msg.value == 0) {
            revert ZeroAmountNotAllowed();
        }

        LedgerManagerStorage storage $ = _getLedgerManagerStorage();
        bytes32 key = _key(recipient);

        // Create account if it doesn't exist
        if (!_contains($, key)) {
            if (msg.value < MIN_ACCOUNT_BALANCE) {
                revert MinimumDepositRequired(msg.value, MIN_ACCOUNT_BALANCE);
            }
            _set($, key, recipient, msg.value, "");
        } else {
            Ledger storage ledger = $.ledgerMap._values[key];
            ledger.availableBalance += msg.value;
            ledger.totalBalance += msg.value;
        }
    }

    function refund(uint amount) external withLedgerLock(msg.sender) {
        LedgerManagerStorage storage $ = _getLedgerManagerStorage();
        Ledger storage ledger = _get($, msg.sender);
        if (ledger.availableBalance < amount) {
            revert InsufficientBalance(msg.sender);
        }

        // Enforce minimum balance: must keep MIN_ACCOUNT_BALANCE or withdraw all
        uint remainingBalance = ledger.availableBalance - amount;
        if (remainingBalance != 0 && remainingBalance < MIN_ACCOUNT_BALANCE) {
            revert MinimumDepositRequired(remainingBalance, MIN_ACCOUNT_BALANCE);
        }

        ledger.availableBalance -= amount;
        ledger.totalBalance -= amount;

        // Auto-delete account if total balance reaches 0
        // Delete account records BEFORE external call to prevent reentrancy issues
        bool shouldDelete = (ledger.totalBalance == 0);
        if (shouldDelete) {
            bytes32 key = _key(msg.sender);
            $.ledgerMap._keys.remove(key);
            delete $.ledgerMap._values[key];

            // Delete all service accounts (involves external calls to service contracts)
            _deleteAllServiceAccounts($, msg.sender);
        }

        // External call comes last (CEI pattern)
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        if (!success) {
            revert TransferFailed();
        }
    }

    // Enhanced transferFund with dynamic service support
    function transferFund(
        address provider,
        string memory serviceName,
        uint amount
    ) external withLedgerLock(msg.sender) {
        LedgerManagerStorage storage $ = _getLedgerManagerStorage();
        Ledger storage ledger = _get($, msg.sender);

        // Dynamic service lookup
        address serviceAddress = $.serviceNameToAddress[serviceName];
        if (serviceAddress == address(0)) {
            revert ServiceNotFound(serviceAddress);
        }

        ServiceInfo storage service = $.registeredServices[serviceAddress];

        address servingAddress = service.serviceAddress;
        IServing serving = service.serviceContract;

        uint transferAmount = amount;
        bytes memory payload;

        if (serving.accountExists(msg.sender, provider)) {
            // Account exists - handle pending refunds
            uint retrievingAmount = serving.getPendingRefund(msg.sender, provider);
            uint cancelRetrievingAmount = Math.min(amount, retrievingAmount);
            transferAmount -= cancelRetrievingAmount;

            payload = abi.encodeWithSignature(
                "depositFund(address,address,uint256)",
                msg.sender,
                provider,
                cancelRetrievingAmount
            );
        } else {
            // New account - require minimum transfer amount
            if (amount < MIN_TRANSFER_AMOUNT) {
                revert MinimumDepositRequired(amount, MIN_TRANSFER_AMOUNT);
            }

            // Use unified addAccount interface
            payload = abi.encodeWithSignature(
                "addAccount(address,address,string)",
                msg.sender,
                provider,
                ledger.additionalInfo
            );

            // Add provider to service storage (using new serviceAddress-based mapping)
            _addProviderToService($, msg.sender, serviceAddress, provider);
        }

        if (ledger.availableBalance < transferAmount) {
            revert InsufficientAvailableBalance(ledger.availableBalance, transferAmount);
        }
        ledger.availableBalance -= transferAmount;

        (bool success, ) = servingAddress.call{value: transferAmount}(payload);
        if (!success) {
            revert CallFailed();
        }
    }

    function retrieveFund(address[] memory providers, string memory serviceName) external withLedgerLock(msg.sender) {
        LedgerManagerStorage storage $ = _getLedgerManagerStorage();
        if (providers.length > MAX_PROVIDERS_PER_BATCH) {
            revert TooManyProviders(providers.length, MAX_PROVIDERS_PER_BATCH);
        }

        // Dynamic service lookup
        address serviceAddress = $.serviceNameToAddress[serviceName];
        if (serviceAddress == address(0)) {
            revert ServiceNotFound(serviceAddress);
        }

        ServiceInfo storage service = $.registeredServices[serviceAddress];

        IServing serving = service.serviceContract;

        Ledger storage ledger = _get($, msg.sender);
        uint totalAmount = 0;

        for (uint i = 0; i < providers.length; i++) {
            if (serving.accountExists(msg.sender, providers[i])) {
                (uint amount, , ) = serving.processRefund(msg.sender, providers[i]);
                totalAmount += amount;
                serving.requestRefundAll(msg.sender, providers[i]);
            }
        }
        ledger.availableBalance += totalAmount;
    }

    function deleteLedger() external nonReentrant withLedgerLock(msg.sender) {
        LedgerManagerStorage storage $ = _getLedgerManagerStorage();
        Ledger storage ledger = _get($, msg.sender);

        // Safety check: ensure all funds have been withdrawn
        if (ledger.totalBalance != 0) {
            revert MustWithdrawAllFundsFirst(ledger.totalBalance);
        }

        _deleteAllServiceAccounts($, msg.sender);

        bytes32 key = _key(msg.sender);
        // Delete main ledger
        $.ledgerMap._keys.remove(key);
        delete $.ledgerMap._values[key];
    }

    function _deleteAllServiceAccounts(LedgerManagerStorage storage $, address user) private {
        // Delete all service accounts dynamically (using serviceAddress-based mapping)
        uint256 serviceCount = $.serviceAddresses.length();
        for (uint256 i = 0; i < serviceCount; i++) {
            address serviceAddress = $.serviceAddresses.at(i);
            ServiceInfo storage service = $.registeredServices[serviceAddress];

            // Use new serviceAddress-based mapping
            EnumerableSet.AddressSet storage providers = $.userServiceProvidersByAddress[user][serviceAddress];

            uint256 providersLen = providers.length();
            address[] memory providerList = new address[](providersLen);
            for (uint j = 0; j < providersLen; j++) {
                providerList[j] = providers.at(j);
            }

            uint256 providerListLen = providerList.length;
            for (uint j = 0; j < providerListLen; j++) {
                try service.serviceContract.deleteAccount(user, providerList[j]) {
                    providers.remove(providerList[j]);
                } catch {
                    providers.remove(providerList[j]); // Remove even on failure
                }
            }
        }
    }

    // === Service Registration Management ===

    function registerService(
        string memory serviceType,
        string memory version,
        address serviceAddress,
        string memory description
    ) external onlyOwner {
        LedgerManagerStorage storage $ = _getLedgerManagerStorage();
        if (serviceAddress == address(0)) {
            revert InvalidServiceAddress(serviceAddress);
        }
        if (bytes(serviceType).length == 0) {
            revert ServiceTypeRequired();
        }
        if (bytes(version).length == 0) {
            revert VersionRequired();
        }
        if ($.registeredServices[serviceAddress].serviceAddress != address(0)) {
            revert ServiceAlreadyRegistered(serviceAddress);
        }

        string memory fullName = string(abi.encodePacked(serviceType, "-", version));
        if ($.serviceNameToAddress[fullName] != address(0)) {
            revert ServiceNameExists(fullName);
        }

        // Check interface support
        if (!serviceAddress.supportsInterface(type(IERC165).interfaceId)) {
            revert ServiceMustImplementIServing(serviceAddress);
        }
        if (!serviceAddress.supportsInterface(SERVING_INTERFACE_ID)) {
            revert ServiceMustImplementIServing(serviceAddress);
        }
        if ($.serviceAddresses.length() >= MAX_SERVICES) {
            revert ServiceRegistryLimitReached(MAX_SERVICES);
        }

        // Register service (default not recommended)
        $.registeredServices[serviceAddress] = ServiceInfo({
            serviceAddress: serviceAddress,
            serviceContract: IServing(serviceAddress),
            serviceType: serviceType,
            version: version,
            fullName: fullName,
            description: description,
            isRecommended: false, // Default not recommended
            registeredAt: block.timestamp
        });

        $.serviceNameToAddress[fullName] = serviceAddress;
        $.serviceAddresses.add(serviceAddress);

        emit ServiceRegistered(serviceAddress, fullName);
    }

    function setRecommendedService(string memory serviceType, string memory version) external onlyOwner {
        LedgerManagerStorage storage $ = _getLedgerManagerStorage();
        string memory fullName = string(abi.encodePacked(serviceType, "-", version));
        address serviceAddress = $.serviceNameToAddress[fullName];
        if (serviceAddress == address(0)) {
            revert ServiceNotFound(serviceAddress);
        }

        // Update per-type recommended pointer and clear previous recommendation if any (O(1))
        bytes32 tkey = keccak256(abi.encodePacked(serviceType));
        address old = $.recommendedByType[tkey];
        if (old != address(0) && old != serviceAddress) {
            $.registeredServices[old].isRecommended = false;
        }
        $.recommendedByType[tkey] = serviceAddress;

        // Set new recommended service
        $.registeredServices[serviceAddress].isRecommended = true;

        emit RecommendedServiceUpdated(serviceType, version, serviceAddress);
    }

    function getServiceInfo(address serviceAddress) external view returns (ServiceInfo memory) {
        LedgerManagerStorage storage $ = _getLedgerManagerStorage();
        return $.registeredServices[serviceAddress];
    }

    function getServiceAddressByName(string memory serviceName) external view returns (address) {
        LedgerManagerStorage storage $ = _getLedgerManagerStorage();
        return $.serviceNameToAddress[serviceName];
    }

    function getAllActiveServices() external view returns (ServiceInfo[] memory) {
        LedgerManagerStorage storage $ = _getLedgerManagerStorage();
        uint256 count = $.serviceAddresses.length();
        ServiceInfo[] memory services = new ServiceInfo[](count);

        for (uint256 i = 0; i < count; i++) {
            address serviceAddress = $.serviceAddresses.at(i);
            services[i] = $.registeredServices[serviceAddress];
        }

        return services;
    }

    function getRecommendedService(
        string memory serviceType
    ) external view returns (string memory version, address serviceAddress) {
        LedgerManagerStorage storage $ = _getLedgerManagerStorage();
        bytes32 tkey = keccak256(abi.encodePacked(serviceType));
        address addr = $.recommendedByType[tkey];
        if (addr == address(0)) {
            revert NoRecommendedService(serviceType);
        }

        ServiceInfo storage service = $.registeredServices[addr];
        return (service.version, addr);
    }

    function getAllVersions(
        string memory serviceType
    ) external view returns (string[] memory versions, address[] memory addresses, bool[] memory isRecommendedFlags) {
        LedgerManagerStorage storage $ = _getLedgerManagerStorage();
        // First count matching services
        uint256 count = $.serviceAddresses.length();
        uint256 matchCount = 0;
        for (uint256 i = 0; i < count; i++) {
            address addr = $.serviceAddresses.at(i);
            ServiceInfo storage service = $.registeredServices[addr];
            if (keccak256(abi.encodePacked(service.serviceType)) == keccak256(abi.encodePacked(serviceType))) {
                matchCount++;
            }
        }

        // Allocate arrays
        versions = new string[](matchCount);
        addresses = new address[](matchCount);
        isRecommendedFlags = new bool[](matchCount);

        // Fill arrays
        uint256 index = 0;
        for (uint256 i = 0; i < count; i++) {
            address addr = $.serviceAddresses.at(i);
            ServiceInfo storage service = $.registeredServices[addr];
            if (keccak256(abi.encodePacked(service.serviceType)) == keccak256(abi.encodePacked(serviceType))) {
                versions[index] = service.version;
                addresses[index] = addr;
                isRecommendedFlags[index] = service.isRecommended;
                index++;
            }
        }
    }

    function isRecommendedVersion(string memory serviceType, string memory version) external view returns (bool) {
        LedgerManagerStorage storage $ = _getLedgerManagerStorage();
        string memory fullName = string(abi.encodePacked(serviceType, "-", version));
        address serviceAddress = $.serviceNameToAddress[fullName];
        if (serviceAddress == address(0)) {
            return false;
        }
        return $.registeredServices[serviceAddress].isRecommended;
    }

    // === Data Migration ===

    /// @notice One-time migration function to move data from old mapping to new mapping
    /// @dev Migrates userServiceProviders (serviceType-based) to userServiceProvidersByAddress (serviceAddress-based)
    /// @dev Supports batch processing to prevent gas limit issues with large user bases
    /// @dev Can be called by owner after contract upgrade to migrate existing data
    /// @dev Safe to call multiple times - will only migrate data that hasn't been migrated yet
    /// @param startUserIndex Index of user to start migration from (0-based, use 0 to start from beginning)
    /// @param batchSize Maximum number of users to process (use 0 for all remaining users)
    /// @return migratedCount Number of users that had data migrated
    /// @return nextUserIndex Index to continue from in next batch (equals total users when complete)
    function migrateUserServiceProvidersMapping(
        uint256 startUserIndex,
        uint256 batchSize
    ) external onlyOwner returns (uint256 migratedCount, uint256 nextUserIndex) {
        LedgerManagerStorage storage $ = _getLedgerManagerStorage();

        // Get the service address (expecting only one in legacy environment)
        uint256 serviceCount = $.serviceAddresses.length();
        if (serviceCount == 0) {
            revert NoServicesRegistered();
        }
        address serviceAddress = $.serviceAddresses.at(0);
        ServiceInfo storage service = $.registeredServices[serviceAddress];
        string memory serviceType = service.serviceType;

        // Get all ledger users
        uint256 ledgerCount = $.ledgerMap._keys.length();
        if (ledgerCount == 0) {
            return (0, 0);
        }

        // Validate startUserIndex
        require(startUserIndex < ledgerCount, "LedgerManager: startUserIndex out of bounds");

        // Calculate end index: if batchSize is 0, process all remaining
        uint256 endUserIndex;
        if (batchSize == 0 || batchSize > ledgerCount - startUserIndex) {
            endUserIndex = ledgerCount;
        } else {
            endUserIndex = startUserIndex + batchSize;
        }

        migratedCount = 0;

        // Process batch of users
        for (uint256 j = startUserIndex; j < endUserIndex; j++) {
            bytes32 ledgerKey = $.ledgerMap._keys.at(j);
            address user = $.ledgerMap._values[ledgerKey].user;

            // Get old mapping data
            EnumerableSet.AddressSet storage oldProviders = $.userServiceProviders[user][serviceType];

            // Skip if no data to migrate
            if (oldProviders.length() == 0) {
                continue;
            }

            // Get new mapping reference
            EnumerableSet.AddressSet storage newProviders = $.userServiceProvidersByAddress[user][serviceAddress];

            // Copy providers to new mapping
            uint256 providerCount = oldProviders.length();
            for (uint256 k = 0; k < providerCount; k++) {
                address provider = oldProviders.at(k);
                // Only add if not already present (safe for multiple calls)
                if (!newProviders.contains(provider)) {
                    newProviders.add(provider);
                }
            }

            // Safety check: verify all providers were migrated successfully
            require(
                newProviders.length() == providerCount,
                "LedgerManager: provider count mismatch in migration"
            );

            // Clear old mapping to save storage
            for (uint256 k = 0; k < providerCount; k++) {
                oldProviders.remove(oldProviders.at(0)); // Always remove first element
            }

            emit UserServiceProvidersMigrated(user, serviceAddress, providerCount);
            migratedCount++;
        }

        nextUserIndex = endUserIndex;
    }

    // === Internal Helper Functions ===

    function _addProviderToService(
        LedgerManagerStorage storage $,
        address user,
        address serviceAddress,
        address provider
    ) private {
        // Write to new mapping structure (using serviceAddress as key)
        EnumerableSet.AddressSet storage providers = $.userServiceProvidersByAddress[user][serviceAddress];

        // Check limit before adding to prevent unbounded gas in _deleteAllServiceAccounts
        if (providers.length() >= MAX_PROVIDERS_PER_USER_PER_SERVICE) {
            revert TooManyProvidersForService(providers.length(), MAX_PROVIDERS_PER_USER_PER_SERVICE);
        }

        providers.add(provider);
    }

    function spendFund(address user, uint amount) external onlyServing withLedgerLock(user) {
        LedgerManagerStorage storage $ = _getLedgerManagerStorage();
        Ledger storage ledger = _get($, user);
        uint256 locked = ledger.totalBalance - ledger.availableBalance;
        if (locked < amount) {
            revert InsufficientAvailableBalance(locked, amount);
        }
        ledger.totalBalance -= amount;
        emit FundSpent(user, msg.sender, amount);
    }

    function _at(uint index) internal view returns (Ledger storage) {
        LedgerManagerStorage storage $ = _getLedgerManagerStorage();
        bytes32 key = $.ledgerMap._keys.at(index);
        return $.ledgerMap._values[key];
    }

    function _contains(LedgerManagerStorage storage $, bytes32 key) internal view returns (bool) {
        return $.ledgerMap._keys.contains(key);
    }

    function _length() internal view returns (uint) {
        LedgerManagerStorage storage $ = _getLedgerManagerStorage();
        return $.ledgerMap._keys.length();
    }

    function _get(LedgerManagerStorage storage $, address user) internal view returns (Ledger storage) {
        bytes32 key = _key(user);
        if (!_contains($, key)) {
            revert LedgerNotExists(user);
        }
        return $.ledgerMap._values[key];
    }

    // Simplified _set without signer parameter
    function _set(
        LedgerManagerStorage storage $,
        bytes32 key,
        address user,
        uint balance,
        string memory additionalInfo
    ) internal {
        Ledger storage ledger = $.ledgerMap._values[key];
        ledger.availableBalance = balance;
        ledger.totalBalance = balance;
        ledger.user = user;
        ledger.additionalInfo = additionalInfo;
        $.ledgerMap._keys.add(key);
    }

    function _key(address user) internal pure returns (bytes32) {
        return keccak256(abi.encode(user));
    }

    receive() external payable {
        if (_isServiceContract(msg.sender)) {
            return;
        }

        // Regular users must use depositFund() or depositFundFor() for explicit deposits
        revert("Direct deposits disabled; use depositFund() instead");
    }

    function _isServiceContract(address sender) internal view returns (bool) {
        LedgerManagerStorage storage $ = _getLedgerManagerStorage();
        return $.registeredServices[sender].serviceAddress != address(0);
    }
}
