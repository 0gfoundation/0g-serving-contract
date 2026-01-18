/**
 * Check created mapping relationships on testnet
 */

import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config({ path: path.join(__dirname, ".env") });

const TESTNET_RPC = process.env.TESTNET_RPC || "";
const TESTNET_LEDGER_ADDRESS = process.env.TESTNET_LEDGER_ADDRESS || "";
const SNAPSHOT_FILE = process.env.SNAPSHOT_FILE || "data/mainnet-snapshot-block-21473014.json";

const LEDGER_MANAGER_ABI = [
  "function getLedgerProviders(address user, string serviceName) view returns (address[])",
  "function getAllActiveServices() view returns (tuple(address serviceAddress, address serviceContract, string serviceType, string version, string fullName, string description, bool isRecommended, uint256 registeredAt)[])",
];

interface MainnetSnapshot {
  blockNumber: number;
  userServiceProviders: {
    [user: string]: {
      [serviceAddress: string]: string[];
    };
  };
}

async function checkMappings() {
  console.log("🔍 Checking testnet mapping relationships...\n");

  // Read snapshot
  const snapshot: MainnetSnapshot = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf-8"));

  // Connect to testnet
  const provider = new ethers.JsonRpcProvider(TESTNET_RPC);
  const ledgerManager = new ethers.Contract(TESTNET_LEDGER_ADDRESS, LEDGER_MANAGER_ABI, provider);

  // Get service information
  const services = await ledgerManager.getAllActiveServices();
  const inferenceService = services.find((s: any) => s.serviceType === "inference");
  if (!inferenceService) {
    throw new Error("Inference service not found");
  }

  console.log(`📋 Testnet service: ${inferenceService.fullName}\n`);

  // Generate test wallet address for each mainnet user
  const mainnetUsers = Object.keys(snapshot.userServiceProviders);
  let totalMappings = 0;
  let successfulMappings = 0;

  console.log("═══════════════════════════════════════════════════════");
  console.log("Check Mapping Relationships");
  console.log("═══════════════════════════════════════════════════════\n");

  for (const mainnetUser of mainnetUsers) {
    const seed = ethers.keccak256(ethers.toUtf8Bytes(`test-user-${mainnetUser}`));
    const testWallet = new ethers.Wallet(seed, provider);

    const mainnetProviders = snapshot.userServiceProviders[mainnetUser];
    for (const [serviceAddr, providers] of Object.entries(mainnetProviders)) {
      totalMappings += providers.length;

      // Query providers on testnet
      const testnetProviders = await ledgerManager.getLedgerProviders(
        testWallet.address,
        inferenceService.fullName
      );

      const createdCount = providers.filter((p: string) =>
        testnetProviders.some((tp: string) => tp.toLowerCase() === p.toLowerCase())
      ).length;

      successfulMappings += createdCount;

      if (createdCount > 0) {
        console.log(`👤 ${testWallet.address.substring(0, 10)}...`);
        console.log(`   Mainnet: ${mainnetUser.substring(0, 10)}...`);
        console.log(`   Expected: ${providers.length} providers`);
        console.log(`   Actual: ${createdCount} providers`);
        console.log(`   Status: ${createdCount === providers.length ? "✅ Complete" : "⚠️  Partial"}`);
        console.log();
      }
    }
  }

  console.log("═══════════════════════════════════════════════════════");
  console.log("📊 Statistics");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`Total users: ${mainnetUsers.length}`);
  console.log(`Expected mappings: ${totalMappings}`);
  console.log(`Successful mappings: ${successfulMappings}`);
  console.log(`Failed mappings: ${totalMappings - successfulMappings}`);
  console.log(`Success rate: ${((successfulMappings / totalMappings) * 100).toFixed(1)}%`);
  console.log("═══════════════════════════════════════════════════════\n");
}

if (require.main === module) {
  checkMappings()
    .then(() => {
      console.log("✅ Check complete");
      process.exit(0);
    })
    .catch((error) => {
      console.error("❌ Error:", error);
      process.exit(1);
    });
}

export { checkMappings };
