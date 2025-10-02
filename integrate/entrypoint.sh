#!/bin/sh

# Start Hardhat node with detailed logging (no redirect to /dev/null)
echo "Starting Hardhat node with detailed logging..."
npx hardhat node --no-deploy --hostname 0.0.0.0 &

# Start deployment script
/bin/sh /usr/local/bin/deploy.sh &

wait