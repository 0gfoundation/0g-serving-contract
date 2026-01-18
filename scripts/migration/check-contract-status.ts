/**
 * Check contract status and permissions
 */

import { ethers } from "ethers";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.join(__dirname, ".env") });

const TESTNET_RPC = process.env.TESTNET_RPC || "";
const TESTNET_PRIVATE_KEY = process.env.TESTNET_PRIVATE_KEY || "";
const TESTNET_LEDGER_ADDRESS = process.env.TESTNET_LEDGER_ADDRESS || "";

const LEDGER_MANAGER_ABI = [
  "function owner() view returns (address)",
  "function migrateUserServiceProvidersMapping(uint256, uint256) returns (uint256, uint256)",
  "function getAllLedgers(uint256 offset, uint256 limit) view returns (tuple(address user, uint256 availableBalance, uint256 totalBalance, string additionalInfo)[] ledgers, uint256 total)",
];

async function checkContractStatus() {
  console.log("🔍 Checking contract status...\n");

  const provider = new ethers.JsonRpcProvider(TESTNET_RPC);
  const wallet = new ethers.Wallet(TESTNET_PRIVATE_KEY, provider);

  console.log(`📡 RPC: ${TESTNET_RPC}`);
  console.log(`💰 Wallet: ${wallet.address}`);
  console.log(`📦 Contract: ${TESTNET_LEDGER_ADDRESS}\n`);

  const ledgerManager = new ethers.Contract(TESTNET_LEDGER_ADDRESS, LEDGER_MANAGER_ABI, provider);

  // 1. Check contract owner
  console.log("1️⃣ Check contract owner...");
  try {
    const owner = await ledgerManager.owner();
    console.log(`   Owner: ${owner}`);
    console.log(`   Current wallet: ${wallet.address}`);
    console.log(`   Matches: ${owner.toLowerCase() === wallet.address.toLowerCase() ? "✅ Yes" : "❌ No"}\n`);
  } catch (error: any) {
    console.log(`   ❌ Unable to get owner: ${error.message}\n`);
  }

  // 2. Check if function exists
  console.log("2️⃣ Check if migration function exists...");
  try {
    // Attempt to estimate gas
    const gasEstimate = await (ledgerManager as any).migrateUserServiceProvidersMapping.estimateGas(0, 1);
    console.log(`   ✅ Function exists, estimated gas: ${gasEstimate}\n`);
  } catch (error: any) {
    console.log(`   ❌ Function call failed: ${error.message}`);

    // Check if it reverts
    if (error.message.includes("revert")) {
      console.log(`   ⚠️  Function exists but reverts, possible reasons:`);
      console.log(`      - Insufficient permissions (not owner)`);
      console.log(`      - Function preconditions not met`);
      console.log(`      - Contract logic has bug\n`);
    } else {
      console.log(`   ⚠️  Function may not exist or ABI mismatch\n`);
    }
  }

  // 3. Check user data
  console.log("3️⃣ Check user data...");
  try {
    const result = await (ledgerManager as any).getAllLedgers(0, 5);
    console.log(`   Total users: ${result.total}`);
    console.log(`   First 5 users:`);
    for (let i = 0; i < Math.min(5, result.ledgers.length); i++) {
      const ledger = result.ledgers[i];
      console.log(`      ${i + 1}. ${ledger.user}`);
    }
    console.log();
  } catch (error: any) {
    console.log(`   ❌ Unable to get user data: ${error.message}\n`);
  }

  // 4. Attempt to call in DRY RUN mode
  console.log("4️⃣ Attempting DRY RUN call (callStatic)...");
  try {
    const ledgerManagerWithWallet = ledgerManager.connect(wallet);
    const result = await (ledgerManagerWithWallet as any).migrateUserServiceProvidersMapping.staticCall(0, 1);
    console.log(`   ✅ DRY RUN successful! Returns: ${result}\n`);
  } catch (error: any) {
    console.log(`   ❌ DRY RUN failed: ${error.message}`);

    // Try to parse revert reason
    if (error.data) {
      console.log(`   Revert data: ${error.data}\n`);
    } else {
      console.log(`   ⚠️  No revert data, possibly out of gas or contract does not exist\n`);
    }
  }
}

if (require.main === module) {
  checkContractStatus()
    .then(() => {
      console.log("✅ Check complete");
      process.exit(0);
    })
    .catch((error) => {
      console.error("❌ Error:", error);
      process.exit(1);
    });
}

export { checkContractStatus };
