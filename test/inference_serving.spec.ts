import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { Block, TransactionReceipt } from "ethers";
import { deployments, ethers } from "hardhat";
import { Deployment } from "hardhat-deploy/types";
import { beforeEach } from "mocha";
import { InferenceServing as Serving, LedgerManager } from "../typechain-types";
import {
    AccountStructOutput,
    ServiceStructOutput,
    TEESettlementDataStruct,
} from "../typechain-types/contracts/inference/InferenceServing.sol/InferenceServing";
// Mock public key for testing - just a placeholder as ZK is no longer used
const publicKey: [bigint, bigint] = [BigInt(1), BigInt(2)];

describe("Inference Serving", () => {
    let serving: Serving;
    let servingDeployment: Deployment;
    let ledger: LedgerManager;
    let LedgerManagerDeployment: Deployment;
    let owner: HardhatEthersSigner,
        user1: HardhatEthersSigner,
        provider1: HardhatEthersSigner,
        provider2: HardhatEthersSigner;
    let ownerAddress: string, user1Address: string, provider1Address: string, provider2Address: string;

    const ownerInitialLedgerBalance = 1000;
    const ownerInitialInferenceBalance = ownerInitialLedgerBalance / 4;

    const user1InitialLedgerBalance = 2000;
    const user1InitialInferenceBalance = user1InitialLedgerBalance / 4;
    const lockTime = 24 * 60 * 60;

    const provider1ServiceType = "HTTP";
    const provider1InputPrice = 100;
    const provider1OutputPrice = 100;
    const provider1Url = "https://example-1.com";
    const provider1Model = "llama-8b";
    const provider1Verifiability = "SPML";

    const provider2ServiceType = "HTTP";
    const provider2InputPrice = 100;
    const provider2OutputPrice = 100;
    const provider2Url = "https://example-2.com";
    const provider2Model = "phi-3-mini-4k-instruct";
    const provider2Verifiability = "TeeML";

    const additionalData = "U2FsdGVkX18cuPVgRkw/sHPq2YzJE5MyczGO0vOTQBBiS9A4Pka5woWK82fZr0Xjh8mDhjlW9ARsX6e6sKDChg==";

    beforeEach(async () => {
        await deployments.fixture(["compute-network"]);
        servingDeployment = await deployments.get("InferenceServing");
        LedgerManagerDeployment = await deployments.get("LedgerManager");
        serving = await ethers.getContractAt("InferenceServing", servingDeployment.address);
        ledger = await ethers.getContractAt("LedgerManager", LedgerManagerDeployment.address);

        [owner, user1, provider1, provider2] = await ethers.getSigners();
        [ownerAddress, user1Address, provider1Address, provider2Address] = await Promise.all([
            owner.getAddress(),
            user1.getAddress(),
            provider1.getAddress(),
            provider2.getAddress(),
        ]);
    });

    beforeEach(async () => {
        await Promise.all([
            ledger.addLedger(publicKey, additionalData, {
                value: ownerInitialLedgerBalance,
            }),
            ledger.connect(user1).addLedger(publicKey, additionalData, {
                value: user1InitialLedgerBalance,
            }),
        ]);

        await Promise.all([
            ledger.transferFund(provider1Address, "inference", ownerInitialInferenceBalance),
            ledger.connect(user1).transferFund(provider1Address, "inference", user1InitialInferenceBalance),

            serving.connect(provider1).addOrUpdateService({
                serviceType: provider1ServiceType,
                url: provider1Url,
                model: provider1Model,
                verifiability: provider1Verifiability,
                inputPrice: provider1InputPrice,
                outputPrice: provider1OutputPrice,
                additionalInfo: "",
            }),
            serving.connect(provider2).addOrUpdateService({
                serviceType: provider2ServiceType,
                url: provider2Url,
                model: provider2Model,
                verifiability: provider2Verifiability,
                inputPrice: provider2InputPrice,
                outputPrice: provider2OutputPrice,
                additionalInfo: "",
            }),
        ]);
    });

    describe("Owner", () => {
        it("should succeed in updating lock time succeed", async () => {
            const updatedLockTime = 2 * 24 * 60 * 60;
            await expect(serving.connect(owner).updateLockTime(updatedLockTime)).not.to.be.reverted;

            const result = await serving.lockTime();
            expect(result).to.equal(BigInt(updatedLockTime));
        });
    });

    describe("User", () => {
        it("should fail to update the lock time if it is not the owner", async () => {
            const updatedLockTime = 2 * 24 * 60 * 60;
            await expect(serving.connect(user1).updateLockTime(updatedLockTime)).to.be.reverted;
            const result = await serving.lockTime();
            expect(result).to.equal(BigInt(lockTime));
        });

        it("should transfer fund and update balance", async () => {
            const transferAmount = (ownerInitialLedgerBalance - ownerInitialInferenceBalance) / 3;
            await ledger.transferFund(provider1Address, "inference", transferAmount);

            const account = await serving.getAccount(ownerAddress, provider1);
            expect(account.balance).to.equal(BigInt(ownerInitialInferenceBalance + transferAmount));
        });

        it("should get all users", async () => {
            const [accounts] = await serving.getAllAccounts(0, 0);
            const userAddresses = (accounts as AccountStructOutput[]).map((a) => a.user);
            const providerAddresses = (accounts as AccountStructOutput[]).map((a) => a.provider);
            const balances = (accounts as AccountStructOutput[]).map((a) => a.balance);

            expect(userAddresses).to.have.members([ownerAddress, user1Address]);
            expect(providerAddresses).to.have.members([provider1Address, provider1Address]);
            expect(balances).to.have.members([
                BigInt(ownerInitialInferenceBalance),
                BigInt(user1InitialInferenceBalance),
            ]);
        });

        it("should get accounts by provider", async () => {
            // Add another provider for testing
            await ledger.transferFund(provider2Address, "inference", ownerInitialInferenceBalance);

            const [accounts1, total1] = await serving.getAccountsByProvider(provider1Address, 0, 0);
            const [accounts2, total2] = await serving.getAccountsByProvider(provider2Address, 0, 0);

            expect(total1).to.equal(BigInt(2)); // owner and user1 with provider1
            expect(total2).to.equal(BigInt(1)); // only owner with provider2
            expect(accounts1.length).to.equal(2);
            expect(accounts2.length).to.equal(1);

            const provider1Users = accounts1.map((a) => a.user);
            const provider2Users = accounts2.map((a) => a.user);
            expect(provider1Users).to.have.members([ownerAddress, user1Address]);
            expect(provider2Users).to.have.members([ownerAddress]);
        });

        it("should get accounts by provider with pagination", async () => {
            const [accounts, total] = await serving.getAccountsByProvider(provider1Address, 0, 1);

            expect(total).to.equal(BigInt(2));
            expect(accounts.length).to.equal(1);

            const [accounts2, total2] = await serving.getAccountsByProvider(provider1Address, 1, 1);
            expect(total2).to.equal(BigInt(2));
            expect(accounts2.length).to.equal(1);

            // Check that we get different accounts
            expect(accounts[0].user).to.not.equal(accounts2[0].user);
        });

        it("should get accounts by user", async () => {
            // Add another provider for testing
            await ledger.transferFund(provider2Address, "inference", ownerInitialInferenceBalance);

            const [ownerAccounts, ownerTotal] = await serving.getAccountsByUser(ownerAddress, 0, 0);
            const [user1Accounts, user1Total] = await serving.getAccountsByUser(user1Address, 0, 0);

            expect(ownerTotal).to.equal(BigInt(2)); // owner with provider1 and provider2
            expect(user1Total).to.equal(BigInt(1)); // user1 only with provider1
            expect(ownerAccounts.length).to.equal(2);
            expect(user1Accounts.length).to.equal(1);

            const ownerProviders = ownerAccounts.map((a) => a.provider);
            const user1Providers = user1Accounts.map((a) => a.provider);
            expect(ownerProviders).to.have.members([provider1Address, provider2Address]);
            expect(user1Providers).to.have.members([provider1Address]);
        });

        it("should get batch accounts by users", async () => {
            const accounts = await serving.connect(provider1).getBatchAccountsByUsers([ownerAddress, user1Address]);

            expect(accounts.length).to.equal(2);
            expect(accounts[0].user).to.equal(ownerAddress);
            expect(accounts[1].user).to.equal(user1Address);
            expect(accounts[0].provider).to.equal(provider1Address);
            expect(accounts[1].provider).to.equal(provider1Address);
        });

        it("should handle batch accounts with non-existent users", async () => {
            const nonExistentUser = ethers.Wallet.createRandom().address;
            const accounts = await serving
                .connect(provider1)
                .getBatchAccountsByUsers([ownerAddress, nonExistentUser, user1Address]);

            expect(accounts.length).to.equal(3);
            expect(accounts[0].user).to.equal(ownerAddress);
            expect(accounts[1].user).to.equal("0x0000000000000000000000000000000000000000"); // non-existent should be zero
            expect(accounts[2].user).to.equal(user1Address);
        });

        it("should enforce pagination limits", async () => {
            await expect(serving.getAccountsByProvider(provider1Address, 0, 51)).to.be.revertedWith("Limit too large");
            await expect(serving.getAccountsByUser(ownerAddress, 0, 51)).to.be.revertedWith("Limit too large");
        });
    });

    describe("Process refund", () => {
        let unlockTime: number;

        beforeEach(async () => {
            const res = await ledger.retrieveFund([provider1Address], "inference");
            const receipt = await res.wait();

            const block = await ethers.provider.getBlock((receipt as TransactionReceipt).blockNumber);
            unlockTime = (block as Block).timestamp + lockTime;
        });

        it("should succeeded if the unlockTime has arrived and called", async () => {
            await time.increaseTo(unlockTime);

            await ledger.retrieveFund([provider1Address], "inference");
            const account = await serving.getAccount(ownerAddress, provider1);
            expect(account.balance).to.be.equal(BigInt(0));
        });
    });

    describe("Refund Array Optimization", () => {
        // Constants from AccountLibrary contract
        const MAX_REFUNDS_PER_ACCOUNT = 30;

        beforeEach(async () => {
            // Setup: Transfer funds to ensure we have a clean test account
            // After setup: balance=1000 (500 from previous + 500 new), pendingRefund=0, refunds=[], validRefundsLength=0
            await ledger.connect(user1).transferFund(provider1Address, "inference", 500);
        });

        it("should reuse array positions after refund processing", async () => {
            // Step 1: Create first refund
            // Before: balance=1000, pendingRefund=0, refunds=[], validRefundsLength=0
            await ledger.connect(user1).retrieveFund([provider1Address], "inference");
            // After: balance=1000, pendingRefund=1000, refunds=[{amount:1000, processed:false}], validRefundsLength=1

            let account = await serving.getAccount(user1Address, provider1);
            const initialBalance = Number(account.balance);
            const initialPendingRefund = Number(account.pendingRefund);
            expect(account.refunds.length).to.equal(1);
            expect(initialPendingRefund).to.equal(initialBalance); // pendingRefund should equal balance after retrieveFund

            // Step 2: Process refund after lock time
            // Before: refunds=[{amount:1000, processed:false}], validRefundsLength=1
            await time.increase(lockTime + 1);
            await ledger.connect(user1).retrieveFund([provider1Address], "inference");
            // After: balance=0, pendingRefund=0, refunds=[{amount:1000, processed:true}], validRefundsLength=0 (dirty data in position 0)

            account = await serving.getAccount(user1Address, provider1);
            expect(Number(account.balance)).to.equal(0);
            expect(Number(account.pendingRefund)).to.equal(0);

            // Step 3: Transfer more funds and create new refund - should reuse position 0
            // Before: balance=0, refunds=[dirty_data], validRefundsLength=0
            const newTransferAmount = 300;
            await ledger.connect(user1).transferFund(provider1Address, "inference", newTransferAmount);
            // After transfer: balance=300, refunds=[dirty_data], validRefundsLength=0
            account = await serving.getAccount(user1Address, provider1);
            expect(Number(account.balance)).to.equal(300);
            expect(Number(account.pendingRefund)).to.equal(0);

            await ledger.connect(user1).retrieveFund([provider1Address], "inference");
            // After new refund: balance=300, pendingRefund=300, refunds=[{amount:300, processed:false}], validRefundsLength=1
            // Key optimization: Position 0 is REUSED, avoiding array.push() and saving ~15,000 gas

            account = await serving.getAccount(user1Address, provider1);
            // Array length should remain 1 (reusing processed position)
            expect(account.refunds.length).to.equal(1);
            expect(Number(account.balance)).to.equal(300);
            expect(Number(account.pendingRefund)).to.equal(300);
        });

        it("should handle refund cancellation through transfer operations", async () => {
            // Step 1: Create initial refund
            await ledger.connect(user1).retrieveFund([provider1Address], "inference");
            // After: balance=1000, pendingRefund=1000, refunds=[{amount:1000, processed:false}], validRefundsLength=1

            let account = await serving.getAccount(user1Address, provider1);
            const initialPendingRefund = Number(account.pendingRefund);
            const initialBalance = Number(account.balance);
            // State snapshot: pendingRefund should equal balance after retrieveFund
            expect(initialPendingRefund).to.equal(initialBalance);

            // Step 2: Transfer more funds - should automatically cancel some pending refunds
            const newTransferAmount = 300;
            await ledger.connect(user1).transferFund(provider1Address, "inference", newTransferAmount);

            account = await serving.getAccount(user1Address, provider1);
            expect(Number(account.balance)).to.equal(1000);
            const cancelledAmount = Math.min(300, initialPendingRefund);
            expect(Number(account.pendingRefund)).to.equal(initialPendingRefund - cancelledAmount);
        });

        it("should create multiple dirty data entries and demonstrate cleanup threshold", async () => {
            // Strategy: Create multiple refunds through partial cancellation, then process them

            // Step 1: Create a large refund
            await ledger.connect(user1).retrieveFund([provider1Address], "inference");

            let account = await serving.getAccount(user1Address, provider1);
            expect(account.refunds.length).to.equal(1);
            expect(Number(account.pendingRefund)).to.equal(1000);
            // After: refunds=[{amount:1000, processed:false}], validRefundsLength=1

            // Step 2: Use partial cancellation to split the refund into smaller pieces
            await ledger.connect(user1).transferFund(provider1Address, "inference", 10);
            // After: refunds=[{amount:990, processed:false}], validRefundsLength=1

            // Now request another refund for the new balance
            await ledger.connect(user1).retrieveFund([provider1Address], "inference");
            // After: refunds=[{amount:990, processed:false}, {amount:10, processed:false}], validRefundsLength=2

            account = await serving.getAccount(user1Address, provider1);
            console.log(
                `After partial cancellation and new refund: refunds.length=${
                    account.refunds.length
                }, pendingRefund=${Number(account.pendingRefund)}`
            );

            // Step 3: Repeat the pattern to create more refunds
            // The key insight: each transferFund + retrieveFund cycle may create new refund entries

            while (account.refunds.length < MAX_REFUNDS_PER_ACCOUNT) {
                // Small transfer and refund to potentially create new entries
                await ledger.connect(user1).transferFund(provider1Address, "inference", 10);
                await ledger.connect(user1).retrieveFund([provider1Address], "inference");

                account = await serving.getAccount(user1Address, provider1);

                if (account.refunds.length == MAX_REFUNDS_PER_ACCOUNT) {
                    account = await serving.getAccount(user1Address, provider1);
                    expect(account.refunds.length).to.equal(MAX_REFUNDS_PER_ACCOUNT);

                    // Now try to add one more refund - this should fail with TooManyRefunds error
                    await ledger.connect(user1).transferFund(provider1Address, "inference", 10);
                    await expect(ledger.connect(user1).retrieveFund([provider1Address], "inference"))
                        .to.be.revertedWithCustomError(serving, "TooManyRefunds")
                        .withArgs(user1Address, provider1Address);

                    console.log(`Reached MAX_REFUNDS_PER_ACCOUNT: ${account.refunds.length}`);
                }
            }

            // Step 4: Process all refunds to create dirty data
            await time.increase(lockTime + 1);
            await ledger.connect(user1).retrieveFund([provider1Address], "inference");

            account = await serving.getAccount(user1Address, provider1);

            // Verify cleanup was triggered since we had MAX_REFUNDS_PER_ACCOUNT dirty entries > REFUND_CLEANUP_THRESHOLD.
            // Physical cleanup should have occurred, reducing from MAX_REFUNDS_PER_ACCOUNT to 1 (left one since retrieveFund adds one fund while processing other refunds)
            expect(account.refunds.length).to.be.equal(1);
        });
    });

    describe("Service provider", () => {
        it("should get service", async () => {
            const service = await serving.getService(provider1Address);

            expect(service.serviceType).to.equal(provider1ServiceType);
            expect(service.url).to.equal(provider1Url);
            expect(service.model).to.equal(provider1Model);
            expect(service.verifiability).to.equal(provider1Verifiability);
            expect(service.inputPrice).to.equal(provider1InputPrice);
            expect(service.outputPrice).to.equal(provider1OutputPrice);
            expect(service.updatedAt).to.not.equal(0);
        });

        it("should get all services", async () => {
            const services = await serving.getAllServices();
            const addresses = (services as ServiceStructOutput[]).map((s) => s.provider);
            const serviceTypes = (services as ServiceStructOutput[]).map((s) => s.serviceType);
            const urls = (services as ServiceStructOutput[]).map((s) => s.url);
            const models = (services as ServiceStructOutput[]).map((s) => s.model);
            const allVerifiability = (services as ServiceStructOutput[]).map((s) => s.verifiability);
            const inputPrices = (services as ServiceStructOutput[]).map((s) => s.inputPrice);
            const outputPrices = (services as ServiceStructOutput[]).map((s) => s.outputPrice);
            const updatedAts = (services as ServiceStructOutput[]).map((s) => s.updatedAt);

            expect(addresses).to.have.members([provider1Address, provider2Address]);
            expect(serviceTypes).to.have.members([provider1ServiceType, provider2ServiceType]);
            expect(urls).to.have.members([provider1Url, provider2Url]);
            expect(models).to.have.members([provider1Model, provider2Model]);
            expect(allVerifiability).to.have.members([provider1Verifiability, provider2Verifiability]);
            expect(inputPrices).to.have.members([BigInt(provider1InputPrice), BigInt(provider2InputPrice)]);
            expect(outputPrices).to.have.members([BigInt(provider1OutputPrice), BigInt(provider2OutputPrice)]);
            expect(updatedAts[0]).to.not.equal(0);
            expect(updatedAts[1]).to.not.equal(0);
        });

        it("should update service", async () => {
            const modifiedServiceType = "RPC";
            const modifiedPriceUrl = "https://example-modified.com";
            const modifiedModel = "llama-13b";
            const modifiedVerifiability = "TeeML";
            const modifiedInputPrice = 200;
            const modifiedOutputPrice = 300;

            await expect(
                serving.connect(provider1).addOrUpdateService({
                    serviceType: modifiedServiceType,
                    url: modifiedPriceUrl,
                    model: modifiedModel,
                    verifiability: modifiedVerifiability,
                    inputPrice: modifiedInputPrice,
                    outputPrice: modifiedOutputPrice,
                    additionalInfo: "",
                })
            )
                .to.emit(serving, "ServiceUpdated")
                .withArgs(
                    provider1Address,
                    modifiedServiceType,
                    modifiedPriceUrl,
                    modifiedInputPrice,
                    modifiedOutputPrice,
                    anyValue,
                    modifiedModel,
                    modifiedVerifiability
                );

            const service = await serving.getService(provider1Address);

            expect(service.serviceType).to.equal(modifiedServiceType);
            expect(service.url).to.equal(modifiedPriceUrl);
            expect(service.model).to.equal(modifiedModel);
            expect(service.verifiability).to.equal(modifiedVerifiability);
            expect(service.inputPrice).to.equal(modifiedInputPrice);
            expect(service.outputPrice).to.equal(modifiedOutputPrice);
            expect(service.updatedAt).to.not.equal(0);
        });

        it("should remove service correctly", async function () {
            await expect(serving.connect(provider1).removeService())
                .to.emit(serving, "ServiceRemoved")
                .withArgs(provider1Address);

            const services = await serving.getAllServices();
            expect(services.length).to.equal(1);
        });
    });

    describe("TEE Settlement", () => {
        const testFee = 50;
        const testRequestsHash = ethers.keccak256(ethers.toUtf8Bytes("test_requests_hash"));

        // Create a separate wallet for TEE signing
        const teePrivateKey = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
        const teeWallet = new ethers.Wallet(teePrivateKey);
        const teeSignerAddress = teeWallet.address;

        beforeEach(async () => {
            // Acknowledge TEE signer for both users - using a dedicated TEE signer
            await serving.connect(owner).acknowledgeTEESigner(provider1Address, teeSignerAddress);
            await serving.connect(user1).acknowledgeTEESigner(provider1Address, teeSignerAddress);
        });

        async function createValidTEESettlement(
            user: string,
            provider: string,
            totalFee: bigint,
            requestsHash: string,
            nonce: bigint
        ): Promise<TEESettlementDataStruct> {
            // Create message hash exactly like the contract
            const messageHash = ethers.solidityPackedKeccak256(
                ["bytes32", "uint256", "address", "address", "uint256"],
                [requestsHash, nonce, provider, user, totalFee]
            );

            // Sign using the exact same approach as fine_tuning_serving.spec.ts backfillVerifierInput
            const signature = await teeWallet.signMessage(ethers.toBeArray(messageHash));

            return {
                user,
                provider,
                totalFee,
                requestsHash,
                nonce,
                signature,
            };
        }

        it("should succeed with valid TEE settlement", async () => {
            const nonce = BigInt(Date.now());
            const settlement = await createValidTEESettlement(
                ownerAddress,
                provider1Address,
                BigInt(testFee),
                testRequestsHash,
                nonce
            );

            // Get initial balance
            const initialBalance = await serving.getAccount(ownerAddress, provider1Address);

            // Execute settlement
            await serving.connect(provider1).settleFeesWithTEE([settlement]);

            // Verify balance was deducted
            const finalBalance = await serving.getAccount(ownerAddress, provider1Address);
            expect(finalBalance.balance).to.equal(initialBalance.balance - BigInt(testFee));
            expect(finalBalance.nonce).to.equal(nonce);
        });

        it("should handle multiple settlements in batch", async () => {
            const nonce1 = BigInt(Date.now());
            const nonce2 = nonce1 + BigInt(1);

            const settlement1 = await createValidTEESettlement(
                ownerAddress,
                provider1Address,
                BigInt(testFee),
                testRequestsHash,
                nonce1
            );

            const settlement2 = await createValidTEESettlement(
                user1Address,
                provider1Address,
                BigInt(testFee),
                testRequestsHash,
                nonce2
            );

            // Get initial balances
            const initialBalance1 = await serving.getAccount(ownerAddress, provider1Address);
            const initialBalance2 = await serving.getAccount(user1Address, provider1Address);

            // Execute batch settlement
            await serving.connect(provider1).settleFeesWithTEE([settlement1, settlement2]);

            // Verify both balances were deducted
            const finalBalance1 = await serving.getAccount(ownerAddress, provider1Address);
            const finalBalance2 = await serving.getAccount(user1Address, provider1Address);
            expect(finalBalance1.balance).to.equal(initialBalance1.balance - BigInt(testFee));
            expect(finalBalance2.balance).to.equal(initialBalance2.balance - BigInt(testFee));
        });

        it("should handle insufficient balance gracefully", async () => {
            const excessiveFee = ownerInitialInferenceBalance + 1000;
            const nonce = BigInt(Date.now());

            const settlement = await createValidTEESettlement(
                ownerAddress,
                provider1Address,
                BigInt(excessiveFee),
                testRequestsHash,
                nonce
            );

            // Get initial balance to verify it doesn't change after failed settlement
            const initialBalance = await serving.getAccount(ownerAddress, provider1Address);

            // Execute settlement - should partially succeed (settle available balance)
            await serving.connect(provider1).settleFeesWithTEE([settlement]);

            // Verify balance is now zero (all available was settled)
            const finalBalance = await serving.getAccount(ownerAddress, provider1Address);
            expect(finalBalance.balance).to.equal(0);
            expect(finalBalance.nonce).to.equal(nonce); // Nonce should update even for partial
        });

        it("should handle mixed success and failure in batch settlement", async () => {
            const nonce1 = BigInt(Date.now());
            const nonce2 = nonce1 + BigInt(1);

            // Create settlement with sufficient balance (should potentially succeed)
            const potentialSuccessSettlement = await createValidTEESettlement(
                user1Address,
                provider1Address,
                BigInt(testFee),
                testRequestsHash,
                nonce1
            );

            // Create settlement with insufficient balance (should definitely fail)
            const excessiveFee = ownerInitialInferenceBalance + 1000;
            const definiteFailSettlement = await createValidTEESettlement(
                ownerAddress,
                provider1Address,
                BigInt(excessiveFee),
                testRequestsHash,
                nonce2
            );

            // Get initial balances
            const initialBalance1 = await serving.getAccount(user1Address, provider1Address);
            const initialBalance2 = await serving.getAccount(ownerAddress, provider1Address);

            // Execute mixed batch - one full success, one partial success
            await serving.connect(provider1).settleFeesWithTEE([potentialSuccessSettlement, definiteFailSettlement]);

            // Verify user1 succeeded (balance deducted), owner partially settled (balance zero)
            const finalBalance1 = await serving.getAccount(user1Address, provider1Address);
            const finalBalance2 = await serving.getAccount(ownerAddress, provider1Address);
            expect(finalBalance1.balance).to.equal(initialBalance1.balance - BigInt(testFee)); // User1 succeeded
            expect(finalBalance2.balance).to.equal(0); // Owner's balance was fully settled
        });

        it("should fail with invalid signature", async () => {
            const settlement: TEESettlementDataStruct = {
                user: ownerAddress,
                provider: provider1Address,
                totalFee: BigInt(testFee),
                requestsHash: testRequestsHash,
                nonce: BigInt(Date.now()),
                signature: "0x" + "00".repeat(65), // Invalid mock signature
            };

            // Get initial balance to verify it doesn't change after failed settlement
            const initialBalance = await serving.getAccount(ownerAddress, provider1Address);

            // Execute settlement
            await serving.connect(provider1).settleFeesWithTEE([settlement]);

            // Verify balance unchanged (settlement failed)
            const finalBalance = await serving.getAccount(ownerAddress, provider1Address);
            expect(finalBalance.balance).to.equal(initialBalance.balance);
            expect(finalBalance.nonce).to.equal(initialBalance.nonce); // Nonce shouldn't update on failure
        });

        it("should prevent duplicate nonce usage", async () => {
            const nonce = BigInt(Date.now());

            const settlement1 = await createValidTEESettlement(
                ownerAddress,
                provider1Address,
                BigInt(testFee),
                testRequestsHash,
                nonce
            );

            // Get initial balance
            const initialBalance = await serving.getAccount(ownerAddress, provider1Address);

            // First settlement should succeed
            await serving.connect(provider1).settleFeesWithTEE([settlement1]);

            // Verify first settlement succeeded
            const balanceAfterFirst = await serving.getAccount(ownerAddress, provider1Address);
            expect(balanceAfterFirst.balance).to.equal(initialBalance.balance - BigInt(testFee));
            expect(balanceAfterFirst.nonce).to.equal(nonce);

            // Second settlement with same nonce should fail
            const settlement2 = await createValidTEESettlement(
                ownerAddress,
                provider1Address,
                BigInt(testFee),
                testRequestsHash,
                nonce // Same nonce
            );

            // Execute second settlement
            await serving.connect(provider1).settleFeesWithTEE([settlement2]);

            // Verify balance unchanged after failed second settlement
            const finalBalance = await serving.getAccount(ownerAddress, provider1Address);
            expect(finalBalance.balance).to.equal(balanceAfterFirst.balance);
        });

        it("should revert with empty settlements array", async () => {
            await expect(serving.connect(provider1).settleFeesWithTEE([])).to.be.revertedWith(
                "No settlements provided"
            );
        });

        it("should handle provider mismatch", async () => {
            const nonce = BigInt(Date.now());

            const settlement = await createValidTEESettlement(
                ownerAddress,
                provider2Address, // Different provider than the one calling
                BigInt(testFee),
                testRequestsHash,
                nonce
            );

            // Get initial balance from provider1 (the one we'll call with)
            const initialBalance = await serving.getAccount(ownerAddress, provider1Address);

            // Execute settlement
            await serving.connect(provider1).settleFeesWithTEE([settlement]);

            // Verify balance unchanged with provider1 (settlement failed)
            const finalBalance = await serving.getAccount(ownerAddress, provider1Address);
            expect(finalBalance.balance).to.equal(initialBalance.balance);
            expect(finalBalance.nonce).to.equal(initialBalance.nonce);
        });

        describe("Partial Settlement", () => {
            it("should handle partial settlement when balance is insufficient", async () => {
                const nonce = BigInt(Date.now());
                const requestedFee = ownerInitialInferenceBalance + 50; // More than available
                
                // Get initial balance
                const initialBalance = await serving.getAccount(ownerAddress, provider1Address);
                const availableBalance = initialBalance.balance;
                
                // Create settlement with more fee than available balance
                const settlement = await createValidTEESettlement(
                    ownerAddress,
                    provider1Address,
                    BigInt(requestedFee),
                    testRequestsHash,
                    nonce
                );

                // Check partial settlement before execution
                const result = await serving.connect(provider1).settleFeesWithTEE.staticCall([settlement]);
                expect(result.failedUsers).to.have.length(0); // No validation failures
                expect(result.partialUsers).to.have.length(1); // One partial settlement
                expect(result.partialUsers[0]).to.equal(ownerAddress);
                expect(result.partialAmounts[0]).to.equal(BigInt(requestedFee) - availableBalance);

                // Execute settlement
                await serving.connect(provider1).settleFeesWithTEE([settlement]);

                // Verify balance is now zero (all available was settled)
                const finalBalance = await serving.getAccount(ownerAddress, provider1Address);
                expect(finalBalance.balance).to.equal(0);
                expect(finalBalance.nonce).to.equal(nonce); // Nonce should update even for partial

                // Note: We can't verify the return values here since the transaction already changed state
                // The static call would need a fresh state to work properly
            });

            it("should handle full settlement when balance is sufficient", async () => {
                const nonce = BigInt(Date.now());
                const requestedFee = ownerInitialInferenceBalance - 10; // Less than available
                
                // Get initial balance
                const initialBalance = await serving.getAccount(ownerAddress, provider1Address);
                
                // Create settlement with less fee than available balance
                const settlement = await createValidTEESettlement(
                    ownerAddress,
                    provider1Address,
                    BigInt(requestedFee),
                    testRequestsHash,
                    nonce
                );

                // Check return values before execution
                const result = await serving.connect(provider1).settleFeesWithTEE.staticCall([settlement]);
                expect(result.failedUsers).to.have.length(0); // No validation failures
                expect(result.partialUsers).to.have.length(0); // No partial settlements
                expect(result.partialAmounts).to.have.length(0);

                // Execute settlement
                await serving.connect(provider1).settleFeesWithTEE([settlement]);

                // Verify balance is reduced by exact amount
                const finalBalance = await serving.getAccount(ownerAddress, provider1Address);
                expect(finalBalance.balance).to.equal(initialBalance.balance - BigInt(requestedFee));
                expect(finalBalance.nonce).to.equal(nonce);

                // Note: For full settlements, the function would return empty arrays
                // but we can't verify this with staticCall after the transaction has been executed
                // The absence of TEEPartialSettlement event confirms this was a full settlement
            });

            it("should handle mixed batch with partial and full settlements", async () => {
                const nonce1 = BigInt(Date.now());
                const nonce2 = nonce1 + 1n;
                
                // Get initial balances
                const ownerInitialBalance = await serving.getAccount(ownerAddress, provider1Address);
                const user1InitialBalance = await serving.getAccount(user1Address, provider1Address);
                
                // Settlement 1: Owner with insufficient balance (partial)
                const ownerRequestedFee = ownerInitialBalance.balance + 30n;
                const ownerSettlement = await createValidTEESettlement(
                    ownerAddress,
                    provider1Address,
                    ownerRequestedFee,
                    testRequestsHash,
                    nonce1
                );

                // Settlement 2: User1 with sufficient balance (full)
                const user1RequestedFee = 50n;
                const user1Settlement = await createValidTEESettlement(
                    user1Address,
                    provider1Address,
                    user1RequestedFee,
                    ethers.keccak256(ethers.toUtf8Bytes("user1_requests_hash")),
                    nonce2
                );

                // Check return values before execution
                const result = await serving.connect(provider1).settleFeesWithTEE.staticCall([ownerSettlement, user1Settlement]);
                expect(result.failedUsers).to.have.length(0); // No validation failures
                expect(result.partialUsers).to.have.length(1); // Owner has partial settlement
                expect(result.partialUsers[0]).to.equal(ownerAddress);
                expect(result.partialAmounts[0]).to.equal(ownerRequestedFee - ownerInitialBalance.balance);

                // Execute mixed batch
                await serving.connect(provider1).settleFeesWithTEE([ownerSettlement, user1Settlement]);

                // Verify final balances
                const ownerFinalBalance = await serving.getAccount(ownerAddress, provider1Address);
                const user1FinalBalance = await serving.getAccount(user1Address, provider1Address);
                
                expect(ownerFinalBalance.balance).to.equal(0); // All available was settled
                expect(user1FinalBalance.balance).to.equal(user1InitialBalance.balance - user1RequestedFee);

                // Note: For mixed settlements, the function would return arrays with unsettled amounts
                // but we can't verify this with staticCall after the transaction has been executed
                // The TEEPartialSettlement and TEESettlementCompleted events confirm the correct behavior
            });

            it("should handle batch of 50 settlements within gas limit", async () => {
                const batchSize = 50;
                const settlements = [];
                const baseNonce = BigInt(Date.now()) * 1000n; // Avoid nonce conflicts
                
                // Reuse existing users and create settlements
                for (let i = 0; i < batchSize; i++) {
                    // Cycle through existing users (owner, user1)
                    const userIndex = i % 2;
                    let userAddress;
                    if (userIndex === 0) userAddress = ownerAddress;
                    else userAddress = user1Address;
                    
                    // Create settlement for this user
                    const settlement = await createValidTEESettlement(
                        userAddress,
                        provider1Address,
                        BigInt(100 + i), // Varying fee amounts
                        ethers.keccak256(ethers.toUtf8Bytes(`batch_test_${i}`)),
                        baseNonce + BigInt(i)
                    );
                    
                    settlements.push(settlement);
                }
                
                console.log(`\n=== Gas Test for ${batchSize} Settlements ===`);
                
                // Estimate gas for the batch settlement
                const gasEstimate = await serving.connect(provider1).settleFeesWithTEE.estimateGas(settlements);
                console.log(`Gas estimate: ${gasEstimate.toString()}`);
                
                // Execute the batch settlement and measure actual gas
                const tx = await serving.connect(provider1).settleFeesWithTEE(settlements);
                const receipt = await tx.wait();
                const actualGas = receipt.gasUsed;
                
                console.log(`Actual gas used: ${actualGas.toString()}`);
                console.log(`Gas per settlement: ${(actualGas / BigInt(batchSize)).toString()}`);
                console.log(`Gas efficiency: ${((gasEstimate - actualGas) * 100n / gasEstimate).toString()}% under estimate`);
                
                // Assert reasonable gas limits
                expect(actualGas).to.be.below(1500000); // Should be under 1.5M gas for 50 settlements
                expect(actualGas / BigInt(batchSize)).to.be.below(30000); // Should be under 30k gas per settlement
                
                // Verify the batch was processed successfully
                expect(receipt.status).to.equal(1);
                
                console.log(`✅ Gas test passed: ${actualGas.toString()} gas for ${batchSize} settlements\n`);
            });
        });
    });

    describe("deleteAccount", () => {
        it("should delete account", async () => {
            await expect(ledger.deleteLedger()).not.to.be.reverted;
            const [accounts] = await serving.getAllAccounts(0, 0);
            expect(accounts.length).to.equal(1);
        });
    });
});
