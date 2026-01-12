// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0 <0.9.0;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EnumerableMap} from "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Initializable} from "../utils/Initializable.sol";
import "./FineTuningAccount.sol";
import {ILedger, IServing} from "../ledger/LedgerManager.sol";

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

    // EIP-712 Domain Separator (manual implementation for upgradeable contracts)
    bytes32 private constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    bytes32 private constant SETTLEMENT_TYPEHASH = keccak256(
        "FineTuningSettlement(string id,bytes encryptedSecret,bytes modelRootHash,uint256 nonce,address providerSigner,uint256 taskFee,address user)"
    );

    string private constant DOMAIN_NAME = "0G Fine-Tuning Serving";
    string private constant DOMAIN_VERSION = "1";

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
    event LockTimeUpdated(uint256 oldLockTime, uint256 newLockTime);
    event PenaltyPercentageUpdated(uint256 oldPercentage, uint256 newPercentage);
    event ContractInitialized(address indexed owner, uint256 lockTime, address ledgerAddress, uint256 penaltyPercentage);
    event AccountDeleted(address indexed user, address indexed provider);

    error InvalidVerifierInput(string reason);
    error ProviderCannotBeUser();
    error LockTimeOutOfRange(uint256 lockTime, uint256 min, uint256 max);
    error InvalidLedgerAddress(address ledgerAddress);
    error PenaltyPercentageTooHigh(uint256 percentage, uint256 max);

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

    function initialize(
        uint _locktime,
        address _ledgerAddress,
        address owner,
        uint _penaltyPercentage
    ) public onlyInitializeOnce {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        _transferOwnership(owner);

        if (_ledgerAddress == address(0) || _ledgerAddress.code.length == 0) {
            revert InvalidLedgerAddress(_ledgerAddress);
        }
        if (_penaltyPercentage > 100) {
            revert PenaltyPercentageTooHigh(_penaltyPercentage, 100);
        }
        if (_locktime < MIN_LOCKTIME || _locktime > MAX_LOCKTIME) {
            revert LockTimeOutOfRange(_locktime, MIN_LOCKTIME, MAX_LOCKTIME);
        }

        $.lockTime = _locktime;
        $.ledgerAddress = _ledgerAddress;
        $.ledger = ILedger(_ledgerAddress);
        $.penaltyPercentage = _penaltyPercentage;

        emit ContractInitialized(owner, _locktime, _ledgerAddress, _penaltyPercentage);
    }

    modifier onlyLedger() {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        require(msg.sender == $.ledgerAddress, "Caller is not the ledger contract");
        _;
    }

    function updateLockTime(uint _locktime) public onlyOwner {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        if (_locktime < MIN_LOCKTIME || _locktime > MAX_LOCKTIME) {
            revert LockTimeOutOfRange(_locktime, MIN_LOCKTIME, MAX_LOCKTIME);
        }
        uint oldLockTime = $.lockTime;
        $.lockTime = _locktime;
        emit LockTimeUpdated(oldLockTime, _locktime);
    }

    function updatePenaltyPercentage(uint _penaltyPercentage) public onlyOwner {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        if (_penaltyPercentage > 100) {
            revert PenaltyPercentageTooHigh(_penaltyPercentage, 100);
        }
        uint oldPercentage = $.penaltyPercentage;
        $.penaltyPercentage = _penaltyPercentage;
        emit PenaltyPercentageUpdated(oldPercentage, _penaltyPercentage);
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
        return $.accountMap.getAccountsByProvider(provider, offset, (limit == 0 ? 50 : limit));
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
        if (user == provider) revert ProviderCannotBeUser();
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        (uint balance, uint pendingRefund) = $.accountMap.addAccount(user, provider, msg.value, additionalInfo);
        emit BalanceUpdated(user, provider, balance, pendingRefund);
    }

    function deleteAccount(address user, address provider) external onlyLedger {
        FineTuningServingStorage storage $ = _getFineTuningServingStorage();
        $.accountMap.deleteAccount(user, provider);
        emit AccountDeleted(user, provider);
    }

    function depositFund(address user, address provider, uint cancelRetrievingAmount) external payable onlyLedger {
        if (user == provider) revert ProviderCannotBeUser();
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
            revert InvalidVerifierInput("deliverable does not exist");
        }
        Deliverable storage deliverable = account.deliverables[verifierInput.id];
        if (keccak256(deliverable.modelRootHash) != keccak256(verifierInput.modelRootHash)) {
            revert InvalidVerifierInput("model root hash mismatch");
        }

        // Verify EIP-712 signature with ECDSA.tryRecover for better security
        if (!_verifySignature(verifierInput, account.providerSigner)) {
            revert InvalidVerifierInput("EIP-712 signature verification failed");
        }

        uint fee = verifierInput.taskFee;
        if (deliverable.acknowledged) {
            if (verifierInput.encryptedSecret.length == 0) {
                revert InvalidVerifierInput("secret should not be empty when deliverable is acknowledged");
            }
            deliverable.encryptedSecret = verifierInput.encryptedSecret;
        } else {
            if (verifierInput.encryptedSecret.length != 0) {
                revert InvalidVerifierInput("secret should be empty when deliverable is not acknowledged");
            }
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

            // Process refunds from most recent to oldest (LIFO)
            uint validLength = account.validRefundsLength;

            for (uint i = validLength; i > 0 && remainingFee > 0; ) {
                unchecked { --i; }
                Refund storage refund = account.refunds[i];

                if (refund.amount <= remainingFee) {
                    // Fully consume this refund
                    remainingFee -= refund.amount;
                    refund.amount = 0;
                    --validLength;
                } else {
                    // Partially consume this refund
                    refund.amount -= remainingFee;
                    remainingFee = 0;
                }
            }

            // Update validRefundsLength (shrink boundary)
            account.validRefundsLength = validLength;

            // Recalculate pendingRefund from active refunds
            uint newPendingRefund = 0;
            for (uint i = 0; i < validLength; i++) {
                newPendingRefund += account.refunds[i].amount;
            }
            account.pendingRefund = newPendingRefund;
        }

        account.balance -= amount;

        // Emit event BEFORE external calls to prevent reentrancy-caused ordering issues
        emit BalanceUpdated(account.user, msg.sender, account.balance, account.pendingRefund);

        // External calls at the end
        $.ledger.spendFund(account.user, amount);
        payable(msg.sender).transfer(amount);
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

    /// @dev Verify EIP-712 signature for fine-tuning settlement
    /// @param input The verifier input containing all settlement data and signature
    /// @param expectedSigner The expected signer address (provider's TEE signer)
    /// @return bool True if signature is valid and matches expected signer
    function _verifySignature(
        VerifierInput calldata input,
        address expectedSigner
    ) private view returns (bool) {
        // Calculate EIP-712 structured hash
        bytes32 structHash = keccak256(
            abi.encode(
                SETTLEMENT_TYPEHASH,
                keccak256(bytes(input.id)),
                keccak256(input.encryptedSecret),
                keccak256(input.modelRootHash),
                input.nonce,
                input.providerSigner,
                input.taskFee,
                input.user
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
        (address recovered, ECDSA.RecoverError error) = ECDSA.tryRecover(digest, input.signature);

        // Return true only if recovery succeeded and address matches
        return error == ECDSA.RecoverError.NoError && recovered == expectedSigner;
    }

    // === ERC165 Support ===

    function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
        return interfaceId == type(IServing).interfaceId || super.supportsInterface(interfaceId);
    }

    receive() external payable {
        revert("Direct deposits disabled; use LedgerManager");
    }
}
