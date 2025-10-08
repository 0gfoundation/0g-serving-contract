// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0 <0.9.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
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
    SUCCESS,              // 0: Full settlement success
    PARTIAL,              // 1: Partial settlement (insufficient balance)
    PROVIDER_MISMATCH,    // 2: Provider mismatch
    NO_TEE_SIGNER,        // 3: TEE signer not acknowledged
    INVALID_NONCE,        // 4: Invalid or duplicate nonce
    INVALID_SIGNATURE     // 5: Signature verification failed
}

contract InferenceServing is Ownable, Initializable, ReentrancyGuard, IServing {
    using AccountLibrary for AccountLibrary.AccountMap;
    using ServiceLibrary for ServiceLibrary.ServiceMap;

    uint public lockTime;
    address public ledgerAddress;
    ILedger private ledger;
    AccountLibrary.AccountMap private accountMap;
    ServiceLibrary.ServiceMap private serviceMap;

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
    error InvalidTEESignature(string reason);

    function initialize(uint _locktime, address _ledgerAddress, address owner) public onlyInitializeOnce {
        _transferOwnership(owner);
        lockTime = _locktime;
        ledgerAddress = _ledgerAddress;
        ledger = ILedger(ledgerAddress);
    }

    modifier onlyLedger() {
        require(msg.sender == ledgerAddress, "Caller is not the ledger contract");
        _;
    }

    function updateLockTime(uint _locktime) public onlyOwner {
        lockTime = _locktime;
    }

    function getAccount(address user, address provider) public view returns (Account memory) {
        return accountMap.getAccount(user, provider);
    }

    function getAllAccounts(uint offset, uint limit) public view returns (Account[] memory accounts, uint total) {
        require(limit == 0 || limit <= 50, "Limit too large");
        return accountMap.getAllAccounts(offset, limit);
    }

    function getAccountsByProvider(
        address provider,
        uint offset,
        uint limit
    ) public view returns (Account[] memory accounts, uint total) {
        require(limit == 0 || limit <= 50, "Limit too large");
        return accountMap.getAccountsByProvider(provider, offset, limit);
    }

    function getAccountsByUser(
        address user,
        uint offset,
        uint limit
    ) public view returns (Account[] memory accounts, uint total) {
        require(limit == 0 || limit <= 50, "Limit too large");
        return accountMap.getAccountsByUser(user, offset, limit);
    }

    function getBatchAccountsByUsers(address[] calldata users) external view returns (Account[] memory accounts) {
        return accountMap.getBatchAccountsByUsers(users, msg.sender);
    }

    function acknowledgeProviderSigner(address provider, uint[2] calldata providerPubKey) external {
        accountMap.acknowledgeProviderSigner(msg.sender, provider, providerPubKey);
    }

    function acknowledgeTEESigner(address provider, address teeSignerAddress) external {
        accountMap.acknowledgeTEESigner(msg.sender, provider, teeSignerAddress);
    }

    function accountExists(address user, address provider) public view returns (bool) {
        return accountMap.accountExists(user, provider);
    }

    function getPendingRefund(address user, address provider) public view returns (uint) {
        return accountMap.getPendingRefund(user, provider);
    }

    function addAccount(
        address user,
        address provider,
        uint[2] calldata signer,
        string memory additionalInfo
    ) external payable onlyLedger {
        (uint balance, uint pendingRefund) = accountMap.addAccount(user, provider, signer, msg.value, additionalInfo);
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
        Account memory account = accountMap.getAccount(user, provider);
        if (account.refunds.length > 0) {
            emit RefundRequested(user, provider, account.refunds.length - 1, block.timestamp);
        }
    }

    function processRefund(
        address user,
        address provider
    ) external onlyLedger returns (uint totalAmount, uint balance, uint pendingRefund) {
        (totalAmount, balance, pendingRefund) = accountMap.processRefund(user, provider, lockTime);

        if (totalAmount > 0) {
            payable(msg.sender).transfer(totalAmount);
            emit BalanceUpdated(user, provider, balance, pendingRefund);
        }
    }

    function getService(address provider) public view returns (Service memory service) {
        service = serviceMap.getService(provider);
    }

    function getAllServices() public view returns (Service[] memory services) {
        services = serviceMap.getAllServices();
    }

    function addOrUpdateService(ServiceParams calldata params) external {
        serviceMap.addOrUpdateService(msg.sender, params);
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

    function removeService() external {
        serviceMap.removeService(msg.sender);
        emit ServiceRemoved(msg.sender);
    }

    function _settleFees(Account storage account, uint amount) private {
        if (amount > (account.balance - account.pendingRefund)) {
            uint remainingFee = amount - (account.balance - account.pendingRefund);
            account.pendingRefund -= remainingFee;
            for (int i = int(account.refunds.length - 1); i >= 0; i--) {
                Refund storage refund = account.refunds[uint(i)];
                if (refund.processed) {
                    continue;
                }

                if (refund.amount <= remainingFee) {
                    remainingFee -= refund.amount;
                } else {
                    refund.amount -= remainingFee;
                    remainingFee = 0;
                }

                if (remainingFee == 0) {
                    break;
                }
            }
        }
        account.balance -= amount;
        ledger.spendFund(account.user, amount);
        emit BalanceUpdated(account.user, msg.sender, account.balance, account.pendingRefund);
    }

    // Static view function for previewing settlement results without state changes
    function previewSettlementResults(
        TEESettlementData[] calldata settlements
    ) external view returns (
        address[] memory failedUsers,
        SettlementStatus[] memory failureReasons,
        address[] memory partialUsers, 
        uint256[] memory partialAmounts
    ) {
        require(settlements.length > 0, "No settlements provided");

        failedUsers = new address[](settlements.length);
        failureReasons = new SettlementStatus[](settlements.length);
        partialUsers = new address[](settlements.length);
        partialAmounts = new uint256[](settlements.length);
        
        uint failedCount = 0;
        uint partialCount = 0;

        for (uint i = 0; i < settlements.length; i++) {
            TEESettlementData calldata settlement = settlements[i];
            
            if (settlement.provider != msg.sender) {
                _recordFailure(failedUsers, failureReasons, failedCount++, settlement.user, SettlementStatus.PROVIDER_MISMATCH);
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

    function settleFeesWithTEE(
        TEESettlementData[] calldata settlements
    ) external nonReentrant returns (
        address[] memory failedUsers,
        SettlementStatus[] memory failureReasons,
        address[] memory partialUsers, 
        uint256[] memory partialAmounts
    ) {
        require(settlements.length > 0, "No settlements provided");

        failedUsers = new address[](settlements.length);
        failureReasons = new SettlementStatus[](settlements.length);
        partialUsers = new address[](settlements.length);
        partialAmounts = new uint256[](settlements.length);
        
        uint failedCount = 0;
        uint partialCount = 0;
        uint256 totalTransferAmount = 0;

        for (uint i = 0; i < settlements.length; i++) {
            TEESettlementData calldata settlement = settlements[i];
            
            if (settlement.provider != msg.sender) {
                _recordFailure(failedUsers, failureReasons, failedCount++, settlement.user, SettlementStatus.PROVIDER_MISMATCH);
                emit TEESettlementResult(settlement.user, SettlementStatus.PROVIDER_MISMATCH, settlement.totalFee);
                continue;
            }
            
            (SettlementStatus status, uint256 unsettledAmount, uint256 settledAmount) = _processTEESettlement(settlement);
            totalTransferAmount += settledAmount;
            emit TEESettlementResult(settlement.user, status, unsettledAmount);
            
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

        // Batch transfer all settled amounts at once
        if (totalTransferAmount > 0) {
            payable(msg.sender).transfer(totalTransferAmount);
        }
    }

    // View function to preview settlement without state changes
    function _previewTEESettlement(TEESettlementData calldata settlement) private view returns (SettlementStatus status, uint256 unsettledAmount) {
        Account storage account = accountMap.getAccount(settlement.user, msg.sender);

        // Validate TEE signer
        if (account.teeSignerAddress == address(0)) {
            return (SettlementStatus.NO_TEE_SIGNER, settlement.totalFee);
        }

        // Validate nonce (check if nonce would be valid)
        if (account.nonce >= settlement.nonce) {
            return (SettlementStatus.INVALID_NONCE, settlement.totalFee);
        }

        // Validate signature
        if (!_verifySignature(settlement, account.teeSignerAddress)) {
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

    function _processTEESettlement(TEESettlementData calldata settlement) private returns (SettlementStatus status, uint256 unsettledAmount, uint256 settledAmount) {
        Account storage account = accountMap.getAccount(settlement.user, msg.sender);

        // Validate TEE signer
        if (account.teeSignerAddress == address(0)) {
            return (SettlementStatus.NO_TEE_SIGNER, settlement.totalFee, 0);
        }

        // Validate nonce
        if (account.nonce >= settlement.nonce) {
            return (SettlementStatus.INVALID_NONCE, settlement.totalFee, 0);
        }

        // Validate signature
        if (!_verifySignature(settlement, account.teeSignerAddress)) {
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

    function _verifySignature(TEESettlementData calldata settlement, address expectedSigner) private pure returns (bool) {
        bytes calldata signature = settlement.signature;
        if (signature.length != 65) return false;
        
        bytes32 messageHash = keccak256(abi.encodePacked(
            settlement.requestsHash,
            settlement.nonce,
            settlement.provider,
            settlement.user,
            settlement.totalFee
        ));
        
        bytes32 ethSignedHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
        
        bytes32 r;
        bytes32 s;
        uint8 v;
        
        assembly {
            r := calldataload(add(signature.offset, 0))
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        
        if (v < 27) v += 27;
        
        return ecrecover(ethSignedHash, v, r, s) == expectedSigner;
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

}
