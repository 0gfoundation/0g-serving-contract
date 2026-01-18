/**
 * Step 2: Rebuild mapping relationships on testnet
 *
 * Features:
 * - Smart detection of existing mappings, only creates missing ones
 * - Automatically handles insufficient balance (tops up to 1 0G)
 * - Supports incremental execution and resume from interruption
 *
 * Usage:
 * export SNAPSHOT_FILE=data/mainnet-snapshot-block-21473014.json
 * npx ts-node scripts/migration/2-rebuild-mappings.ts
 */

import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config({ path: path.join(__dirname, ".env") });

const TESTNET_RPC = process.env.TESTNET_RPC || "https://evmrpc-testnet.0g.ai";
const TESTNET_PRIVATE_KEY = process.env.TESTNET_PRIVATE_KEY || "";
const TESTNET_LEDGER_MANAGER = process.env.TESTNET_LEDGER_ADDRESS || "";
const SNAPSHOT_FILE = process.env.SNAPSHOT_FILE || "";

interface MainnetSnapshot {
  blockNumber: number;
  userServiceProviders: {
    [user: string]: {
      [serviceAddress: string]: string[];
    };
  };
  services: Array<{
    serviceAddress: string;
    serviceType: string;
  }>;
  accounts: Array<{
    user: string;
    provider: string;
    balance: string;
  }>;
  ledgers: Array<{
    user: string;
    balance: string;
  }>;
}

const LEDGER_MANAGER_ABI = [
  "function depositFundFor(address user) payable",
  "function transferFund(address provider, string serviceName, uint256 amount)",
  "function getLedgerProviders(address user, string serviceName) view returns (address[])",
  "function getAllActiveServices() view returns (tuple(address serviceAddress, address serviceContract, string serviceType, string version, string fullName, string description, bool isRecommended, uint256 registeredAt)[])",
  "function getLedger(address user) view returns (tuple(address user, uint256 availableBalance, uint256 totalBalance, string additionalInfo))",
];

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rebuildMappings() {
  console.log("🚀 Rebuilding mapping relationships on testnet...\n");

  // 1. Check parameters
  if (!TESTNET_PRIVATE_KEY || !SNAPSHOT_FILE) {
    throw new Error("❌ Missing required environment variables");
  }

  // 2. Read snapshot
  console.log(`📂 Reading snapshot: ${SNAPSHOT_FILE}`);
  const snapshot: MainnetSnapshot = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf-8"));
  console.log(`✅ Snapshot from block ${snapshot.blockNumber}`);
  console.log(`   - ${Object.keys(snapshot.userServiceProviders).length} users`);
  console.log(`   - ${snapshot.ledgers.length} Ledgers`);
  console.log(`   - ${snapshot.accounts.length} accounts\n`);

  // 3. Connect to testnet
  const provider = new ethers.JsonRpcProvider(TESTNET_RPC);
  const owner = new ethers.Wallet(TESTNET_PRIVATE_KEY, provider);
  console.log(`📡 Testnet connection successful`);
  console.log(`💰 Owner: ${owner.address}\n`);

  const ledgerManager = new ethers.Contract(TESTNET_LEDGER_MANAGER, LEDGER_MANAGER_ABI, owner);

  // 4. Get service mapping
  console.log("🔍 Checking testnet services...");
  const testnetServices = await ledgerManager.getAllActiveServices();
  const serviceMapping: { [mainnetAddr: string]: string } = {};
  for (const ts of testnetServices) {
    const ms = snapshot.services.find((s) => s.serviceType === ts.serviceType);
    if (ms) {
      serviceMapping[ms.serviceAddress] = ts.fullName;
      console.log(`   ✅ ${ts.serviceType} => ${ts.fullName}`);
    }
  }
  console.log();

  if (Object.keys(serviceMapping).length === 0) {
    throw new Error("❌ No matching services on testnet");
  }

  // 5. Statistics
  const stats = {
    phase1: { ledgersCreated: 0, ledgersSkipped: 0, failed: 0 },
    phase2: { mappingsCreated: 0, mappingsSkipped: 0, failed: 0 },
  };

  console.log("═══════════════════════════════════════════════════════");
  console.log("📦 Phase 1: Create Ledgers");
  console.log("═══════════════════════════════════════════════════════\n");

  // 6. Create Ledger for each user
  const userWallets = new Map<string, ethers.Wallet>();

  for (let i = 0; i < snapshot.ledgers.length; i++) {
    const mainnetUser = snapshot.ledgers[i].user;

    // Generate deterministic test wallet
    const seed = ethers.keccak256(ethers.toUtf8Bytes(`test-user-${mainnetUser}`));
    const testWallet = new ethers.Wallet(seed, provider);
    userWallets.set(mainnetUser, testWallet);

    console.log(`👤 User ${i + 1}/${snapshot.ledgers.length}`);
    console.log(`   Mainnet: ${mainnetUser}`);
    console.log(`   Testnet: ${testWallet.address}`);

    // Check if Ledger already exists
    try {
      const existingLedger = await ledgerManager.getLedger(testWallet.address);
      if (existingLedger.user !== ethers.ZeroAddress) {
        const currentBalance = existingLedger.availableBalance;
        console.log(`   ✅ Ledger exists: ${ethers.formatEther(currentBalance)} 0G`);

        // Calculate expected total provider count
        const userServices = snapshot.userServiceProviders[mainnetUser] || {};
        let expectedProviderCount = 0;
        for (const providers of Object.values(userServices)) {
          expectedProviderCount += providers.length;
        }

        // Check current provider count
        let currentProviderCount = 0;
        for (const [mainnetSvcAddr] of Object.entries(userServices)) {
          const serviceName = serviceMapping[mainnetSvcAddr];
          if (serviceName) {
            try {
              const existingProviders = await ledgerManager.getLedgerProviders(testWallet.address, serviceName);
              currentProviderCount += existingProviders.length;
            } catch {
              // Service not found, skip
            }
          }
        }

        console.log(`   📊 Providers: ${currentProviderCount}/${expectedProviderCount} (current/expected)`);

        // If current provider count equals expected count, skip
        if (currentProviderCount === expectedProviderCount) {
          console.log(`   ✅ All Providers created, skipping`);
        } else {
          // Calculate needed additional balance (expected - current - availableBalance + buffer)
          const buffer = 1;
          const currentBalanceInEther = Number(ethers.formatEther(currentBalance));
          const neededBalance = expectedProviderCount - currentProviderCount - currentBalanceInEther + buffer;

          if (neededBalance > 0) {
            console.log(`   💰 Top-up needed: ${neededBalance.toFixed(1)} 0G (${expectedProviderCount} - ${currentProviderCount} - ${currentBalanceInEther.toFixed(1)} + ${buffer})`);
            try {
              const topUpTx = await ledgerManager.depositFundFor(testWallet.address, {
                value: ethers.parseEther(neededBalance.toFixed(18)),
                gasLimit: 500000,
              });
              await topUpTx.wait();
              console.log(`   ✅ Top-up complete: ${neededBalance.toFixed(1)} 0G`);
              await delay(500);
            } catch (error) {
              console.log(`   ⚠️  Top-up failed: ${error instanceof Error ? error.message : String(error)}`);
            }
          } else {
            console.log(`   ✅ Balance sufficient, no top-up needed`);
          }
        }

        stats.phase1.ledgersSkipped++;
        console.log();
        continue;
      }
    } catch {
      // Ledger does not exist, continue creation
    }

    // Calculate initial deposit amount (expected - 0 - 0 + buffer)
    const userServices = snapshot.userServiceProviders[mainnetUser] || {};
    let expectedProviderCount = 0;
    for (const providers of Object.values(userServices)) {
      expectedProviderCount += providers.length;
    }

    const buffer = 1;
    const initialBalance = expectedProviderCount + buffer;
    const balance = ethers.parseEther(initialBalance.toString());

    console.log(`   📊 Expected Providers: ${expectedProviderCount}`);
    console.log(`   💰 Initial deposit: ${initialBalance} 0G (${expectedProviderCount} + ${buffer} buffer)`);

    // Create Ledger
    try {
      const tx = await ledgerManager.depositFundFor(testWallet.address, {
        value: balance,
        gasLimit: 500000,
      });
      await tx.wait();
      console.log(`   ✅ Ledger created successfully`);
      stats.phase1.ledgersCreated++;

      // Fund test wallet with gas
      const gasTx = await owner.sendTransaction({
        to: testWallet.address,
        value: ethers.parseEther("0.5"),
      });
      await gasTx.wait();
      console.log(`   ✅ Gas funded: 0.5 0G\n`);

      await delay(500);
    } catch (error) {
      console.log(`   ❌ Creation failed: ${error instanceof Error ? error.message : String(error)}\n`);
      stats.phase1.failed++;
    }
  }

  console.log(`✅ Phase 1 complete: ${stats.phase1.ledgersCreated} created, ${stats.phase1.ledgersSkipped} skipped, ${stats.phase1.failed} failed\n`);

  console.log("═══════════════════════════════════════════════════════");
  console.log("📦 Phase 2: Create Mapping Relationships");
  console.log("═══════════════════════════════════════════════════════\n");

  // 7. Create mapping relationships
  for (const [mainnetUser, services] of Object.entries(snapshot.userServiceProviders)) {
    const testWallet = userWallets.get(mainnetUser);
    if (!testWallet) {
      console.log(`⚠️  Skipping user ${mainnetUser} (no test wallet)\n`);
      continue;
    }

    console.log(`👤 ${testWallet.address}`);
    console.log(`   Mainnet: ${mainnetUser}`);

    const userLedgerManager = new ethers.Contract(TESTNET_LEDGER_MANAGER, LEDGER_MANAGER_ABI, testWallet);

    for (const [mainnetSvcAddr, providers] of Object.entries(services)) {
      const serviceName = serviceMapping[mainnetSvcAddr];
      if (!serviceName) {
        console.log(`   ⚠️  Skipping service ${mainnetSvcAddr}`);
        continue;
      }

      // Get existing providers
      const existingProviders = await ledgerManager.getLedgerProviders(testWallet.address, serviceName);
      console.log(`   📋 ${serviceName}: ${providers.length} providers (existing: ${existingProviders.length})`);

      for (const provider of providers) {
        // Check if already exists
        const exists = existingProviders.some((p: string) => p.toLowerCase() === provider.toLowerCase());
        if (exists) {
          console.log(`      ➜ ${provider}: ✅ Already exists`);
          stats.phase2.mappingsSkipped++;
          continue;
        }

        try {
          const amount =  ethers.parseEther("1.1");

          // Call transferFund to create mapping
          const tx = await userLedgerManager.transferFund(provider, serviceName, amount, {
            gasLimit: 2000000,
          });
          await tx.wait();
          stats.phase2.mappingsCreated++;
          console.log(`         ✅ Created successfully`);

          await delay(500);
        } catch (error) {
          stats.phase2.failed++;
          const errorMsg = error instanceof Error ? error.message.split('\n')[0] : String(error);
          console.log(`         ❌ ${errorMsg}`);
        }
      }
    }
    console.log();
  }

  console.log(`✅ Phase 2 complete: ${stats.phase2.mappingsCreated} created, ${stats.phase2.mappingsSkipped} skipped, ${stats.phase2.failed} failed\n`);

  // 8. Summary
  console.log("═══════════════════════════════════════════════════════");
  console.log("✅ Reconstruction complete!");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`📊 Ledgers:`);
  console.log(`   - Created: ${stats.phase1.ledgersCreated}`);
  console.log(`   - Already exists: ${stats.phase1.ledgersSkipped}`);
  console.log(`   - Failed: ${stats.phase1.failed}`);
  console.log(`\n📊 Mapping relationships:`);
  console.log(`   - Created: ${stats.phase2.mappingsCreated}`);
  console.log(`   - Already exists: ${stats.phase2.mappingsSkipped}`);
  console.log(`   - Failed: ${stats.phase2.failed}`);
  console.log("═══════════════════════════════════════════════════════\n");

  // 9. Save user mapping table
  const mapping: { [mainnetAddr: string]: string } = {};
  for (const [mainnet, wallet] of userWallets.entries()) {
    mapping[mainnet] = wallet.address;
  }

  const mappingFile = path.join(__dirname, "../../data", `testnet-user-mapping-${Date.now()}.json`);
  fs.writeFileSync(mappingFile, JSON.stringify({ mapping, stats }, null, 2));
  console.log(`📁 User mapping table: ${mappingFile}\n`);

  return stats;
}

if (require.main === module) {
  rebuildMappings()
    .then(() => {
      console.log("🎉 Complete!");
      process.exit(0);
    })
    .catch((error) => {
      console.error("❌ Error:", error);
      process.exit(1);
    });
}

export { rebuildMappings };
