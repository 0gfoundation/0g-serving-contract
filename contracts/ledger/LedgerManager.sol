// SPDX-License-Identifier: Unlicense
pragma solidity >=0.8.0 <0.9.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "../utils/Initializable.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

struct Ledger {
    address user;
    uint availableBalance;
    uint totalBalance;
    uint[2] inferenceSigner;
    string additionalInfo;
    address[] inferenceProviders;
    address[] fineTuningProviders;
}

interface ILedger {
    function spendFund(address user, uint amount) external;
}

interface IServing {
    function accountExists(address user, address provider) external view returns (bool);

    function getPendingRefund(address user, address provider) external view returns (uint);

    function depositFund(address user, address provider, uint cancelRetrievingAmount) external payable;

    function requestRefundAll(address user, address provider) external;

    function processRefund(
        address user,
        address provider
    ) external returns (uint totalAmount, uint balance, uint pendingRefund);

    function deleteAccount(address user, address provider) external;
}

contract LedgerManager is Ownable, Initializable, ReentrancyGuard {
    using EnumerableSet for EnumerableSet.Bytes32Set;
    using EnumerableSet for EnumerableSet.AddressSet;

    address payable public inferenceAddress;
    address payable public fineTuningAddress;
    LedgerMap private ledgerMap;
    mapping(address => EnumerableSet.AddressSet) private userInferenceProviders;
    mapping(address => EnumerableSet.AddressSet) private userFineTuningProviders;
    IServing private fineTuningAccount;
    IServing private inferenceAccount;

    // Constants
    uint public constant MAX_PROVIDERS_PER_BATCH = 20;

    // Errors
    error LedgerNotExists(address user);
    error LedgerExists(address user);
    error InsufficientBalance(address user);
    error TooManyProviders(uint requested, uint maximum);
    error InvalidServiceType(string serviceType);

    struct LedgerMap {
        EnumerableSet.Bytes32Set _keys;
        mapping(bytes32 => Ledger) _values;
        // Operation locks to prevent reentrancy
        mapping(bytes32 => bool) _operationLocks;
    }

    // Prevent reentrancy on ledger operations
    modifier withLedgerLock(address user) {
        bytes32 key = _key(user);
        require(!ledgerMap._operationLocks[key], "Ledger locked for operation");
        ledgerMap._operationLocks[key] = true;
        _;
        ledgerMap._operationLocks[key] = false;
    }

    function initialize(
        address _inferenceAddress,
        address _fineTuningAddress,
        address owner
    ) public onlyInitializeOnce {
        _transferOwnership(owner);

        inferenceAddress = payable(_inferenceAddress);
        fineTuningAddress = payable(_fineTuningAddress);
        fineTuningAccount = IServing(fineTuningAddress);
        inferenceAccount = IServing(inferenceAddress);
    }

    modifier onlyServing() {
        require(
            msg.sender == fineTuningAddress || msg.sender == inferenceAddress,
            "Caller is not the fine tuning or inference contract"
        );
        _;
    }

    function getLedger(address user) public view returns (Ledger memory) {
        return _get(user);
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

    function addLedger(
        uint[2] calldata inferenceSigner,
        string memory additionalInfo
    ) external payable withLedgerLock(msg.sender) returns (uint, uint) {
        bytes32 key = _key(msg.sender);
        if (_contains(key)) {
            revert LedgerExists(msg.sender);
        }
        _set(key, msg.sender, inferenceSigner, msg.value, additionalInfo);
        return (msg.value, 0);
    }

    function depositFund() external payable withLedgerLock(msg.sender) {
        Ledger storage ledger = _get(msg.sender);
        ledger.availableBalance += msg.value;
        ledger.totalBalance += msg.value;
    }

    function refund(uint amount) external withLedgerLock(msg.sender) {
        Ledger storage ledger = _get(msg.sender);
        if (ledger.availableBalance < amount) {
            revert InsufficientBalance(msg.sender);
        }

        ledger.availableBalance -= amount;
        ledger.totalBalance -= amount;
        payable(msg.sender).transfer(amount);
    }

    function transferFund(
        address provider,
        string memory serviceTypeStr,
        uint amount
    ) external withLedgerLock(msg.sender) {
        Ledger storage ledger = _get(msg.sender);
        (address servingAddress, IServing serving, bool isInference) = _getServiceDetails(serviceTypeStr);

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
            // New account
            if (isInference) {
                payload = abi.encodeWithSignature(
                    "addAccount(address,address,uint256[2],string)",
                    msg.sender,
                    provider,
                    ledger.inferenceSigner,
                    ledger.additionalInfo
                );
            } else {
                payload = abi.encodeWithSignature(
                    "addAccount(address,address,string)",
                    msg.sender,
                    provider,
                    ledger.additionalInfo
                );
            }
            // Add provider to optimized storage
            _addProvider(msg.sender, provider, isInference);
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
        if (providers.length > MAX_PROVIDERS_PER_BATCH) {
            revert TooManyProviders(providers.length, MAX_PROVIDERS_PER_BATCH);
        }

        (, IServing serving, ) = _getServiceDetails(serviceType);
        Ledger storage ledger = _get(msg.sender);
        uint totalAmount = 0;

        for (uint i = 0; i < providers.length; i++) {
            (uint amount, , ) = serving.processRefund(msg.sender, providers[i]);
            totalAmount += amount;
            serving.requestRefundAll(msg.sender, providers[i]);
        }
        ledger.availableBalance += totalAmount;
    }

    function deleteLedger() external nonReentrant withLedgerLock(msg.sender) {
        bytes32 key = _key(msg.sender);

        // Delete all inference accounts
        EnumerableSet.AddressSet storage inferenceProvs = userInferenceProviders[msg.sender];
        address[] memory inferenceList = new address[](inferenceProvs.length());
        for (uint i = 0; i < inferenceProvs.length(); i++) {
            inferenceList[i] = inferenceProvs.at(i);
        }
        for (uint i = 0; i < inferenceList.length; i++) {
            try inferenceAccount.deleteAccount(msg.sender, inferenceList[i]) {
                inferenceProvs.remove(inferenceList[i]);
            } catch {
                inferenceProvs.remove(inferenceList[i]); // Remove even on failure
            }
        }

        // Delete all fine-tuning accounts
        EnumerableSet.AddressSet storage finetuningProvs = userFineTuningProviders[msg.sender];
        address[] memory finetuningList = new address[](finetuningProvs.length());
        for (uint i = 0; i < finetuningProvs.length(); i++) {
            finetuningList[i] = finetuningProvs.at(i);
        }
        for (uint i = 0; i < finetuningList.length; i++) {
            try fineTuningAccount.deleteAccount(msg.sender, finetuningList[i]) {
                finetuningProvs.remove(finetuningList[i]);
            } catch {
                finetuningProvs.remove(finetuningList[i]); // Remove even on failure
            }
        }

        // Clear legacy arrays
        Ledger storage ledger = _get(msg.sender);
        delete ledger.inferenceProviders;
        delete ledger.fineTuningProviders;

        // Delete main ledger
        ledgerMap._keys.remove(key);
        delete ledgerMap._values[key];
    }

    function _addProvider(address user, address provider, bool isInference) private {
        EnumerableSet.AddressSet storage providers = isInference
            ? userInferenceProviders[user]
            : userFineTuningProviders[user];

        // Only add if not already exists
        if (!providers.contains(provider)) {
            providers.add(provider);

            // Also update legacy array for backwards compatibility
            Ledger storage ledger = _get(user);
            if (isInference) {
                ledger.inferenceProviders.push(provider);
            } else {
                ledger.fineTuningProviders.push(provider);
            }
        }
    }

    function _getServiceDetails(string memory serviceType) private view returns (address, IServing, bool) {
        bytes32 serviceTypeHash = keccak256(abi.encodePacked(serviceType));

        if (serviceTypeHash == keccak256("inference")) {
            return (inferenceAddress, inferenceAccount, true);
        } else if (serviceTypeHash == keccak256("fine-tuning")) {
            return (fineTuningAddress, fineTuningAccount, false);
        } else {
            revert InvalidServiceType(serviceType);
        }
    }

    function spendFund(address user, uint amount) external onlyServing {
        Ledger storage ledger = _get(user);
        require((ledger.totalBalance - ledger.availableBalance) >= amount, "Insufficient balance");

        ledger.totalBalance -= amount;
    }

    function _at(uint index) internal view returns (Ledger storage) {
        bytes32 key = ledgerMap._keys.at(index);
        return ledgerMap._values[key];
    }

    function _contains(bytes32 key) internal view returns (bool) {
        return ledgerMap._keys.contains(key);
    }

    function _length() internal view returns (uint) {
        return ledgerMap._keys.length();
    }

    function _get(address user) internal view returns (Ledger storage) {
        bytes32 key = _key(user);
        if (!_contains(key)) {
            revert LedgerNotExists(user);
        }
        return ledgerMap._values[key];
    }

    function _set(
        bytes32 key,
        address user,
        uint[2] calldata inferenceSigner,
        uint balance,
        string memory additionalInfo
    ) internal {
        Ledger storage ledger = ledgerMap._values[key];
        ledger.availableBalance = balance;
        ledger.totalBalance = balance;
        ledger.user = user;
        ledger.inferenceSigner = inferenceSigner;
        ledger.additionalInfo = additionalInfo;
        ledgerMap._keys.add(key);
    }

    function _key(address user) internal pure returns (bytes32) {
        return keccak256(abi.encode(user));
    }

    receive() external payable {}
}
