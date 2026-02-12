# Modular Deployment Guide

## Overview

### Architecture

The 0G Compute Network's smart contract architecture consists of:

-   **One LedgerManager Contract**: Manages user accounts and balances across the entire network
-   **Multiple Service Contracts**: Each service (e.g., inference, fine-tuning) can have multiple versions deployed independently

This modular design ensures users can use a unified account to pay for any current or future services added to the compute network.

### Branch Management Strategy

#### Branch Structure

-   **main branch**: Contains only the latest, actively developed code for all services
-   **release/{service-name}-v{version} branches**: Long-term maintenance branches for each deployed service version
    -   Example: `release/inference-v1`, `release/inference-v2`, `release/fine-tuning-v1`
    -   Created when a service version is deployed and requires ongoing maintenance
    -   Used for patches, upgrades, and version-specific fixes

#### Service Versioning Convention

When deploying new service versions, follow this naming convention:

-   Format: `{service-name}-v{version-number}`
-   Example: `inference-v1`, `inference-v2`, `fine-tuning-v1`
-   Version numbers should increment sequentially (v1, v2, v3...)

### When to Deploy New Service Versions

A new service version should only be deployed when:

-   Storage layout breaking changes are required
-   Fundamental architectural changes cannot be achieved through upgrades

Each service version:

-   Has its own independent contract
-   Maintains isolated providers
-   Does not share state with other versions

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
        "compatibleServingImages": [
            "0g-inference:v1.0.0",
            "0g-inference:v1.0.1"
        ]
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

-   **Upgrade**: When changes don't affect storage layout
-   **New Version**: When storage layout changes are required

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

Follow the scenarios below for detailed deployment and upgrade steps. And here we use zgTestnetDev as the target network for all commands as examples.

## Scenario 1: Initial Contract Deployment

### 1.1 Deploy LedgerManager

```bash
# Deploy LedgerManager
npx hardhat deploy --tags ledger --network zgTestnetDev

# Verify LedgerManager contract
IMPL=$(cat deployments/zgTestnetDev/LedgerManagerImpl.json | jq -r '.address')
BEACON=$(cat deployments/zgTestnetDev/LedgerManagerBeacon.json | jq -r '.address')
PROXY=$(cat deployments/zgTestnetDev/LedgerManager.json | jq -r '.address')
IMPL_ADDRESS=$IMPL BEACON_ADDRESS=$BEACON PROXY_ADDRESS=$PROXY npx hardhat deploy --tags verify-contracts --network zgTestnetDev

# Import to OpenZeppelin
npx hardhat upgrade:forceImportAll --network zgTestnetDev
```

### 1.2 Deploy Inference v1.0

```bash
# Work from main branch
git checkout main

# Deploy contract
SERVICE_TYPE=inference SERVICE_VERSION=v1.0 npx hardhat deploy --tags deploy-service --network zgTestnetDev

# Verify contract
IMPL=$(cat deployments/zgTestnetDev/InferenceServing_v1.0Impl.json | jq -r '.address')
BEACON=$(cat deployments/zgTestnetDev/InferenceServing_v1.0Beacon.json | jq -r '.address')
PROXY=$(cat deployments/zgTestnetDev/InferenceServing_v1.0.json | jq -r '.address')
IMPL_ADDRESS=$IMPL BEACON_ADDRESS=$BEACON PROXY_ADDRESS=$PROXY npx hardhat deploy --tags verify-contracts --network zgTestnetDev

# Clean other service deployment files
rm deployments/zgTestnetDev/FineTuningServing_*.json 2>/dev/null || true

# Import to OpenZeppelin
npx hardhat upgrade:forceImportAll --network zgTestnetDev

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
SERVICE_TYPE=inference SERVICE_VERSION=v2.0 npx hardhat deploy --tags deploy-service --network zgTestnetDev

# Verify contract
IMPL=$(cat deployments/zgTestnetDev/InferenceServing_v2.0Impl.json | jq -r '.address')
BEACON=$(cat deployments/zgTestnetDev/InferenceServing_v2.0Beacon.json | jq -r '.address')
PROXY=$(cat deployments/zgTestnetDev/InferenceServing_v2.0.json | jq -r '.address')
IMPL_ADDRESS=$IMPL BEACON_ADDRESS=$BEACON PROXY_ADDRESS=$PROXY npx hardhat deploy --tags verify-contracts --network zgTestnetDev

# Clean other version deployment files
rm deployments/zgTestnetDev/InferenceServing_v1.0*.json 2>/dev/null || true
rm deployments/zgTestnetDev/FineTuningServing_*.json 2>/dev/null || true

# Import to OpenZeppelin
npx hardhat upgrade:forceImportAll --network zgTestnetDev

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
SERVICE_TYPE=fine-tuning SERVICE_VERSION=v1.0 npx hardhat deploy --tags deploy-service --network zgTestnetDev

# Verify contract
IMPL=$(cat deployments/zgTestnetDev/FineTuningServing_v1.1Impl.json | jq -r '.address')
BEACON=$(cat deployments/zgTestnetDev/FineTuningServing_v1.1Beacon.json | jq -r '.address')
PROXY=$(cat deployments/zgTestnetDev/FineTuningServing_v1.1.json | jq -r '.address')
IMPL_ADDRESS=$IMPL BEACON_ADDRESS=$BEACON PROXY_ADDRESS=$PROXY npx hardhat deploy --tags verify-contracts --network zgTestnetDev

# Clean other service deployment files
rm deployments/zgTestnetDev/InferenceServing_*.json 2>/dev/null || true

# Import to OpenZeppelin
npx hardhat upgrade:forceImportAll --network zgTestnetDev

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

### Upgrade inference v1.0

```bash
# Switch to the release branch for the specific version
git checkout release/inference-v1.0

# Modify contract code

# Validate upgrade compatibility
npx hardhat upgrade:validate --old InferenceServing_v1.0 --new InferenceServing --network zgTestnetDev

# Execute upgrade
npx hardhat upgrade --name InferenceServing_v1.0 --artifact InferenceServing --execute true --network zgTestnetDev

IMPL=$(cat deployments/zgTestnetDev/InferenceServing_v1.0Impl.json | jq -r '.address')
BEACON=$(cat deployments/zgTestnetDev/InferenceServing_v1.0Beacon.json | jq -r '.address')
PROXY=$(cat deployments/zgTestnetDev/InferenceServing_v1.0.json | jq -r '.address')
IMPL_ADDRESS=$IMPL BEACON_ADDRESS=$BEACON PROXY_ADDRESS=$PROXY npx hardhat deploy --tags verify-contracts --network zgTestnetDev

# Re-import upgraded contracts
npx hardhat upgrade:forceImportAll --network zgTestnetDev

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

### Upgrade fine-tuning v1.1

```bash
# Switch to the release branch for the specific version
git checkout release/fine-tuning-v1.1

# Modify contract code

# Validate upgrade compatibility
npx hardhat upgrade:validate --old FineTuningServing_v1.1 --new FineTuningServing --network zgTestnetDev

# Execute upgrade
npx hardhat upgrade --name FineTuningServing_v1.1 --artifact FineTuningServing --execute true --network zgTestnetDev

IMPL=$(cat deployments/zgTestnetDev/FineTuningServing_v1.1Impl.json | jq -r '.address')
BEACON=$(cat deployments/zgTestnetDev/FineTuningServing_v1.1Beacon.json | jq -r '.address')
PROXY=$(cat deployments/zgTestnetDev/FineTuningServing_v1.1.json | jq -r '.address')
IMPL_ADDRESS=$IMPL BEACON_ADDRESS=$BEACON PROXY_ADDRESS=$PROXY npx hardhat deploy --tags verify-contracts --network zgTestnetDev

# Re-import upgraded contracts
npx hardhat upgrade:forceImportAll --network zgTestnetDev

# Update version info (increment patch version)
cat > VERSION.json << EOF
{
  "service": "fine-tuning",
  "version": "v1.0",
  "compatibleClientSDKs": ["v1.0.0", "v1.0.1"],
  "compatibleServingImages": ["0g-fine-tuning:v1.0.0", "0g-fine-tuning:v1.0.1"]
}
EOF

# Commit upgrade info to release branch
git add deployments/ .openzeppelin/ VERSION.json
git commit -m "Upgrade fine-tuning v1.0 - patch 1"
git push origin release/fine-tuning-v1.0

git checkout main
```

## Scenario 5: Set Recommended Version

```bash
# Set inference v2.0 as recommended version
SERVICE_TYPE=inference SERVICE_VERSION=v2.0 npx hardhat deploy --tags set-recommended --network zgTestnetDev
```

## Scenario 6: List All Services

```bash
npx hardhat deploy --tags list-services --network zgTestnetDev
```

## Scenario 7: Upgrade LedgerManager (Public Infrastructure)

LedgerManager is public infrastructure shared by all service versions. After upgrading, it needs to be synchronized to all version tags.

```bash
# Modify LedgerManager contract code in main branch
git checkout main

# Validate upgrade compatibility
npx hardhat upgrade:validate --old LedgerManager --new LedgerManager --network zgTestnetDev

# Execute upgrade
npx hardhat upgrade --name LedgerManager --artifact LedgerManager --execute true --network zgTestnetDev

# Verify contract
IMPL=$(cat deployments/zgTestnetDev/LedgerManagerImpl.json | jq -r '.address')
BEACON=$(cat deployments/zgTestnetDev/LedgerManagerBeacon.json | jq -r '.address')
PROXY=$(cat deployments/zgTestnetDev/LedgerManager.json | jq -r '.address')
IMPL_ADDRESS=$IMPL BEACON_ADDRESS=$BEACON PROXY_ADDRESS=$PROXY npx hardhat deploy --tags verify-contracts --network zgTestnetDev

# Re-import upgraded contracts
npx hardhat upgrade:forceImportAll --network zgTestnetDev

# Commit upgrade to main branch
git add deployments/zgTestnetDev/LedgerManager*.json .openzeppelin/
git commit -m "Upgrade LedgerManager"

# Synchronize LedgerManager upgrade to all release branches
# Execute the following steps for each release branch:

# Step 1: Switch to release branch (e.g., release/inference-v1)
git checkout release/inference-v1

# Step 2: Cherry-pick upgrade commits from main
git cherry-pick <ledger-upgrade-commit-hash>

# Step 3: Re-import contracts (using updated LedgerManager)
npx hardhat upgrade:forceImportAll --network zgTestnetDev

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

-   **Compatibility Assessment**: Evaluate compatibility impact on all existing service versions before modification
-   **Full Synchronization**: If modifications affect all versions, update all release branches to include the latest modifications like LedgerManager
-   **Versioning Strategy**: If modifications are incompatible with existing versions, consider creating new public component versions instead of directly modifying existing components
-   **Test Coverage**: After modification, test all service versions that depend on the component to ensure functionality is normal

## Scenario 8.1: Upgrade with Foundation-Owned Beacon for LedgerManager

When beacon ownership has been transferred to the Foundation (see Scenario 9), developers cannot execute the full upgrade (specifically the `upgradeTo` call). This scenario separates the upgrade process into two phases:

-   **Phase 1 (Developer)**: Deploy new implementation, verify contract, and prepare upgrade instructions
-   **Phase 2 (Foundation)**: Execute `upgradeTo` on chain explorer

### Phase 1: Developer - Deploy and Prepare

```bash
# Modify LedgerManager contract code in main branch
git checkout main

# Modify contract code as needed
# ...

# 1. Validate upgrade compatibility
npx hardhat upgrade:validate --old LedgerManager --new LedgerManager --network zgTestnetDev


# 2. Deploy new implementation only (without calling upgradeTo)
npx hardhat upgrade:deployImpl --name LedgerManager --artifact LedgerManager --network zgTestnetDev

# 3. Verify the new implementation contract
IMPL=$(cat deployments/zgTestnetDev/LedgerManagerImpl.json | jq -r '.address')
npx hardhat verify --network zgTestnetDev $IMPL

# 4. Import storage layout (does NOT depend on Foundation's upgradeTo)
npx hardhat upgrade:forceImportAll --network zgTestnetDev


# 6. Commit and push
git add deployments/zgTestnetDev/LedgerManager*.json .openzeppelin/
git commit -m "Upgrade LedgerManager"
```

The `upgrade:deployImpl` command will output an upgrade instruction file to `./upgrade-pending/` directory. Send this file to the Foundation.

Example output:

```json
{
    "network": "zgTestnetDev",
    "chainId": "16600",
    "timestamp": "2024-01-15T10:30:00.000Z",
    "contractName": "InferenceServing_v1.0",
    "artifact": "InferenceServing",
    "newImplementation": "0x1234567890abcdef1234567890abcdef12345678",
    "beacon": "0xabcdef1234567890abcdef1234567890abcdef12",
    "currentImplementation": "0x9876543210fedcba9876543210fedcba98765432",
    "action": {
        "method": "upgradeTo(address)",
        "methodSignature": "0x3659cfe6",
        "parameter": "0x1234567890abcdef1234567890abcdef12345678"
    },
    "instructions": [
        "1. Open beacon contract on chain explorer: 0xabcdef...",
        "2. Navigate to \"Write Contract\" or \"Write as Proxy\" tab",
        "3. Connect Foundation wallet (must be beacon owner)",
        "4. Find and call upgradeTo(address) method",
        "5. Input new implementation address: 0x1234...",
        "6. Confirm and submit transaction",
        "7. Verify upgrade by calling implementation() - should return: 0x1234..."
    ]
}
```

## Scenario 8.2: Upgrade with Foundation-Owned Beacon for inference

When beacon ownership has been transferred to the Foundation (see Scenario 9), developers cannot execute the full upgrade (specifically the `upgradeTo` call). This scenario separates the upgrade process into two phases:

-   **Phase 1 (Developer)**: Deploy new implementation, verify contract, and prepare upgrade instructions
-   **Phase 2 (Foundation)**: Execute `upgradeTo` on chain explorer

### Phase 1: Developer - Deploy and Prepare

```bash
# Switch to the release branch for the specific version
git checkout release/inference-v1.0

# Modify contract code as needed
# ...

# 1. Validate upgrade compatibility
npx hardhat upgrade:validate --old InferenceServing_v1.0 --new InferenceServing --network zgTestnetDev

# 2. Deploy new implementation only (without calling upgradeTo)
npx hardhat upgrade:deployImpl --name InferenceServing_v1.0 --artifact InferenceServing --network zgTestnetDev

# 3. Verify the new implementation contract
IMPL=$(cat deployments/zgTestnetDev/InferenceServing_v1.0Impl.json | jq -r '.address')
npx hardhat verify --network zgTestnetDev $IMPL

# 4. Import storage layout (does NOT depend on Foundation's upgradeTo)
npx hardhat upgrade:forceImportAll --network zgTestnetDev

# 5. Update VERSION.json if needed
cat > VERSION.json << EOF
{
  "service": "inference",
  "version": "v1.0",
  "compatibleClientSDKs": ["v1.0.0", "v1.0.1"],
  "compatibleServingImages": ["0g-inference:v1.0.0", "0g-inference:v1.0.1"]
}
EOF

# 6. Commit and push
git add deployments/ .openzeppelin/ upgrade-pending/ VERSION.json
git commit -m "Deploy new impl for InferenceServing_v1.0 upgrade"
git push origin release/inference-v1.0

# Return to main branch
git checkout main
```

The `upgrade:deployImpl` command will output an upgrade instruction file to `./upgrade-pending/` directory. Send this file to the Foundation.

### Phase 2: Foundation - Execute Upgrade on Chain Explorer

1. **Review the Upgrade**

    - Review the new implementation contract code on chain explorer (already verified)
    - Confirm the upgrade has been approved through proper governance process

2. **Open Chain Explorer**

    - Navigate to the Beacon contract address provided in the upgrade instruction file
    - Example: `https://chain.0g.ai/address/0xabcdef...`

3. **Connect Wallet**

    - Click "Write Contract" tab
    - Connect the Foundation's owner wallet (must be the beacon owner)

4. **Execute upgradeTo**

    - Find the `upgradeTo(address)` method
    - Input the new implementation address from the upgrade instruction file
    - Click "Write" and confirm the transaction

5. **Verify Upgrade Success**
    - Go to "Read Contract" tab
    - Call `implementation()` method
    - Confirm it returns the new implementation address

### When to Use This Scenario

Use this scenario when:

-   Beacon ownership has been transferred to Foundation or multisig (see Scenario 9)
-   You (developer) no longer have permission to call `upgradeTo` on the beacon
-   Upgrade governance requires Foundation approval before execution

Use standard Scenario 4 when:

-   You still have beacon owner permissions (e.g., testnet, development)
-   Quick iteration is needed without governance overhead

## Scenario 9: Transfer Ownership to Foundation

This scenario covers transferring contract ownership from developer to Foundation. There are two types of ownership that can be transferred independently.

### Understanding the Two Types of Ownership

In the BeaconProxy architecture, there are **two independent owners** for each contract system:

| Owner Type                  | Set By                                         | Controls                                                            |
| --------------------------- | ---------------------------------------------- | ------------------------------------------------------------------- |
| **Beacon Owner**            | `UpgradeableBeacon` constructor (`msg.sender`) | Contract upgrades (`upgradeTo()`)                                   |
| **Business Contract Owner** | `initialize(owner)` call                       | Business logic administration (functions with `onlyOwner` modifier) |

Both owners default to the deployer address and need to be transferred separately.

### 9.1 Transfer Beacon Ownership

Transferring beacon ownership gives Foundation control over contract upgrades. After transfer, developers must use Scenario 8 for upgrades.

**Contracts to transfer:**

-   `LedgerManagerBeacon`
-   `InferenceServing_v1.0Beacon`
-   Other service version beacons as needed

**Steps on Chain Explorer:**

1. **Open Beacon Contract**

    - Navigate to the beacon contract address on chain explorer
    - Example: `https://chain.0g.ai/address/<LedgerManagerBeacon_address>`
    - Beacon addresses can be found in `deployments/<network>/*Beacon.json`

2. **Connect Developer Wallet**

    - Click "Write Contract" tab
    - Connect the current owner wallet (deployer)

3. **Execute transferOwnership**

    - Find `transferOwnership(address newOwner)` method
    - Input Foundation address as `newOwner` parameter
    - Click "Write" and confirm transaction

4. **Verify Transfer**
    - Go to "Read Contract" tab
    - Call `owner()` method
    - Confirm it returns the Foundation address

**Repeat for each beacon contract that needs to be transferred.**

### 9.2 Transfer Business Contract Ownership

Transferring business contract ownership gives Foundation control over administrative functions (functions with `onlyOwner` modifier).

**Contracts to transfer:**

-   `LedgerManager` (proxy address)
-   Service contracts if they have owner-restricted functions

**Steps on Chain Explorer:**

1. **Open Business Contract (Proxy)**

    - Navigate to the proxy contract address on chain explorer
    - Example: `https://chain.0g.ai/address/<LedgerManager_address>`
    - Proxy addresses can be found in `deployments/<network>/<ContractName>.json` (without `Impl` or `Beacon` suffix)

2. **Connect Developer Wallet**

    - Click "Write as Proxy" tab (important: use proxy tab, not implementation)
    - Connect the current owner wallet (deployer)

3. **Execute transferOwnership**

    - Find `transferOwnership(address newOwner)` method
    - Input Foundation address as `newOwner` parameter
    - Click "Write" and confirm transaction

4. **Verify Transfer**
    - Go to "Read as Proxy" tab
    - Call `owner()` method
    - Confirm it returns the Foundation address
