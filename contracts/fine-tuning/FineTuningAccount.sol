// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.22;

import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

// Constants
uint constant MAX_DELIVERABLES_PER_ACCOUNT = 20;
uint constant MAX_DELIVERABLE_ID_LENGTH = 256; // HIGH-5 FIX: Max length for deliverable IDs

/// @notice Account structure for user-provider relationship with fine-tuning deliverables
/// @dev Deliverables are managed using a circular array pattern (FIFO with fixed capacity)
/// @dev Data Structure:
///   - deliverables[id]: Mapping storing actual deliverable data by ID
///   - deliverableIds[]: Fixed-size array (20) storing IDs in chronological order
///   - deliverablesHead: Points to the oldest deliverable (index of next eviction)
///   - deliverablesCount: Current number of deliverables (0-20)
///
/// @dev Circular Array Mechanics:
///   When count < MAX (not full):
///     - New deliverables are appended to position [count]
///     - Head stays at 0
///     - Count increments
///
///   When count == MAX (full):
///     - Oldest deliverable at [head] is evicted from mapping
///     - New deliverable overwrites position [head] in array
///     - Head advances: head = (head + 1) % MAX
///     - Count stays at MAX
///
/// @dev Example Evolution:
///   Initial (empty):
///     deliverableIds: [empty × 20]
///     head: 0, count: 0
///
///   After adding 3 deliverables (id1, id2, id3):
///     deliverableIds: [id1, id2, id3, empty × 17]
///     head: 0, count: 3
///
///   After adding 20 deliverables (fills array):
///     deliverableIds: [id1, id2, ..., id20]
///     head: 0, count: 20
///
///   After adding id21 (evicts id1):
///     deliverableIds: [id21, id2, id3, ..., id20]
///     head: 1, count: 20
///     Note: id2 is now the oldest, at index 1
///
///   After adding id22 (evicts id2):
///     deliverableIds: [id21, id22, id3, ..., id20]
///     head: 2, count: 20
///     Note: id3 is now the oldest, at index 2
///
/// @dev Safety: MED-4 ensures only acknowledged deliverables can be evicted
///   Serial task execution is enforced on-chain, so when array is full,
///   the oldest deliverable is guaranteed to be acknowledged and safe to remove
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
    uint constant REFUND_CLEANUP_THRESHOLD = 3;
    uint constant MAX_ADDITIONAL_INFO_LENGTH = 4096; // 4KB limit for JSON configuration data

    // Custom errors for gas efficiency (GAS-1 optimization)
    error AccountNotExists(address user, address provider);
    error AccountExists(address user, address provider);
    error InsufficientBalance(address user, address provider);
    error RefundInvalid(address user, address provider, uint index);
    error RefundProcessed(address user, address provider, uint index);
    error RefundLocked(address user, address provider, uint index);
    error TooManyRefunds(address user, address provider);
    error AdditionalInfoTooLong();
    error ProviderSignerZeroAddress();
    error DeliverableNotExists(string id);
    error DeliverableAlreadyExists(string id);
    error DeliverableIdInvalidLength(uint256 length);
    error PreviousDeliverableNotAcknowledged(string id);

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

        uint end = offset + limit;
        if (limit == 0 || end > total) {
            end = total;
        }

        uint resultLength = end - offset;
        accounts = new AccountSummary[](resultLength);

        for (uint i = 0; i < resultLength; ) {
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
            unchecked { ++i; }
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

        for (uint i = 0; i < resultLen; ) {
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
            unchecked { ++i; }
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

        for (uint i = 0; i < resultLen; ) {
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
            unchecked { ++i; }
        }

        return (accounts, total);
    }

    function getBatchAccountsByUsers(
        AccountMap storage map,
        address[] calldata users,
        address provider
    ) internal view returns (AccountSummary[] memory accounts) {
        require(users.length <= 500, "Batch size too large (max 500)");
        accounts = new AccountSummary[](users.length);

        for (uint i = 0; i < users.length; ) {
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
            unchecked { ++i; }
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

    /// @notice Deletes an account while preserving nonce to prevent signature replay attacks
    /// @dev This implements "soft delete" - removes from indexes but preserves nonce in storage
    /// @dev SECURITY: nonce is intentionally NOT reset to prevent replay attacks if account is recreated
    /// @param map The account map storage
    /// @param user The user address
    /// @param provider The provider address
    /// @return deletedBalance The balance that was deleted (for event emission)
    function deleteAccount(AccountMap storage map, address user, address provider) internal returns (uint deletedBalance) {
        bytes32 key = _key(user, provider);
        if (!_contains(map, key)) {
            return 0;
        }

        // Preserve nonce to prevent signature replay attacks when account is recreated
        Account storage account = map._values[key];

        // Capture balance before deletion for event
        deletedBalance = account.balance;

        // Clear all balance and state data
        account.balance = 0;
        account.pendingRefund = 0;
        account.providerSigner = address(0);
        account.validRefundsLength = 0;

        // IMPORTANT: Must explicitly delete each deliverable from mapping
        // Unlike arrays, Solidity mappings cannot be deleted in bulk
        // If we don't delete these, addDeliverable() will revert when the account
        // is recreated and tries to use the same deliverable IDs (line 606 check)
        // Gas cost is acceptable: MAX_DELIVERABLES_PER_ACCOUNT = 20 iterations
        for (uint i = 0; i < account.deliverablesCount; ) {
            uint index = (account.deliverablesHead + i) % MAX_DELIVERABLES_PER_ACCOUNT;
            string memory deliverableId = account.deliverableIds[index];
            delete account.deliverables[deliverableId];
            unchecked { ++i; }
        }

        account.deliverablesHead = 0;
        account.deliverablesCount = 0;
        delete account.refunds;
        delete account.additionalInfo;

        // Note: nonce is intentionally NOT reset
        // This prevents signature replay attacks if the account is recreated

        // Remove from indexes to make account appear "deleted"
        map._providerIndex[provider].remove(key);
        map._userIndex[user].remove(key);
        map._keys.remove(key);

        // Note: We do NOT delete map._values[key] to preserve nonce
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
            for (uint i = 0; i < account.refunds.length; ) {
                Refund storage refund = account.refunds[i];

                if (refund.processed) {
                    unchecked { ++i; }
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
                unchecked { ++i; }
            }

            // Update validRefundsLength after cancelling refunds
            account.validRefundsLength = writeIndex;

            // Cleanup if needed
            if (writeIndex < account.refunds.length) {
                _cleanupRefunds(account, writeIndex);
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
        for (uint i = 0; i < account.refunds.length; ) {
            Refund storage refund = account.refunds[i];

            if (refund.processed) {
                unchecked { ++i; }
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
            unchecked { ++i; }
        }

        // Update valid refunds length
        account.validRefundsLength = writeIndex;

        // Clean up or mark dirty data
        if (writeIndex < account.refunds.length) {
            uint dirtyCount = account.refunds.length - writeIndex;

            if (dirtyCount >= REFUND_CLEANUP_THRESHOLD) {
                // Many dirty entries: physical cleanup is more efficient
                _cleanupRefunds(account, writeIndex);
            } else {
                // Few dirty entries: mark as processed to prevent duplicate processing
                for (uint i = writeIndex; i < account.refunds.length; ) {
                    account.refunds[i].processed = true;
                    unchecked { ++i; }
                }
            }
        }

        account.balance -= totalAmount;
        account.pendingRefund = pendingRefund;
        balance = account.balance;
    }

    /// @notice Allows user to acknowledge a provider's signing address for TEE verification
    /// @param map The account map storage
    /// @param user The user address
    /// @param provider The provider address
    /// @param providerSigner The provider's TEE signer address
    /// @dev HIGH-4 FIX: Added zero-address validation to prevent setting invalid signer
    function acknowledgeProviderSigner(
        AccountMap storage map,
        address user,
        address provider,
        address providerSigner
    ) internal {
        // HIGH-4 FIX: Validate providerSigner is not zero address
        if (providerSigner == address(0)) {
            revert ProviderSignerZeroAddress();
        }

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
            revert DeliverableNotExists(id);
        }

        // Mark as acknowledged
        account.deliverables[id].acknowledged = true;
    }

    // provider functions

    /// @notice Adds a new deliverable to a user-provider account
    /// @dev MED-4 FIX: Enforces serial task execution - previous deliverable must be acknowledged
    /// @dev HIGH-5 FIX: Added deliverable ID length validation to prevent DoS attacks
    /// @param map The account map storage
    /// @param user The user address
    /// @param provider The provider address
    /// @param id The unique deliverable identifier
    /// @param modelRootHash The model root hash
    function addDeliverable(
        AccountMap storage map,
        address user,
        address provider,
        string calldata id,
        bytes memory modelRootHash
    ) internal {
        // HIGH-5 FIX: Validate deliverable ID length to prevent DoS via excessive gas consumption
        uint256 idLength = bytes(id).length;
        if (idLength == 0 || idLength > MAX_DELIVERABLE_ID_LENGTH) {
            revert DeliverableIdInvalidLength(idLength);
        }

        if (!_contains(map, _key(user, provider))) {
            revert AccountNotExists(user, provider);
        }
        Account storage account = _get(map, user, provider);

        // Check if ID already exists
        if (bytes(account.deliverables[id].id).length != 0) {
            revert DeliverableAlreadyExists(id);
        }

        // MED-4 FIX: Enforce serial task execution
        // BUSINESS RULE: Tasks must be completed sequentially
        // Only allow new deliverable if previous one is acknowledged or no deliverables exist
        // This prevents adding new tasks while previous ones are still pending
        if (account.deliverablesCount > 0) {
            // Get the most recent deliverable ID
            uint latestIndex;
            if (account.deliverablesCount == MAX_DELIVERABLES_PER_ACCOUNT) {
                // Array is full, latest is right before head (circular)
                latestIndex = (account.deliverablesHead + MAX_DELIVERABLES_PER_ACCOUNT - 1) % MAX_DELIVERABLES_PER_ACCOUNT;
            } else {
                // Array not full, latest is at count - 1
                latestIndex = account.deliverablesCount - 1;
            }

            string memory latestId = account.deliverableIds[latestIndex];
            if (!account.deliverables[latestId].acknowledged) {
                revert PreviousDeliverableNotAcknowledged(latestId);
            }
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
            // Array is full (20 deliverables), use FIFO eviction strategy
            // SAFETY: Due to serial task validation above, all older deliverables
            // must be acknowledged before we can add this new one. Therefore,
            // the oldest deliverable is guaranteed to be acknowledged and safe to evict.
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
            revert DeliverableNotExists(id);
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

        if (count < MAX_DELIVERABLES_PER_ACCOUNT) {
            // Array not full yet, deliverables are in chronological order from index 0
            for (uint i = 0; i < count; ) {
                ids[i] = account.deliverableIds[i];
                unchecked { ++i; }
            }
        } else {
            // Array is full, need to reorder starting from the oldest (at head position)
            uint head = account.deliverablesHead;
            for (uint i = 0; i < count; ) {
                uint sourceIndex = (head + i) % MAX_DELIVERABLES_PER_ACCOUNT;
                ids[i] = account.deliverableIds[sourceIndex];
                unchecked { ++i; }
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
        deliverables = new Deliverable[](ids.length);

        Account storage account = _get(map, user, provider);
        for (uint i = 0; i < ids.length; ) {
            deliverables[i] = account.deliverables[ids[i]];
            unchecked { ++i; }
        }

        return deliverables;
    }

    // Helper functions

    function _cleanupRefunds(Account storage account, uint keepCount) private {
        // Resize array to remove processed refunds
        uint currentLength = account.refunds.length;
        for (uint i = currentLength; i > keepCount; ) {
            account.refunds.pop();
            unchecked { --i; }
        }
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

    /// @dev Internal function to initialize or update account data
    /// @dev SECURITY: This function intentionally does NOT reset nonce
    /// @dev This allows deleteAccount's "soft delete" to preserve nonce across account recreation
    /// @dev preventing signature replay attacks (see deleteAccount line 345 comment)
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
        // NOTE: nonce is intentionally NOT set here
        // For new accounts, it defaults to 0
        // For re-created accounts, it preserves the old nonce value
        map._keys.add(key);
    }

    function _key(address user, address provider) internal pure returns (bytes32) {
        return keccak256(abi.encode(user, provider));
    }
}
