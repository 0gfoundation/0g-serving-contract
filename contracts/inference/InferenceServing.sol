// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0 <0.9.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165.sol";
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

contract InferenceServing is Ownable, Initializable, ReentrancyGuard, IServing, ERC165 {
    using AccountLibrary for AccountLibrary.AccountMap;
    using ServiceLibrary for ServiceLibrary.ServiceMap;

    // @custom:storage-location erc7201:0g.serving.inference.v1.0
    struct InferenceServingStorage {
        uint lockTime;
        address ledgerAddress;
        ILedger ledger;
        AccountLibrary.AccountMap accountMap;
        ServiceLibrary.ServiceMap serviceMap;
        mapping(address => uint) providerStake; // Service provider stake amounts
    }

    // keccak256(abi.encode(uint256(keccak256("0g.serving.inference.v1.0")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant INFERENCE_SERVING_STORAGE_LOCATION = 0xdfd123095cdedb1cecbc229b30f7cf8745fb3d3951645ac4a8fa4c0895f89500;
    
    // Enforce sane lockTime to avoid instant bypass (0) or excessive freeze (> 7 days)
    uint public constant MIN_LOCKTIME = 1 hours;
    uint public constant MAX_LOCKTIME = 7 days;

    // Service provider stake requirement
    uint public constant MIN_PROVIDER_STAKE = 100 ether; // 100 0G minimum stake

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
        return $.ledgerAddress;
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
    error InvalidTEESignature(string reason);

    function initialize(uint _locktime, address _ledgerAddress, address owner) public onlyInitializeOnce {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        _transferOwnership(owner);
        require(
            _locktime >= MIN_LOCKTIME && _locktime <= MAX_LOCKTIME,
            "lockTime out of range"
        );
        $.lockTime = _locktime;
        $.ledgerAddress = _ledgerAddress;
        $.ledger = ILedger(_ledgerAddress);
    }

    modifier onlyLedger() {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        require(msg.sender == $.ledgerAddress, "Caller is not the ledger contract");
        _;
    }

    function updateLockTime(uint _locktime) public onlyOwner {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        require(
            _locktime >= MIN_LOCKTIME && _locktime <= MAX_LOCKTIME,
            "lockTime out of range"
        );
        $.lockTime = _locktime;
    }

    function getAccount(address user, address provider) public view returns (Account memory) {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        return $.accountMap.getAccount(user, provider);
    }

    function getAllAccounts(uint offset, uint limit) public view returns (Account[] memory accounts, uint total) {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        require(limit == 0 || limit <= 50, "Limit too large");
        return $.accountMap.getAllAccounts(offset, (limit == 0 ? 50 : limit));
    }

    function getAccountsByProvider(
        address provider,
        uint offset,
        uint limit
    ) public view returns (Account[] memory accounts, uint total) {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        require(limit == 0 || limit <= 50, "Limit too large");
        return $.accountMap.getAccountsByProvider(provider, offset, (limit == 0 ? 50 : limit));
    }

    function getAccountsByUser(
        address user,
        uint offset,
        uint limit
    ) public view returns (Account[] memory accounts, uint total) {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        require(limit == 0 || limit <= 50, "Limit too large");
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

    function accountExists(address user, address provider) public view returns (bool) {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        return $.accountMap.accountExists(user, provider);
    }

    function getPendingRefund(address user, address provider) public view returns (uint) {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        return $.accountMap.getPendingRefund(user, provider);
    }

    function addAccount(
        address user,
        address provider,
        string memory additionalInfo
    ) external payable onlyLedger {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        (uint balance, uint pendingRefund) = $.accountMap.addAccount(user, provider, msg.value, additionalInfo);

        // Auto-acknowledge TEE signer when user transfers funds to provider
        $.accountMap.acknowledgeTEESigner(user, provider, true);

        emit BalanceUpdated(user, provider, balance, pendingRefund);
    }

    function deleteAccount(address user, address provider) external onlyLedger {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        $.accountMap.deleteAccount(user, provider);
    }

    function depositFund(address user, address provider, uint cancelRetrievingAmount) external payable onlyLedger {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        (uint balance, uint pendingRefund) = $.accountMap.depositFund(user, provider, cancelRetrievingAmount, msg.value);

        // Auto-acknowledge TEE signer when user deposits funds to provider (if not already acknowledged)
        Account storage account = $.accountMap.getAccount(user, provider);
        if (!account.acknowledged) {
            $.accountMap.acknowledgeTEESigner(user, provider, true);
        }

        emit BalanceUpdated(user, provider, balance, pendingRefund);
    }

    function requestRefundAll(address user, address provider) external onlyLedger {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        $.accountMap.requestRefundAll(user, provider);
        Account memory account = $.accountMap.getAccount(user, provider);
        if (account.refunds.length > 0) {
            emit RefundRequested(user, provider, account.refunds.length - 1, block.timestamp);
        }
    }

    function processRefund(
        address user,
        address provider
    ) external onlyLedger returns (uint totalAmount, uint balance, uint pendingRefund) {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        (totalAmount, balance, pendingRefund) = $.accountMap.processRefund(user, provider, $.lockTime);

        if (totalAmount > 0) {
            (bool success, ) = payable(msg.sender).call{value: totalAmount}("");
            require(success, "transfer to ledger failed");
            emit BalanceUpdated(user, provider, balance, pendingRefund);
        }
    }

    function getService(address provider) public view returns (Service memory service) {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        service = $.serviceMap.getService(provider);
    }

    function getAllServices(uint offset, uint limit) public view returns (Service[] memory services, uint total) {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        require(limit == 0 || limit <= 50, "Limit too large");
        return $.serviceMap.getAllServices(offset, (limit == 0 ? 50 : limit));
    }

    function addOrUpdateService(ServiceParams calldata params) external payable {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        if ($.providerStake[msg.sender] > 0) {
            // Updating existing service: cannot add more stake
            require(msg.value == 0, "Cannot add more stake when updating service");
        } else {
            // First time registration: require stake
            require(msg.value >= MIN_PROVIDER_STAKE, "Minimum stake of 100 0G required");
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

            (bool success, ) = payable(msg.sender).call{value: stake}("");
            require(success, "Stake return failed");

            emit ProviderStakeReturned(msg.sender, stake);
        }

        emit ServiceRemoved(msg.sender);
    }

    function _settleFees(Account storage account, uint amount) private {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
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
                    refund.amount = 0;           // Clear consumed amount
                    refund.processed = true;     // Mark as processed to prevent double-counting
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
        $.ledger.spendFund(account.user, amount);
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
    ) external returns (
        address[] memory failedUsers,
        SettlementStatus[] memory failureReasons,
        address[] memory partialUsers, 
        uint256[] memory partialAmounts
    ) {
        require(settlements.length > 0, "No settlements provided");
        require(settlements.length <= 50, "Too many settlements in batch");

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
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        Account storage account = $.accountMap.getAccount(settlement.user, msg.sender);

        // Validate TEE signer acknowledgement - both user and service must be acknowledged, and service must have valid TEE signer address
        Service storage service = $.serviceMap.getService(msg.sender);
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

    function _processTEESettlement(TEESettlementData calldata settlement) private returns (SettlementStatus status, uint256 unsettledAmount, uint256 settledAmount) {
        InferenceServingStorage storage $ = _getInferenceServingStorage();
        Account storage account = $.accountMap.getAccount(settlement.user, msg.sender);

        // Validate TEE signer acknowledgement - both user and service must be acknowledged, and service must have valid TEE signer address
        Service storage service = $.serviceMap.getService(msg.sender);
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
