// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0 <0.9.0;

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
    bytes32 private constant FINETUNING_SERVING_STORAGE_LOCATION = 0x5dcaaa00d1d3fae8cd5d66aceca789aec54970049ac35cb62a7adefca50a6800;
    
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
    error InvalidVerifierInput(string reason);

    function initialize(
        uint _locktime,
        address _ledgerAddress,
        address owner,
        uint _penaltyPercentage
    ) public onlyInitializeOnce {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        require(
            _ledgerAddress != address(0) && _ledgerAddress.code.length > 0,
            "Invalid ledger address"
        );
        require(_penaltyPercentage <= 100, "penaltyPercentage > 100");
        require(_locktime <= 365 days, "lockTime too large");        
        _transferOwnership(owner);
        require(
            _locktime >= MIN_LOCKTIME && _locktime <= MAX_LOCKTIME,
            "lockTime out of range"
        );
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

    function updateLockTime(uint _locktime) public onlyOwner {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        require(_locktime <= 365 days, "lockTime too large");
        require(
            _locktime >= MIN_LOCKTIME && _locktime <= MAX_LOCKTIME,
            "lockTime out of range"
        );
        $.lockTime = _locktime;
    }

    function updatePenaltyPercentage(uint _penaltyPercentage) public onlyOwner {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        require(_penaltyPercentage <= 100, "penaltyPercentage > 100");
        $.penaltyPercentage = _penaltyPercentage;
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
        require(limit == 0 || limit <= 50, "Limit too large");
        return $.accountMap.getAllAccounts(offset, (limit == 0 ? 50 : limit));
    }

    function getAccountsByProvider(
        address provider,
        uint offset,
        uint limit
    ) public view returns (AccountSummary[] memory accounts, uint total) {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        require(limit == 0 || limit <= 50, "Limit too large");
        return $.accountMap.getAccountsByProvider(
            provider,
            offset,
            (limit == 0 ? 50 : limit)
        );
    }

    function getAccountsByUser(
        address user,
        uint offset,
        uint limit
    ) public view returns (AccountSummary[] memory accounts, uint total) {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        require(limit == 0 || limit <= 50, "Limit too large");
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
        $.accountMap.deleteAccount(user, provider);
    }

    function depositFund(address user, address provider, uint cancelRetrievingAmount) external payable onlyLedger {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        (uint balance, uint pendingRefund) = $.accountMap.depositFund(user, provider, cancelRetrievingAmount, msg.value);
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
        (bool success, ) = payable(msg.sender).call{value: totalAmount}("");
        require(success, "transfer to ledger failed");
        emit BalanceUpdated(user, provider, balance, pendingRefund);
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

    function settleFees(VerifierInput calldata verifierInput) external {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        Account storage account = $.accountMap.getAccount(verifierInput.user, msg.sender);

        // Group all validation checks together for gas efficiency
        if (account.providerSigner != verifierInput.providerSigner) {
            revert InvalidVerifierInput("provider signing address is not acknowledged");
        }
        if (account.nonce >= verifierInput.nonce) {
            revert InvalidVerifierInput("nonce should larger than the current nonce");
        }
        if (account.balance < verifierInput.taskFee) {
            revert InvalidVerifierInput("insufficient balance");
        }

        // Validate deliverable exists
        if (bytes(account.deliverables[verifierInput.id].id).length == 0) {
            revert("Deliverable does not exist");
        }
        Deliverable storage deliverable = account.deliverables[verifierInput.id];
        if (keccak256(deliverable.modelRootHash) != keccak256(verifierInput.modelRootHash)) {
            revert InvalidVerifierInput("model root hash mismatch");
        }

        // Verify TEE signature
        bool teePassed = verifierInput.verifySignature(account.providerSigner);
        if (!teePassed) {
            revert InvalidVerifierInput("TEE settlement validation failed");
        }

        uint fee = verifierInput.taskFee;
        if (deliverable.acknowledged) {
            require(verifierInput.encryptedSecret.length != 0, "secret should not be empty");
            deliverable.encryptedSecret = verifierInput.encryptedSecret;
        } else {
            require(verifierInput.encryptedSecret.length == 0, "secret should be empty");
            fee = (fee * $.penaltyPercentage) / 100;
        }

        account.nonce = verifierInput.nonce;
        _settleFees(account, fee);
    }

    function _settleFees(Account storage account, uint amount) private {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        uint availableBalance = account.balance - account.pendingRefund;

        if (amount > availableBalance) {
            uint remainingFee = amount - availableBalance;
            if (account.pendingRefund < remainingFee) {
                revert InvalidVerifierInput("insufficient balance in pendingRefund");
            }

            account.pendingRefund -= remainingFee;

            // Optimized: Process from the end with early exit
            uint refundsLength = account.refunds.length;
            for (uint i = refundsLength; i > 0 && remainingFee > 0; i--) {
                Refund storage refund = account.refunds[i - 1];
                if (refund.processed) {
                    continue;
                }

                if (refund.amount <= remainingFee) {
                    remainingFee -= refund.amount;
                    refund.amount = 0;
                    refund.processed = true;
                } else {
                    refund.amount -= remainingFee;
                    remainingFee = 0;
                    break;
                }
            }
        }

        account.balance -= amount;
        $.ledger.spendFund(account.user, amount);
        emit BalanceUpdated(account.user, msg.sender, account.balance, account.pendingRefund);
        payable(msg.sender).transfer(amount);
    }

    // === ERC165 Support ===
    
    function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
        return
            interfaceId == type(IServing).interfaceId ||
            super.supportsInterface(interfaceId);
    }

    receive() external payable {
        revert("Direct deposits disabled; use LedgerManager");
    }
}
