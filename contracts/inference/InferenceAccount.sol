// SPDX-License-Identifier: Unlicense
pragma solidity >=0.8.0 <0.9.0;

import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

struct Account {
    address user;
    address provider;
    uint nonce;
    uint balance;
    uint pendingRefund;
    Refund[] refunds;
    string additionalInfo;
    bool acknowledged; // Whether user has acknowledged this provider
    uint validRefundsLength; // Track the number of valid (non-dirty) refunds
}

struct Refund {
    uint index;
    uint amount;
    uint createdAt;
    bool processed;
}

library AccountLibrary {
    using EnumerableSet for EnumerableSet.Bytes32Set;

    // Constants for optimization
    uint constant MAX_REFUNDS_PER_ACCOUNT = 5;
    uint constant REFUND_CLEANUP_THRESHOLD = 3;

    error AccountNotExists(address user, address provider);
    error AccountExists(address user, address provider);
    error InsufficientBalance(address user, address provider);
    error RefundInvalid(address user, address provider, uint index);
    error RefundProcessed(address user, address provider, uint index);
    error RefundLocked(address user, address provider, uint index);
    error TooManyRefunds(address user, address provider);

    struct AccountMap {
        EnumerableSet.Bytes32Set _keys;
        mapping(bytes32 => Account) _values;
        mapping(address => EnumerableSet.Bytes32Set) _providerIndex;
        mapping(address => EnumerableSet.Bytes32Set) _userIndex;
    }

    function getAccount(
        AccountMap storage map,
        address user,
        address provider
    ) internal view returns (Account storage) {
        return _get(map, user, provider);
    }

    function getAllAccounts(
        AccountMap storage map,
        uint offset,
        uint limit
    ) internal view returns (Account[] memory accounts, uint total) {
        total = _length(map);

        if (offset >= total) {
            return (new Account[](0), total);
        }

        uint end = offset + limit;
        if (limit == 0 || end > total) {
            end = total;
        }

        uint resultLength = end - offset;
        accounts = new Account[](resultLength);

        for (uint i = 0; i < resultLength; i++) {
            accounts[i] = _at(map, offset + i);
        }
    }

    function getAccountsByProvider(
        AccountMap storage map,
        address provider,
        uint offset,
        uint limit
    ) internal view returns (Account[] memory accounts, uint total) {
        EnumerableSet.Bytes32Set storage providerKeys = map._providerIndex[provider];
        total = providerKeys.length();

        if (offset >= total) {
            return (new Account[](0), total);
        }

        uint end = limit == 0 ? total : offset + limit;
        if (end > total) {
            end = total;
        }

        uint resultLen = end - offset;
        accounts = new Account[](resultLen);

        for (uint i = 0; i < resultLen; i++) {
            bytes32 key = providerKeys.at(offset + i);
            accounts[i] = map._values[key];
        }

        return (accounts, total);
    }

    function getAccountsByUser(
        AccountMap storage map,
        address user,
        uint offset,
        uint limit
    ) internal view returns (Account[] memory accounts, uint total) {
        EnumerableSet.Bytes32Set storage userKeys = map._userIndex[user];
        total = userKeys.length();

        if (offset >= total) {
            return (new Account[](0), total);
        }

        uint end = limit == 0 ? total : offset + limit;
        if (end > total) {
            end = total;
        }

        uint resultLen = end - offset;
        accounts = new Account[](resultLen);

        for (uint i = 0; i < resultLen; i++) {
            bytes32 key = userKeys.at(offset + i);
            accounts[i] = map._values[key];
        }

        return (accounts, total);
    }

    function getAccountCountByProvider(AccountMap storage map, address provider) internal view returns (uint) {
        return map._providerIndex[provider].length();
    }

    function getAccountCountByUser(AccountMap storage map, address user) internal view returns (uint) {
        return map._userIndex[user].length();
    }

    function getBatchAccountsByUsers(
        AccountMap storage map,
        address[] calldata users,
        address provider
    ) internal view returns (Account[] memory accounts) {
        require(users.length <= 500, "Batch size too large (max 500)");
        accounts = new Account[](users.length);

        for (uint i = 0; i < users.length; i++) {
            bytes32 key = _key(users[i], provider);
            if (_contains(map, key)) {
                accounts[i] = map._values[key];
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

    function acknowledgeTEESigner(
        AccountMap storage map,
        address user,
        address provider,
        bool acknowledged
    ) internal {
        Account storage account = _get(map, user, provider);
        
        // Once acknowledged as true, can only be set back to false if balance is zero
        if (account.acknowledged && !acknowledged) {
            require(account.balance == 0, "Cannot revoke acknowledgement with non-zero balance");
        }
        
        account.acknowledged = acknowledged;
    }

    function depositFund(
        AccountMap storage map,
        address user,
        address provider,
        uint cancelRetrievingAmount,
        uint amount
    ) internal returns (uint, uint) {
        Account storage account = _get(map, user, provider);

        if (cancelRetrievingAmount > 0 && account.refunds.length > 0) {
            uint remainingCancel = cancelRetrievingAmount;
            uint newPendingRefund = account.pendingRefund;

            // Process refunds in-place to avoid memory allocation
            uint writeIndex = 0;
            for (uint i = 0; i < account.refunds.length; i++) {
                Refund storage refund = account.refunds[i];

                if (refund.processed) {
                    continue;
                }

                if (remainingCancel >= refund.amount) {
                    remainingCancel -= refund.amount;
                    newPendingRefund -= refund.amount;
                    refund.processed = true; // Mark as processed instead of removing
                } else if (remainingCancel > 0) {
                    refund.amount -= remainingCancel;
                    newPendingRefund -= remainingCancel;
                    remainingCancel = 0;
                }

                // Keep unprocessed refunds
                if (!refund.processed && i != writeIndex) {
                    account.refunds[writeIndex] = refund;
                    account.refunds[writeIndex].index = writeIndex;
                    writeIndex++;
                } else if (!refund.processed) {
                    writeIndex++;
                }
            }

            // Update validRefundsLength after cancelling refunds
            account.validRefundsLength = writeIndex;

            // Cleanup if needed
            if (writeIndex < account.refunds.length) {
                _cleanupRefunds(account, writeIndex);
                account.validRefundsLength = account.refunds.length; // Update after cleanup
            }

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

        if (account.refunds.length == 0) {
            return (0, account.balance, account.pendingRefund);
        }

        totalAmount = 0;
        pendingRefund = 0;
        uint writeIndex = 0;
        uint currentTime = block.timestamp;

        // Process refunds in-place
        for (uint i = 0; i < account.refunds.length; i++) {
            Refund storage refund = account.refunds[i];

            if (refund.processed) {
                continue;
            }

            if (currentTime >= refund.createdAt + lockTime) {
                totalAmount += refund.amount;
                refund.processed = true; // Mark as processed
            } else {
                pendingRefund += refund.amount;
                // Keep unprocessed refunds
                if (i != writeIndex) {
                    account.refunds[writeIndex] = refund;
                    account.refunds[writeIndex].index = writeIndex;
                }
                writeIndex++;
            }
        }

        // Update valid refunds length
        account.validRefundsLength = writeIndex;

        // Clean up or mark dirty data
        if (writeIndex < account.refunds.length) {
            uint dirtyCount = account.refunds.length - writeIndex;

            if (dirtyCount >= REFUND_CLEANUP_THRESHOLD) {
                // Many dirty entries: physical cleanup is more efficient
                _cleanupRefunds(account, writeIndex);
                account.validRefundsLength = account.refunds.length; // Update after cleanup
            } else {
                // Few dirty entries: mark as processed to prevent duplicate processing
                for (uint i = writeIndex; i < account.refunds.length; i++) {
                    account.refunds[i].processed = true;
                }
            }
        }

        account.balance -= totalAmount;
        account.pendingRefund = pendingRefund;
        balance = account.balance;
    }

    function _cleanupRefunds(Account storage account, uint keepCount) private {
        // Resize array to remove processed refunds
        uint currentLength = account.refunds.length;
        for (uint i = currentLength; i > keepCount; i--) {
            account.refunds.pop();
        }
    }

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
        if (!_contains(map, key)) {
            revert AccountNotExists(user, provider);
        }
        return map._values[key];
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
        map._keys.add(key);
    }

    function _key(address user, address provider) internal pure returns (bytes32) {
        return keccak256(abi.encode(user, provider));
    }
}
