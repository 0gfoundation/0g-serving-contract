/**
 * Step 1: Export all state data from mainnet
 *
 * Usage:
 * MAINNET_RPC=<url> npx ts-node scripts/migration/1-export-mainnet-data.ts
 */

import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

// Load .env file
dotenv.config({ path: path.join(__dirname, ".env") });

// Mainnet contract addresses (adjust according to actual deployment)
const MAINNET_INFERENCE_SERVING = process.env.MAINNET_INFERENCE_ADDRESS || "";
const MAINNET_LEDGER_MANAGER = process.env.MAINNET_LEDGER_ADDRESS || "";
const MAINNET_RPC = process.env.MAINNET_RPC || "https://evmrpc.0g.ai";

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

interface MainnetSnapshot {
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
  };
}

// ABI fragments
const INFERENCE_SERVING_ABI = [
  "function getAllAccounts(uint256 offset, uint256 limit) view returns (tuple(address user, address provider, uint256 nonce, uint256 balance, uint256 pendingRefund, tuple(uint256 index, uint256 amount, uint256 createdAt, bool processed)[] refunds, string additionalInfo, bool acknowledged, uint256 validRefundsLength, uint256 generation, uint256 revokedBitmap)[] accounts, uint256 total)",
  "function getAccountsByProvider(address provider, uint256 offset, uint256 limit) view returns (tuple(address user, address provider, uint256 nonce, uint256 balance, uint256 pendingRefund, tuple(uint256 index, uint256 amount, uint256 createdAt, bool processed)[] refunds, string additionalInfo, bool acknowledged, uint256 validRefundsLength, uint256 generation, uint256 revokedBitmap)[] accounts, uint256 total)",
];

const LEDGER_MANAGER_ABI = [
  "function getAllLedgers(uint256 offset, uint256 limit) view returns (tuple(address user, uint256 availableBalance, uint256 totalBalance, string additionalInfo)[] ledgers, uint256 total)",
  "function getAllActiveServices() view returns (tuple(address serviceAddress, address serviceContract, string serviceType, string version, string fullName, string description, bool isRecommended, uint256 registeredAt)[] services)",
  "function getLedgerProviders(address user, string serviceName) view returns (address[] providers)",
];

async function exportMainnetData() {
  console.log("🚀 Starting mainnet data export...\n");

  // Connect to mainnet
  const provider = new ethers.JsonRpcProvider(MAINNET_RPC);
  const blockNumber = await provider.getBlockNumber();
  const network = await provider.getNetwork();

  console.log(`📡 Connected to mainnet: Chain ID ${network.chainId}, Block ${blockNumber}\n`);

  if (!MAINNET_INFERENCE_SERVING || !MAINNET_LEDGER_MANAGER) {
    throw new Error("❌ Please set environment variables: MAINNET_INFERENCE_ADDRESS and MAINNET_LEDGER_ADDRESS");
  }

  const inferenceServing = new ethers.Contract(MAINNET_INFERENCE_SERVING, INFERENCE_SERVING_ABI, provider);
  const ledgerManager = new ethers.Contract(MAINNET_LEDGER_MANAGER, LEDGER_MANAGER_ABI, provider);

  const snapshot: MainnetSnapshot = {
    timestamp: Date.now(),
    blockNumber,
    chainId: Number(network.chainId),
    contracts: {
      inferenceServing: MAINNET_INFERENCE_SERVING,
      ledgerManager: MAINNET_LEDGER_MANAGER,
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
    },
  };

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

  // 2. Export all accounts (paginated)
  console.log("📦 Exporting all accounts...");
  const BATCH_SIZE = 50;
  let offset = 0;
  let totalAccounts = 0;
  let accountsWithDirtyRefunds = 0;
  let totalPendingRefund = BigInt(0);

  try {
    // Get total count first
    const firstBatch = await inferenceServing.getAllAccounts(0, BATCH_SIZE);
    totalAccounts = Number(firstBatch.total);
    console.log(`   Total accounts: ${totalAccounts}`);

    // Export in batches
    while (offset < totalAccounts) {
      const result = await inferenceServing.getAllAccounts(offset, BATCH_SIZE);
      const accounts = result.accounts;

      for (const account of accounts) {
        // Check if there are dirty refunds (processed=true)
        const dirtyRefunds = account.refunds.filter((r: any) => r.processed);
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
          refunds: account.refunds.map((r: any) => ({
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
      console.log(`   Progress: ${Math.min(offset, totalAccounts)}/${totalAccounts} (${Math.floor((offset / totalAccounts) * 100)}%)`);
    }

    snapshot.statistics.totalAccounts = totalAccounts;
    snapshot.statistics.accountsWithDirtyRefunds = accountsWithDirtyRefunds;
    snapshot.statistics.totalPendingRefund = totalPendingRefund.toString();
    console.log(`✅ Exported ${totalAccounts} accounts (${accountsWithDirtyRefunds} with dirty refunds)\n`);
  } catch (error) {
    console.log(`❌ Failed to export accounts: ${error}\n`);
  }

  // 3. Export all Ledgers (paginated)
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
      console.log(`   Progress: ${Math.min(offset, totalLedgers)}/${totalLedgers} (${Math.floor((offset / totalLedgers) * 100)}%)`);
    }

    snapshot.statistics.totalLedgers = totalLedgers;
    snapshot.statistics.totalBalance = totalBalance.toString();
    console.log(`✅ Exported ${totalLedgers} Ledgers\n`);
  } catch (error) {
    console.log(`❌ Failed to export Ledgers: ${error}\n`);
  }

  // 4. Export user-service-provider mappings (requires iterating through each user and service)
  console.log("📦 Exporting user-service-provider mappings...");
  try {
    for (const ledger of snapshot.ledgers) {
      snapshot.userServiceProviders[ledger.user] = {};

      for (const service of snapshot.services) {
        try {
          const providers = await ledgerManager.getLedgerProviders(ledger.user, service.fullName);
          if (providers.length > 0) {
            snapshot.userServiceProviders[ledger.user][service.serviceAddress] = providers;
          }
        } catch (error) {
          // User may not have providers for this service
        }
      }
    }
    console.log(`✅ User-service-provider mapping export complete\n`);
  } catch (error) {
    console.log(`⚠️  Partial mapping export failure: ${error}\n`);
  }

  // 5. Save snapshot
  const outputDir = path.join(__dirname, "../../data");
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Determine network type based on chainId
  const networkName =
    network.chainId === BigInt(16661)
      ? "mainnet"
      : network.chainId === BigInt(16600) || network.chainId === BigInt(16602)
      ? "testnet"
      : `chain-${network.chainId}`;

  const filename = `${networkName}-snapshot-block-${blockNumber}.json`;
  const filepath = path.join(outputDir, filename);

  fs.writeFileSync(filepath, JSON.stringify(snapshot, null, 2));

  console.log("═══════════════════════════════════════════════════════");
  console.log("✅ Data export complete!");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`📁 File path: ${filepath}`);
  console.log(`📊 Statistics:`);
  console.log(`   - Block height: ${blockNumber}`);
  console.log(`   - Total accounts: ${snapshot.statistics.totalAccounts}`);
  console.log(`   - Total Ledgers: ${snapshot.statistics.totalLedgers}`);
  console.log(`   - Total services: ${snapshot.statistics.totalServices}`);
  console.log(`   - Accounts with dirty refunds: ${snapshot.statistics.accountsWithDirtyRefunds}`);
  console.log(`   - Total balance: ${ethers.formatEther(snapshot.statistics.totalBalance)} 0G`);
  console.log(`   - Total pending refund: ${ethers.formatEther(snapshot.statistics.totalPendingRefund)} 0G`);
  console.log("═══════════════════════════════════════════════════════\n");

  return filepath;
}

// Execute
if (require.main === module) {
  exportMainnetData()
    .then((filepath) => {
      console.log(`🎉 Success! Snapshot file: ${filepath}`);
      process.exit(0);
    })
    .catch((error) => {
      console.error("❌ Error:", error);
      process.exit(1);
    });
}

export { exportMainnetData };
