# Modular Deployment Guide

**Important Note**: Although this repository contains code for multiple services (inference, fine-tuning), each version tag is specific to a particular service. For example, in the `inference-v1` tag, fine-tuning related code should be ignored.

## Scenario 1: Initial Contract Deployment

### 1.1 Deploy LedgerManager

```bash
# Deploy LedgerManager
npx hardhat deploy --tags ledger --network zgTestnetV4

# Verify LedgerManager contract
IMPL=$(cat deployments/zgTestnetV4/LedgerManagerImpl.json | jq -r '.address')
BEACON=$(cat deployments/zgTestnetV4/LedgerManagerBeacon.json | jq -r '.address')
PROXY=$(cat deployments/zgTestnetV4/LedgerManager.json | jq -r '.address')
IMPL_ADDRESS=$IMPL BEACON_ADDRESS=$BEACON PROXY_ADDRESS=$PROXY npx hardhat deploy --tags verify-contracts --network zgTestnetV4

# Import to OpenZeppelin
npx hardhat upgrade:forceImportAll --network zgTestnetV4
```

### 1.2 Deploy Inference v1.0

```bash
# Create version branch
git checkout -b inference-v1.0

# Deploy contract
SERVICE_TYPE=inference SERVICE_VERSION=v1.0 npx hardhat deploy --tags deploy-service --network zgTestnetV4

# Verify contract
IMPL=$(cat deployments/zgTestnetV4/InferenceServing_v1.0Impl.json | jq -r '.address')
BEACON=$(cat deployments/zgTestnetV4/InferenceServing_v1.0Beacon.json | jq -r '.address')
PROXY=$(cat deployments/zgTestnetV4/InferenceServing_v1.0.json | jq -r '.address')
IMPL_ADDRESS=$IMPL BEACON_ADDRESS=$BEACON PROXY_ADDRESS=$PROXY npx hardhat deploy --tags verify-contracts --network zgTestnetV4

# Clean other service deployment files
rm deployments/zgTestnetV4/FineTuningServing_*.json 2>/dev/null || true

# Import to OpenZeppelin
npx hardhat upgrade:forceImportAll --network zgTestnetV4

# Create version info file
cat > VERSION.json << EOF
{
  "service": "inference",
  "version": "v1.0",
  "clientSDK": "v1.0.0",
  "serverImage": "0g-inference:v1.0.0"
}
EOF

# Commit and tag
git add deployments/ .openzeppelin/ VERSION.json
git commit -m "Deploy inference v1.0"
git tag inference-v1.0
```

## Scenario 2: Deploy New Version (inference v2.0)

```bash
# Create new version branch from main
git checkout main
git checkout -b inference-v2.0

# Modify contract code (as needed)

# Deploy new version
SERVICE_TYPE=inference SERVICE_VERSION=v2.0 npx hardhat deploy --tags deploy-service --network zgTestnetV4

# Verify contract
IMPL=$(cat deployments/zgTestnetV4/InferenceServing_v2.0Impl.json | jq -r '.address')
BEACON=$(cat deployments/zgTestnetV4/InferenceServing_v2.0Beacon.json | jq -r '.address')
PROXY=$(cat deployments/zgTestnetV4/InferenceServing_v2.0.json | jq -r '.address')
IMPL_ADDRESS=$IMPL BEACON_ADDRESS=$BEACON PROXY_ADDRESS=$PROXY npx hardhat deploy --tags verify-contracts --network zgTestnetV4

# Clean other version deployment files
rm deployments/zgTestnetV4/InferenceServing_v1.0*.json 2>/dev/null || true
rm deployments/zgTestnetV4/FineTuningServing_*.json 2>/dev/null || true

# Import to OpenZeppelin
npx hardhat upgrade:forceImportAll --network zgTestnetV4

# Update version info file
cat > VERSION.json << EOF
{
  "service": "inference",
  "version": "v2.0",
  "clientSDK": "v2.0.0",
  "serverImage": "0g-inference:v2.0.0"
}
EOF

# Commit and tag
git add deployments/ .openzeppelin/ VERSION.json
git commit -m "Deploy inference v2.0"
git tag inference-v2.0
```

## Scenario 3: Add New Service (fine-tuning v1.0)

```bash
# Create new service branch from main
git checkout main
git checkout -b fine-tuning-v1.0

# Deploy fine-tuning service
SERVICE_TYPE=fine-tuning SERVICE_VERSION=v1.0 npx hardhat deploy --tags deploy-service --network zgTestnetV4

# Verify contract
IMPL=$(cat deployments/zgTestnetV4/FineTuningServing_v1.0Impl.json | jq -r '.address')
BEACON=$(cat deployments/zgTestnetV4/FineTuningServing_v1.0Beacon.json | jq -r '.address')
PROXY=$(cat deployments/zgTestnetV4/FineTuningServing_v1.0.json | jq -r '.address')
IMPL_ADDRESS=$IMPL BEACON_ADDRESS=$BEACON PROXY_ADDRESS=$PROXY npx hardhat deploy --tags verify-contracts --network zgTestnetV4

# Clean other service deployment files
rm deployments/zgTestnetV4/InferenceServing_*.json 2>/dev/null || true

# Import to OpenZeppelin
npx hardhat upgrade:forceImportAll --network zgTestnetV4

# Create version info file
cat > VERSION.json << EOF
{
  "service": "fine-tuning",
  "version": "v1.0",
  "clientSDK": "v1.0.0",
  "serverImage": "0g-fine-tuning:v1.0.0"
}
EOF

# Commit and tag
git add deployments/ .openzeppelin/ VERSION.json
git commit -m "Deploy fine-tuning v1.0"
git tag fine-tuning-v1.0
```

## Scenario 4: Upgrade Specific Version

```bash
# Switch to the version tag to upgrade
git checkout inference-v1.0

# Modify contract code

# Validate upgrade compatibility
npx hardhat upgrade:validate --old InferenceServing_v1.0 --new InferenceServing --network zgTestnetV4

# Execute upgrade
npx hardhat upgrade --name InferenceServing_v1.0 --artifact InferenceServing --execute true --network zgTestnetV4

# Re-import upgraded contracts
npx hardhat upgrade:forceImportAll --network zgTestnetV4

# Update version info (increment patch version)
cat > VERSION.json << EOF
{
  "service": "inference",
  "version": "v1.0",
  "clientSDK": "v1.0.1",
  "serverImage": "0g-inference:v1.0.1"
}
EOF

# Commit upgrade info and create new tag
git add deployments/ .openzeppelin/ VERSION.json
git commit -m "Upgrade inference v1.0 - patch 1"
git tag inference-v1.0-1

# For subsequent upgrades, continue incrementing: inference-v1.0-2, inference-v1.0-3, etc.
```

## Scenario 5: Set Recommended Version

```bash
# Set inference v2.0 as recommended version
SERVICE_TYPE=inference SERVICE_VERSION=v2.0 npx hardhat deploy --tags set-recommended --network zgTestnetV4
```

## Scenario 6: List All Services

```bash
npx hardhat deploy --tags list-services --network zgTestnetV4
```

## Scenario 7: Upgrade LedgerManager (Public Infrastructure)

LedgerManager is public infrastructure shared by all service versions. After upgrading, it needs to be synchronized to all version tags.

```bash
# Modify LedgerManager contract code in main branch
git checkout main

# Validate upgrade compatibility
npx hardhat upgrade:validate --old LedgerManager --new LedgerManager --network zgTestnetV4

# Execute upgrade
npx hardhat upgrade --name LedgerManager --artifact LedgerManager --execute true --network zgTestnetV4

# Commit upgrade to main branch
git add deployments/zgTestnetV4/LedgerManager*.json .openzeppelin/
git commit -m "Upgrade LedgerManager"

# Synchronize LedgerManager upgrade to all version tags
# Execute the following steps for each version tag:

# Step 1: Switch to version tag (e.g., inference-v1.0)
git checkout inference-v1.0

# Step 2: Sync LedgerManager code and files from main branch
git checkout main -- contracts/ledger/
git checkout main -- deployments/zgTestnetV4/LedgerManager*.json

# Step 3: Re-import contracts (using updated LedgerManager)
npx hardhat upgrade:forceImportAll --network zgTestnetV4

# Step 4: Commit updates
git add deployments/ .openzeppelin/
git commit -m "Update LedgerManager after upgrade"

# Repeat the above steps for other version tags: inference-v2.0, fine-tuning-v1.0, etc.

# Return to main branch
git checkout main
```

**Explanation**: LedgerManager as public infrastructure affects all service versions. Therefore, it requires:

1. Execute upgrade in main branch
2. Synchronize upgraded code and deployment files to all version tags
3. Each version re-executes `forceImportAll` to update `.openzeppelin/` information
4. This ensures all versions use the latest LedgerManager

**Important Principles**: For modifications to public infrastructure like LedgerManager, consider the following:

- **Compatibility Assessment**: Evaluate compatibility impact on all existing service versions before modification
- **Full Synchronization**: If modifications affect all versions, update all version tags to the latest modification like LedgerManager
- **Versioning Strategy**: If modifications are incompatible with existing versions, consider creating new public component versions instead of directly modifying existing components
- **Test Coverage**: After modification, test all service versions that depend on the component to ensure functionality is normal