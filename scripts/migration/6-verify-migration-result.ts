/**
 * Step 6: Verify migration result
 *
 * Features:
 * - Compare testnet data before and after upgrade
 * - Verify old mapping data was correctly migrated to new mapping
 * - Generate detailed comparison report
 *
 * Usage:
 * export BEFORE_SNAPSHOT=data/testnet-before-upgrade-block-12345.json
 * export AFTER_SNAPSHOT=data/testnet-after-migration-block-12346.json
 * npx ts-node scripts/migration/6-verify-migration-result.ts
 */

import fs from "fs";
import path from "path";
import { ethers } from "ethers";

const BEFORE_SNAPSHOT = process.env.BEFORE_SNAPSHOT || "";
const AFTER_SNAPSHOT = process.env.AFTER_SNAPSHOT || "";

interface Snapshot {
  snapshotName: string;
  blockNumber: number;
  chainId: number;
  contracts: {
    inferenceServing: string;
    ledgerManager: string;
  };
  accounts: unknown[];
  ledgers: unknown[];
  services: unknown[];
  userServiceProviders: {
    [user: string]: {
      [serviceAddress: string]: string[];
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

interface VerificationResult {
  summary: {
    beforeBlock: number;
    afterBlock: number;
    mappingsBefore: number;
    mappingsAfter: number;
    migrated: number;
    success: boolean;
  };
  details: {
    missingMappings: Array<{
      user: string;
      service: string;
      providers: string[];
    }>;
    extraMappings: Array<{
      user: string;
      service: string;
      providers: string[];
    }>;
    mismatchedMappings: Array<{
      user: string;
      service: string;
      expectedProviders: string[];
      actualProviders: string[];
    }>;
  };
  userSummary: Array<{
    user: string;
    oldMappings: number;
    newMappings: number;
    matched: boolean;
  }>;
}

async function verifyMigrationResult() {
  console.log("🚀 Starting migration result verification...\n");

  // 1. Check parameters
  if (!BEFORE_SNAPSHOT || !AFTER_SNAPSHOT) {
    throw new Error("❌ Please set environment variables: BEFORE_SNAPSHOT and AFTER_SNAPSHOT");
  }

  if (!fs.existsSync(BEFORE_SNAPSHOT)) {
    throw new Error(`❌ Cannot find before-upgrade snapshot: ${BEFORE_SNAPSHOT}`);
  }

  if (!fs.existsSync(AFTER_SNAPSHOT)) {
    throw new Error(`❌ Cannot find after-upgrade snapshot: ${AFTER_SNAPSHOT}`);
  }

  // 2. Read snapshot
  console.log(`📂 Reading before-upgrade snapshot: ${BEFORE_SNAPSHOT}`);
  const before: Snapshot = JSON.parse(fs.readFileSync(BEFORE_SNAPSHOT, "utf-8"));
  console.log(`   - Block: ${before.blockNumber}`);
  console.log(`   - mapping relationships: ${before.statistics.totalMappings}\n`);

  console.log(`📂 Reading after-upgrade snapshot: ${AFTER_SNAPSHOT}`);
  const after: Snapshot = JSON.parse(fs.readFileSync(AFTER_SNAPSHOT, "utf-8"));
  console.log(`   - Block: ${after.blockNumber}`);
  console.log(`   - mapping relationships: ${after.statistics.totalMappings}\n`);

  const result: VerificationResult = {
    summary: {
      beforeBlock: before.blockNumber,
      afterBlock: after.blockNumber,
      mappingsBefore: before.statistics.totalMappings,
      mappingsAfter: after.statistics.totalMappings,
      migrated: after.statistics.totalMappings - before.statistics.totalMappings,
      success: false,
    },
    details: {
      missingMappings: [],
      extraMappings: [],
      mismatchedMappings: [],
    },
    userSummary: [],
  };

  // 3. User verification
  console.log("═══════════════════════════════════════════════════════");
  console.log("🔍 Starting verification of each user.s mappings...");
  console.log("═══════════════════════════════════════════════════════\n");

  const allUsers = new Set([
    ...Object.keys(before.userServiceProviders),
    ...Object.keys(after.userServiceProviders),
  ]);

  let matchedUsers = 0;
  let mismatchedUsers = 0;

  for (const user of allUsers) {
    const beforeMappingsUser = before.userServiceProviders[user] || {};
    const afterMappingsUser = after.userServiceProviders[user] || {};

    let totalBeforeProviders = 0;
    let totalAfterProviders = 0;
    let userMatched = true;

    // Calculate mapping count for this user
    for (const providers of Object.values(beforeMappingsUser)) {
      totalBeforeProviders += providers.length;
    }

    for (const providers of Object.values(afterMappingsUser)) {
      totalAfterProviders += providers.length;
    }

    // Compare providers for each service
    for (const [serviceAddr, expectedProviders] of Object.entries(beforeMappingsUser)) {
      const actualProviders = afterMappingsUser[serviceAddr] || [];

      // Normalize addresses (lowercase)
      const expectedSet = new Set(expectedProviders.map((p) => p.toLowerCase()));
      const actualSet = new Set(actualProviders.map((p) => p.toLowerCase()));

      // Check if fully matched
      const missing = [...expectedSet].filter((p) => !actualSet.has(p));
      const extra = [...actualSet].filter((p) => !expectedSet.has(p));

      if (missing.length > 0) {
        userMatched = false;
        result.details.missingMappings.push({
          user,
          service: serviceAddr,
          providers: missing,
        });
      }

      if (extra.length > 0) {
        userMatched = false;
        result.details.extraMappings.push({
          user,
          service: serviceAddr,
          providers: extra,
        });
      }

      if (missing.length > 0 || extra.length > 0) {
        result.details.mismatchedMappings.push({
          user,
          service: serviceAddr,
          expectedProviders,
          actualProviders,
        });
      }
    }

    // Check for any additional services after upgrade
    for (const [serviceAddr, actualProviders] of Object.entries(afterMappingsUser)) {
      if (!beforeMappingsUser[serviceAddr]) {
        userMatched = false;
        result.details.extraMappings.push({
          user,
          service: serviceAddr,
          providers: actualProviders,
        });
      }
    }

    result.userSummary.push({
      user,
      oldMappings: totalBeforeProviders,
      newMappings: totalAfterProviders,
      matched: userMatched,
    });

    if (userMatched) {
      matchedUsers++;
      console.log(`✅ ${user}: ${totalBeforeProviders} → ${totalAfterProviders} (matched)`);
    } else {
      mismatchedUsers++;
      console.log(`❌ ${user}: ${totalBeforeProviders} → ${totalAfterProviders} (mismatched)`);
    }
  }

  console.log();

  // 4. Determine overall success
  result.summary.success =
    result.details.missingMappings.length === 0 && result.details.mismatchedMappings.length === 0;

  // 5. Output results
  console.log("═══════════════════════════════════════════════════════");
  console.log(result.summary.success ? "✅ Migration verification successful!" : "❌ Migration verification failed!");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`📊 Overall statistics:`);
  console.log(`   - Block before upgrade: ${result.summary.beforeBlock}`);
  console.log(`   - Block after upgrade: ${result.summary.afterBlock}`);
  console.log(`   - Mappings before upgrade: ${result.summary.mappingsBefore}`);
  console.log(`   - Mappings after upgrade: ${result.summary.mappingsAfter}`);
  console.log(`   - New mappings added: ${result.summary.migrated}`);
  console.log(`\n📊 User verification:`);
  console.log(`   - Total users: ${allUsers.size}`);
  console.log(`   - Matched users: ${matchedUsers}`);
  console.log(`   - Mismatched users: ${mismatchedUsers}`);
  console.log(`   - Success rate: ${((matchedUsers / allUsers.size) * 100).toFixed(1)}%`);

  if (result.details.missingMappings.length > 0) {
    console.log(`\n⚠️  Missing mappings: ${result.details.missingMappings.length} more`);
    for (const item of result.details.missingMappings.slice(0, 5)) {
      console.log(`   - ${item.user} @ ${item.service}: ${item.providers.join(", ")}`);
    }
    if (result.details.missingMappings.length > 5) {
      console.log(`   ... ... and ${result.details.missingMappings.length - 5} more`);
    }
  }

  if (result.details.extraMappings.length > 0) {
    console.log(`\n⚠️  Extra mappings: ${result.details.extraMappings.length} more`);
    for (const item of result.details.extraMappings.slice(0, 5)) {
      console.log(`   - ${item.user} @ ${item.service}: ${item.providers.join(", ")}`);
    }
    if (result.details.extraMappings.length > 5) {
      console.log(`   ... ... and ${result.details.extraMappings.length - 5} more`);
    }
  }

  console.log("═══════════════════════════════════════════════════════\n");

  // 6. Save detailed report
  const reportFile = path.join(__dirname, "../../data", `migration-verification-${Date.now()}.json`);
  fs.writeFileSync(reportFile, JSON.stringify(result, null, 2));
  console.log(`📁 Detailed report: ${reportFile}\n`);

  return result;
}

if (require.main === module) {
  verifyMigrationResult()
    .then((result) => {
      if (result.summary.success) {
        console.log("🎉 Verification successful! Migration data is fully consistent.");
        process.exit(0);
      } else {
        console.log("⚠️  Verification found discrepancies, please check the detailed report.");
        process.exit(1);
      }
    })
    .catch((error) => {
      console.error("❌ Error:", error);
      process.exit(1);
    });
}

export { verifyMigrationResult };
