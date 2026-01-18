#!/bin/bash

# ═══════════════════════════════════════════════════════
# Export testnet production environment data
# ═══════════════════════════════════════════════════════

set -e

echo "🚀 Exporting production data from testnet..."
echo ""

# Load testnet configuration
if [ ! -f "scripts/migration/.env.testnet" ]; then
    echo "❌ Error: .env.testnet file not found"
    exit 1
fi

# Execute export using testnet configuration
env $(cat scripts/migration/.env.testnet | grep -v '^#' | xargs) \
  npx ts-node scripts/migration/1-export-mainnet-data.ts

echo ""
echo "✅ Testnet data export complete!"
echo ""
echo "Generated files are in the data/ directory"
echo "Filename format: testnet-snapshot-block-<blockNumber>.json"
