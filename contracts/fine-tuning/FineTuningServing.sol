// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0 <0.9.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "../utils/Initializable.sol";
import "./FineTuningAccount.sol";

using AccountLibrary for AccountLibrary.AccountMap;
import "./FineTuningService.sol";
import "./FineTuningVerifier.sol";
import "../ledger/LedgerManager.sol";

interface ISignatureVerifier {
    function verifySignature(
        string memory message,
        bytes memory signature,
        address expectedAddress
    ) external view returns (bool);
}

contract FineTuningServing is Ownable, Initializable, ReentrancyGuard, IServing {
    using AccountLibrary for AccountLibrary.AccountMap;
    using ServiceLibrary for ServiceLibrary.ServiceMap;
    using VerifierLibrary for VerifierInput;

    uint public lockTime;
    address public ledgerAddress;
    ILedger private ledger;
    AccountLibrary.AccountMap private accountMap;
    ServiceLibrary.ServiceMap private serviceMap;
    uint public penaltyPercentage;

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
        _transferOwnership(owner);
        lockTime = _locktime;
        ledgerAddress = _ledgerAddress;
        ledger = ILedger(ledgerAddress);
        penaltyPercentage = _penaltyPercentage;
    }

    modifier onlyLedger() {
        require(msg.sender == ledgerAddress, "Caller is not the ledger contract");
        _;
    }

    function updateLockTime(uint _locktime) public onlyOwner {
        lockTime = _locktime;
    }

    function updatePenaltyPercentage(uint _penaltyPercentage) public onlyOwner {
        penaltyPercentage = _penaltyPercentage;
    }

    // user functions

    function getAccount(address user, address provider) public view returns (AccountDetails memory) {
        return accountMap.getAccountDetails(user, provider);
    }

    function getAllAccounts(
        uint offset,
        uint limit
    ) public view returns (AccountSummary[] memory accounts, uint total) {
        require(limit == 0 || limit <= 50, "Limit too large");
        return accountMap.getAllAccounts(offset, limit);
    }

    function getAccountsByProvider(
        address provider,
        uint offset,
        uint limit
    ) public view returns (AccountSummary[] memory accounts, uint total) {
        require(limit == 0 || limit <= 50, "Limit too large");
        return accountMap.getAccountsByProvider(provider, offset, limit);
    }

    function getAccountsByUser(
        address user,
        uint offset,
        uint limit
    ) public view returns (AccountSummary[] memory accounts, uint total) {
        require(limit == 0 || limit <= 50, "Limit too large");
        return accountMap.getAccountsByUser(user, offset, limit);
    }

    function getBatchAccountsByUsers(
        address[] calldata users
    ) external view returns (AccountSummary[] memory accounts) {
        return accountMap.getBatchAccountsByUsers(users, msg.sender);
    }

    function accountExists(address user, address provider) public view returns (bool) {
        return accountMap.accountExists(user, provider);
    }

    function getPendingRefund(address user, address provider) public view returns (uint) {
        return accountMap.getPendingRefund(user, provider);
    }

    function addAccount(address user, address provider, string memory additionalInfo) external payable onlyLedger {
        (uint balance, uint pendingRefund) = accountMap.addAccount(user, provider, msg.value, additionalInfo);
        emit BalanceUpdated(user, provider, balance, pendingRefund);
    }

    function deleteAccount(address user, address provider) external onlyLedger {
        accountMap.deleteAccount(user, provider);
    }

    function depositFund(address user, address provider, uint cancelRetrievingAmount) external payable onlyLedger {
        (uint balance, uint pendingRefund) = accountMap.depositFund(user, provider, cancelRetrievingAmount, msg.value);
        emit BalanceUpdated(user, provider, balance, pendingRefund);
    }

    function requestRefundAll(address user, address provider) external onlyLedger {
        accountMap.requestRefundAll(user, provider);
    }

    function processRefund(
        address user,
        address provider
    ) external onlyLedger returns (uint totalAmount, uint balance, uint pendingRefund) {
        (totalAmount, balance, pendingRefund) = accountMap.processRefund(user, provider, lockTime);
        if (totalAmount == 0) {
            return (0, balance, pendingRefund);
        }
        payable(msg.sender).transfer(totalAmount);
        emit BalanceUpdated(user, provider, balance, pendingRefund);
    }

    function getService(address provider) public view returns (Service memory service) {
        service = serviceMap.getService(provider);
    }

    function getAllServices() public view returns (Service[] memory services) {
        services = serviceMap.getAllServices();
    }

    function acknowledgeProviderSigner(address provider, address providerSigner) external {
        accountMap.acknowledgeProviderSigner(msg.sender, provider, providerSigner);
    }

    function acknowledgeDeliverable(address provider, string calldata id) external {
        accountMap.acknowledgeDeliverable(msg.sender, provider, id);
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
        serviceMap.addOrUpdateService(msg.sender, url, quota, pricePerToken, providerSigner, occupied, models);
        emit ServiceUpdated(msg.sender, url, quota, pricePerToken, providerSigner, occupied);
    }

    function removeService() external {
        serviceMap.removeService(msg.sender);
        emit ServiceRemoved(msg.sender);
    }

    function addDeliverable(address user, string calldata id, bytes memory modelRootHash) external {
        accountMap.addDeliverable(user, msg.sender, id, modelRootHash);
    }

    function getDeliverable(
        address user,
        address provider,
        string calldata id
    ) public view returns (Deliverable memory) {
        return accountMap.getDeliverable(user, provider, id);
    }

    function getDeliverables(address user, address provider) public view returns (Deliverable[] memory) {
        return accountMap.getDeliverables(user, provider);
    }

    function settleFees(VerifierInput calldata verifierInput) external nonReentrant {
        Account storage account = accountMap.getAccount(verifierInput.user, msg.sender);

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
            fee = (fee * penaltyPercentage) / 100;
        }

        account.nonce = verifierInput.nonce;
        _settleFees(account, fee);
    }

    function _settleFees(Account storage account, uint amount) private {
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
        ledger.spendFund(account.user, amount);
        emit BalanceUpdated(account.user, msg.sender, account.balance, account.pendingRefund);
        payable(msg.sender).transfer(amount);
    }
}
