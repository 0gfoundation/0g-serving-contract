/**
 * Step 4: Export testnet data snapshot
 *
 * Purpose:
 * - Before upgrade: Export old contract data as baseline
 * - After upgrade: Export new contract data for comparison verification
 *
 * Usage:
 * # Export before upgrade
 * export SNAPSHOT_NAME=before-upgrade
 * npx ts-node scripts/migration/4-export-testnet-snapshot.ts
 *
 * # Export after migration
 * export SNAPSHOT_NAME=after-migration
 * npx ts-node scripts/migration/4-export-testnet-snapshot.ts
 */

import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config({ path: path.join(__dirname, ".env") });

const TESTNET_RPC = process.env.TESTNET_RPC || "https://evmrpc-testnet.0g.ai";
const TESTNET_INFERENCE_ADDRESS = process.env.TESTNET_INFERENCE_ADDRESS || "";
const TESTNET_LEDGER_ADDRESS = process.env.TESTNET_LEDGER_ADDRESS || "";
const SNAPSHOT_NAME = process.env.SNAPSHOT_NAME || "testnet";

interface AccountSnapshot {
  user: string;
  provider: string;
  nonce: string;
  balance: string;
  pendingRefund: string;
  validRefundsLength: number;
  generation: string;
  acknowledged: boolean;
  additionalInfo: string;
  refunds: Array<{
    index: number;
    amount: string;
    createdAt: string;
    processed: boolean;
  }>;
}

interface LedgerSnapshot {
  user: string;
  availableBalance: string;
  totalBalance: string;
  additionalInfo: string;
}

interface ServiceSnapshot {
  serviceAddress: string;
  serviceType: string;
  version: string;
  fullName: string;
  description: string;
  isRecommended: boolean;
}

interface TestnetSnapshot {
  snapshotName: string;
  timestamp: number;
  blockNumber: number;
  chainId: number;
  contracts: {
    inferenceServing: string;
    ledgerManager: string;
  };
  accounts: AccountSnapshot[];
  ledgers: LedgerSnapshot[];
  services: ServiceSnapshot[];
  userServiceProviders: {
    [user: string]: {
      [serviceAddress: string]: string[]; // providers
    };
  };
  statistics: {
    totalAccounts: number;
    totalLedgers: number;
    totalServices: number;
    accountsWithDirtyRefunds: number;
    totalBalance: string;
    totalPendingRefund: string;
    totalMappings: number;
  };
}

const INFERENCE_SERVING_ABI = [
  "function getAllAccounts(uint256 offset, uint256 limit) view returns (tuple(address user, address provider, uint256 nonce, uint256 balance, uint256 pendingRefund, tuple(uint256 index, uint256 amount, uint256 createdAt, bool processed)[] refunds, string additionalInfo, bool acknowledged, uint256 validRefundsLength, uint256 generation, uint256 revokedBitmap)[] accounts, uint256 total)",
];

const LEDGER_MANAGER_ABI = [
  "function getAllLedgers(uint256 offset, uint256 limit) view returns (tuple(address user, uint256 availableBalance, uint256 totalBalance, string additionalInfo)[] ledgers, uint256 total)",
  "function getAllActiveServices() view returns (tuple(address serviceAddress, address serviceContract, string serviceType, string version, string fullName, string description, bool isRecommended, uint256 registeredAt)[] services)",
  "function getLedgerProviders(address user, string serviceName) view returns (address[] providers)",
];

async function exportTestnetSnapshot() {
  console.log("🚀 Starting testnet data export...\n");
  console.log(`📝 Snapshot name: ${SNAPSHOT_NAME}\n`);

  if (!TESTNET_INFERENCE_ADDRESS || !TESTNET_LEDGER_ADDRESS) {
    throw new Error("❌ Please set environment variables: TESTNET_INFERENCE_ADDRESS and TESTNET_LEDGER_ADDRESS");
  }

  // Connect to testnet
  const provider = new ethers.JsonRpcProvider(TESTNET_RPC);
  const blockNumber = await provider.getBlockNumber();
  const network = await provider.getNetwork();

  console.log(`📡 Connected to testnet: Chain ID ${network.chainId}, Block ${blockNumber}\n`);

  const inferenceServing = new ethers.Contract(TESTNET_INFERENCE_ADDRESS, INFERENCE_SERVING_ABI, provider);
  const ledgerManager = new ethers.Contract(TESTNET_LEDGER_ADDRESS, LEDGER_MANAGER_ABI, provider);

  const snapshot: TestnetSnapshot = {
    snapshotName: SNAPSHOT_NAME,
    timestamp: Date.now(),
    blockNumber,
    chainId: Number(network.chainId),
    contracts: {
      inferenceServing: TESTNET_INFERENCE_ADDRESS,
      ledgerManager: TESTNET_LEDGER_ADDRESS,
    },
    accounts: [],
    ledgers: [],
    services: [],
    userServiceProviders: {},
    statistics: {
      totalAccounts: 0,
      totalLedgers: 0,
      totalServices: 0,
      accountsWithDirtyRefunds: 0,
      totalBalance: "0",
      totalPendingRefund: "0",
      totalMappings: 0,
    },
  };

  const BATCH_SIZE = 50;

  // 1. Export all services
  console.log("📦 Exporting service list...");
  try {
    const services = await ledgerManager.getAllActiveServices();
    for (const service of services) {
      snapshot.services.push({
        serviceAddress: service.serviceAddress,
        serviceType: service.serviceType,
        version: service.version,
        fullName: service.fullName,
        description: service.description,
        isRecommended: service.isRecommended,
      });
    }
    snapshot.statistics.totalServices = services.length;
    console.log(`✅ Exported ${services.length} services\n`);
  } catch (error) {
    console.log(`⚠️  Failed to export services: ${error}\n`);
  }

  // 2. Export all accounts
  console.log("📦 Exporting all accounts...");
  let offset = 0;
  let totalAccounts = 0;
  let accountsWithDirtyRefunds = 0;
  let totalPendingRefund = BigInt(0);

  try {
    const firstBatch = await inferenceServing.getAllAccounts(0, BATCH_SIZE);
    totalAccounts = Number(firstBatch.total);
    console.log(`   Total accounts: ${totalAccounts}`);

    while (offset < totalAccounts) {
      const result = await inferenceServing.getAllAccounts(offset, BATCH_SIZE);
      const accounts = result.accounts;

      for (const account of accounts) {
        interface Refund {
          index: bigint;
          amount: bigint;
          createdAt: bigint;
          processed: boolean;
        }

        const dirtyRefunds = account.refunds.filter((r: Refund) => r.processed);
        if (dirtyRefunds.length > 0) {
          accountsWithDirtyRefunds++;
        }

        const accountSnapshot: AccountSnapshot = {
          user: account.user,
          provider: account.provider,
          nonce: account.nonce.toString(),
          balance: account.balance.toString(),
          pendingRefund: account.pendingRefund.toString(),
          validRefundsLength: Number(account.validRefundsLength),
          generation: account.generation.toString(),
          acknowledged: account.acknowledged,
          additionalInfo: account.additionalInfo,
          refunds: account.refunds.map((r: Refund) => ({
            index: Number(r.index),
            amount: r.amount.toString(),
            createdAt: r.createdAt.toString(),
            processed: r.processed,
          })),
        };

        snapshot.accounts.push(accountSnapshot);
        totalPendingRefund += account.pendingRefund;
      }

      offset += BATCH_SIZE;
      console.log(`   Progress: ${Math.min(offset, totalAccounts)}/${totalAccounts}`);
    }

    snapshot.statistics.totalAccounts = totalAccounts;
    snapshot.statistics.accountsWithDirtyRefunds = accountsWithDirtyRefunds;
    snapshot.statistics.totalPendingRefund = totalPendingRefund.toString();
    console.log(`✅ Exported ${totalAccounts} accounts\n`);
  } catch (error) {
    console.log(`❌ Failed to export accounts: ${error}\n`);
  }

  // 3. Export all Ledgers
  console.log("📦 Exporting all Ledgers...");
  offset = 0;
  let totalLedgers = 0;
  let totalBalance = BigInt(0);

  try {
    const firstBatch = await ledgerManager.getAllLedgers(0, BATCH_SIZE);
    totalLedgers = Number(firstBatch.total);
    console.log(`   Total Ledgers: ${totalLedgers}`);

    while (offset < totalLedgers) {
      const result = await ledgerManager.getAllLedgers(offset, BATCH_SIZE);
      const ledgers = result.ledgers;

      for (const ledger of ledgers) {
        snapshot.ledgers.push({
          user: ledger.user,
          availableBalance: ledger.availableBalance.toString(),
          totalBalance: ledger.totalBalance.toString(),
          additionalInfo: ledger.additionalInfo,
        });

        totalBalance += ledger.totalBalance;
      }

      offset += BATCH_SIZE;
      console.log(`   Progress: ${Math.min(offset, totalLedgers)}/${totalLedgers}`);
    }

    snapshot.statistics.totalLedgers = totalLedgers;
    snapshot.statistics.totalBalance = totalBalance.toString();
    console.log(`✅ Exported ${totalLedgers} Ledgers\n`);
  } catch (error) {
    console.log(`❌ Failed to export Ledgers: ${error}\n`);
  }

  // 4. Export user-service-provider mappings
  console.log("📦 Exporting user-service-provider mappings...");
  let totalMappings = 0;
  try {
    for (const ledger of snapshot.ledgers) {
      snapshot.userServiceProviders[ledger.user] = {};

      for (const service of snapshot.services) {
        try {
          // getLedgerProviders automatically reads from the corresponding mapping based on contract version
          // Before upgrade: reads from old mapping userServiceProviders
          // After upgrade: reads from new mapping userServiceProvidersByAddress
          const providers = await ledgerManager.getLedgerProviders(ledger.user, service.fullName);
          if (providers.length > 0) {
            snapshot.userServiceProviders[ledger.user][service.serviceAddress] = providers;
            totalMappings += providers.length;
          }
        } catch {
          // User has no providers for this service
        }
      }
    }
    snapshot.statistics.totalMappings = totalMappings;
    console.log(`✅ Exported mapping relationships: ${totalMappings}\n`);
  } catch (error) {
    console.log(`⚠️  Partial mapping export failure: ${error}\n`);
  }

  // 6. Save snapshot
  const outputDir = path.join(__dirname, "../../data");
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const filename = `testnet-${SNAPSHOT_NAME}-block-${blockNumber}.json`;
  const filepath = path.join(outputDir, filename);

  fs.writeFileSync(filepath, JSON.stringify(snapshot, null, 2));

  console.log("═══════════════════════════════════════════════════════");
  console.log("✅ Testnet data export complete!");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`📁 File path: ${filepath}`);
  console.log(`📊 Statistics:`);
  console.log(`   - Snapshot name: ${SNAPSHOT_NAME}`);
  console.log(`   - Block height: ${blockNumber}`);
  console.log(`   - Total accounts: ${snapshot.statistics.totalAccounts}`);
  console.log(`   - Total Ledgers: ${snapshot.statistics.totalLedgers}`);
  console.log(`   - Total services: ${snapshot.statistics.totalServices}`);
  console.log(`   - Mapping relationships: ${snapshot.statistics.totalMappings}`);
  console.log(`   - Total balance: ${ethers.formatEther(snapshot.statistics.totalBalance)} 0G`);
  console.log("═══════════════════════════════════════════════════════\n");

  return filepath;
}

if (require.main === module) {
  exportTestnetSnapshot()
    .then((filepath) => {
      console.log(`🎉 Success! Snapshot file: ${filepath}`);
      process.exit(0);
    })
    .catch((error) => {
      console.error("❌ Error:", error);
      process.exit(1);
    });
}

export { exportTestnetSnapshot };
