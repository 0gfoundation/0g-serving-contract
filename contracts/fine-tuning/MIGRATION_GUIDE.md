# Fine-Tuning Contract TEE Signer Acknowledgement Migration Guide

## 概述

本次更新为 Fine-Tuning 合约引入了与 Inference 合约一致的 TEE Signer 确认机制，包括：
- **Provider Stake 机制**：Provider 注册服务时需要质押 100 0G
- **双重确认机制**：Owner 和 User 都需要确认 Provider 的 TEE Signer
- **简化的数据结构**：移除冗余字段，使用统一的 TEE Signer 地址

---

## 核心变化

### 1. TEE Signer 确认机制

新增了三方确认流程：

```
Provider 注册服务 (质押 100 0G)
    ↓
Owner 确认 TEE Signer (acknowledgeTEESignerByOwner)
    ↓
User 转账/充值时自动确认 (acknowledgeTEESigner)
    ↓
可以进行 Settlement
```

### 2. Provider Stake 机制

- **首次注册**：Provider 必须质押至少 100 0G (MIN_PROVIDER_STAKE)
- **更新服务**：更新服务信息时不能额外增加质押
- **移除服务**：移除服务时，质押会自动退还

---

## 接口变化详解

### 一、Service 相关接口

#### 1.1 `addOrUpdateService()` - **重大变更**

**旧版本：**
```solidity
function addOrUpdateService(
    string calldata url,
    Quota memory quota,
    uint pricePerToken,
    address providerSigner,      // ❌ 已移除
    bool occupied,
    string[] memory models
) external
```

**新版本：**
```solidity
function addOrUpdateService(
    string calldata url,
    Quota memory quota,
    uint pricePerToken,
    bool occupied,
    string[] memory models,
    address teeSignerAddress     // ✅ 新增：TEE 签名者地址
) external payable               // ✅ 新增：支持质押
```

**使用变化：**
```javascript
// 旧版本
await fineTuningServing.connect(provider).addOrUpdateService(
    url, quota, pricePerToken, providerSigner, false, models
);

// 新版本 - 首次注册需要质押
await fineTuningServing.connect(provider).addOrUpdateService(
    url, quota, pricePerToken, false, models, teeSignerAddress,
    { value: ethers.parseEther("100") }  // 质押 100 0G
);

// 新版本 - 更新服务不需要质押
await fineTuningServing.connect(provider).addOrUpdateService(
    url, quota, pricePerToken, false, models, teeSignerAddress
);
```

**关键变更：**
- 参数顺序变化：`providerSigner` → `teeSignerAddress` 移到最后
- 函数变为 `payable`，首次注册需要质押
- 更新关键字段（teeSignerAddress）会重置 Owner 的确认状态

#### 1.2 `removeService()` - **逻辑变更**

**新增功能：**
- 移除服务时自动退还质押的 0G
- 使用 `nonReentrant` 保护防止重入攻击

```solidity
function removeService() external nonReentrant
```

**新增事件：**
```solidity
event ProviderStaked(address indexed provider, uint amount);
event ProviderStakeReturned(address indexed provider, uint amount);
```

### 二、确认相关接口

#### 2.1 `acknowledgeTEESignerByOwner()` - **新增**

Owner 确认 Provider 的 TEE Signer。

```solidity
function acknowledgeTEESignerByOwner(address provider) external onlyOwner
```

**使用示例：**
```javascript
// Owner 确认 provider 的 TEE signer
await fineTuningServing.connect(owner).acknowledgeTEESignerByOwner(providerAddress);
```

**事件：**
```solidity
event ProviderTEESignerAcknowledged(
    address indexed provider,
    address indexed teeSignerAddress,
    bool acknowledged
);
```

#### 2.2 `acknowledgeTEESigner()` - **新增**

User 确认 Provider 的 TEE Signer。

```solidity
function acknowledgeTEESigner(address provider, bool acknowledged) external
```

**使用示例：**
```javascript
// 用户确认 provider
await fineTuningServing.connect(user).acknowledgeTEESigner(providerAddress, true);

// 用户撤销确认（仅在余额为 0 时允许）
await fineTuningServing.connect(user).acknowledgeTEESigner(providerAddress, false);
```

**重要限制：**
- 撤销确认时，用户在该 provider 的余额必须为 0
- 用户转账/充值时会自动确认 provider

#### 2.3 `revokeTEESignerAcknowledgement()` - **新增**

Owner 撤销对 Provider TEE Signer 的确认。

```solidity
function revokeTEESignerAcknowledgement(address provider) external onlyOwner
```

#### 2.4 `acknowledgeProviderSigner()` - **已移除**

此函数已完全移除，替换为上述的 TEE Signer 确认机制。

### 三、Account 相关接口

#### 3.1 `addAccount()` 和 `depositFund()` - **逻辑变更**

这两个函数现在会**自动确认** user 对 provider 的 TEE Signer。

```solidity
function addAccount(address user, address provider, string memory additionalInfo)
    external payable onlyLedger
// 内部调用: $.accountMap.acknowledgeTEESigner(user, provider, true);

function depositFund(address user, address provider, uint cancelRetrievingAmount)
    external payable onlyLedger
// 如果尚未确认，内部调用: $.accountMap.acknowledgeTEESigner(user, provider, true);
```

**使用影响：**
- 用户通过 Ledger 转账给 provider 时，会自动建立信任关系
- 无需额外调用确认函数

### 四、Settlement 相关接口

#### 4.1 `settleFees()` - **验证逻辑变更**

新增 TEE Signer 确认验证。

**新增验证：**
```solidity
// 验证 TEE signer 确认状态
if (!account.acknowledged ||
    !service.teeSignerAcknowledged ||
    service.teeSignerAddress == address(0)) {
    revert InvalidVerifierInput("TEE signer not acknowledged");
}
```

**完整验证流程：**
1. ✅ User 已确认 provider (account.acknowledged)
2. ✅ Owner 已确认 service (service.teeSignerAcknowledged)
3. ✅ Service 有有效的 TEE signer 地址
4. ✅ Nonce 有效
5. ✅ 余额充足
6. ✅ Deliverable 存在且 hash 匹配
7. ✅ TEE 签名验证通过

---

## 数据结构变化

### 1. Service 结构体

```solidity
// 旧版本
struct Service {
    address provider;
    string url;
    Quota quota;
    uint pricePerToken;
    address providerSigner;        // ❌ 已移除
    bool occupied;
    string[] models;
}

// 新版本
struct Service {
    address provider;
    string url;
    Quota quota;
    uint pricePerToken;
    bool occupied;
    string[] models;
    address teeSignerAddress;      // ✅ 新增
    bool teeSignerAcknowledged;    // ✅ 新增：Owner 确认状态
}
```

### 2. Account 结构体

```solidity
// 旧版本
struct Account {
    address user;
    address provider;
    uint nonce;
    uint balance;
    uint pendingRefund;
    Refund[] refunds;
    string additionalInfo;
    address providerSigner;           // ❌ 已移除
    mapping(string => Deliverable) deliverables;
    string[MAX_DELIVERABLES_PER_ACCOUNT] deliverableIds;
    uint validRefundsLength;
    uint deliverablesHead;
    uint deliverablesCount;
}

// 新版本
struct Account {
    address user;
    address provider;
    uint nonce;
    uint balance;
    uint pendingRefund;
    Refund[] refunds;
    string additionalInfo;
    mapping(string => Deliverable) deliverables;
    string[MAX_DELIVERABLES_PER_ACCOUNT] deliverableIds;
    uint validRefundsLength;
    uint deliverablesHead;
    uint deliverablesCount;
    bool acknowledged;                // ✅ 新增：User 确认状态
}
```

### 3. VerifierInput 结构体

```solidity
// 旧版本
struct VerifierInput {
    string id;
    bytes encryptedSecret;
    bytes modelRootHash;
    uint nonce;
    address providerSigner;           // ❌ 已移除
    bytes signature;
    uint taskFee;
    address user;
}

// 新版本
struct VerifierInput {
    string id;
    bytes encryptedSecret;
    bytes modelRootHash;
    uint nonce;
    bytes signature;
    uint taskFee;
    address user;
}
```

**重要：** EIP-712 签名的 MESSAGE_TYPEHASH 也相应更新：

```solidity
// 旧版本
"VerifierMessage(string id,bytes encryptedSecret,bytes modelRootHash,uint256 nonce,address providerSigner,uint256 taskFee,address user)"

// 新版本
"VerifierMessage(string id,bytes encryptedSecret,bytes modelRootHash,uint256 nonce,uint256 taskFee,address user)"
```

---

## 使用流程变化

### 场景 1: Provider 注册服务

**旧流程：**
```javascript
// 1. 注册服务（无需质押）
await fineTuningServing.connect(provider).addOrUpdateService(
    url, quota, pricePerToken, providerSigner, false, models
);
// 完成 ✅
```

**新流程：**
```javascript
// 1. Provider 注册服务（需要质押 100 0G）
await fineTuningServing.connect(provider).addOrUpdateService(
    url, quota, pricePerToken, false, models, teeSignerAddress,
    { value: ethers.parseEther("100") }
);

// 2. Owner 确认 TEE Signer
await fineTuningServing.connect(owner).acknowledgeTEESignerByOwner(providerAddress);

// 完成 ✅
```

### 场景 2: User 使用服务

**旧流程：**
```javascript
// 1. User 转账
await ledger.connect(user).transferFund(providerAddress, "fine-tuning", amount);

// 2. User 确认 provider signer
await fineTuningServing.connect(user).acknowledgeProviderSigner(
    providerAddress, providerSignerAddress
);

// 3. Provider 提供服务并 settle
await fineTuningServing.connect(provider).settleFees(verifierInput);
```

**新流程：**
```javascript
// 1. User 转账（自动确认）
await ledger.connect(user).transferFund(providerAddress, "fine-tuning", amount);
// 自动调用 acknowledgeTEESigner(user, provider, true) ✅

// 2. Provider 提供服务并 settle
await fineTuningServing.connect(provider).settleFees(verifierInput);
// 验证通过条件：
// - account.acknowledged = true (步骤1自动设置)
// - service.teeSignerAcknowledged = true (Owner已确认)
// - service.teeSignerAddress != address(0)
```

### 场景 3: 生成 Settlement 签名

**旧版本签名数据：**
```javascript
const MESSAGE_TYPEHASH = keccak256(
    "VerifierMessage(string id,bytes encryptedSecret,bytes modelRootHash,uint256 nonce,address providerSigner,uint256 taskFee,address user)"
);

const structHash = keccak256(encode(
    MESSAGE_TYPEHASH,
    keccak256(id),
    keccak256(encryptedSecret),
    keccak256(modelRootHash),
    nonce,
    providerSigner,  // ❌ 需要包含
    taskFee,
    user
));
```

**新版本签名数据：**
```javascript
const MESSAGE_TYPEHASH = keccak256(
    "VerifierMessage(string id,bytes encryptedSecret,bytes modelRootHash,uint256 nonce,uint256 taskFee,address user)"
);

const structHash = keccak256(encode(
    MESSAGE_TYPEHASH,
    keccak256(id),
    keccak256(encryptedSecret),
    keccak256(modelRootHash),
    nonce,
    // providerSigner 已移除 ✅
    taskFee,
    user
));
```

**签名验证：**
```solidity
// 合约内部使用 service.teeSignerAddress 验证签名
bool teePassed = verifierInput.verifySignature(
    service.teeSignerAddress,  // 从 service 获取
    address(this)
);
```

---

## 错误处理变化

### 新增错误

```solidity
// Stake 相关
error CannotAddStakeWhenUpdating();
error InsufficientStake(uint256 provided, uint256 required);

// Account 相关
error CannotRevokeWithNonZeroBalance(address user, address provider, uint256 balance);
```

### 移除的错误

```solidity
error ProviderSignerZeroAddress();  // 已移除
```

### Settlement 错误变化

```solidity
// 新增验证失败原因
revert InvalidVerifierInput("TEE signer not acknowledged");
```

---

## 迁移检查清单

### 对于 Provider

- [ ] 准备至少 100 0G 用于 stake
- [ ] 更新 `addOrUpdateService()` 调用，添加 `teeSignerAddress` 参数和 stake
- [ ] 联系 Owner 进行 TEE Signer 确认
- [ ] 更新签名生成逻辑，移除 `providerSigner` 字段
- [ ] 测试 settlement 流程

### 对于 User

- [ ] 移除手动调用 `acknowledgeProviderSigner()` 的代码
- [ ] 确认转账后自动建立信任关系
- [ ] 测试撤销确认功能（需要余额为 0）

### 对于 Owner

- [ ] 实现 `acknowledgeTEESignerByOwner()` 调用流程
- [ ] 建立 TEE Signer 审核机制
- [ ] 监控 `ProviderTEESignerAcknowledged` 事件

### 对于集成方

- [ ] 更新合约 ABI
- [ ] 更新所有接口调用
- [ ] 更新 EIP-712 签名生成代码
- [ ] 更新事件监听
- [ ] 更新测试用例
- [ ] 更新文档

---

## 常见问题 (FAQ)

### Q1: 为什么需要质押 100 0G？

**A:** Stake 机制增加了 Provider 作恶的成本，保护用户利益。如果 Provider 提供不合格的服务，可以通过治理机制对质押进行惩罚。

### Q2: 更新服务信息时需要重新质押吗？

**A:** 不需要。只有首次注册需要质押。更新服务时如果尝试添加质押会报错 `CannotAddStakeWhenUpdating`。

### Q3: 什么时候可以取回质押？

**A:** 调用 `removeService()` 时，质押会自动退还给 Provider。

### Q4: 用户什么时候需要手动确认 Provider？

**A:** 通常不需要。用户通过 Ledger 转账给 Provider 时会自动确认。只有在需要撤销确认时才需要手动调用。

### Q5: 撤销确认后还能继续使用服务吗？

**A:** 不能。撤销确认后，该用户对该 Provider 的所有 settlement 都会失败，直到重新确认。

### Q6: Owner 如何撤销对 Provider 的确认？

**A:** 调用 `revokeTEESignerAcknowledgement(provider)`。撤销后，所有用户对该 Provider 的 settlement 都会失败。

### Q7: 更新 TEE Signer 地址后会发生什么？

**A:** Owner 的确认状态会被重置为 `false`，需要 Owner 重新确认。这确保了每次更新关键安全字段都经过审核。

### Q8: 旧的签名还能用吗？

**A:** 不能。EIP-712 签名结构已改变，所有旧签名都会验证失败。必须使用新的签名格式。

---

## 技术细节

### 常量定义

```solidity
// contracts/fine-tuning/FineTuningServing.sol
uint public constant MIN_PROVIDER_STAKE = 100 ether; // 100 0G
```

### 存储变化

```solidity
struct FineTuningServingStorage {
    uint lockTime;
    address ledgerAddress;
    ILedger ledger;
    AccountLibrary.AccountMap accountMap;
    ServiceLibrary.ServiceMap serviceMap;
    uint penaltyPercentage;
    mapping(address => uint) providerStake;  // ✅ 新增
}
```

### 事件汇总

```solidity
// 新增事件
event ProviderTEESignerAcknowledged(
    address indexed provider,
    address indexed teeSignerAddress,
    bool acknowledged
);
event ProviderStaked(address indexed provider, uint amount);
event ProviderStakeReturned(address indexed provider, uint amount);

// 更新事件
event ServiceUpdated(
    address indexed user,
    string url,
    Quota quota,
    uint pricePerToken,
    address teeSignerAddress,  // 改为 teeSignerAddress
    bool occupied
);
```

---

## 版本兼容性

- **合约版本**: Solidity 0.8.22
- **不兼容**: 与旧版本合约不兼容，需要重新部署
- **状态迁移**: 无法从旧合约状态迁移，建议使用新合约部署新服务
- **API 变更**: 所有集成方需要更新接口调用

---

## 参考资料

- [Inference Contract TEE Signer Acknowledgement](../inference/InferenceServing.sol)
- [EIP-712 Typed Data Signing](https://eips.ethereum.org/EIPS/eip-712)
- [OpenZeppelin ReentrancyGuard](https://docs.openzeppelin.com/contracts/4.x/api/security#ReentrancyGuard)

---

**最后更新**: 2026-01-14
**版本**: v1.0.0
**作者**: Claude Sonnet 4.5
