// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import "../utils/Initializable.sol";
import "./FineTuningAccount.sol";
import "../ledger/LedgerManager.sol";

using AccountLibrary for AccountLibrary.AccountMap;
import "./FineTuningService.sol";
import "./FineTuningVerifier.sol";

interface ISignatureVerifier {
    function verifySignature(
        string memory message,
        bytes memory signature,
        address expectedAddress
    ) external view returns (bool);
}

contract FineTuningServing is Ownable, Initializable, ReentrancyGuard, IServing, ERC165 {
    using AccountLibrary for AccountLibrary.AccountMap;
    using ServiceLibrary for ServiceLibrary.ServiceMap;
    using VerifierLibrary for VerifierInput;

    // @custom:storage-location erc7201:0g.serving.finetuning.v1.0
    struct FineTuningServingStorage {
        uint lockTime;
        address ledgerAddress;
        ILedger ledger;
        AccountLibrary.AccountMap accountMap;
        ServiceLibrary.ServiceMap serviceMap;
        uint penaltyPercentage;
        mapping(address => uint) providerStake; // Service provider stake amounts
    }

    // keccak256(abi.encode(uint256(keccak256("0g.serving.finetuning.v1.0")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant FINETUNING_SERVING_STORAGE_LOCATION =
        0x5dcaaa00d1d3fae8cd5d66aceca789aec54970049ac35cb62a7adefca50a6800;

    // Enforce sane lockTime to avoid instant bypass (0) or excessive freeze (> 7 days)
    uint public constant MIN_LOCKTIME = 1 hours;
    uint public constant MAX_LOCKTIME = 7 days;

    // Service provider stake requirement
    uint public constant MIN_PROVIDER_STAKE = 100 ether; // 100 0G minimum stake

    function _getFineTuningServingStorage() private pure returns (FineTuningServingStorage storage $) {
        assembly {
            $.slot := FINETUNING_SERVING_STORAGE_LOCATION
        }
    }

    // Public getters for compatibility
    function lockTime() public view returns (uint) {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        return $.lockTime;
    }

    function ledgerAddress() public view returns (address) {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        return $.ledgerAddress;
    }

    function penaltyPercentage() public view returns (uint) {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        return $.penaltyPercentage;
    }

    event BalanceUpdated(address indexed user, address indexed provider, uint amount, uint pendingRefund);
    event RefundRequested(address indexed user, address indexed provider, uint indexed index, uint timestamp);
    event ServiceUpdated(
        address indexed provider,
        string url,
        Quota quota,
        uint pricePerToken,
        address teeSignerAddress,
        bool occupied
    );
    event ServiceRemoved(address indexed provider);
    event AccountDeleted(address indexed user, address indexed provider, uint256 refundedAmount);
    event LockTimeUpdated(uint256 oldLockTime, uint256 newLockTime);
    event ProviderTEESignerAcknowledged(address indexed provider, address indexed teeSignerAddress, bool acknowledged);
    event ProviderStaked(address indexed provider, uint amount);
    event ProviderStakeReturned(address indexed provider, uint amount);
    event DeliverableAdded(address indexed user, address indexed provider, string deliverableId, bytes modelRootHash, uint timestamp);
    event DeliverableAcknowledged(address indexed user, address indexed provider, string deliverableId, uint timestamp);
    event DeliverableEvicted(address indexed provider, address indexed user, string evictedDeliverableId, string newDeliverableId, uint timestamp);
    event FeesSettled(address indexed user, address indexed provider, string deliverableId, uint fee, bool acknowledged, uint nonce);

    // GAS-1 optimization: Custom errors for gas efficiency
    error InvalidVerifierInput(string reason);
    error InvalidLedgerAddress();
    error CallerNotLedger();
    error PenaltyPercentageTooHigh(uint256 percentage);
    error LockTimeOutOfRange(uint256 lockTime);
    error LimitTooLarge(uint256 limit);
    error TransferToLedgerFailed();
    error ETHTransferFailed();
    error DirectDepositsDisabled();
    error SecretShouldNotBeEmpty();
    error SecretShouldBeEmpty();
    error CannotAddStakeWhenUpdating();
    error InsufficientStake(uint256 provided, uint256 required);
    error DeliverableAlreadySettled(string id);

    /// @notice Initializes the contract with locktime and ledger address
    /// @param _locktime The time period for refund locks
    /// @param _ledgerAddress The address of the ledger contract
    /// @param owner The owner address
    /// @param _penaltyPercentage The penalty percentage for unacknowledged deliverables
    function initialize(
        uint _locktime,
        address _ledgerAddress,
        address owner,
        uint _penaltyPercentage
    ) public onlyInitializeOnce {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        if (_ledgerAddress == address(0) || _ledgerAddress.code.length == 0) {
            revert InvalidLedgerAddress();
        }
        if (_penaltyPercentage > 100) {
            revert PenaltyPercentageTooHigh(_penaltyPercentage);
        }
        _transferOwnership(owner);
        if (_locktime < MIN_LOCKTIME || _locktime > MAX_LOCKTIME) {
            revert LockTimeOutOfRange(_locktime);
        }
        $.lockTime = _locktime;
        $.ledgerAddress = _ledgerAddress;
        $.ledger = ILedger(_ledgerAddress);
        $.penaltyPercentage = _penaltyPercentage;
    }

    modifier onlyLedger() {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        if (msg.sender != $.ledgerAddress) {
            revert CallerNotLedger();
        }
        _;
    }

    /// @notice Updates the lock time for refunds
    /// @dev MED-5: This change applies immediately to ALL pending refunds
    /// @dev The new lockTime will be used when processing any refund, regardless of when it was created
    /// @dev Owner should exercise caution as this affects users' expectations for refund timing
    /// @dev GAS-8: Skip storage write if value unchanged (~2900 gas saved)
    /// @param _locktime The new lock time (must be between MIN_LOCKTIME and MAX_LOCKTIME)
    function updateLockTime(uint _locktime) public onlyOwner {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        if (_locktime < MIN_LOCKTIME || _locktime > MAX_LOCKTIME) {
            revert LockTimeOutOfRange(_locktime);
        }
        uint256 oldLockTime = $.lockTime;
        // GAS-8: Only write if value changed
        if (oldLockTime != _locktime) {
            $.lockTime = _locktime;
            emit LockTimeUpdated(oldLockTime, _locktime);
        }
    }

    /// @notice Updates the penalty percentage for unacknowledged deliverables
    /// @dev GAS-8: Skip storage write if value unchanged (~2900 gas saved)
    /// @param _penaltyPercentage The new penalty percentage (0-100)
    function updatePenaltyPercentage(uint _penaltyPercentage) public onlyOwner {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        if (_penaltyPercentage > 100) {
            revert PenaltyPercentageTooHigh(_penaltyPercentage);
        }
        // GAS-8: Only write if value changed
        if ($.penaltyPercentage != _penaltyPercentage) {
            $.penaltyPercentage = _penaltyPercentage;
        }
    }

    // user functions

    function getAccount(address user, address provider) public view returns (AccountDetails memory) {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        return $.accountMap.getAccountDetails(user, provider);
    }

    function getAllAccounts(
        uint offset,
        uint limit
    ) public view returns (AccountSummary[] memory accounts, uint total) {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        if (limit != 0 && limit > 50) {
            revert LimitTooLarge(limit);
        }
        return $.accountMap.getAllAccounts(offset, (limit == 0 ? 50 : limit));
    }

    function getAccountsByProvider(
        address provider,
        uint offset,
        uint limit
    ) public view returns (AccountSummary[] memory accounts, uint total) {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        if (limit != 0 && limit > 50) {
            revert LimitTooLarge(limit);
        }
        return $.accountMap.getAccountsByProvider(provider, offset, (limit == 0 ? 50 : limit));
    }

    function getAccountsByUser(
        address user,
        uint offset,
        uint limit
    ) public view returns (AccountSummary[] memory accounts, uint total) {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        if (limit != 0 && limit > 50) {
            revert LimitTooLarge(limit);
        }
        return $.accountMap.getAccountsByUser(user, offset, (limit == 0 ? 50 : limit));
    }

    function getBatchAccountsByUsers(
        address[] calldata users
    ) external view returns (AccountSummary[] memory accounts) {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        return $.accountMap.getBatchAccountsByUsers(users, msg.sender);
    }

    function accountExists(address user, address provider) public view returns (bool) {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        return $.accountMap.accountExists(user, provider);
    }

    function getPendingRefund(address user, address provider) public view returns (uint) {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        return $.accountMap.getPendingRefund(user, provider);
    }

    function addAccount(address user, address provider, string memory additionalInfo) external payable onlyLedger {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        (uint balance, uint pendingRefund) = $.accountMap.addAccount(user, provider, msg.value, additionalInfo);

        // Auto-acknowledge TEE signer when user transfers funds to provider
        $.accountMap.acknowledgeTEESigner(user, provider, true);

        emit BalanceUpdated(user, provider, balance, pendingRefund);
    }

    function deleteAccount(address user, address provider) external onlyLedger {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        uint deletedBalance = $.accountMap.deleteAccount(user, provider);
        emit AccountDeleted(user, provider, deletedBalance);
    }

    function depositFund(address user, address provider, uint cancelRetrievingAmount) external payable onlyLedger {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
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

    function requestRefundAll(address user, address provider) external onlyLedger {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        $.accountMap.requestRefundAll(user, provider);

        // Emit RefundRequested event after requestRefundAll
        Account storage account = $.accountMap.getAccount(user, provider);
        if (account.validRefundsLength > 0) {
            emit RefundRequested(user, provider, account.validRefundsLength - 1, block.timestamp);
        }
    }

    function processRefund(
        address user,
        address provider
    ) external onlyLedger returns (uint totalAmount, uint balance, uint pendingRefund) {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        (totalAmount, balance, pendingRefund) = $.accountMap.processRefund(user, provider, $.lockTime);
        if (totalAmount == 0) {
            return (0, balance, pendingRefund);
        }
        // HIGH-3 FIX: Emit event BEFORE external call (CEI pattern)
        emit BalanceUpdated(user, provider, balance, pendingRefund);

        (bool success, ) = payable(msg.sender).call{value: totalAmount}("");
        if (!success) {
            revert TransferToLedgerFailed();
        }
    }

    function getService(address provider) public view returns (Service memory service) {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        service = $.serviceMap.getService(provider);
    }

    function getAllServices() public view returns (Service[] memory services) {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        services = $.serviceMap.getAllServices();
    }

    function acknowledgeDeliverable(address provider, string calldata id) external {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        $.accountMap.acknowledgeDeliverable(msg.sender, provider, id);
        emit DeliverableAcknowledged(msg.sender, provider, id, block.timestamp);
    }

    function acknowledgeTEESignerByOwner(address provider) external onlyOwner {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        Service storage service = $.serviceMap.getService(provider);
        $.serviceMap.acknowledgeTEESigner(provider);
        emit ProviderTEESignerAcknowledged(provider, service.teeSignerAddress, true);
    }

    function acknowledgeTEESigner(address provider, bool acknowledged) external {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        $.accountMap.acknowledgeTEESigner(msg.sender, provider, acknowledged);
    }

    function revokeTEESignerAcknowledgement(address provider) external onlyOwner {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        Service storage service = $.serviceMap.getService(provider);
        $.serviceMap.revokeTEESignerAcknowledgement(provider);
        emit ProviderTEESignerAcknowledged(provider, service.teeSignerAddress, false);
    }

    // provider functions

    function addOrUpdateService(
        string calldata url,
        Quota memory quota,
        uint pricePerToken,
        bool occupied,
        string[] memory models,
        address teeSignerAddress
    ) external payable {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
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

        $.serviceMap.addOrUpdateService(msg.sender, url, quota, pricePerToken, occupied, models, teeSignerAddress);
        emit ServiceUpdated(msg.sender, url, quota, pricePerToken, teeSignerAddress, occupied);
    }

    function removeService() external nonReentrant {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
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
                revert ETHTransferFailed();
            }
        } else {
            emit ServiceRemoved(msg.sender);
        }
    }

    function addDeliverable(address user, string calldata id, bytes memory modelRootHash) external {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        (bool evicted, string memory evictedId) = $.accountMap.addDeliverable(user, msg.sender, id, modelRootHash);

        // Emit eviction event if a deliverable was evicted
        if (evicted) {
            emit DeliverableEvicted(msg.sender, user, evictedId, id, block.timestamp);
        }

        emit DeliverableAdded(user, msg.sender, id, modelRootHash, block.timestamp);
    }

    function getDeliverable(
        address user,
        address provider,
        string calldata id
    ) public view returns (Deliverable memory) {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        return $.accountMap.getDeliverable(user, provider, id);
    }

    function getDeliverables(address user, address provider) public view returns (Deliverable[] memory) {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        return $.accountMap.getDeliverables(user, provider);
    }

    /// @notice Settles fees for a completed deliverable with TEE signature verification
    /// @param verifierInput The verifier input containing signature and deliverable data
    /// @dev CRIT-4 FIX: Added nonReentrant modifier to prevent reentrancy attacks
    /// @dev GAS-2: Cache storage variables to save ~100 gas
    function settleFees(VerifierInput calldata verifierInput) external nonReentrant {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        Account storage account = $.accountMap.getAccount(verifierInput.user, msg.sender);
        Service storage service = $.serviceMap.getService(msg.sender);

        // Validate TEE signer acknowledgement - both user and service must be acknowledged, and service must have valid TEE signer address
        if (!account.acknowledged || !service.teeSignerAcknowledged || service.teeSignerAddress == address(0)) {
            revert InvalidVerifierInput("TEE signer not acknowledged");
        }

        // GAS-2: Cache frequently accessed storage variables
        uint accountNonce = account.nonce;

        // Group all validation checks together for gas efficiency
        if (accountNonce >= verifierInput.nonce) {
            revert InvalidVerifierInput("nonce should larger than the current nonce");
        }
        if (account.balance < verifierInput.taskFee) {
            revert InvalidVerifierInput("insufficient balance");
        }

        // Validate deliverable exists
        if (bytes(account.deliverables[verifierInput.id].id).length == 0) {
            revert AccountLibrary.DeliverableNotExists(verifierInput.id);
        }
        Deliverable storage deliverable = account.deliverables[verifierInput.id];
        if (deliverable.settled) {
            revert DeliverableAlreadySettled(verifierInput.id);
        }
        if (keccak256(deliverable.modelRootHash) != keccak256(verifierInput.modelRootHash)) {
            revert InvalidVerifierInput("model root hash mismatch");
        }

        // Verify TEE signature using EIP-712 (uses service.teeSignerAddress)
        bool teePassed = verifierInput.verifySignature(service.teeSignerAddress, address(this));
        if (!teePassed) {
            revert InvalidVerifierInput("TEE settlement validation failed");
        }

        uint fee = verifierInput.taskFee;
        if (deliverable.acknowledged) {
            if (verifierInput.encryptedSecret.length == 0) {
                revert SecretShouldNotBeEmpty();
            }
            deliverable.encryptedSecret = verifierInput.encryptedSecret;
        } else {
            if (verifierInput.encryptedSecret.length != 0) {
                revert SecretShouldBeEmpty();
            }
            fee = (fee * $.penaltyPercentage) / 100;
        }

        account.nonce = verifierInput.nonce;
        deliverable.settled = true;

        // Emit FeesSettled event before _settleFees to track settlement details
        emit FeesSettled(
            verifierInput.user,
            msg.sender,
            verifierInput.id,
            fee,
            deliverable.acknowledged,
            verifierInput.nonce
        );

        _settleFees(account, fee);
    }

    /// @notice Internal function to settle fees with the provider
    /// @param account The account storage reference
    /// @param amount The amount to settle
    /// @dev CRIT-3 FIX: Uses call() instead of transfer() to avoid 2300 gas limit issues
    /// @dev Uses grow-only refund strategy aligned with Inference contract
    /// @dev Refunds are processed in LIFO order; validRefundsLength tracks active refunds
    function _settleFees(Account storage account, uint amount) private {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();

        if (amount > (account.balance - account.pendingRefund)) {
            // Need to cancel some refunds to cover the fee
            uint amountFromRefunds = amount - (account.balance - account.pendingRefund);
            uint remainingToDeduct = amountFromRefunds;
            uint validLength = account.validRefundsLength;

            // Single pass: process refunds from end to start (LIFO - most recent first)
            for (uint i = validLength; i > 0 && remainingToDeduct > 0; ) {
                unchecked { --i; }
                Refund storage refund = account.refunds[i];

                if (refund.amount <= remainingToDeduct) {
                    // Fully cancel this refund
                    remainingToDeduct -= refund.amount;
                    refund.amount = 0;
                    --validLength;
                } else {
                    // Partially cancel this refund
                    refund.amount -= remainingToDeduct;
                    remainingToDeduct = 0;
                }
            }

            account.validRefundsLength = validLength;
            account.pendingRefund -= amountFromRefunds;
        }

        account.balance -= amount;
        $.ledger.spendFund(account.user, amount);
        emit BalanceUpdated(account.user, msg.sender, account.balance, account.pendingRefund);

        // CRIT-3 FIX: Use call() instead of transfer() to support contracts with expensive receive() fallbacks
        // transfer() only forwards 2300 gas which can fail for contract recipients
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        if (!success) {
            revert ETHTransferFailed();
        }
    }

    // === ERC165 Support ===

    function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
        return interfaceId == type(IServing).interfaceId || super.supportsInterface(interfaceId);
    }

    receive() external payable {
        revert DirectDepositsDisabled();
    }
}
