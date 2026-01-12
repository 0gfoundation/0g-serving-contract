// SPDX-License-Identifier: Unlicense
pragma solidity >=0.8.0 <0.9.0;

import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

// Constants
uint constant MAX_DELIVERABLES_PER_ACCOUNT = 20;

struct Account {
    address user;
    address provider;
    uint nonce;
    uint balance;
    uint pendingRefund;
    Refund[] refunds;
    string additionalInfo;
    address providerSigner;
    mapping(string => Deliverable) deliverables; // ID -> Deliverable mapping
    string[MAX_DELIVERABLES_PER_ACCOUNT] deliverableIds; // Circular array of IDs
    uint validRefundsLength; // Track the number of valid (non-dirty) refunds
    uint deliverablesHead; // Circular array head pointer (oldest position)
    uint deliverablesCount; // Current count of deliverables
}

struct Refund {
    uint index;
    uint amount;
    uint createdAt;
    bool processed;
}

struct Deliverable {
    string id; // Unique identifier for the deliverable
    bytes modelRootHash;
    bytes encryptedSecret;
    bool acknowledged;
    uint timestamp; // When this deliverable was added
}

struct AccountSummary {
    address user;
    address provider;
    uint nonce;
    uint balance;
    uint pendingRefund;
    string additionalInfo;
    address providerSigner;
    uint validRefundsLength;
    uint deliverablesCount;
}

struct AccountDetails {
    address user;
    address provider;
    uint nonce;
    uint balance;
    uint pendingRefund;
    Refund[] refunds;
    string additionalInfo;
    address providerSigner;
    Deliverable[] deliverables; // For backward compatibility, we'll populate this from the mapping
    uint validRefundsLength;
    uint deliverablesHead;
    uint deliverablesCount;
}

library AccountLibrary {
    using EnumerableSet for EnumerableSet.Bytes32Set;

    // Constants for optimization
    uint constant MAX_REFUNDS_PER_ACCOUNT = 5;
    uint constant MAX_ADDITIONAL_INFO_LENGTH = 4096; // 4KB limit for JSON configuration data

    error AccountNotExists(address user, address provider);
    error AccountExists(address user, address provider);
    error InsufficientBalance(address user, address provider);
    error RefundInvalid(address user, address provider, uint index);
    error RefundProcessed(address user, address provider, uint index);
    error RefundLocked(address user, address provider, uint index);
    error TooManyRefunds(address user, address provider);
    error AdditionalInfoTooLong();
    error BatchSizeTooLarge(uint256 size, uint256 max);
    error CannotRevokeWithNonZeroBalance(address user, address provider, uint256 balance);

    struct AccountMap {
        EnumerableSet.Bytes32Set _keys;
        mapping(bytes32 => Account) _values;
        mapping(address => EnumerableSet.Bytes32Set) _providerIndex;
        mapping(address => EnumerableSet.Bytes32Set) _userIndex;
    }

    // user functions

    function getAccount(
        AccountMap storage map,
        address user,
        address provider
    ) internal view returns (Account storage) {
        return _get(map, user, provider);
    }

    // Get account details for external interfaces (converts mapping to array)
    function getAccountDetails(
        AccountMap storage map,
        address user,
        address provider
    ) internal view returns (AccountDetails memory details) {
        Account storage account = _get(map, user, provider);

        // Get deliverables in chronological order
        Deliverable[] memory deliverables = getDeliverables(map, user, provider);

        details = AccountDetails({
            user: account.user,
            provider: account.provider,
            nonce: account.nonce,
            balance: account.balance,
            pendingRefund: account.pendingRefund,
            refunds: account.refunds,
            additionalInfo: account.additionalInfo,
            providerSigner: account.providerSigner,
            deliverables: deliverables,
            validRefundsLength: account.validRefundsLength,
            deliverablesHead: account.deliverablesHead,
            deliverablesCount: account.deliverablesCount
        });
    }

    function getAllAccounts(
        AccountMap storage map,
        uint offset,
        uint limit
    ) internal view returns (AccountSummary[] memory accounts, uint total) {
        total = _length(map);

        if (offset >= total) {
            return (new AccountSummary[](0), total);
        }

        uint end = limit == 0 ? total : offset + limit;
        if (end > total) {
            end = total;
        }

        uint resultLength = end - offset;
        accounts = new AccountSummary[](resultLength);

        for (uint i = 0; i < resultLength; i++) {
            Account storage fullAccount = _at(map, offset + i);
            accounts[i] = AccountSummary({
                user: fullAccount.user,
                provider: fullAccount.provider,
                nonce: fullAccount.nonce,
                balance: fullAccount.balance,
                pendingRefund: fullAccount.pendingRefund,
                additionalInfo: fullAccount.additionalInfo,
                providerSigner: fullAccount.providerSigner,
                validRefundsLength: fullAccount.validRefundsLength,
                deliverablesCount: fullAccount.deliverablesCount
            });
        }
    }

    function getAccountsByProvider(
        AccountMap storage map,
        address provider,
        uint offset,
        uint limit
    ) internal view returns (AccountSummary[] memory accounts, uint total) {
        EnumerableSet.Bytes32Set storage providerKeys = map._providerIndex[provider];
        total = providerKeys.length();

        if (offset >= total) {
            return (new AccountSummary[](0), total);
        }

        uint end = limit == 0 ? total : offset + limit;
        if (end > total) {
            end = total;
        }

        uint resultLen = end - offset;
        accounts = new AccountSummary[](resultLen);

        for (uint i = 0; i < resultLen; i++) {
            bytes32 key = providerKeys.at(offset + i);
            Account storage fullAccount = map._values[key];
            accounts[i] = AccountSummary({
                user: fullAccount.user,
                provider: fullAccount.provider,
                nonce: fullAccount.nonce,
                balance: fullAccount.balance,
                pendingRefund: fullAccount.pendingRefund,
                additionalInfo: fullAccount.additionalInfo,
                providerSigner: fullAccount.providerSigner,
                validRefundsLength: fullAccount.validRefundsLength,
                deliverablesCount: fullAccount.deliverablesCount
            });
        }

        return (accounts, total);
    }

    function getAccountsByUser(
        AccountMap storage map,
        address user,
        uint offset,
        uint limit
    ) internal view returns (AccountSummary[] memory accounts, uint total) {
        EnumerableSet.Bytes32Set storage userKeys = map._userIndex[user];
        total = userKeys.length();

        if (offset >= total) {
            return (new AccountSummary[](0), total);
        }

        uint end = limit == 0 ? total : offset + limit;
        if (end > total) {
            end = total;
        }

        uint resultLen = end - offset;
        accounts = new AccountSummary[](resultLen);

        for (uint i = 0; i < resultLen; i++) {
            bytes32 key = userKeys.at(offset + i);
            Account storage fullAccount = map._values[key];
            accounts[i] = AccountSummary({
                user: fullAccount.user,
                provider: fullAccount.provider,
                nonce: fullAccount.nonce,
                balance: fullAccount.balance,
                pendingRefund: fullAccount.pendingRefund,
                additionalInfo: fullAccount.additionalInfo,
                providerSigner: fullAccount.providerSigner,
                validRefundsLength: fullAccount.validRefundsLength,
                deliverablesCount: fullAccount.deliverablesCount
            });
        }

        return (accounts, total);
    }

    function getBatchAccountsByUsers(
        AccountMap storage map,
        address[] calldata users,
        address provider
    ) internal view returns (AccountSummary[] memory accounts) {
        if (users.length > 500) {
            revert BatchSizeTooLarge(users.length, 500);
        }
        uint usersLength = users.length;
        accounts = new AccountSummary[](usersLength);

        for (uint i = 0; i < usersLength; i++) {
            bytes32 key = _key(users[i], provider);
            if (_contains(map, key)) {
                Account storage fullAccount = map._values[key];
                accounts[i] = AccountSummary({
                    user: fullAccount.user,
                    provider: fullAccount.provider,
                    nonce: fullAccount.nonce,
                    balance: fullAccount.balance,
                    pendingRefund: fullAccount.pendingRefund,
                    additionalInfo: fullAccount.additionalInfo,
                    providerSigner: fullAccount.providerSigner,
                    validRefundsLength: fullAccount.validRefundsLength,
                    deliverablesCount: fullAccount.deliverablesCount
                });
            }
        }
    }

    function accountExists(AccountMap storage map, address user, address provider) internal view returns (bool) {
        return _contains(map, _key(user, provider));
    }

    function getPendingRefund(AccountMap storage map, address user, address provider) internal view returns (uint) {
        Account storage account = _get(map, user, provider);
        return account.pendingRefund;
    }

    function addAccount(
        AccountMap storage map,
        address user,
        address provider,
        uint amount,
        string memory additionalInfo
    ) internal returns (uint, uint) {
        if (bytes(additionalInfo).length > MAX_ADDITIONAL_INFO_LENGTH) {
            revert AdditionalInfoTooLong();
        }
        bytes32 key = _key(user, provider);
        if (_contains(map, key)) {
            revert AccountExists(user, provider);
        }

        _set(map, key, user, provider, amount, additionalInfo);

        map._providerIndex[provider].add(key);
        map._userIndex[user].add(key);

        return (amount, 0);
    }

    function deleteAccount(AccountMap storage map, address user, address provider) internal {
        bytes32 key = _key(user, provider);
        if (!_contains(map, key)) {
            return;
        }

        map._providerIndex[provider].remove(key);
        map._userIndex[user].remove(key);
        map._keys.remove(key);
        delete map._values[key];
    }

    function depositFund(
        AccountMap storage map,
        address user,
        address provider,
        uint cancelRetrievingAmount,
        uint amount
    ) internal returns (uint, uint) {
        Account storage account = _get(map, user, provider);

        if (cancelRetrievingAmount > 0 && account.validRefundsLength > 0) {
            // No need to ensure capacity here - if validRefundsLength > 0, array is already initialized
            uint remainingCancel = cancelRetrievingAmount;
            uint newPendingRefund = account.pendingRefund;

            // Use swap-and-shrink: process active refunds and compact (LIFO - most recent first)
            uint writeIndex = 0;
            for (uint i = 0; i < account.validRefundsLength; i++) {
                Refund storage refund = account.refunds[i];

                if (remainingCancel >= refund.amount) {
                    // Fully cancel this refund - skip it (don't write back)
                    remainingCancel -= refund.amount;
                    newPendingRefund -= refund.amount;
                } else if (remainingCancel > 0) {
                    // Partially cancel this refund - keep with reduced amount
                    refund.amount -= remainingCancel;
                    newPendingRefund -= remainingCancel;
                    remainingCancel = 0;
                    // Swap to writeIndex if needed
                    if (i != writeIndex) {
                        account.refunds[writeIndex] = refund;
                        account.refunds[writeIndex].index = writeIndex;
                    }
                    writeIndex++;
                } else {
                    // Keep this refund unchanged
                    if (i != writeIndex) {
                        account.refunds[writeIndex] = refund;
                        account.refunds[writeIndex].index = writeIndex;
                    }
                    writeIndex++;
                }
            }

            // Shrink active boundary (no pop needed - just adjust boundary)
            account.validRefundsLength = writeIndex;
            account.pendingRefund = newPendingRefund;
        }

        account.balance += amount;
        return (account.balance, account.pendingRefund);
    }

    function requestRefund(
        AccountMap storage map,
        address user,
        address provider,
        uint amount
    ) internal returns (uint) {
        Account storage account = _get(map, user, provider);
        if ((account.balance - account.pendingRefund) < amount) {
            revert InsufficientBalance(user, provider);
        }

        // Check refund limit using validRefundsLength
        if (account.validRefundsLength >= MAX_REFUNDS_PER_ACCOUNT) {
            revert TooManyRefunds(user, provider);
        }

        uint newIndex;
        if (account.validRefundsLength < account.refunds.length) {
            // Reuse dirty position (saves ~15,000 gas)
            newIndex = account.validRefundsLength;
            account.refunds[newIndex] = Refund(newIndex, amount, block.timestamp, false);
        } else {
            // Need to push new position
            newIndex = account.refunds.length;
            account.refunds.push(Refund(newIndex, amount, block.timestamp, false));
        }

        account.validRefundsLength++;
        account.pendingRefund += amount;
        return newIndex;
    }

    function requestRefundAll(AccountMap storage map, address user, address provider) internal {
        Account storage account = _get(map, user, provider);
        uint amount = account.balance - account.pendingRefund;
        if (amount == 0) {
            return;
        }

        // Check refund limit using validRefundsLength
        if (account.validRefundsLength >= MAX_REFUNDS_PER_ACCOUNT) {
            revert TooManyRefunds(user, provider);
        }

        uint newIndex;
        if (account.validRefundsLength < account.refunds.length) {
            // Reuse dirty position (saves ~15,000 gas)
            newIndex = account.validRefundsLength;
            account.refunds[newIndex] = Refund(newIndex, amount, block.timestamp, false);
        } else {
            // Need to push new position
            newIndex = account.refunds.length;
            account.refunds.push(Refund(newIndex, amount, block.timestamp, false));
        }

        account.validRefundsLength++;
        account.pendingRefund += amount;
    }

    function processRefund(
        AccountMap storage map,
        address user,
        address provider,
        uint lockTime
    ) internal returns (uint totalAmount, uint balance, uint pendingRefund) {
        Account storage account = _get(map, user, provider);

        if (account.validRefundsLength == 0) {
            return (0, account.balance, account.pendingRefund);
        }

        totalAmount = 0;
        pendingRefund = 0;
        uint writeIndex = 0;
        uint currentTime = block.timestamp;
        uint validLength = account.validRefundsLength;

        // Process refunds in-place, only process active refunds
        for (uint i = 0; i < validLength; i++) {
            Refund storage refund = account.refunds[i];

            if (currentTime >= refund.createdAt + lockTime) {
                // Refund is unlocked, process it
                totalAmount += refund.amount;
                // Don't write back (effectively removes it)
            } else {
                // Refund still locked, keep it
                pendingRefund += refund.amount;
                if (i != writeIndex) {
                    account.refunds[writeIndex] = refund;
                    account.refunds[writeIndex].index = writeIndex;
                }
                writeIndex++;
            }
        }

        // Update valid refunds length (shrink boundary)
        account.validRefundsLength = writeIndex;
        account.balance -= totalAmount;
        account.pendingRefund = pendingRefund;
        balance = account.balance;
    }

    function acknowledgeProviderSigner(
        AccountMap storage map,
        address user,
        address provider,
        address providerSigner
    ) internal {
        if (!_contains(map, _key(user, provider))) {
            revert AccountNotExists(user, provider);
        }
        Account storage account = _get(map, user, provider);
        account.providerSigner = providerSigner;
    }

    function acknowledgeDeliverable(
        AccountMap storage map,
        address user,
        address provider,
        string calldata id
    ) internal {
        if (!_contains(map, _key(user, provider))) {
            revert AccountNotExists(user, provider);
        }
        Account storage account = _get(map, user, provider);

        // Check if deliverable exists
        if (bytes(account.deliverables[id].id).length == 0) {
            revert("Deliverable does not exist");
        }

        // Mark as acknowledged
        account.deliverables[id].acknowledged = true;
    }

    // provider functions

    function addDeliverable(
        AccountMap storage map,
        address user,
        address provider,
        string calldata id,
        bytes memory modelRootHash
    ) internal {
        if (!_contains(map, _key(user, provider))) {
            revert AccountNotExists(user, provider);
        }
        Account storage account = _get(map, user, provider);

        // Check if ID already exists
        if (bytes(account.deliverables[id].id).length != 0) {
            revert("Deliverable ID already exists");
        }

        // Create new deliverable
        Deliverable memory deliverable = Deliverable({
            id: id,
            modelRootHash: modelRootHash,
            encryptedSecret: "",
            acknowledged: false,
            timestamp: block.timestamp
        });

        if (account.deliverablesCount < MAX_DELIVERABLES_PER_ACCOUNT) {
            // Array not full, add to next available position
            account.deliverableIds[account.deliverablesCount] = id;
            account.deliverablesCount++;
        } else {
            // Array is full, remove oldest and add new one
            string memory oldestId = account.deliverableIds[account.deliverablesHead];
            delete account.deliverables[oldestId]; // Remove from mapping

            account.deliverableIds[account.deliverablesHead] = id; // Overwrite with new ID
            account.deliverablesHead = (account.deliverablesHead + 1) % MAX_DELIVERABLES_PER_ACCOUNT;
        }

        // Add to mapping
        account.deliverables[id] = deliverable;
    }

    // Get deliverable by ID
    function getDeliverable(
        AccountMap storage map,
        address user,
        address provider,
        string calldata id
    ) internal view returns (Deliverable memory) {
        Account storage account = _get(map, user, provider);
        if (bytes(account.deliverables[id].id).length == 0) {
            revert("Deliverable does not exist");
        }
        return account.deliverables[id];
    }

    // Get all deliverable IDs in chronological order (oldest to newest)
    function getDeliverableIds(
        AccountMap storage map,
        address user,
        address provider
    ) internal view returns (string[] memory ids) {
        Account storage account = _get(map, user, provider);
        uint count = account.deliverablesCount;

        if (count == 0) {
            return new string[](0);
        }

        ids = new string[](count);
        uint maxDeliverables = MAX_DELIVERABLES_PER_ACCOUNT;

        if (count < maxDeliverables) {
            // Array not full yet, deliverables are in chronological order from index 0
            for (uint i = 0; i < count; i++) {
                ids[i] = account.deliverableIds[i];
            }
        } else {
            // Array is full, need to reorder starting from the oldest (at head position)
            uint head = account.deliverablesHead;
            for (uint i = 0; i < count; i++) {
                uint sourceIndex = (head + i) % maxDeliverables;
                ids[i] = account.deliverableIds[sourceIndex];
            }
        }

        return ids;
    }

    // Get all deliverables in chronological order
    function getDeliverables(
        AccountMap storage map,
        address user,
        address provider
    ) internal view returns (Deliverable[] memory deliverables) {
        string[] memory ids = getDeliverableIds(map, user, provider);
        uint idsLength = ids.length;
        deliverables = new Deliverable[](idsLength);

        Account storage account = _get(map, user, provider);
        for (uint i = 0; i < idsLength; i++) {
            deliverables[i] = account.deliverables[ids[i]];
        }

        return deliverables;
    }

    // common functions

    function _at(AccountMap storage map, uint index) internal view returns (Account storage) {
        bytes32 key = map._keys.at(index);
        return map._values[key];
    }

    function _contains(AccountMap storage map, bytes32 key) internal view returns (bool) {
        return map._keys.contains(key);
    }

    function _length(AccountMap storage map) internal view returns (uint) {
        return map._keys.length();
    }

    function _get(AccountMap storage map, address user, address provider) internal view returns (Account storage) {
        bytes32 key = _key(user, provider);
        Account storage value = map._values[key];
        if (!_contains(map, key)) {
            revert AccountNotExists(user, provider);
        }
        return value;
    }

    function _set(
        AccountMap storage map,
        bytes32 key,
        address user,
        address provider,
        uint balance,
        string memory additionalInfo
    ) internal {
        Account storage account = map._values[key];
        account.balance = balance;
        account.user = user;
        account.provider = provider;
        account.additionalInfo = additionalInfo;
        account.validRefundsLength = 0; // Initialize validRefundsLength
        account.deliverablesHead = 0; // Initialize circular array head
        account.deliverablesCount = 0; // Initialize deliverable count
        map._keys.add(key);
    }

    function _key(address user, address provider) internal pure returns (bytes32) {
        return keccak256(abi.encode(user, provider));
    }
}
