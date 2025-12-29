// SPDX-License-Identifier: Unlicense
pragma solidity >=0.8.0 <0.9.0;

import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/// @notice Account structure for user-provider relationship
/// @dev Invariants for refunds array management (grow-only strategy):
/// 1. The refunds array grows on-demand up to MAX_REFUNDS_PER_ACCOUNT
/// 2. Active refunds are stored in positions [0, validRefundsLength)
/// 3. Inactive/reusable slots are in positions [validRefundsLength, refunds.length)
/// 4. pendingRefund equals the sum of all refunds[i].amount where i < validRefundsLength
/// 5. Array grows via push when needed, but never shrinks via pop - only slot reuse
/// 6. The 'processed' field is kept for storage compatibility but not used in logic
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
    uint generation; // Token generation for batch revocation
    uint256 revokedBitmap; // Bitmap for precise token revocation (each bit represents a tokenId 0-255)
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

        // Preserve nonce and generation to prevent signature replay attacks
        // when account is recreated
        Account storage account = map._values[key];

        // Clear all balance and state data
        account.balance = 0;
        account.pendingRefund = 0;
        account.acknowledged = false;
        account.validRefundsLength = 0;
        account.revokedBitmap = 0;
        delete account.refunds;
        delete account.additionalInfo;

        // Note: nonce and generation are intentionally NOT reset
        // This prevents signature replay attacks if the account is recreated

        // Remove from indexes to make account appear "deleted"
        map._providerIndex[provider].remove(key);
        map._userIndex[user].remove(key);
        map._keys.remove(key);

        // Note: We do NOT delete map._values[key] to preserve nonce/generation
    }

    function acknowledgeTEESigner(AccountMap storage map, address user, address provider, bool acknowledged) internal {
        Account storage account = _get(map, user, provider);

        // Once acknowledged as true, can only be set back to false if balance is zero
        if (account.acknowledged && !acknowledged) {
            require(account.balance == 0, "Cannot revoke acknowledgement with non-zero balance");
        }

        account.acknowledged = acknowledged;
    }

    function revokeToken(AccountMap storage map, address user, address provider, uint8 tokenId) internal {
        Account storage account = _get(map, user, provider);
        account.revokedBitmap |= (uint256(1) << tokenId);
    }

    function revokeTokens(AccountMap storage map, address user, address provider, uint8[] calldata tokenIds) internal {
        Account storage account = _get(map, user, provider);
        for (uint i = 0; i < tokenIds.length; i++) {
            account.revokedBitmap |= (uint256(1) << tokenIds[i]);
        }
    }

    function revokeAllTokens(
        AccountMap storage map,
        address user,
        address provider
    ) internal returns (uint newGeneration) {
        Account storage account = _get(map, user, provider);
        account.generation++;
        account.revokedBitmap = 0; // Reset bitmap for new generation
        return account.generation;
    }

    function isTokenRevoked(
        AccountMap storage map,
        address user,
        address provider,
        uint8 tokenId
    ) internal view returns (bool) {
        Account storage account = _get(map, user, provider);
        return (account.revokedBitmap & (uint256(1) << tokenId)) != 0;
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

            // Use swap-and-shrink: process active refunds and compact
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

        // Check refund limit using validRefundsLength (active boundary)
        if (account.validRefundsLength >= MAX_REFUNDS_PER_ACCOUNT) {
            revert TooManyRefunds(user, provider);
        }

        uint newIndex = account.validRefundsLength;

        // Grow array on-demand: push if not enough capacity, reuse if available
        if (account.refunds.length <= newIndex) {
            account.refunds.push(Refund(newIndex, amount, block.timestamp, false));
        } else {
            account.refunds[newIndex] = Refund(newIndex, amount, block.timestamp, false);
        }

        account.validRefundsLength++; // Expand active boundary
        account.pendingRefund += amount;
        return newIndex;
    }

    function requestRefundAll(AccountMap storage map, address user, address provider) internal {
        Account storage account = _get(map, user, provider);

        uint amount = account.balance - account.pendingRefund;
        if (amount == 0) {
            return;
        }

        // Check refund limit using validRefundsLength (active boundary)
        if (account.validRefundsLength >= MAX_REFUNDS_PER_ACCOUNT) {
            revert TooManyRefunds(user, provider);
        }

        uint newIndex = account.validRefundsLength;

        // Grow array on-demand: push if not enough capacity, reuse if available
        if (account.refunds.length <= newIndex) {
            account.refunds.push(Refund(newIndex, amount, block.timestamp, false));
        } else {
            account.refunds[newIndex] = Refund(newIndex, amount, block.timestamp, false);
        }

        account.validRefundsLength++; // Expand active boundary
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
            // No need to ensure capacity here - if validRefundsLength > 0, array is already initialized
            return (0, account.balance, account.pendingRefund);
        }

        totalAmount = 0;
        pendingRefund = 0;
        uint writeIndex = 0;
        uint currentTime = block.timestamp;

        // Use swap-and-shrink: process active refunds and compact
        for (uint i = 0; i < account.validRefundsLength; i++) {
            Refund storage refund = account.refunds[i];

            if (currentTime >= refund.createdAt + lockTime) {
                // Refund is unlocked, process it (skip - don't write back)
                totalAmount += refund.amount;
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

        // Shrink active boundary (no pop needed - just adjust boundary)
        account.validRefundsLength = writeIndex;

        account.balance -= totalAmount;
        account.pendingRefund = pendingRefund;
        balance = account.balance;
    }

    /// @dev Migration function: Clean up old processed refunds for specified accounts
    /// Should be called once after contract upgrade to clean all dirty data
    /// This is a one-time migration utility, can be removed after migration completes
    function migrateRefunds(
        AccountMap storage map,
        address[] calldata users,
        address provider
    ) internal returns (uint cleanedCount) {
        cleanedCount = 0;
        for (uint j = 0; j < users.length; j++) {
            bytes32 key = _key(users[j], provider);
            if (!_contains(map, key)) {
                continue;
            }

            Account storage account = map._values[key];
            if (account.validRefundsLength == 0) {
                continue;
            }

            // Clean up old dirty data (processed=true) if present
            uint writeIndex = 0;
            bool hasDirty = false;
            for (uint i = 0; i < account.validRefundsLength; i++) {
                if (!account.refunds[i].processed) {
                    if (i != writeIndex) {
                        account.refunds[writeIndex] = account.refunds[i];
                        account.refunds[writeIndex].index = writeIndex;
                    }
                    writeIndex++;
                } else {
                    hasDirty = true;
                }
            }

            if (hasDirty) {
                account.validRefundsLength = writeIndex;
                // Recalculate pendingRefund after cleanup
                uint newPendingRefund = 0;
                for (uint i = 0; i < writeIndex; i++) {
                    newPendingRefund += account.refunds[i].amount;
                }
                account.pendingRefund = newPendingRefund;
                cleanedCount++;
            }
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
