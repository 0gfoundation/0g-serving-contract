/**
 * Step 5: Execute contract migration
 *
 * Features:
 * - Call migrateUserServiceProvidersMapping function
 * - Migrate old mapping data to new mapping structure
 * - Supports batch processing and incremental execution
 *
 * Usage:
 * export BATCH_SIZE=10
 * npx ts-node scripts/migration/5-execute-migration.ts
 */

import { ethers } from "ethers";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.join(__dirname, ".env") });

const TESTNET_RPC = process.env.TESTNET_RPC || "https://evmrpc-testnet.0g.ai";
const TESTNET_PRIVATE_KEY = process.env.TESTNET_PRIVATE_KEY || "";
const TESTNET_LEDGER_ADDRESS = process.env.TESTNET_LEDGER_ADDRESS || "";
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || "10");

const LEDGER_MANAGER_ABI = [
  "function getAllLedgers(uint256 offset, uint256 limit) view returns (tuple(address user, uint256 availableBalance, uint256 totalBalance, string additionalInfo)[] ledgers, uint256 total)",
  "function getAllActiveServices() view returns (tuple(address serviceAddress, address serviceContract, string serviceType, string version, string fullName, string description, bool isRecommended, uint256 registeredAt)[] services)",
  "function getLedgerProviders(address user, string serviceName) view returns (address[] providers)",
  "function migrateUserServiceProvidersMapping(uint256 startUserIndex, uint256 batchSize) returns (uint256 migratedCount, uint256 nextUserIndex)",
  "function owner() view returns (address)",
];

interface MigrationStats {
  totalUsers: number;
  totalServices: number;
  totalMigrated: number;
  batchesExecuted: number;
  mappingsBefore: number;
  mappingsAfter: number;
  failed: number;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeMigration() {
  console.log("🚀 Starting contract migration execution...\n");

  if (!TESTNET_PRIVATE_KEY || !TESTNET_LEDGER_ADDRESS) {
    throw new Error("❌ Missing required environment variables");
  }

  // Connect to testnet
  const provider = new ethers.JsonRpcProvider(TESTNET_RPC);
  const owner = new ethers.Wallet(TESTNET_PRIVATE_KEY, provider);
  const blockNumber = await provider.getBlockNumber();

  console.log(`📡 Testnet connection successful (Block ${blockNumber})`);
  console.log(`💰 Owner: ${owner.address}\n`);

  const ledgerManager = new ethers.Contract(TESTNET_LEDGER_ADDRESS, LEDGER_MANAGER_ABI, owner);

  // Verify permissions
  try {
    const contractOwner = await ledgerManager.owner();
    if (contractOwner.toLowerCase() !== owner.address.toLowerCase()) {
      throw new Error(`❌ Insufficient permissions: contract owner is ${contractOwner}, but you are ${owner.address}`);
    }
    console.log(`✅ Permission verification passed\n`);
  } catch (error) {
    console.log(`⚠️  Unable to verify permissions: ${error}\n`);
  }

  const stats: MigrationStats = {
    totalUsers: 0,
    totalServices: 0,
    totalMigrated: 0,
    batchesExecuted: 0,
    mappingsBefore: 0,
    mappingsAfter: 0,
    failed: 0,
  };

  // 1. Getting all services
  console.log("📦 Getting all services...");
  const services = await ledgerManager.getAllActiveServices();
  stats.totalServices = services.length;
  console.log(`✅ Found ${services.length} services\n`);

  if (services.length === 0) {
    throw new Error("❌ No services found, cannot migrate");
  }

  const firstService = services[0];
  console.log(`📋 Will migrate service: ${firstService.fullName} (${firstService.serviceAddress})\n`);

  // 2. Get total user count
  console.log("📦 Getting total user count...");
  const firstBatch = await ledgerManager.getAllLedgers(0, 1);
  const totalLedgers = Number(firstBatch.total);
  stats.totalUsers = totalLedgers;
  console.log(`✅ Total users: ${totalLedgers}\n`);

  if (totalLedgers === 0) {
    console.log("⚠️  No users, no migration needed\n");
    return stats;
  }

  // 3. Calculate new mapping data before migration
  console.log("📊 Checking new mapping status before migration...");
  let mappingsBeforeMigration = 0;
  const PAGE_SIZE = 50;
  let offset = 0;

  while (offset < totalLedgers) {
    const result = await ledgerManager.getAllLedgers(offset, PAGE_SIZE);
    for (const ledger of result.ledgers) {
      try {
        const providers = await ledgerManager.getLedgerProviders(ledger.user, firstService.fullName);
        if (providers.length > 0) {
          mappingsBeforeMigration += providers.length;
        }
      } catch {
        // Ignore errors
      }
    }
    offset += PAGE_SIZE;
  }
  stats.mappingsBefore = mappingsBeforeMigration;
  console.log(`   New mappings before migration: ${mappingsBeforeMigration}\n`);

  // 4. Execute migration (in batches)
  console.log("═══════════════════════════════════════════════════════");
  console.log(`🔄 Starting migration execution (batch size: ${BATCH_SIZE})`);
  console.log("═══════════════════════════════════════════════════════\n");

  let currentUserIndex = 0;
  let batchNum = 0;
  const totalBatches = Math.ceil(totalLedgers / BATCH_SIZE);

  while (currentUserIndex < totalLedgers) {
    batchNum++;
    const remainingUsers = totalLedgers - currentUserIndex;
    const currentBatchSize = Math.min(BATCH_SIZE, remainingUsers);

    console.log(`📦 Batch ${batchNum}/${totalBatches}`);
    console.log(`   Starting index: ${currentUserIndex}`);
    console.log(`   batch size: ${currentBatchSize}`);

    try {
      const tx = await ledgerManager.migrateUserServiceProvidersMapping(currentUserIndex, currentBatchSize, {
        gasLimit: 10000000, // 10M gas limit
      });

      console.log(`   ⏳ Transaction submitted: ${tx.hash}`);
      const receipt = await tx.wait();

      // Parse return value
      // Note: ethers v6 wait() returns receipt, need to get return value from transaction call
      console.log(`   ✅ Transaction confirmed (Gas: ${receipt.gasUsed.toString()})`);

      // Try to get migration count from events (if contract emits events)
      let migratedInBatch = 0;
      for (const log of receipt.logs) {
        try {
          const parsed = ledgerManager.interface.parseLog({
            topics: [...log.topics],
            data: log.data,
          });
          if (parsed && parsed.name === "UserServiceProvidersMigrated") {
            migratedInBatch++;
          }
        } catch {
          // Not an event we care about
        }
      }

      stats.totalMigrated += migratedInBatch;
      stats.batchesExecuted++;

      console.log(`   📊 This batch migrated: ${migratedInBatch > 0 ? migratedInBatch : "~" + currentBatchSize} users\n`);

      currentUserIndex += currentBatchSize;
      await delay(1000); // Avoid too many requests
    } catch (error) {
      stats.failed++;
      console.log(`   ❌ Batch failed: ${error instanceof Error ? error.message : String(error)}`);
      console.log(`   ⚠️  Attempting to continue from index ${currentUserIndex}...\n`);
      // Can choose to continue next batch or terminate
      break;
    }
  }

  // 5. Calculate new mapping data after migration
  console.log("📊 Checking new mapping status after migration...");
  let mappingsAfterMigration = 0;
  offset = 0;

  while (offset < totalLedgers) {
    const result = await ledgerManager.getAllLedgers(offset, PAGE_SIZE);
    for (const ledger of result.ledgers) {
      try {
        const providers = await ledgerManager.getLedgerProviders(ledger.user, firstService.fullName);
        if (providers.length > 0) {
          mappingsAfterMigration += providers.length;
        }
      } catch {
        // Ignore errors
      }
    }
    offset += PAGE_SIZE;
  }
  stats.mappingsAfter = mappingsAfterMigration;
  console.log(`   New mappings after migration: ${mappingsAfterMigration}\n`);

  // 6. Output results
  console.log("═══════════════════════════════════════════════════════");
  console.log("✅ Migration complete!");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`📊 Migration statistics:`);
  console.log(`   - Total users: ${stats.totalUsers}`);
  console.log(`   - Total services: ${stats.totalServices}`);
  console.log(`   - Batches executed: ${stats.batchesExecuted}/${totalBatches}`);
  console.log(`   - Failed batches: ${stats.failed}`);
  console.log(`   - New mappings before migration: ${stats.mappingsBefore}`);
  console.log(`   - New mappings after migration: ${stats.mappingsAfter}`);
  console.log(`   - New mappings added: ${stats.mappingsAfter - stats.mappingsBefore}`);
  console.log("═══════════════════════════════════════════════════════\n");

  console.log("💡 Next steps:");
  console.log("   1. Execute Step 7 to export post-upgrade data");
  console.log("   2. Execute Step 8 to verify migration results\n");

  return stats;
}

if (require.main === module) {
  executeMigration()
    .then(() => {
      console.log("🎉 Complete!");
      process.exit(0);
    })
    .catch((error) => {
      console.error("❌ Error:", error);
      process.exit(1);
    });
}

export { executeMigration };
