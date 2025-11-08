// SPDX-License-Identifier: Unlicense
pragma solidity >=0.8.0 <0.9.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import "../utils/Initializable.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
interface IServing {
    function accountExists(address user, address provider) external view returns (bool);
    function getPendingRefund(address user, address provider) external view returns (uint);
    function addAccount(address user, address provider, string memory additionalInfo) external payable;
    function depositFund(address user, address provider, uint cancelRetrievingAmount) external payable;
    function requestRefundAll(address user, address provider) external;
    function processRefund(address user, address provider) external returns (uint totalAmount, uint balance, uint pendingRefund);
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
    string version;     // "v1.0", "v2.0" etc.
    string fullName;    // "inference-v2.0"
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
        
        LedgerMap ledgerMap;
        mapping(address => mapping(string => EnumerableSet.AddressSet)) userServiceProviders; // user => serviceType => providers
    }

    // keccak256(abi.encode(uint256(keccak256("0g.serving.ledger")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant LEDGER_MANAGER_STORAGE_LOCATION = 0x0bb5d42557ea6926c17416c5b1c1c29c28d9006d6f713295a2d385f07156ed00;

    function _getLedgerManagerStorage() private pure returns (LedgerManagerStorage storage $) {
        assembly {
            $.slot := LEDGER_MANAGER_STORAGE_LOCATION
        }
    }

    // Constants
    uint public constant MAX_PROVIDERS_PER_BATCH = 20;
    bytes4 private constant SERVING_INTERFACE_ID = type(IServing).interfaceId;

    // Events
    event ServiceRegistered(address indexed serviceAddress, string serviceName);
    event RecommendedServiceUpdated(string indexed serviceType, string version, address serviceAddress);

    // Errors
    error LedgerNotExists(address user);
    error LedgerExists(address user);
    error InsufficientBalance(address user);
    error TooManyProviders(uint requested, uint maximum);
    error InvalidServiceType(string serviceType);
    error ServiceNotRegistered(address serviceAddress);
    error ServiceNameExists(string serviceName);
    error InvalidServiceAddress(address serviceAddress);

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
        require(!$.ledgerMap._operationLocks[key], "Ledger locked for operation");
        $.ledgerMap._operationLocks[key] = true;
        _;
        $.ledgerMap._operationLocks[key] = false;
    }

    function initialize(
        address owner
    ) public onlyInitializeOnce {
        _transferOwnership(owner);
    }

    modifier onlyServing() {
        LedgerManagerStorage storage $ = _getLedgerManagerStorage();
        require(
            $.registeredServices[msg.sender].serviceAddress != address(0),
            "Caller is not a registered service"
        );
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

        uint end = limit == 0 ? total : Math.min(offset + limit, total);
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
        require(serviceAddress != address(0), "Service not found");
        
        string memory serviceType = $.registeredServices[serviceAddress].serviceType;
        EnumerableSet.AddressSet storage providers = $.userServiceProviders[user][serviceType];
        address[] memory providerList = new address[](providers.length());
        
        for (uint256 i = 0; i < providers.length(); i++) {
            providerList[i] = providers.at(i);
        }
        
        return providerList;
    }

    function addLedger(
        string memory additionalInfo
    ) external payable withLedgerLock(msg.sender) returns (uint, uint) {
        LedgerManagerStorage storage $ = _getLedgerManagerStorage();
        bytes32 key = _key(msg.sender);
        if (_contains($, key)) {
            revert LedgerExists(msg.sender);
        }
        _set($, key, msg.sender, msg.value, additionalInfo);
        return (msg.value, 0);
    }

    function depositFund() external payable withLedgerLock(msg.sender) {
        _depositFundInternal(msg.sender, msg.value);
    }
    
    // Internal function for deposit logic without modifier
    function _depositFundInternal(address user, uint256 amount) internal {
        LedgerManagerStorage storage $ = _getLedgerManagerStorage();
        bytes32 key = _key(user);
        
        // Create account if it doesn't exist
        if (!_contains($, key)) {
            _set($, key, user, amount, "");
        } else {
            Ledger storage ledger = $.ledgerMap._values[key];
            ledger.availableBalance += amount;
            ledger.totalBalance += amount;
        }
    }

    function depositFundFor(address recipient) external payable withLedgerLock(recipient) {
        LedgerManagerStorage storage $ = _getLedgerManagerStorage();
        bytes32 key = _key(recipient);
        
        // Create account if it doesn't exist
        if (!_contains($, key)) {
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

        ledger.availableBalance -= amount;
        ledger.totalBalance -= amount;
        payable(msg.sender).transfer(amount);
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
        require(serviceAddress != address(0), "Service not found");
        
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
            // New account - use unified addAccount interface
            payload = abi.encodeWithSignature(
                "addAccount(address,address,string)",
                msg.sender,
                provider,
                ledger.additionalInfo
            );
            
            // Add provider to service storage
            _addProviderToService($, msg.sender, service.serviceType, provider);
        }

        require(ledger.availableBalance >= transferAmount, "Insufficient balance");
        ledger.availableBalance -= transferAmount;

        (bool success, ) = servingAddress.call{value: transferAmount}(payload);
        require(success, "Call to child contract failed");
    }

    function retrieveFund(
        address[] memory providers,
        string memory serviceType
    ) external withLedgerLock(msg.sender) {
        LedgerManagerStorage storage $ = _getLedgerManagerStorage();
        if (providers.length > MAX_PROVIDERS_PER_BATCH) {
            revert TooManyProviders(providers.length, MAX_PROVIDERS_PER_BATCH);
        }

        // Dynamic service lookup
        address serviceAddress = $.serviceNameToAddress[serviceType];
        require(serviceAddress != address(0), "Service not found");
        
        ServiceInfo storage service = $.registeredServices[serviceAddress];
        
        IServing serving = service.serviceContract;
        
        Ledger storage ledger = _get($, msg.sender);
        uint totalAmount = 0;

        for (uint i = 0; i < providers.length; i++) {
            (uint amount, , ) = serving.processRefund(msg.sender, providers[i]);
            totalAmount += amount;
            serving.requestRefundAll(msg.sender, providers[i]);
        }
        ledger.availableBalance += totalAmount;
    }

    function deleteLedger() external nonReentrant withLedgerLock(msg.sender) {
        LedgerManagerStorage storage $ = _getLedgerManagerStorage();
        Ledger storage ledger = _get($, msg.sender);
        
        // Safety check: ensure all funds have been withdrawn
        require(ledger.totalBalance == 0, "Must withdraw all funds first");
        
        bytes32 key = _key(msg.sender);

        // Delete all service accounts dynamically
        uint256 serviceCount = $.serviceAddresses.length();
        for (uint256 i = 0; i < serviceCount; i++) {
            address serviceAddress = $.serviceAddresses.at(i);
            ServiceInfo storage service = $.registeredServices[serviceAddress];
            
            EnumerableSet.AddressSet storage providers = $.userServiceProviders[msg.sender][service.serviceType];
            address[] memory providerList = new address[](providers.length());
            for (uint j = 0; j < providers.length(); j++) {
                providerList[j] = providers.at(j);
            }
            
            for (uint j = 0; j < providerList.length; j++) {
                try service.serviceContract.deleteAccount(msg.sender, providerList[j]) {
                    providers.remove(providerList[j]);
                } catch {
                    providers.remove(providerList[j]); // Remove even on failure
                }
            }
        }

        // Delete main ledger
        $.ledgerMap._keys.remove(key);
        delete $.ledgerMap._values[key];
    }

    // === Service Registration Management ===

    function registerService(
        string memory serviceType,
        string memory version,
        address serviceAddress,
        string memory description
    ) external onlyOwner {
        LedgerManagerStorage storage $ = _getLedgerManagerStorage();
        require(serviceAddress != address(0), "Invalid service address");
        require(bytes(serviceType).length > 0, "Service type required");
        require(bytes(version).length > 0, "Version required");
        require($.registeredServices[serviceAddress].serviceAddress == address(0), "Service already registered");
        
        string memory fullName = string(abi.encodePacked(serviceType, "-", version));
        require($.serviceNameToAddress[fullName] == address(0), "Service name already exists");
        
        // Check interface support
        require(
            serviceAddress.supportsInterface(type(IERC165).interfaceId),
            "Service must support ERC165 interface detection"
        );
        require(
            serviceAddress.supportsInterface(SERVING_INTERFACE_ID),
            "Service must implement IServing interface"
        );
        
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

    function setRecommendedService(
        string memory serviceType,
        string memory version
    ) external onlyOwner {
        LedgerManagerStorage storage $ = _getLedgerManagerStorage();
        string memory fullName = string(abi.encodePacked(serviceType, "-", version));
        address serviceAddress = $.serviceNameToAddress[fullName];
        require(serviceAddress != address(0), "Service not found");
        
        // Clear all recommended flags for this service type
        _clearRecommendedServices($, serviceType);
        
        // Set new recommended service
        $.registeredServices[serviceAddress].isRecommended = true;
        
        emit RecommendedServiceUpdated(serviceType, version, serviceAddress);
    }
    
    function _clearRecommendedServices(LedgerManagerStorage storage $, string memory serviceType) internal {
        uint256 count = $.serviceAddresses.length();
        for (uint256 i = 0; i < count; i++) {
            address serviceAddr = $.serviceAddresses.at(i);
            ServiceInfo storage service = $.registeredServices[serviceAddr];
            
            if (keccak256(abi.encodePacked(service.serviceType)) == keccak256(abi.encodePacked(serviceType))) {
                service.isRecommended = false;
            }
        }
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
    
    function getRecommendedService(string memory serviceType) 
        external view returns (string memory version, address serviceAddress) {
        LedgerManagerStorage storage $ = _getLedgerManagerStorage();
        uint256 count = $.serviceAddresses.length();
        for (uint256 i = 0; i < count; i++) {
            address addr = $.serviceAddresses.at(i);
            ServiceInfo storage service = $.registeredServices[addr];
            
            if (keccak256(abi.encodePacked(service.serviceType)) == keccak256(abi.encodePacked(serviceType)) 
                && service.isRecommended) {
                return (service.version, addr);
            }
        }
        revert("No recommended service found for this type");
    }
    
    function getAllVersions(string memory serviceType) 
        external view returns (
            string[] memory versions,
            address[] memory addresses,
            bool[] memory isRecommendedFlags
        ) {
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
    
    function isRecommendedVersion(string memory serviceType, string memory version)
        external view returns (bool) {
        LedgerManagerStorage storage $ = _getLedgerManagerStorage();
        string memory fullName = string(abi.encodePacked(serviceType, "-", version));
        address serviceAddress = $.serviceNameToAddress[fullName];
        if (serviceAddress == address(0)) {
            return false;
        }
        return $.registeredServices[serviceAddress].isRecommended;
    }

    function _addProviderToService(LedgerManagerStorage storage $, address user, string memory serviceType, address provider) private {
        EnumerableSet.AddressSet storage providers = $.userServiceProviders[user][serviceType];
        providers.add(provider);
    }

    function spendFund(address user, uint amount) external onlyServing {
        LedgerManagerStorage storage $ = _getLedgerManagerStorage();
        // Use withLedgerLock to ensure single-user atomicity
        bytes32 key = _key(user);
        require(!$.ledgerMap._operationLocks[key], "Ledger locked for operation");
        $.ledgerMap._operationLocks[key] = true;
        
        Ledger storage ledger = _get($, user);
        require((ledger.totalBalance - ledger.availableBalance) >= amount, "Insufficient balance");
        ledger.totalBalance -= amount;
        
        $.ledgerMap._operationLocks[key] = false;
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
        
        LedgerManagerStorage storage $ = _getLedgerManagerStorage();
        bytes32 key = _key(tx.origin);
        
        // Check and set lock
        require(!$.ledgerMap._operationLocks[key], "Ledger locked for operation");
        $.ledgerMap._operationLocks[key] = true;
        
        // Deposit funds using internal function  
        _depositFundInternal(tx.origin, msg.value);
        
        // Release lock
        $.ledgerMap._operationLocks[key] = false;
    }

    function _isServiceContract(address sender) internal view returns (bool) {
        LedgerManagerStorage storage $ = _getLedgerManagerStorage();
        return $.registeredServices[sender].serviceAddress != address(0);
    }
}
