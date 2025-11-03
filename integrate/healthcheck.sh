#!/bin/sh

# Check if the deployment marker exists
if [ ! -f "/usr/src/app/deployed.txt" ]; then
  echo "Deployment not yet complete"
  exit 1
fi

# Read deployment addresses from deployment files (if available)
# Default to checking standard deployment addresses
LEDGER_MANAGER_ADDRESS="0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0"

# Function to check if contract is deployed
check_contract() {
  local address=$1
  local name=$2
  
  result=$(curl -s -X POST --data "{
      \"jsonrpc\": \"2.0\",
      \"method\": \"eth_getCode\",
      \"params\": [\"$address\", \"latest\"],
      \"id\": 1
  }" -H "Content-Type: application/json" http://localhost:8545)
  
  if [ -n "$result" ] && echo "$result" | jq -e 'if .result != null and .result != "0x" and (.result | test("^0x[0-9a-fA-F]+$")) then true else false end' > /dev/null; then
    echo "✅ $name deployed at $address"
    return 0
  else
    echo "❌ $name not found at $address"
    return 1
  fi
}

# Check LedgerManager
if ! check_contract "$LEDGER_MANAGER_ADDRESS" "LedgerManager"; then
  echo "Health check failed: LedgerManager not deployed"
  exit 1
fi

# Additional checks can be performed here
# For example, checking if services are registered:
# - Query LedgerManager for registered services
# - Verify recommended services are set

echo "=========================================="
echo "Health check passed!"
echo "All contracts are deployed and accessible"
echo "=========================================="
exit 0