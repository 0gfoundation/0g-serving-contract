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
    }

    // keccak256(abi.encode(uint256(keccak256("0g.serving.finetuning.v1.0")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant FINETUNING_SERVING_STORAGE_LOCATION =
        0x5dcaaa00d1d3fae8cd5d66aceca789aec54970049ac35cb62a7adefca50a6800;

    // Enforce sane lockTime to avoid instant bypass (0) or excessive freeze (> 7 days)
    uint public constant MIN_LOCKTIME = 1 hours;
    uint public constant MAX_LOCKTIME = 7 days;

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
        address indexed user,
        string url,
        Quota quota,
        uint pricePerToken,
        address providerSigner,
        bool occupied
    );
    event ServiceRemoved(address indexed user);
    event AccountDeleted(address indexed user, address indexed provider, uint256 refundedAmount);
    event LockTimeUpdated(uint256 oldLockTime, uint256 newLockTime);

    // GAS-1 optimization: Custom errors for gas efficiency
    error InvalidVerifierInput(string reason);
    error InvalidLedgerAddress();
    error PenaltyPercentageTooHigh(uint256 percentage);
    error LockTimeOutOfRange(uint256 lockTime);
    error LimitTooLarge(uint256 limit);
    error TransferToLedgerFailed();
    error ETHTransferFailed();
    error DirectDepositsDisabled();
    error DeliverableNotExists(string id);
    error SecretShouldNotBeEmpty();
    error SecretShouldBeEmpty();

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
        require(msg.sender == $.ledgerAddress, "Caller is not the ledger contract");
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
        emit BalanceUpdated(user, provider, balance, pendingRefund);
    }

    function requestRefundAll(address user, address provider) external onlyLedger {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        $.accountMap.requestRefundAll(user, provider);
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

    function acknowledgeProviderSigner(address provider, address providerSigner) external {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        $.accountMap.acknowledgeProviderSigner(msg.sender, provider, providerSigner);
    }

    function acknowledgeDeliverable(address provider, string calldata id) external {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        $.accountMap.acknowledgeDeliverable(msg.sender, provider, id);
    }

    // provider functions

    function addOrUpdateService(
        string calldata url,
        Quota memory quota,
        uint pricePerToken,
        address providerSigner,
        bool occupied,
        string[] memory models
    ) external {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        $.serviceMap.addOrUpdateService(msg.sender, url, quota, pricePerToken, providerSigner, occupied, models);
        emit ServiceUpdated(msg.sender, url, quota, pricePerToken, providerSigner, occupied);
    }

    function removeService() external {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        $.serviceMap.removeService(msg.sender);
        emit ServiceRemoved(msg.sender);
    }

    function addDeliverable(address user, string calldata id, bytes memory modelRootHash) external {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        $.accountMap.addDeliverable(user, msg.sender, id, modelRootHash);
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

        // GAS-2: Cache frequently accessed storage variables
        address providerSigner = account.providerSigner;
        uint accountNonce = account.nonce;

        // Group all validation checks together for gas efficiency
        if (providerSigner != verifierInput.providerSigner) {
            revert InvalidVerifierInput("provider signing address is not acknowledged");
        }
        if (accountNonce >= verifierInput.nonce) {
            revert InvalidVerifierInput("nonce should larger than the current nonce");
        }
        if (account.balance < verifierInput.taskFee) {
            revert InvalidVerifierInput("insufficient balance");
        }

        // Validate deliverable exists
        if (bytes(account.deliverables[verifierInput.id].id).length == 0) {
            revert DeliverableNotExists(verifierInput.id);
        }
        Deliverable storage deliverable = account.deliverables[verifierInput.id];
        if (keccak256(deliverable.modelRootHash) != keccak256(verifierInput.modelRootHash)) {
            revert InvalidVerifierInput("model root hash mismatch");
        }

        // Verify TEE signature using EIP-712 (uses cached providerSigner)
        bool teePassed = verifierInput.verifySignature(providerSigner, address(this));
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
        _settleFees(account, fee);
    }

    /// @notice Internal function to settle fees with the provider
    /// @param account The account storage reference
    /// @param amount The amount to settle
    /// @dev CRIT-3 FIX: Uses call() instead of transfer() to avoid 2300 gas limit issues
    /// @dev GAS-2: Cache storage variables to save ~100 gas
    function _settleFees(Account storage account, uint amount) private {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();

        // GAS-2: Cache frequently accessed storage variables
        uint accountBalance = account.balance;
        uint pendingRefund = account.pendingRefund;
        uint availableBalance = accountBalance - pendingRefund;

        if (amount > availableBalance) {
            uint remainingFee = amount - availableBalance;
            if (pendingRefund < remainingFee) {
                revert InvalidVerifierInput("insufficient balance in pendingRefund");
            }

            pendingRefund -= remainingFee;

            // Optimized: Process from the end with early exit
            uint refundsLength = account.refunds.length;
            for (uint i = refundsLength; i > 0 && remainingFee > 0; ) {
                Refund storage refund = account.refunds[i - 1];
                if (refund.processed) {
                    unchecked { --i; }
                    continue;
                }

                if (refund.amount <= remainingFee) {
                    remainingFee -= refund.amount;
                    refund.amount = 0;
                    refund.processed = true;
                } else {
                    refund.amount -= remainingFee;
                    remainingFee = 0;
                    unchecked { --i; }
                    break;
                }
                unchecked { --i; }
            }

            // Write back updated pendingRefund
            account.pendingRefund = pendingRefund;
        }

        // Update balance and emit event with cached values
        accountBalance -= amount;
        account.balance = accountBalance;
        $.ledger.spendFund(account.user, amount);
        emit BalanceUpdated(account.user, msg.sender, accountBalance, pendingRefund);

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
