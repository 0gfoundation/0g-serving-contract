# LedgerManager Contract Upgrade and Data Migration Execution Guide

This document provides a complete contract upgrade and data migration verification process for validating the correct migration from the old mapping structure to the new mapping structure on testnet.

---

## 📋 Objectives

Verify that after the LedgerManager contract upgrade:
1. Old mapping data (`userServiceProviders`) can be correctly migrated to the new mapping structure (`userServiceProvidersByAddress`)
2. Data integrity: All user-service-provider mapping relationships remain consistent
3. The migration function's batch processing mechanism works correctly

---

## 🏗️ Mapping Structure Changes

### Old Version (based on serviceType string)
```solidity
mapping(address => mapping(string => EnumerableSet.AddressSet)) userServiceProviders
// user => serviceType => providers
```

### New Version (based on serviceAddress)
```solidity
mapping(address => mapping(address => EnumerableSet.AddressSet)) userServiceProvidersByAddress
// user => serviceAddress => providers
```

### Key Function
```solidity
function migrateUserServiceProvidersMapping(
    uint256 startUserIndex,  // Starting user index
    uint256 batchSize        // Batch size
) external onlyOwner returns (
    uint256 migratedCount,   // Number of users migrated
    uint256 nextUserIndex    // Starting index for next batch
)
```

---

## 📝 Prerequisites

### Environment Configuration
Configure in `scripts/migration/.env` file:

```env
# Mainnet configuration
MAINNET_RPC=https://evmrpc.0g.ai
MAINNET_INFERENCE_ADDRESS=0x47340d900bdFec2BD393c626E12ea0656F938d84
MAINNET_LEDGER_ADDRESS=0x2dE54c845Cd948B72D2e32e39586fe89607074E3

# Testnet configuration
TESTNET_RPC=https://evmrpc-testnet.0g.ai
TESTNET_PRIVATE_KEY=your_private_key_here
TESTNET_INFERENCE_ADDRESS=0xe8B609Dd4674A457607A779d5Fb75e8d382c256c
TESTNET_LEDGER_ADDRESS=0xA873c190E9Ae89691f923c979F861A58A6a39BC8
```

### Permission Requirements
- Owner permission for testnet contracts
- Sufficient testnet wallet balance (recommended > 200 0G for gas and data reconstruction)

### Dependency Check
```bash
# Install dependencies
npm install

# Check prerequisites
npx ts-node scripts/migration/check-prerequisites.ts
```

---

## 🚀 Complete Execution Process

This process is divided into two phases with 8 steps.

---

## Phase 1: Data Preparation and Reconstruction

### Step 1: Export Mainnet Data

Export real user-service-provider mapping relationships from mainnet.

```bash
npx ts-node scripts/migration/1-export-mainnet-data.ts
```

**Output file**: `data/mainnet-snapshot-block-*.json`

**Expected result**:
```
✅ Data export complete!
📊 Statistics:
   - Block height: 21473014
   - Total accounts: 150
   - Total Ledgers: 23
   - Total services: 2
   - Mapping relationships: 54
```

**Checkpoints**:
- [ ] Snapshot file generated successfully
- [ ] User count > 0
- [ ] Mapping relationship count > 0

---

### Step 2: Rebuild Mappings on Testnet

Reconstruct users and mapping relationships on testnet using mainnet data.

```bash
export SNAPSHOT_FILE=data/mainnet-snapshot-block-21473014.json
npx ts-node scripts/migration/2-rebuild-mappings.ts
```

**Features**:
- ✅ Smart detection of existing Ledgers and mappings, only creates missing ones
- ✅ Automatically calculates deposit amount based on expected provider count
- ✅ Supports resumption after interruption (incremental execution)
- ✅ Automatically handles insufficient balance issues

**Expected result**:
```
✅ Reconstruction complete!
📊 Ledgers: 23 created, 0 skipped
📊 Mapping relationships: 54 created, 0 skipped
```

**Checkpoints**:
- [ ] All Ledgers created successfully
- [ ] Mapping relationships created successfully (may require multiple executions until 100%)
- [ ] User mapping table file generated

**Notes**:
- If some mapping creation fails (insufficient balance), re-execute this script
- Script will automatically skip already created data

---

### Step 3: Verify Rebuilt Mappings

Verify that mapping relationships on testnet match the mainnet snapshot.

```bash
export SNAPSHOT_FILE=data/mainnet-snapshot-block-21473014.json
npx ts-node scripts/migration/3-verify-mappings.ts
```

**Expected result**:
```
✅ Verification complete!
Total users: 23
Expected mappings: 54
Successful mappings: 54
Success rate: 100.0%
```

**Checkpoints**:
- [ ] Success rate = 100%
- [ ] All user mapping relationships are complete
- [ ] No missing or extra mappings

---

## Phase 2: Upgrade and Migration Verification

### Step 4: Export Testnet Data Before Upgrade

Before upgrading the contract, export the current testnet state as a baseline.

```bash
export SNAPSHOT_NAME=before-upgrade
npx ts-node scripts/migration/4-export-testnet-snapshot.ts
```

**Output file**: `data/testnet-before-upgrade-block-*.json`

**Expected result**:
```
✅ Testnet data export complete!
📊 Statistics:
   - Snapshot name: before-upgrade
   - Block height: 12345
   - Total Ledgers: 23
   - Mapping relationships: 54
```

**Key explanation**:
- The `getLedgerProviders` function reads from the old mapping `userServiceProviders` before upgrade
- The before-upgrade snapshot records all existing mapping relationships

**Checkpoints**:
- [ ] Snapshot file generated successfully
- [ ] Mapping relationship count matches Step 3

---

### Step 5: Upgrade Contract

Use Hardhat to upgrade the inference and LedgerManager contract to the new version.

```bash
# Validate upgrade compatibility
npx hardhat upgrade:validate --old LedgerManager --new LedgerManager --network zgTestnetMigrate

# Execute upgrade
npx hardhat upgrade --name LedgerManager --artifact LedgerManager --execute true --network zgTestnetMigrate

# Validate upgrade compatibility
npx hardhat upgrade:validate --old InferenceServing_v1.0 --new InferenceServing --network zgTestnetMigrate

# Execute upgrade
npx hardhat upgrade --name InferenceServing_v1.0 --artifact InferenceServing --execute true --network zgTestnetMigrate
```

**Post-upgrade verification**:
```bash
# Check contract status
npx ts-node scripts/migration/check-contract-status.ts
```

**Important note**:
- After upgrade, the `getLedgerProviders` function will automatically read from the new mapping `userServiceProvidersByAddress`
- However, the new mapping is empty at this point and requires executing the migration function to populate data

---

### Step 6: Execute Migration Function

Call `migrateUserServiceProvidersMapping` to migrate old mapping data to the new mapping.

```bash
# Set batch size (optional, default 10)
export BATCH_SIZE=10

# Execute migration
npx ts-node scripts/migration/5-execute-migration.ts
```

**Execution process**:
```
🔄 Starting migration execution (batch size: 10)

📦 Batch 1/3
   Starting index: 0
   Batch size: 10
   ⏳ Transaction submitted: 0xabc123...
   ✅ Transaction confirmed (Gas: 2,456,789)
   📊 This batch migrated: ~10 users

📦 Batch 2/3
   ...
```

**Expected result**:
```
✅ Migration complete!
📊 Migration statistics:
   - Total users: 23
   - Batches executed: 3/3
   - Failed batches: 0
   - Mappings before migration: 0
   - Mappings after migration: 54
   - New mappings added: 54
```

**Checkpoints**:
- [ ] All batches executed successfully (failed batches = 0)
- [ ] Mapping count after migration = mapping count before migration (e.g., 54)
- [ ] Gas consumption is reasonable (< 10M gas per batch)

**Troubleshooting**:
- If a batch fails, check gas limit or reduce `BATCH_SIZE`
- Migration function supports multiple calls (already migrated data will be skipped)

---

### Step 7: Export Testnet Data After Migration

After migration completes, export the new state for verification.

```bash
export SNAPSHOT_NAME=after-migration
npx ts-node scripts/migration/4-export-testnet-snapshot.ts
```

**Output file**: `data/testnet-after-migration-block-*.json`

**Expected result**:
```
✅ Testnet data export complete!
📊 Statistics:
   - Snapshot name: after-migration
   - Block height: 12350
   - Total Ledgers: 23
   - Mapping relationships: 54
```

**Key explanation**:
- At this point, `getLedgerProviders` reads from the new mapping `userServiceProvidersByAddress`
- Mapping count should match before upgrade

**Checkpoints**:
- [ ] Snapshot file generated successfully
- [ ] Mapping relationship count matches Step 4

---

### Step 8: Verify Migration Result

Compare data before and after upgrade to verify migration correctness.

```bash
export BEFORE_SNAPSHOT=data/testnet-before-upgrade-block-12345.json
export AFTER_SNAPSHOT=data/testnet-after-migration-block-12350.json
npx ts-node scripts/migration/6-verify-migration-result.ts
```

**Verification process**:
```
🔍 Starting verification of each user's mappings...

✅ 0x1234...: 3 → 3 (matched)
✅ 0x5678...: 2 → 2 (matched)
✅ 0xabcd...: 7 → 7 (matched)
...
```
