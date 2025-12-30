// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0 <0.9.0;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EnumerableMap} from "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "../utils/Initializable.sol";
import "./InferenceAccount.sol";
import "./InferenceService.sol";
import "../ledger/LedgerManager.sol";

struct TEESettlementData {
    address user;
    address provider;
    uint totalFee;
    bytes32 requestsHash;
    uint nonce;
    bytes signature;
}

enum SettlementStatus {
    SUCCESS, // 0: Full settlement success
    PARTIAL, // 1: Partial settlement (insufficient balance)
    PROVIDER_MISMATCH, // 2: Provider mismatch
    NO_TEE_SIGNER, // 3: TEE signer not acknowledged
    INVALID_NONCE, // 4: Invalid or duplicate nonce
    INVALID_SIGNATURE // 5: Signature verification failed
}

contract InferenceServing is Ownable, Initializable, ReentrancyGuard, IServing, ERC165 {
    using AccountLibrary for AccountLibrary.AccountMap;
    using ServiceLibrary for ServiceLibrary.ServiceMap;

    // @custom:storage-location erc7201:0g.serving.inference.v1.0
    struct InferenceServingStorage {
        uint lockTime;
        address ledgerManagerAddress;
        ILedger ledgerManager;
        AccountLibrary.AccountMap accountMap;
        ServiceLibrary.ServiceMap serviceMap;
        mapping(address => uint) providerStake; // Service provider stake amounts
    }

    // keccak256(abi.encode(uint256(keccak256("0g.serving.inference.v1.0")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant INFERENCE_SERVING_STORAGE_LOCATION =
        0xdfd123095cdedb1cecbc229b30f7cf8745fb3d3951645ac4a8fa4c0895f89500;

    // Enforce sane lockTime to avoid instant bypass (0) or excessive freeze (> 7 days)
    uint public constant MIN_LOCKTIME = 1 hours;
    uint public constant MAX_LOCKTIME = 7 days;

    // Service provider stake requirement
    uint public constant MIN_PROVIDER_STAKE = 100 ether; // 100 0G minimum stake

    // EIP-712 Domain Separator (manual implementation for upgradeable contracts)
    bytes32 private constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    bytes32 private constant SETTLEMENT_TYPEHASH = keccak256(
        "TEESettlement(bytes32 requestsHash,uint256 nonce,address provider,address user,uint256 totalFee)"
    );

    string private constant DOMAIN_NAME = "0G Inference Serving";
    string private constant DOMAIN_VERSION = "1";

    function _getInferenceServingStorage() private pure returns (InferenceServingStorage storage $) {
        assembly {
            $.slot := INFERENCE_SERVING_STORAGE_LOCATION
        }
    }

    // Public getters for compatibility
    function lockTime() public view returns (uint) {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        return $.lockTime;
    }

    function ledgerAddress() public view returns (address) {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        return $.ledgerManagerAddress;
    }

    event BalanceUpdated(address indexed user, address indexed provider, uint amount, uint pendingRefund);
    event RefundRequested(address indexed user, address indexed provider, uint indexed index, uint timestamp);
    event ServiceUpdated(
        address indexed service,
        string serviceType,
        string url,
        uint inputPrice,
        uint outputPrice,
        uint updatedAt,
        string model,
        string verifiability
    );
    event ServiceRemoved(address indexed service);
    event TEESettlementResult(address indexed user, SettlementStatus status, uint256 unsettledAmount);
    event BatchBalanceUpdated(address[] users, uint256[] balances, uint256[] pendingRefunds);
    event ProviderTEESignerAcknowledged(address indexed provider, address indexed teeSignerAddress, bool acknowledged);
    event ProviderStaked(address indexed provider, uint amount);
    event ProviderStakeReturned(address indexed provider, uint amount);
    // Session token revocation events
    event TokenRevoked(address indexed user, address indexed provider, uint8 tokenId);
    event TokensRevoked(address indexed user, address indexed provider, uint8[] tokenIds);
    event AllTokensRevoked(address indexed user, address indexed provider, uint newGeneration);
    event LockTimeUpdated(uint256 oldLockTime, uint256 newLockTime);
    event ContractInitialized(address indexed owner, uint256 lockTime, address ledgerAddress);

    // Custom errors
    error InvalidTEESignature(string reason);
    error LockTimeOutOfRange(uint256 lockTime, uint256 min, uint256 max);
    error CallerNotLedger(address caller);
    error LimitTooLarge(uint256 limit, uint256 max);
    error InvalidAddress(address addr);
    error TransferFailed();
    error CannotAddStakeWhenUpdating();
    error InsufficientStake(uint256 provided, uint256 required);
    error NoSettlementsProvided();
    error TooManySettlements(uint256 count, uint256 max);

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

    function initialize(uint _locktime, address _ledgerAddress, address owner) public onlyInitializeOnce {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        _transferOwnership(owner);
        if (_locktime < MIN_LOCKTIME || _locktime > MAX_LOCKTIME) {
            revert LockTimeOutOfRange(_locktime, MIN_LOCKTIME, MAX_LOCKTIME);
        }
        $.lockTime = _locktime;
        $.ledgerManagerAddress = _ledgerAddress;
        $.ledgerManager = ILedger(_ledgerAddress);
        emit ContractInitialized(owner, _locktime, _ledgerAddress);
    }

    modifier onlyLedgerManager() {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        if (msg.sender != $.ledgerManagerAddress) {
            revert CallerNotLedger(msg.sender);
        }
        _;
    }

    function updateLockTime(uint _locktime) public onlyOwner {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        if (_locktime < MIN_LOCKTIME || _locktime > MAX_LOCKTIME) {
            revert LockTimeOutOfRange(_locktime, MIN_LOCKTIME, MAX_LOCKTIME);
        }
        uint256 oldLockTime = $.lockTime;
        $.lockTime = _locktime;
        emit LockTimeUpdated(oldLockTime, _locktime);
    }

    function getAccount(address user, address provider) public view returns (Account memory) {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        return $.accountMap.getAccount(user, provider);
    }

    function getAllAccounts(uint offset, uint limit) public view returns (Account[] memory accounts, uint total) {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        if (limit != 0 && limit > 50) {
            revert LimitTooLarge(limit, 50);
        }
        return $.accountMap.getAllAccounts(offset, (limit == 0 ? 50 : limit));
    }

    function getAccountsByProvider(
        address provider,
        uint offset,
        uint limit
    ) public view returns (Account[] memory accounts, uint total) {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        if (limit != 0 && limit > 50) {
            revert LimitTooLarge(limit, 50);
        }
        return $.accountMap.getAccountsByProvider(provider, offset, (limit == 0 ? 50 : limit));
    }

    function getAccountsByUser(
        address user,
        uint offset,
        uint limit
    ) public view returns (Account[] memory accounts, uint total) {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        if (limit != 0 && limit > 50) {
            revert LimitTooLarge(limit, 50);
        }
        return $.accountMap.getAccountsByUser(user, offset, (limit == 0 ? 50 : limit));
    }

    function getBatchAccountsByUsers(address[] calldata users) external view returns (Account[] memory accounts) {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        return $.accountMap.getBatchAccountsByUsers(users, msg.sender);
    }

    function acknowledgeTEESignerByOwner(address provider) external onlyOwner {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        Service storage service = $.serviceMap.getService(provider);
        $.serviceMap.acknowledgeTEESigner(provider);
        emit ProviderTEESignerAcknowledged(provider, service.teeSignerAddress, true);
    }

    function acknowledgeTEESigner(address provider, bool acknowledged) external {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        $.accountMap.acknowledgeTEESigner(msg.sender, provider, acknowledged);
    }

    function revokeTEESignerAcknowledgement(address provider) external onlyOwner {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        Service storage service = $.serviceMap.getService(provider);
        $.serviceMap.revokeTEESignerAcknowledgement(provider);
        emit ProviderTEESignerAcknowledged(provider, service.teeSignerAddress, false);
    }

    /// @notice Migration function to clean up old processed refunds (one-time use after upgrade)
    /// @param users Array of user addresses to migrate
    /// @param provider Provider address
    /// @return cleanedCount Number of accounts that had dirty data cleaned
    function migrateRefunds(address[] calldata users, address provider) external onlyOwner returns (uint cleanedCount) {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        return $.accountMap.migrateRefunds(users, provider);
    }

    function revokeToken(address provider, uint8 tokenId) external {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        $.accountMap.revokeToken(msg.sender, provider, tokenId);
        emit TokenRevoked(msg.sender, provider, tokenId);
    }

    function revokeTokens(address provider, uint8[] calldata tokenIds) external {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        $.accountMap.revokeTokens(msg.sender, provider, tokenIds);
        emit TokensRevoked(msg.sender, provider, tokenIds);
    }

    function revokeAllTokens(address provider) external {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        uint newGeneration = $.accountMap.revokeAllTokens(msg.sender, provider);
        emit AllTokensRevoked(msg.sender, provider, newGeneration);
    }

    function isTokenRevoked(address user, address provider, uint8 tokenId) external view returns (bool) {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        return $.accountMap.isTokenRevoked(user, provider, tokenId);
    }

    function accountExists(address user, address provider) public view returns (bool) {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        return $.accountMap.accountExists(user, provider);
    }

    function serviceExists(address provider) public view returns (bool) {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        return $.serviceMap.serviceExists(provider);
    }

    function getPendingRefund(address user, address provider) public view returns (uint) {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        return $.accountMap.getPendingRefund(user, provider);
    }

    function addAccount(address user, address provider, string memory additionalInfo) external payable onlyLedgerManager {
        if (user == address(0)) {
            revert InvalidAddress(user);
        }
        if (provider == address(0)) {
            revert InvalidAddress(provider);
        }

        InferenceServingStorage storage $ = _getInferenceServingStorage();
        (uint balance, uint pendingRefund) = $.accountMap.addAccount(user, provider, msg.value, additionalInfo);

        // Auto-acknowledge TEE signer when user transfers funds to provider
        $.accountMap.acknowledgeTEESigner(user, provider, true);

        emit BalanceUpdated(user, provider, balance, pendingRefund);
    }

    function deleteAccount(address user, address provider) external onlyLedgerManager {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        $.accountMap.deleteAccount(user, provider);
    }

    function depositFund(address user, address provider, uint cancelRetrievingAmount) external payable onlyLedgerManager {
        if (user == address(0)) {
            revert InvalidAddress(user);
        }
        if (provider == address(0)) {
            revert InvalidAddress(provider);
        }

        InferenceServingStorage storage $ = _getInferenceServingStorage();
        (uint balance, uint pendingRefund) = $.accountMap.depositFund(
            user,
            provider,
            cancelRetrievingAmount,
            msg.value
        );

        // Auto-acknowledge TEE signer when user deposits funds to provider (if not already acknowledged)
        Account storage account = $.accountMap.getAccount(user, provider);
        if (!account.acknowledged) {
            $.accountMap.acknowledgeTEESigner(user, provider, true);
        }

        emit BalanceUpdated(user, provider, balance, pendingRefund);
    }

    function requestRefundAll(address user, address provider) external onlyLedgerManager {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        $.accountMap.requestRefundAll(user, provider);
        Account memory account = $.accountMap.getAccount(user, provider);
        if (account.validRefundsLength > 0) {
            emit RefundRequested(user, provider, account.validRefundsLength - 1, block.timestamp);
        }
    }

    function processRefund(
        address user,
        address provider
    ) external onlyLedgerManager returns (uint totalAmount, uint balance, uint pendingRefund) {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        (totalAmount, balance, pendingRefund) = $.accountMap.processRefund(user, provider, $.lockTime);

        if (totalAmount > 0) {
            // Emit event before external call to prevent reentrancy-caused event ordering issues
            emit BalanceUpdated(user, provider, balance, pendingRefund);

            (bool success, ) = payable(msg.sender).call{value: totalAmount}("");
            if (!success) {
                revert TransferFailed();
            }
        }
    }

    function getService(address provider) public view returns (Service memory service) {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        service = $.serviceMap.getService(provider);
    }

    function getAllServices(uint offset, uint limit) public view returns (Service[] memory services, uint total) {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        if (limit != 0 && limit > 50) {
            revert LimitTooLarge(limit, 50);
        }
        return $.serviceMap.getAllServices(offset, (limit == 0 ? 50 : limit));
    }

    function addOrUpdateService(ServiceParams calldata params) external payable {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        if ($.providerStake[msg.sender] > 0) {
            // Updating existing service: cannot add more stake
            if (msg.value != 0) {
                revert CannotAddStakeWhenUpdating();
            }
        } else {
            // First time registration: require stake
            if (msg.value < MIN_PROVIDER_STAKE) {
                revert InsufficientStake(msg.value, MIN_PROVIDER_STAKE);
            }
            $.providerStake[msg.sender] = msg.value;

            emit ProviderStaked(msg.sender, msg.value);
        }

        $.serviceMap.addOrUpdateService(msg.sender, params);
        emit ServiceUpdated(
            msg.sender,
            params.serviceType,
            params.url,
            params.inputPrice,
            params.outputPrice,
            block.timestamp,
            params.model,
            params.verifiability
        );
    }

    function removeService() external nonReentrant {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        $.serviceMap.removeService(msg.sender);

        // Return stake if any
        uint stake = $.providerStake[msg.sender];
        if (stake > 0) {
            $.providerStake[msg.sender] = 0;

            // Emit events before external call to prevent reentrancy-caused event ordering issues
            emit ProviderStakeReturned(msg.sender, stake);
            emit ServiceRemoved(msg.sender);

            (bool success, ) = payable(msg.sender).call{value: stake}("");
            if (!success) {
                revert TransferFailed();
            }
        } else {
            emit ServiceRemoved(msg.sender);
        }
    }

    function _settleFees(Account storage account, uint amount) private {
        InferenceServingStorage storage $ = _getInferenceServingStorage();

        if (amount > (account.balance - account.pendingRefund)) {
            // No need to ensure capacity here - if validRefundsLength > 0, array is already initialized
            uint remainingFee = amount - (account.balance - account.pendingRefund);
            account.pendingRefund -= remainingFee;

            // Use swap-and-shrink: process refunds from end to start
            // Process from end to prioritize newer refunds for cancellation
            uint writeIndex = 0;
            bool[] memory shouldCancel = new bool[](account.validRefundsLength);

            // First pass: mark which refunds to cancel (from end to start)
            for (int i = int(account.validRefundsLength) - 1; i >= 0 && remainingFee > 0; i--) {
                Refund storage refund = account.refunds[uint(i)];

                if (refund.amount <= remainingFee) {
                    remainingFee -= refund.amount;
                    shouldCancel[uint(i)] = true;
                } else {
                    refund.amount -= remainingFee;
                    remainingFee = 0;
                }
            }

            // Second pass: compact array keeping non-cancelled refunds
            for (uint i = 0; i < account.validRefundsLength; i++) {
                if (!shouldCancel[i]) {
                    if (i != writeIndex) {
                        account.refunds[writeIndex] = account.refunds[i];
                        account.refunds[writeIndex].index = writeIndex;
                    }
                    writeIndex++;
                }
            }

            // Shrink active boundary (no pop needed - just adjust boundary)
            account.validRefundsLength = writeIndex;
        }

        account.balance -= amount;
        $.ledgerManager.spendFund(account.user, amount);
        emit BalanceUpdated(account.user, msg.sender, account.balance, account.pendingRefund);
    }

    // Static view function for previewing settlement results without state changes
    function previewSettlementResults(
        TEESettlementData[] calldata settlements
    )
        external
        view
        returns (
            address[] memory failedUsers,
            SettlementStatus[] memory failureReasons,
            address[] memory partialUsers,
            uint256[] memory partialAmounts
        )
    {
        if (settlements.length == 0) {
            revert NoSettlementsProvided();
        }
        if (settlements.length > 50) {
            revert TooManySettlements(settlements.length, 50);
        }

        uint settlementsLength = settlements.length;
        failedUsers = new address[](settlementsLength);
        failureReasons = new SettlementStatus[](settlementsLength);
        partialUsers = new address[](settlementsLength);
        partialAmounts = new uint256[](settlementsLength);

        uint failedCount = 0;
        uint partialCount = 0;

        for (uint i = 0; i < settlementsLength; i++) {
            TEESettlementData calldata settlement = settlements[i];

            if (settlement.provider != msg.sender) {
                _recordFailure(
                    failedUsers,
                    failureReasons,
                    failedCount++,
                    settlement.user,
                    SettlementStatus.PROVIDER_MISMATCH
                );
                continue;
            }

            (SettlementStatus status, uint256 unsettledAmount) = _previewTEESettlement(settlement);

            if (status == SettlementStatus.SUCCESS) {
                continue;
            }

            if (status == SettlementStatus.PARTIAL) {
                _recordPartial(partialUsers, partialAmounts, partialCount++, settlement.user, unsettledAmount);
                continue;
            }
            _recordFailure(failedUsers, failureReasons, failedCount++, settlement.user, status);
        }

        assembly {
            mstore(failedUsers, failedCount)
            mstore(failureReasons, failedCount)
            mstore(partialUsers, partialCount)
            mstore(partialAmounts, partialCount)
        }
    }

    /// @notice Settle fees with TEE-signed settlement data
    /// @param settlements Array of settlement data to process
    /// @return statuses Array of settlement statuses (uint8), preserving one-to-one correspondence with input
    /// @dev Status codes: 0=SUCCESS, 1=PARTIAL_SETTLEMENT, 2=PROVIDER_MISMATCH, 3=NO_TEE_SIGNER, 4=INVALID_NONCE, 5=INVALID_SIGNATURE
    /// @dev Statuses array has same length as input, with statuses[i] corresponding to settlements[i]
    /// @dev All settlement details are emitted via TEESettlementResult events
    function settleFeesWithTEE(
        TEESettlementData[] calldata settlements
    )
        external
        nonReentrant
        returns (uint8[] memory statuses)
    {
        if (settlements.length == 0) {
            revert NoSettlementsProvided();
        }
        if (settlements.length > 50) {
            revert TooManySettlements(settlements.length, 50);
        }

        uint settlementsLength = settlements.length;
        statuses = new uint8[](settlementsLength);
        uint256 totalTransferAmount = 0;

        for (uint i = 0; i < settlementsLength; i++) {
            TEESettlementData calldata settlement = settlements[i];

            if (settlement.provider != msg.sender) {
                statuses[i] = uint8(SettlementStatus.PROVIDER_MISMATCH);
                emit TEESettlementResult(settlement.user, SettlementStatus.PROVIDER_MISMATCH, settlement.totalFee);
                continue;
            }

            (SettlementStatus status, uint256 unsettledAmount, uint256 settledAmount) = _processTEESettlement(
                settlement
            );

            statuses[i] = uint8(status);
            totalTransferAmount += settledAmount;
            emit TEESettlementResult(settlement.user, status, unsettledAmount);
        }

        // Batch transfer all settled amounts at once
        if (totalTransferAmount > 0) {
            (bool success, ) = payable(msg.sender).call{value: totalTransferAmount}("");
            if (!success) {
                revert TransferFailed();
            }
        }
    }

    // View function to preview settlement without state changes
    function _previewTEESettlement(
        TEESettlementData calldata settlement
    ) private view returns (SettlementStatus status, uint256 unsettledAmount) {
        InferenceServingStorage storage $ = _getInferenceServingStorage();

        // Check if account exists to prevent revert in batch processing
        if (!$.accountMap.accountExists(settlement.user, msg.sender)) {
            return (SettlementStatus.INVALID_SIGNATURE, settlement.totalFee);
        }

        // Check if service exists to prevent revert in batch processing
        if (!$.serviceMap.serviceExists(msg.sender)) {
            return (SettlementStatus.PROVIDER_MISMATCH, settlement.totalFee);
        }

        Account storage account = $.accountMap.getAccount(settlement.user, msg.sender);
        Service storage service = $.serviceMap.getService(msg.sender);

        // Validate TEE signer acknowledgement - both user and service must be acknowledged, and service must have valid TEE signer address
        if (!account.acknowledged || !service.teeSignerAcknowledged || service.teeSignerAddress == address(0)) {
            return (SettlementStatus.NO_TEE_SIGNER, settlement.totalFee);
        }

        // Validate nonce (check if nonce would be valid)
        if (account.nonce >= settlement.nonce) {
            return (SettlementStatus.INVALID_NONCE, settlement.totalFee);
        }

        // Validate signature using service TEE signer address
        if (!_verifySignature(settlement, service.teeSignerAddress)) {
            return (SettlementStatus.INVALID_SIGNATURE, settlement.totalFee);
        }

        // Calculate settlement amounts (without modifying state)
        uint256 balance = account.balance;
        uint256 unsettled = settlement.totalFee > balance ? settlement.totalFee - balance : 0;

        // Return appropriate status
        if (unsettled > 0) {
            return (SettlementStatus.PARTIAL, unsettled);
        } else {
            return (SettlementStatus.SUCCESS, 0);
        }
    }

    function _processTEESettlement(
        TEESettlementData calldata settlement
    ) private returns (SettlementStatus status, uint256 unsettledAmount, uint256 settledAmount) {
        InferenceServingStorage storage $ = _getInferenceServingStorage();

        // Check if account exists to prevent revert in batch processing
        if (!$.accountMap.accountExists(settlement.user, msg.sender)) {
            return (SettlementStatus.INVALID_SIGNATURE, settlement.totalFee, 0);
        }

        // Check if service exists to prevent revert in batch processing
        if (!$.serviceMap.serviceExists(msg.sender)) {
            return (SettlementStatus.PROVIDER_MISMATCH, settlement.totalFee, 0);
        }

        Account storage account = $.accountMap.getAccount(settlement.user, msg.sender);
        Service storage service = $.serviceMap.getService(msg.sender);

        // Validate TEE signer acknowledgement - both user and service must be acknowledged, and service must have valid TEE signer address
        if (!account.acknowledged || !service.teeSignerAcknowledged || service.teeSignerAddress == address(0)) {
            return (SettlementStatus.NO_TEE_SIGNER, settlement.totalFee, 0);
        }

        // Validate nonce
        if (account.nonce >= settlement.nonce) {
            return (SettlementStatus.INVALID_NONCE, settlement.totalFee, 0);
        }

        // Validate signature using service TEE signer address
        if (!_verifySignature(settlement, service.teeSignerAddress)) {
            return (SettlementStatus.INVALID_SIGNATURE, settlement.totalFee, 0);
        }

        // All validations passed, update nonce
        account.nonce = settlement.nonce;

        // Calculate settlement amounts
        uint256 balance = account.balance;
        uint256 toSettle = settlement.totalFee > balance ? balance : settlement.totalFee;
        uint256 unsettled = settlement.totalFee > balance ? settlement.totalFee - balance : 0;

        // Settle what we can
        if (toSettle > 0) {
            _settleFees(account, toSettle);
        }

        // Return appropriate status
        if (unsettled > 0) {
            return (SettlementStatus.PARTIAL, unsettled, toSettle);
        } else {
            return (SettlementStatus.SUCCESS, 0, toSettle);
        }
    }

    /// @dev Calculate EIP-712 domain separator
    /// @notice Computed dynamically to handle chain forks and proxy deployments correctly
    function _domainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256(bytes(DOMAIN_NAME)),
                keccak256(bytes(DOMAIN_VERSION)),
                block.chainid,
                address(this)
            )
        );
    }

    function _verifySignature(
        TEESettlementData calldata settlement,
        address expectedSigner
    ) private view returns (bool) {
        // Calculate EIP-712 structured hash
        bytes32 structHash = keccak256(
            abi.encode(
                SETTLEMENT_TYPEHASH,
                settlement.requestsHash,
                settlement.nonce,
                settlement.provider,
                settlement.user,
                settlement.totalFee
            )
        );

        // Calculate EIP-712 digest with domain separator
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",  // EIP-712 prefix
                _domainSeparator(),
                structHash
            )
        );

        // ECDSA.tryRecover automatically checks s value malleability and returns error on invalid signature
        (address recovered, ECDSA.RecoverError error) = ECDSA.tryRecover(digest, settlement.signature);

        // Return true only if recovery succeeded and address matches
        return error == ECDSA.RecoverError.NoError && recovered == expectedSigner;
    }

    function _recordFailure(
        address[] memory failedUsers,
        SettlementStatus[] memory failureReasons,
        uint index,
        address user,
        SettlementStatus reason
    ) private pure {
        failedUsers[index] = user;
        failureReasons[index] = reason;
    }

    function _recordPartial(
        address[] memory partialUsers,
        uint256[] memory partialAmounts,
        uint index,
        address user,
        uint256 amount
    ) private pure {
        partialUsers[index] = user;
        partialAmounts[index] = amount;
    }

    // === ERC165 Support ===

    function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
        return interfaceId == type(IServing).interfaceId || super.supportsInterface(interfaceId);
    }

    receive() external payable {
        revert("Direct deposits disabled; use LedgerManager");
    }
}
