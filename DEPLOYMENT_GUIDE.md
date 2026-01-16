# Modular Deployment Guide

## Overview

### Architecture

The 0G Compute Network's smart contract architecture consists of:

- **One LedgerManager Contract**: Manages user accounts and balances across the entire network
- **Multiple Service Contracts**: Each service (e.g., inference, fine-tuning) can have multiple versions deployed independently

This modular design ensures users can use a unified account to pay for any current or future services added to the compute network.

### Branch Management Strategy

#### Branch Structure

- **main branch**: Contains only the latest, actively developed code for all services
- **release/{service-name}-v{version} branches**: Long-term maintenance branches for each deployed service version
  - Example: `release/inference-v1`, `release/inference-v2`, `release/fine-tuning-v1`
  - Created when a service version is deployed and requires ongoing maintenance
  - Used for patches, upgrades, and version-specific fixes

#### Service Versioning Convention

When deploying new service versions, follow this naming convention:

- Format: `{service-name}-v{version-number}`
- Example: `inference-v1`, `inference-v2`, `fine-tuning-v1`
- Version numbers should increment sequentially (v1, v2, v3...)

### When to Deploy New Service Versions

A new service version should only be deployed when:

- Storage layout breaking changes are required
- Fundamental architectural changes cannot be achieved through upgrades

Each service version:

- Has its own independent contract
- Maintains isolated providers
- Does not share state with other versions

### Release Process for New Service Versions

When releasing a new service version, follow these steps:

1. **Deploy and Verify Contracts**
   - Deploy contracts on both testnet and mainnet
   - Verify all deployed contracts

2. **Clean Deployment Directory**
   - Ensure only the current service version and LedgerManager files exist in the deployments directory

3. **Save Storage Layout**
   - Run `npx hardhat upgrade:forceImportAll` for both testnet and mainnet
   - Export storage layout information to the `.openzeppelin` directory

4. **Update VERSION.json**
   - Document compatible client SDK versions
   - Document compatible serving image versions

   ```json
   {
     "service": "inference",
     "version": "v1",
     "compatibleClientSDKs": ["v1.0.0", "v1.0.1"],
     "compatibleServingImages": ["0g-inference:v1.0.0", "0g-inference:v1.0.1"]
   }
   ```

5. **Create Release Branch**
   - Commit all changes to the main branch
   - Create a release branch for long-term maintenance: `release/{service-name}-v{version}`
   - Example: `git checkout -b release/inference-v1`
   - Push the branch to remote: `git push -u origin release/inference-v1`
   - Note: Each release branch represents a specific service version in production

### Contract Upgrade Strategy

#### When to Upgrade vs Deploy New Version

- **Upgrade**: When changes don't affect storage layout
- **New Version**: When storage layout changes are required

#### Upgrade Guidelines

1. **Service Contract Upgrades**
   - Follow steps in "Scenario 4: Upgrade Specific Version"
   - Only affects the specific service version

2. **LedgerManager Upgrades**
   - LedgerManager can only be upgraded, never redeployed
   - Requires extreme caution as it affects all services
   - After upgrading, update ALL service release branches (see "Scenario 7: Upgrade LedgerManager")

### Code Modification Workflow

1. **Bug Fixes for Deployed Service Version**
   - Switch to the relevant release branch: `git checkout release/inference-v1`
   - Apply the fix and test thoroughly
   - Upgrade the corresponding contract if needed
   - Commit changes to the release branch
   - Cherry-pick or merge the fix to main branch if modified the latest service version

2. **Deploy New Service Version**
    - Work from the main branch
    - Implement new features or changes
    - Follow the release process for new service versions

3. **Common/Shared Code Changes (e.g., LedgerManager updates)**
   - First update and test on main branch
   - Apply changes to ALL active release branches
   - Upgrade affected contracts in each branch
   - Coordinate upgrades across all affected services

4. **Supporting Component Updates**
   - When client SDK or serving images are updated
   - Update VERSION.json in affected release branches

**Important Note**: The main branch contains code for all services. Each release branch (e.g., `release/inference-v1`) is specific to a particular service version. Code for other services in a release branch should be considered inactive and not modified.

Follow the scenarios below for detailed deployment and upgrade steps. And here we use zgTestnetMigrate as the target network for all commands as examples.

## Scenario 1: Initial Contract Deployment

### 1.1 Deploy LedgerManager

```bash
# Deploy LedgerManager
npx hardhat deploy --tags ledger --network zgTestnetMigrate

# Verify LedgerManager contract
IMPL=$(cat deployments/zgTestnetMigrate/LedgerManagerImpl.json | jq -r '.address')
BEACON=$(cat deployments/zgTestnetMigrate/LedgerManagerBeacon.json | jq -r '.address')
PROXY=$(cat deployments/zgTestnetMigrate/LedgerManager.json | jq -r '.address')
IMPL_ADDRESS=$IMPL BEACON_ADDRESS=$BEACON PROXY_ADDRESS=$PROXY npx hardhat deploy --tags verify-contracts --network zgTestnetMigrate

# Import to OpenZeppelin
npx hardhat upgrade:forceImportAll --network zgTestnetMigrate
```

### 1.2 Deploy Inference v1.0

```bash
# Work from main branch
git checkout main

# Deploy contract
SERVICE_TYPE=inference SERVICE_VERSION=v1.0 npx hardhat deploy --tags deploy-service --network zgTestnetMigrate

# Verify contract
IMPL=$(cat deployments/zgTestnetMigrate/InferenceServing_v1.0Impl.json | jq -r '.address')
BEACON=$(cat deployments/zgTestnetMigrate/InferenceServing_v1.0Beacon.json | jq -r '.address')
PROXY=$(cat deployments/zgTestnetMigrate/InferenceServing_v1.0.json | jq -r '.address')
IMPL_ADDRESS=$IMPL BEACON_ADDRESS=$BEACON PROXY_ADDRESS=$PROXY npx hardhat deploy --tags verify-contracts --network zgTestnetMigrate

# Clean other service deployment files
rm deployments/zgTestnetMigrate/FineTuningServing_*.json 2>/dev/null || true

# Import to OpenZeppelin
npx hardhat upgrade:forceImportAll --network zgTestnetMigrate

# Create version info file
cat > VERSION.json << EOF
{
  "service": "inference",
  "version": "v1.0",
  "compatibleClientSDKs": ["v1.0.0"],
  "compatibleServingImages": ["0g-inference:v1.0.0"]
}
EOF

# Commit to main branch
git add deployments/ .openzeppelin/ VERSION.json
git commit -m "Deploy inference v1.0"

# Create release branch for long-term maintenance
git checkout -b release/inference-v1.0
git push -u origin release/inference-v1.0

# Return to main branch
git checkout main
```

## Scenario 2: Deploy New Version (inference v2.0)

```bash
# Work from main branch
git checkout main

# Modify contract code (as needed)

# Deploy new version
SERVICE_TYPE=inference SERVICE_VERSION=v2.0 npx hardhat deploy --tags deploy-service --network zgTestnetMigrate

# Verify contract
IMPL=$(cat deployments/zgTestnetMigrate/InferenceServing_v2.0Impl.json | jq -r '.address')
BEACON=$(cat deployments/zgTestnetMigrate/InferenceServing_v2.0Beacon.json | jq -r '.address')
PROXY=$(cat deployments/zgTestnetMigrate/InferenceServing_v2.0.json | jq -r '.address')
IMPL_ADDRESS=$IMPL BEACON_ADDRESS=$BEACON PROXY_ADDRESS=$PROXY npx hardhat deploy --tags verify-contracts --network zgTestnetMigrate

# Clean other version deployment files
rm deployments/zgTestnetMigrate/InferenceServing_v1.0*.json 2>/dev/null || true
rm deployments/zgTestnetMigrate/FineTuningServing_*.json 2>/dev/null || true

# Import to OpenZeppelin
npx hardhat upgrade:forceImportAll --network zgTestnetMigrate

# Update version info file
cat > VERSION.json << EOF
{
  "service": "inference",
  "version": "v2.0",
  "compatibleClientSDKs": ["v2.0.0"],
  "compatibleServingImages": ["0g-inference:v2.0.0"]
}
EOF

# Commit to main branch
git add deployments/ .openzeppelin/ VERSION.json
git commit -m "Deploy inference v2.0"

# Create release branch for long-term maintenance
git checkout -b release/inference-v2.0
git push -u origin release/inference-v2.0

# Return to main branch
git checkout main
```

## Scenario 3: Add New Service (fine-tuning v1.0)

```bash
# Work from main branch
git checkout main

# Deploy fine-tuning service
SERVICE_TYPE=fine-tuning SERVICE_VERSION=v1.0 npx hardhat deploy --tags deploy-service --network zgTestnetMigrate

# Verify contract
IMPL=$(cat deployments/zgTestnetMigrate/FineTuningServing_v1.0Impl.json | jq -r '.address')
BEACON=$(cat deployments/zgTestnetMigrate/FineTuningServing_v1.0Beacon.json | jq -r '.address')
PROXY=$(cat deployments/zgTestnetMigrate/FineTuningServing_v1.0.json | jq -r '.address')
IMPL_ADDRESS=$IMPL BEACON_ADDRESS=$BEACON PROXY_ADDRESS=$PROXY npx hardhat deploy --tags verify-contracts --network zgTestnetMigrate

# Clean other service deployment files
rm deployments/zgTestnetMigrate/InferenceServing_*.json 2>/dev/null || true

# Import to OpenZeppelin
npx hardhat upgrade:forceImportAll --network zgTestnetMigrate

# Create version info file
cat > VERSION.json << EOF
{
  "service": "fine-tuning",
  "version": "v1.0",
  "compatibleClientSDKs": ["v1.0.0"],
  "compatibleServingImages": ["0g-fine-tuning:v1.0.0"]
}
EOF

# Commit to main branch
git add deployments/ .openzeppelin/ VERSION.json
git commit -m "Deploy fine-tuning v1.0"

# Create release branch for long-term maintenance
git checkout -b release/fine-tuning-v1.0
git push -u origin release/fine-tuning-v1.0

# Return to main branch
git checkout main
```

## Scenario 4: Upgrade Specific Version

```bash
# Switch to the release branch for the specific version
git checkout release/inference-v1.0

# Modify contract code

# Validate upgrade compatibility
npx hardhat upgrade:validate --old InferenceServing_v1.0 --new InferenceServing --network zgTestnetMigrate

# Execute upgrade
npx hardhat upgrade --name InferenceServing_v1.0 --artifact InferenceServing --execute true --network zgTestnetMigrate

IMPL=$(cat deployments/zgTestnetMigrate/InferenceServing_v1.0Impl.json | jq -r '.address')
BEACON=$(cat deployments/zgTestnetMigrate/InferenceServing_v1.0Beacon.json | jq -r '.address')
PROXY=$(cat deployments/zgTestnetMigrate/InferenceServing_v1.0.json | jq -r '.address')
IMPL_ADDRESS=$IMPL BEACON_ADDRESS=$BEACON PROXY_ADDRESS=$PROXY npx hardhat deploy --tags verify-contracts --network zgTestnetMigrate

# Re-import upgraded contracts
npx hardhat upgrade:forceImportAll --network zgTestnetMigrate

# Update version info (increment patch version)
cat > VERSION.json << EOF
{
  "service": "inference",
  "version": "v1.0",
  "compatibleClientSDKs": ["v1.0.0", "v1.0.1"],
  "compatibleServingImages": ["0g-inference:v1.0.0", "0g-inference:v1.0.1"]
}
EOF

# Commit upgrade info to release branch
git add deployments/ .openzeppelin/ VERSION.json
git commit -m "Upgrade inference v1.0 - patch 1"
git push origin release/inference-v1.0

git checkout main
```

## Scenario 5: Set Recommended Version

```bash
# Set inference v2.0 as recommended version
SERVICE_TYPE=inference SERVICE_VERSION=v2.0 npx hardhat deploy --tags set-recommended --network zgTestnetMigrate
```

## Scenario 6: List All Services

```bash
npx hardhat deploy --tags list-services --network zgTestnetMigrate
```

## Scenario 7: Upgrade LedgerManager (Public Infrastructure)

LedgerManager is public infrastructure shared by all service versions. After upgrading, it needs to be synchronized to all version tags.

```bash
# Modify LedgerManager contract code in main branch
git checkout main

# Validate upgrade compatibility
npx hardhat upgrade:validate --old LedgerManager --new LedgerManager --network zgTestnetMigrate

# Execute upgrade
npx hardhat upgrade --name LedgerManager --artifact LedgerManager --execute true --network zgTestnetMigrate

# Verify contract
IMPL=$(cat deployments/zgTestnetMigrate/LedgerManagerImpl.json | jq -r '.address')
BEACON=$(cat deployments/zgTestnetMigrate/LedgerManagerBeacon.json | jq -r '.address')
PROXY=$(cat deployments/zgTestnetMigrate/LedgerManager.json | jq -r '.address')
IMPL_ADDRESS=$IMPL BEACON_ADDRESS=$BEACON PROXY_ADDRESS=$PROXY npx hardhat deploy --tags verify-contracts --network zgTestnetMigrate

# Re-import upgraded contracts
npx hardhat upgrade:forceImportAll --network zgTestnetMigrate

# Commit upgrade to main branch
git add deployments/zgTestnetMigrate/LedgerManager*.json .openzeppelin/
git commit -m "Upgrade LedgerManager"

# Synchronize LedgerManager upgrade to all release branches
# Execute the following steps for each release branch:

# Step 1: Switch to release branch (e.g., release/inference-v1)
git checkout release/inference-v1

# Step 2: Cherry-pick upgrade commits from main
git cherry-pick <ledger-upgrade-commit-hash>

# Step 3: Re-import contracts (using updated LedgerManager)
npx hardhat upgrade:forceImportAll --network zgTestnetMigrate

# Step 4: Commit and push updates to release branch
git add deployments/ .openzeppelin/
git commit -m "Update contract imports after LedgerManager upgrade"
git push origin release/inference-v1

# Repeat the above steps for other release branches: release/inference-v2, release/fine-tuning-v1, etc.

# Return to main branch
git checkout main
```

**Explanation**: LedgerManager as public infrastructure affects all service versions. Therefore, it requires:

1. Execute upgrade in main branch
2. Synchronize upgraded code and deployment files to all release branches using cherry-pick
3. Each release branch re-executes `forceImportAll` to update `.openzeppelin/` information
4. This ensures all service versions use the latest LedgerManager while preserving branch-specific modifications

**Important Principles**: For modifications to public infrastructure like LedgerManager, consider the following:

- **Compatibility Assessment**: Evaluate compatibility impact on all existing service versions before modification
- **Full Synchronization**: If modifications affect all versions, update all release branches to include the latest modifications like LedgerManager
- **Versioning Strategy**: If modifications are incompatible with existing versions, consider creating new public component versions instead of directly modifying existing components
- **Test Coverage**: After modification, test all service versions that depend on the component to ensure functionality is normal
