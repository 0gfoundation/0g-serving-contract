/**
 * Check prerequisites for executing Step 2
 */

import { ethers } from "ethers";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.join(__dirname, ".env") });

const TESTNET_RPC = process.env.TESTNET_RPC || "";
const TESTNET_PRIVATE_KEY = process.env.TESTNET_PRIVATE_KEY || "";
const TESTNET_LEDGER_ADDRESS = process.env.TESTNET_LEDGER_ADDRESS || "";

const LEDGER_MANAGER_ABI = [
  "function getAllActiveServices() view returns (tuple(address serviceAddress, address serviceContract, string serviceType, string version, string fullName, string description, bool isRecommended, uint256 registeredAt)[])",
];

async function checkPrerequisites() {
  console.log("🔍 Checking prerequisites...\n");

  // 1. Check RPC connection
  console.log("1️⃣ Check testnet RPC connection...");
  try {
    const provider = new ethers.JsonRpcProvider(TESTNET_RPC);
    const network = await provider.getNetwork();
    const blockNumber = await provider.getBlockNumber();
    console.log(`   ✅ Connection successful: Chain ${network.chainId}, Block ${blockNumber}\n`);

    // 2. Check Owner wallet balance
    console.log("2️⃣ Check Owner wallet balance...");
    const owner = new ethers.Wallet(TESTNET_PRIVATE_KEY, provider);
    const balance = await provider.getBalance(owner.address);
    const balanceInEther = ethers.formatEther(balance);
    console.log(`   💰 Owner: ${owner.address}`);
    console.log(`   💰 Balance: ${balanceInEther} 0G`);

    const requiredBalance = 200;
    if (parseFloat(balanceInEther) < requiredBalance) {
      console.log(`   ⚠️  Warning: Insufficient balance ${requiredBalance} 0G, may not be able to complete reconstruction\n`);
    } else {
      console.log(`   ✅ Balance sufficient\n`);
    }

    // 3. Check service registration
    console.log("3️⃣ Check testnet service registration...");
    const ledgerManager = new ethers.Contract(TESTNET_LEDGER_ADDRESS, LEDGER_MANAGER_ABI, provider);
    const services = await ledgerManager.getAllActiveServices();

    if (services.length === 0) {
      console.log(`   ❌ No services registered on testnet\n`);
      console.log(`   ⚠️  Need to register InferenceServing service before executing Step 2\n`);
      return false;
    }

    console.log(`   ✅ Registered ${services.length} services:`);
    for (const svc of services) {
      console.log(`      - ${svc.serviceType}: ${svc.fullName}`);
    }
    console.log();

    // 4. Check snapshot file
    console.log("4️⃣ Check snapshot file...");
    const snapshotFile = process.env.SNAPSHOT_FILE || "data/mainnet-snapshot-block-21473014.json";
    const fs = require("fs");
    if (fs.existsSync(snapshotFile)) {
      console.log(`   ✅ Snapshot file exists: ${snapshotFile}\n`);
    } else {
      console.log(`   ❌ Snapshot file does not exist: ${snapshotFile}\n`);
      return false;
    }

    console.log("═══════════════════════════════════════════════════════");
    console.log("✅ All prerequisite checks passed！");
    console.log("═══════════════════════════════════════════════════════\n");
    console.log("📋 Can execute Step 2:");
    console.log("   export SNAPSHOT_FILE=data/mainnet-snapshot-block-21473014.json");
    console.log("   npx ts-node scripts/migration/2-rebuild-userServiceProviders-v2.ts\n");

    return true;
  } catch (error: any) {
    console.error(`   ❌ Error: ${error.message}\n`);
    return false;
  }
}

if (require.main === module) {
  checkPrerequisites()
    .then((success) => {
      process.exit(success ? 0 : 1);
    })
    .catch((error) => {
      console.error("❌ Check failed:", error);
      process.exit(1);
    });
}

export { checkPrerequisites };
