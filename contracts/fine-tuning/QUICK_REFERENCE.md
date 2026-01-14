# Fine-Tuning Contract - 快速参考

## 🔑 关键变化速查

### 核心概念

| 概念 | 旧版本 | 新版本 |
|------|--------|--------|
| Provider 注册 | 无需质押 | 需要质押 100 0G |
| 签名验证地址 | `account.providerSigner` | `service.teeSignerAddress` |
| 确认机制 | User 单方确认 | Owner + User 双重确认 |
| 确认方式 | 手动调用函数 | 转账时自动确认 |

---

## 📋 接口快速对照表

### Provider 接口

| 操作 | 旧接口 | 新接口 | 变化 |
|------|--------|--------|------|
| 注册服务 | `addOrUpdateService(url, quota, price, signer, occupied, models)` | `addOrUpdateService(url, quota, price, occupied, models, teeSigner) payable` | ⚠️ 参数顺序和数量变化 |
| 更新服务 | 同上 | 同上（不需要 value） | ✅ 不能额外质押 |
| 移除服务 | `removeService()` | `removeService()` | ✅ 自动退还质押 |

### Owner 接口

| 操作 | 旧接口 | 新接口 |
|------|--------|--------|
| 确认 TEE Signer | ❌ 不存在 | `acknowledgeTEESignerByOwner(provider)` ✅ |
| 撤销确认 | ❌ 不存在 | `revokeTEESignerAcknowledgement(provider)` ✅ |

### User 接口

| 操作 | 旧接口 | 新接口 |
|------|--------|--------|
| 确认 Provider | `acknowledgeProviderSigner(provider, signer)` ❌ | 转账时自动确认 ✅ |
| 手动确认 | ❌ 不支持 | `acknowledgeTEESigner(provider, true)` ✅ |
| 撤销确认 | ❌ 不支持 | `acknowledgeTEESigner(provider, false)` ✅ |

---

## 💻 代码示例对照

### 1. Provider 注册服务

<table>
<tr>
<th>旧版本</th>
<th>新版本</th>
</tr>
<tr>
<td>

```javascript
// 无需质押
await contract.addOrUpdateService(
  url,
  quota,
  pricePerToken,
  providerSigner,    // 第4个参数
  occupied,
  models
);
```

</td>
<td>

```javascript
// 需要质押 100 0G
await contract.addOrUpdateService(
  url,
  quota,
  pricePerToken,
  occupied,
  models,
  teeSignerAddress,  // 最后一个参数
  { value: ethers.parseEther("100") }
);
```

</td>
</tr>
</table>

### 2. Owner 确认 TEE Signer

<table>
<tr>
<th>旧版本</th>
<th>新版本</th>
</tr>
<tr>
<td>

```javascript
// 不需要
```

</td>
<td>

```javascript
// Owner 必须确认
await contract
  .connect(owner)
  .acknowledgeTEESignerByOwner(
    providerAddress
  );
```

</td>
</tr>
</table>

### 3. User 确认 Provider

<table>
<tr>
<th>旧版本</th>
<th>新版本</th>
</tr>
<tr>
<td>

```javascript
// 1. 转账
await ledger.transferFund(
  provider,
  "fine-tuning",
  amount
);

// 2. 手动确认
await contract.acknowledgeProviderSigner(
  provider,
  providerSigner
);
```

</td>
<td>

```javascript
// 只需转账，自动确认
await ledger.transferFund(
  provider,
  "fine-tuning",
  amount
);
// ✅ 自动确认完成
```

</td>
</tr>
</table>

### 4. 生成 EIP-712 签名

<table>
<tr>
<th>旧版本</th>
<th>新版本</th>
</tr>
<tr>
<td>

```javascript
const MESSAGE_TYPEHASH = keccak256(
  "VerifierMessage(" +
  "string id," +
  "bytes encryptedSecret," +
  "bytes modelRootHash," +
  "uint256 nonce," +
  "address providerSigner," + // ❌
  "uint256 taskFee," +
  "address user)"
);

const structHash = keccak256(encode(
  MESSAGE_TYPEHASH,
  keccak256(id),
  keccak256(encryptedSecret),
  keccak256(modelRootHash),
  nonce,
  providerSigner,  // ❌ 需要
  taskFee,
  user
));
```

</td>
<td>

```javascript
const MESSAGE_TYPEHASH = keccak256(
  "VerifierMessage(" +
  "string id," +
  "bytes encryptedSecret," +
  "bytes modelRootHash," +
  "uint256 nonce," +
  // 移除 providerSigner ✅
  "uint256 taskFee," +
  "address user)"
);

const structHash = keccak256(encode(
  MESSAGE_TYPEHASH,
  keccak256(id),
  keccak256(encryptedSecret),
  keccak256(modelRootHash),
  nonce,
  // 移除 providerSigner ✅
  taskFee,
  user
));
```

</td>
</tr>
</table>

### 5. VerifierInput 构造

<table>
<tr>
<th>旧版本</th>
<th>新版本</th>
</tr>
<tr>
<td>

```javascript
const verifierInput = {
  id: deliverableId,
  encryptedSecret: secret,
  modelRootHash: hash,
  nonce: 1,
  providerSigner: signerAddress,  // ❌
  signature: sig,
  taskFee: fee,
  user: userAddress
};
```

</td>
<td>

```javascript
const verifierInput = {
  id: deliverableId,
  encryptedSecret: secret,
  modelRootHash: hash,
  nonce: 1,
  // 移除 providerSigner ✅
  signature: sig,
  taskFee: fee,
  user: userAddress
};
```

</td>
</tr>
</table>

---

## 🔄 完整工作流程

### Provider 注册流程

```
1. Provider 调用 addOrUpdateService (质押 100 0G)
   ↓
2. Owner 调用 acknowledgeTEESignerByOwner
   ↓
3. 服务就绪 ✅
```

### User 使用流程

```
1. User 通过 Ledger 转账给 Provider
   ↓ (自动确认)
2. Provider 完成任务
   ↓
3. Provider 调用 settleFees (验证双重确认)
   ↓
4. 结算完成 ✅
```

### Settlement 验证流程

```
settleFees() 验证步骤：

1. ✅ account.acknowledged (User 确认)
2. ✅ service.teeSignerAcknowledged (Owner 确认)
3. ✅ service.teeSignerAddress != address(0)
4. ✅ nonce 有效
5. ✅ 余额充足
6. ✅ deliverable 存在
7. ✅ hash 匹配
8. ✅ 使用 service.teeSignerAddress 验证签名
```

---

## 📊 数据结构对照

### Service

| 字段 | 旧版本 | 新版本 | 说明 |
|------|--------|--------|------|
| provider | ✅ | ✅ | 不变 |
| url | ✅ | ✅ | 不变 |
| quota | ✅ | ✅ | 不变 |
| pricePerToken | ✅ | ✅ | 不变 |
| providerSigner | ✅ | ❌ | 已移除 |
| occupied | ✅ | ✅ | 不变 |
| models | ✅ | ✅ | 不变 |
| teeSignerAddress | ❌ | ✅ | 新增 |
| teeSignerAcknowledged | ❌ | ✅ | 新增 |

### Account

| 字段 | 旧版本 | 新版本 | 说明 |
|------|--------|--------|------|
| user | ✅ | ✅ | 不变 |
| provider | ✅ | ✅ | 不变 |
| nonce | ✅ | ✅ | 不变 |
| balance | ✅ | ✅ | 不变 |
| pendingRefund | ✅ | ✅ | 不变 |
| refunds | ✅ | ✅ | 不变 |
| additionalInfo | ✅ | ✅ | 不变 |
| providerSigner | ✅ | ❌ | 已移除 |
| deliverables | ✅ | ✅ | 不变 |
| deliverableIds | ✅ | ✅ | 不变 |
| validRefundsLength | ✅ | ✅ | 不变 |
| deliverablesHead | ✅ | ✅ | 不变 |
| deliverablesCount | ✅ | ✅ | 不变 |
| acknowledged | ❌ | ✅ | 新增 |

---

## ⚠️ 常见错误

### 1. Stake 不足

```solidity
error InsufficientStake(uint256 provided, uint256 required)
```

**原因**: 首次注册时质押少于 100 0G

**解决**:
```javascript
{ value: ethers.parseEther("100") }
```

### 2. 更新时添加质押

```solidity
error CannotAddStakeWhenUpdating()
```

**原因**: 更新服务时提供了 `value`

**解决**: 更新时不要提供 `value` 参数

### 3. 撤销确认失败

```solidity
error CannotRevokeWithNonZeroBalance(address user, address provider, uint256 balance)
```

**原因**: User 余额不为 0 时尝试撤销确认

**解决**: 先提取所有余额，再撤销确认

### 4. TEE Signer 未确认

```solidity
revert InvalidVerifierInput("TEE signer not acknowledged")
```

**原因**: Settlement 时确认状态不满足

**检查**:
- Owner 是否调用了 `acknowledgeTEESignerByOwner`
- User 是否已转账（自动确认）
- Service 的 `teeSignerAddress` 是否有效

---

## 🎯 迁移检查清单

### Provider 端

- [ ] 更新 `addOrUpdateService` 调用
- [ ] 准备 100 0G 质押
- [ ] 更新签名生成逻辑
- [ ] 移除 `VerifierInput.providerSigner` 字段
- [ ] 更新测试用例

### User 端

- [ ] 移除 `acknowledgeProviderSigner` 调用
- [ ] 依赖转账自动确认
- [ ] 测试撤销确认流程

### Owner 端

- [ ] 实现 `acknowledgeTEESignerByOwner` 流程
- [ ] 建立 TEE Signer 审核机制

### 开发环境

- [ ] 更新合约 ABI
- [ ] 更新 EIP-712 签名代码
- [ ] 更新事件监听
- [ ] 更新测试环境
- [ ] 更新文档

---

## 📞 获取帮助

- 详细文档: [MIGRATION_GUIDE.md](./MIGRATION_GUIDE.md)
- 版本变更: [CHANGELOG.md](./CHANGELOG.md)
- 问题反馈: [GitHub Issues](https://github.com/0glabs/0g-serving-broker)

---

**版本**: v1.0.0
**最后更新**: 2026-01-14
