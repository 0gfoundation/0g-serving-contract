# 模块化部署指南

**重要说明**：虽然此仓库包含多个服务的代码（inference、fine-tuning），但每个版本分支只针对特定服务。例如在 `inference-v1` 分支中，fine-tuning 相关代码应被忽略。

## 场景 1：首次部署合约

### 1.1 部署 LedgerManager

```bash
# 部署 LedgerManager
npx hardhat deploy --tags ledger --network zgTestnetV4

# 验证 LedgerManager 合约
IMPL=$(cat deployments/zgTestnetV4/LedgerManagerImpl.json | jq -r '.address')
BEACON=$(cat deployments/zgTestnetV4/LedgerManagerBeacon.json | jq -r '.address')
PROXY=$(cat deployments/zgTestnetV4/LedgerManager.json | jq -r '.address')
IMPL_ADDRESS=$IMPL BEACON_ADDRESS=$BEACON PROXY_ADDRESS=$PROXY npx hardhat deploy --tags verify-contracts --network zgTestnetV4

# 导入到 OpenZeppelin
npx hardhat upgrade:forceImportAll --network zgTestnetV4
```

### 1.2 部署 Inference v1.0

```bash
# 创建版本分支
git checkout -b inference-v1.0

# 部署合约
SERVICE_TYPE=inference SERVICE_VERSION=v1.0 npx hardhat deploy --tags deploy-service --network zgTestnetV4

# 验证合约
IMPL=$(cat deployments/zgTestnetV4/InferenceServing_v1.0Impl.json | jq -r '.address')
BEACON=$(cat deployments/zgTestnetV4/InferenceServing_v1.0Beacon.json | jq -r '.address')
PROXY=$(cat deployments/zgTestnetV4/InferenceServing_v1.0.json | jq -r '.address')
IMPL_ADDRESS=$IMPL BEACON_ADDRESS=$BEACON PROXY_ADDRESS=$PROXY npx hardhat deploy --tags verify-contracts --network zgTestnetV4

# 清理其他服务的 deployment 文件
rm deployments/zgTestnetV4/FineTuningServing_*.json 2>/dev/null || true

# 导入到 OpenZeppelin
npx hardhat upgrade:forceImportAll --network zgTestnetV4

# 创建版本信息文件
cat > VERSION.json << EOF
{
  "service": "inference",
  "version": "v1.0",
  "clientSDK": "v1.0.0",
  "serverImage": "0g-inference:v1.0.0"
}
EOF

# 提交并打标签
git add deployments/ .openzeppelin/ VERSION.json
git commit -m "Deploy inference v1.0"
git tag inference-v1.0
```

## 场景 2：部署新版本（inference v2.0）

```bash
# 从 main 分支创建新版本分支
git checkout main
git checkout -b inference-v2.0

# 修改合约代码（根据需求）

# 部署新版本
SERVICE_TYPE=inference SERVICE_VERSION=v2.0 npx hardhat deploy --tags deploy-service --network zgTestnetV4

# 验证合约
IMPL=$(cat deployments/zgTestnetV4/InferenceServing_v3.0Impl.json | jq -r '.address')
BEACON=$(cat deployments/zgTestnetV4/InferenceServing_v3.0Beacon.json | jq -r '.address')
PROXY=$(cat deployments/zgTestnetV4/InferenceServing_v3.0.json | jq -r '.address')
IMPL_ADDRESS=$IMPL BEACON_ADDRESS=$BEACON PROXY_ADDRESS=$PROXY npx hardhat deploy --tags verify-contracts --network zgTestnetV4

# 清理其他版本的 deployment 文件
rm deployments/zgTestnetV4/InferenceServing_v1.0*.json 2>/dev/null || true
rm deployments/zgTestnetV4/FineTuningServing_*.json 2>/dev/null || true

# 导入到 OpenZeppelin
npx hardhat upgrade:forceImportAll --network zgTestnetV4

# 更新版本信息文件
cat > VERSION.json << EOF
{
  "service": "inference",
  "version": "v2.0",
  "clientSDK": "v2.0.0",
  "serverImage": "0g-inference:v2.0.0"
}
EOF

# 提交并打标签
git add deployments/ .openzeppelin/ VERSION.json
git commit -m "Deploy inference v2.0"
git tag inference-v2.0
```

## 场景 3：添加新服务（fine-tuning v1.0）

```bash
# 从 main 分支创建新服务分支
git checkout main
git checkout -b fine-tuning-v1.0

# 部署 fine-tuning 服务
SERVICE_TYPE=fine-tuning SERVICE_VERSION=v1.0 npx hardhat deploy --tags deploy-service --network zgTestnetV4

# 验证合约
IMPL=$(cat deployments/zgTestnetV4/FineTuningServing_v1.0Impl.json | jq -r '.address')
BEACON=$(cat deployments/zgTestnetV4/FineTuningServing_v1.0Beacon.json | jq -r '.address')
PROXY=$(cat deployments/zgTestnetV4/FineTuningServing_v1.0.json | jq -r '.address')
IMPL_ADDRESS=$IMPL BEACON_ADDRESS=$BEACON PROXY_ADDRESS=$PROXY npx hardhat deploy --tags verify-contracts --network zgTestnetV4

# 清理其他服务的 deployment 文件
rm deployments/zgTestnetV4/InferenceServing_*.json 2>/dev/null || true

# 导入到 OpenZeppelin
npx hardhat upgrade:forceImportAll --network zgTestnetV4

# 创建版本信息文件
cat > VERSION.json << EOF
{
  "service": "fine-tuning",
  "version": "v1.0",
  "clientSDK": "v1.0.0",
  "serverImage": "0g-fine-tuning:v1.0.0"
}
EOF

# 提交并打标签
git add deployments/ .openzeppelin/ VERSION.json
git commit -m "Deploy fine-tuning v1.0"
git tag fine-tuning-v1.0
```

## 场景 4：升级特定版本

```bash
# 切换到要升级的版本 tag
git checkout inference-v1.0

# 修改合约代码

yarn compile

# 验证升级兼容性
npx hardhat upgrade:validate --old InferenceServing_v1.0 --new InferenceServing --network zgTestnetV4

# 执行升级
npx hardhat upgrade --name InferenceServing_v1.0 --artifact InferenceServing --execute true --network zgTestnetV4

# 重新导入升级后的合约
npx hardhat upgrade:forceImportAll --network zgTestnetV4

# 更新版本信息（递增补丁版本）
cat > VERSION.json << EOF
{
  "service": "inference",
  "version": "v1.0",
  "clientSDK": "v1.0.1",
  "serverImage": "0g-inference:v1.0.1"
}
EOF

# 提交升级信息并打新的 tag
git add deployments/ .openzeppelin/ VERSION.json
git commit -m "Upgrade inference v1.0 - patch 1"
git tag inference-v1.0-1

# 如果后续还有升级，继续递增：inference-v1.0-2, inference-v1.0-3 等
```

## 场景 5：设置推荐版本

```bash
# 设置 inference v2.0 为推荐版本
SERVICE_TYPE=inference SERVICE_VERSION=v2.0 npx hardhat deploy --tags set-recommended --network zgTestnetV4
```

## 场景 6：查看所有服务

```bash
npx hardhat deploy --tags list-services --network zgTestnetV4
```

## 场景 7：升级 LedgerManager（公共基础设施）

LedgerManager 是所有服务版本共享的公共基础设施，升级后需要同步到所有版本分支。

```bash
# 在 main 分支修改 LedgerManager 合约代码
git checkout main

# 验证升级兼容性
npx hardhat upgrade:validate --old LedgerManager --new LedgerManager --network zgTestnetV4

# 执行升级
npx hardhat upgrade --name LedgerManager --artifact LedgerManager --execute true --network zgTestnetV4

# 提交升级到 main 分支
git add deployments/zgTestnetV4/LedgerManager*.json .openzeppelin/
git commit -m "Upgrade LedgerManager"

# 将 LedgerManager 升级同步到所有版本 tag
# 需要对每个版本 tag 执行以下步骤：

# 步骤1：切换到版本 tag（如 inference-v1.0）
git checkout inference-v1.0

# 步骤2：从 main 分支同步 LedgerManager 代码和文件
git checkout main -- contracts/ledger/
git checkout main -- deployments/zgTestnetV4/LedgerManager*.json

# 步骤3：重新导入合约（使用更新后的 LedgerManager）
npx hardhat upgrade:forceImportAll --network zgTestnetV4

# 步骤4：提交更新
git add deployments/ .openzeppelin/
git commit -m "Update LedgerManager after upgrade"

# 重复以上步骤为其他版本 tag：inference-v2.0, fine-tuning-v1.0 等

# 返回 main 分支
git checkout main
```

**说明**：LedgerManager 作为公共基础设施，其升级会影响所有服务版本。因此需要：

1. 在 main 分支执行升级
2. 将升级后的代码和 deployment 文件同步到所有版本 tag
3. 每个版本重新执行 `forceImportAll` 以更新 `.openzeppelin/` 信息
4. 这样确保所有版本都使用最新的 LedgerManager

**重要原则**：对于 LedgerManager 等公共基础设施的修改，必须考虑以下几点：

- **兼容性评估**：修改前需要评估对所有现有服务版本的兼容性影响
- **全量同步**：如果修改影响所有版本，需要像 LedgerManager 一样将所有版本 tag 更新到最新修改
- **版本策略**：如果修改不兼容现有版本，考虑创建新的公共组件版本，而不是直接修改现有组件
- **测试覆盖**：修改后需要测试所有依赖该组件的服务版本，确保功能正常