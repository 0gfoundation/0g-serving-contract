/**
 * Check mapping data status on testnet
 */

import { ethers } from "ethers";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.join(__dirname, ".env") });

const TESTNET_RPC = process.env.TESTNET_RPC || "";
const TESTNET_LEDGER_ADDRESS = process.env.TESTNET_LEDGER_ADDRESS || "";

const LEDGER_MANAGER_ABI = [
  "function getAllActiveServices() view returns (tuple(address serviceAddress, address serviceContract, string serviceType, string version, string fullName, string description, bool isRecommended, uint256 registeredAt)[])",
  "function getLedgerProviders(address user, string serviceName) view returns (address[])",
  "function getAllLedgers(uint256 offset, uint256 limit) view returns (tuple(address user, uint256 availableBalance, uint256 totalBalance, string additionalInfo)[] ledgers, uint256 total)",
];

async function checkMappingData() {
  console.log("🔍 Checking mapping data status...\n");

  const provider = new ethers.JsonRpcProvider(TESTNET_RPC);
  const ledgerManager = new ethers.Contract(TESTNET_LEDGER_ADDRESS, LEDGER_MANAGER_ABI, provider);

  // 1. Get service information
  console.log("1️⃣ Check service information...");
  const services = await ledgerManager.getAllActiveServices();
  console.log(`   Service count: ${services.length}`);
  for (const svc of services) {
    console.log(`   - ${svc.serviceType}: ${svc.fullName}`);
    console.log(`     Address: ${svc.serviceAddress}`);
  }
  console.log();

  if (services.length === 0) {
    console.log("❌ No registered services\n");
    return;
  }

  const inferenceService = services[0];

  // 2. Check mappings for first 3 users
  console.log("2️⃣ Check mapping data for first 3 users...");
  const ledgersResult = await ledgerManager.getAllLedgers(0, 3);

  for (let i = 0; i < Math.min(3, ledgersResult.ledgers.length); i++) {
    const user = ledgersResult.ledgers[i].user;
    console.log(`\n   User ${i + 1}: ${user}`);

    // Query new mappings (via getLedgerProviders)
    try {
      const providers = await ledgerManager.getLedgerProviders(user, inferenceService.fullName);
      console.log(`   📊 New mappings (userServiceProvidersByAddress):`);
      console.log(`      Providers: ${providers.length}`);
      for (let j = 0; j < Math.min(5, providers.length); j++) {
        console.log(`         ${j + 1}. ${providers[j]}`);
      }
    } catch (error: any) {
      console.log(`   ❌ Query failed: ${error.message}`);
    }
  }

  console.log();

  // 3. Summary
  console.log("3️⃣ Mapping status summary");
  console.log(`   - Service: ${inferenceService.serviceType} (${inferenceService.fullName})`);
  console.log(`   - ServiceAddress: ${inferenceService.serviceAddress}`);
  console.log(`   - Total users: ${ledgersResult.total}`);
  console.log();

  // 4. Recommendations
  console.log("💡 Recommendations:");
  console.log("   If new mappings have data, migration is complete or data is already in new mappings");
  console.log("   If new mappings are empty, need to check why migration had no effect");
  console.log();
}

if (require.main === module) {
  checkMappingData()
    .then(() => {
      console.log("✅ Check complete");
      process.exit(0);
    })
    .catch((error) => {
      console.error("❌ Error:", error);
      process.exit(1);
    });
}

export { checkMappingData };
