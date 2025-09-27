import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { Block, ethers as newEthers, TransactionReceipt } from "ethers";
import { deployments, ethers } from "hardhat";
import { Deployment } from "hardhat-deploy/types";
import { beforeEach } from "mocha";
// Mock public key for testing - just a placeholder as ZK is no longer used
const publicKey: [bigint, bigint] = [BigInt(1), BigInt(2)];
import { FineTuningServing as Serving, LedgerManager } from "../typechain-types";
import {
    AccountStructOutput,
    QuotaStruct,
    ServiceStructOutput,
    VerifierInputStruct,
} from "../typechain-types/contracts/fine-tuning/FineTuningServing.sol/FineTuningServing";

describe("Fine tuning serving", () => {
    let serving: Serving;
    let servingDeployment: Deployment;
    let ledger: LedgerManager;
    let LedgerManagerDeployment: Deployment;
    let owner: HardhatEthersSigner,
        user1: HardhatEthersSigner,
        provider1: HardhatEthersSigner,
        provider2: HardhatEthersSigner;
    let ownerAddress: string, user1Address: string, provider1Address: string, provider2Address: string;

    const walletMockTEE = ethers.Wallet.createRandom();
    const providerPrivateKey = walletMockTEE.privateKey;

    const ownerInitialLedgerBalance = 1000;
    const ownerInitialFineTuningBalance = ownerInitialLedgerBalance / 4;

    const user1InitialLedgerBalance = 2000;
    const user1InitialFineTuningBalance = user1InitialLedgerBalance / 4;
    const lockTime = 24 * 60 * 60;
    const defaultPenaltyPercentage = 30;

    const provider1Quota: QuotaStruct = {
        cpuCount: BigInt(8),
        nodeMemory: BigInt(32),
        gpuCount: BigInt(1),
        nodeStorage: BigInt(50000),
        gpuType: "H100",
    };
    const provider1PricePerToken = 100;
    const provider1Url = "https://example-1.com";
    const provider1Signer = walletMockTEE.address;

    const provider2Quota: QuotaStruct = {
        cpuCount: BigInt(8),
        nodeMemory: BigInt(32),
        gpuCount: BigInt(1),
        nodeStorage: BigInt(50000),
        gpuType: "H100",
    };
    const provider2PricePerToken = 100;
    const provider2Url = "https://example-2.com";
    const provider2Signer = walletMockTEE.address;

    const additionalData = "";

    beforeEach(async () => {
        await deployments.fixture(["compute-network"]);
        servingDeployment = await deployments.get("FineTuningServing");
        LedgerManagerDeployment = await deployments.get("LedgerManager");
        serving = await ethers.getContractAt("FineTuningServing", servingDeployment.address);
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
            ledger.transferFund(provider1Address, "fine-tuning", ownerInitialFineTuningBalance),
            ledger.connect(user1).transferFund(provider1Address, "fine-tuning", user1InitialFineTuningBalance),

            serving
                .connect(provider1)
                .addOrUpdateService(provider1Url, provider1Quota, provider1PricePerToken, provider1Signer, false, []),
            serving
                .connect(provider2)
                .addOrUpdateService(provider2Url, provider2Quota, provider2PricePerToken, provider2Signer, false, []),
        ]);
    });

    describe("Owner", () => {
        it("should succeed in updating lock time succeed", async () => {
            const updatedLockTime = 2 * 24 * 60 * 60;
            await expect(serving.connect(owner).updateLockTime(updatedLockTime)).not.to.be.reverted;

            const result = await serving.lockTime();
            expect(result).to.equal(BigInt(updatedLockTime));
        });

        it("should succeed in updating penalty percentage succeed", async () => {
            const updatedPenaltyPercentage = 60;
            await expect(serving.connect(owner).updatePenaltyPercentage(updatedPenaltyPercentage)).not.to.be.reverted;

            const result = await serving.penaltyPercentage();
            expect(result).to.equal(BigInt(updatedPenaltyPercentage));
        });
    });

    describe("User", () => {
        it("should fail to update the lock time if it is not the owner", async () => {
            const updatedLockTime = 2 * 24 * 60 * 60;
            await expect(serving.connect(user1).updateLockTime(updatedLockTime)).to.be.reverted;
            const result = await serving.lockTime();
            expect(result).to.equal(BigInt(lockTime));
        });

        it("should fail to update the penalty percentage if it is not the owner", async () => {
            const updatedPenaltyPercentage = 60;
            await expect(serving.connect(user1).updatePenaltyPercentage(updatedPenaltyPercentage)).to.be.reverted;
            const result = await serving.penaltyPercentage();
            expect(result).to.equal(BigInt(defaultPenaltyPercentage));
        });

        it("should transfer fund and update balance", async () => {
            const transferAmount = (ownerInitialLedgerBalance - ownerInitialFineTuningBalance) / 3;
            await ledger.transferFund(provider1Address, "fine-tuning", transferAmount);

            const account = await serving.getAccount(ownerAddress, provider1);
            expect(account.balance).to.equal(BigInt(ownerInitialFineTuningBalance + transferAmount));
        });

        it("should get all users", async () => {
            const [accounts] = await serving.getAllAccounts(0, 0);
            const userAddresses = (accounts as AccountStructOutput[]).map((a) => a.user);
            const providerAddresses = (accounts as AccountStructOutput[]).map((a) => a.provider);
            const balances = (accounts as AccountStructOutput[]).map((a) => a.balance);

            expect(userAddresses).to.have.members([ownerAddress, user1Address]);
            expect(providerAddresses).to.have.members([provider1Address, provider1Address]);
            expect(balances).to.have.members([
                BigInt(ownerInitialFineTuningBalance),
                BigInt(user1InitialFineTuningBalance),
            ]);
        });

        it("should support pagination in getAllAccounts", async () => {
            const [allAccounts, total] = await serving.getAllAccounts(0, 0);
            expect(total).to.equal(BigInt(2));
            expect(allAccounts.length).to.equal(2);
            
            // Test pagination with limit
            const [firstPage, total1] = await serving.getAllAccounts(0, 1);
            expect(total1).to.equal(BigInt(2));
            expect(firstPage.length).to.equal(1);
            
            const [secondPage, total2] = await serving.getAllAccounts(1, 1);
            expect(total2).to.equal(BigInt(2));
            expect(secondPage.length).to.equal(1);
            
            // Verify different accounts in each page
            expect(firstPage[0].user).to.not.equal(secondPage[0].user);
            
            // Test offset beyond bounds
            const [emptyPage, total3] = await serving.getAllAccounts(10, 1);
            expect(total3).to.equal(BigInt(2));
            expect(emptyPage.length).to.equal(0);
        });

        it("should enforce pagination limits", async () => {
            await expect(serving.getAllAccounts(0, 51)).to.be.revertedWith("Limit too large");
        });

        it("should get accounts by provider", async () => {
            // Add another provider for testing
            await ledger.transferFund(provider2Address, "fine-tuning", ownerInitialFineTuningBalance);
            
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
            await ledger.transferFund(provider2Address, "fine-tuning", ownerInitialFineTuningBalance);
            
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
            const accounts = await serving.connect(provider1).getBatchAccountsByUsers([ownerAddress, nonExistentUser, user1Address]);
            
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
            const res = await ledger.retrieveFund([provider1Address], "fine-tuning");
            const receipt = await res.wait();

            const block = await ethers.provider.getBlock((receipt as TransactionReceipt).blockNumber);
            unlockTime = (block as Block).timestamp + lockTime;
        });

        it("should succeeded if the unlockTime has arrived and called", async () => {
            await time.increaseTo(unlockTime);

            await ledger.retrieveFund([provider1Address], "fine-tuning");
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
            await ledger.connect(user1).transferFund(provider1Address, "fine-tuning", 500);
        });

        it("should reuse array positions after refund processing", async () => {
            // Step 1: Create first refund
            // Before: balance=1000, pendingRefund=0, refunds=[], validRefundsLength=0
            await ledger.connect(user1).retrieveFund([provider1Address], "fine-tuning");
            // After: balance=1000, pendingRefund=1000, refunds=[{amount:1000, processed:false}], validRefundsLength=1
            
            let account = await serving.getAccount(user1Address, provider1);
            const initialBalance = Number(account.balance);
            const initialPendingRefund = Number(account.pendingRefund);
            expect(account.refunds.length).to.equal(1);
            expect(initialPendingRefund).to.equal(initialBalance); // pendingRefund should equal balance after retrieveFund
            
            // Step 2: Process refund after lock time
            // Before: refunds=[{amount:1000, processed:false}], validRefundsLength=1
            await time.increase(lockTime + 1);
            await ledger.connect(user1).retrieveFund([provider1Address], "fine-tuning");
            // After: balance=0, pendingRefund=0, refunds=[{amount:1000, processed:true}], validRefundsLength=0 (dirty data in position 0)
            
            account = await serving.getAccount(user1Address, provider1);
            expect(Number(account.balance)).to.equal(0);
            expect(Number(account.pendingRefund)).to.equal(0);
            
            // Step 3: Transfer more funds and create new refund
            // Before: balance=0, refunds=[dirty_data], validRefundsLength=0
            const newTransferAmount = 300;
            await ledger.connect(user1).transferFund(provider1Address, "fine-tuning", newTransferAmount);
            // After transfer: balance=300, refunds=[dirty_data], validRefundsLength=0
            account = await serving.getAccount(user1Address, provider1);
            expect(Number(account.balance)).to.equal(300);
            expect(Number(account.pendingRefund)).to.equal(0);
            
            await ledger.connect(user1).retrieveFund([provider1Address], "fine-tuning");
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
            // Before: balance=1000, pendingRefund=0, refunds=[], validRefundsLength=0
            await ledger.connect(user1).retrieveFund([provider1Address], "fine-tuning");
            // After: balance=1000, pendingRefund=1000, refunds=[{amount:1000, processed:false}], validRefundsLength=1
            
            let account = await serving.getAccount(user1Address, provider1);
            const initialPendingRefund = Number(account.pendingRefund);
            const initialBalance = Number(account.balance);
            // State snapshot: pendingRefund should equal balance after retrieveFund
            expect(initialPendingRefund).to.equal(initialBalance);
            
            // Step 2: Transfer more funds - should automatically cancel some pending refunds
            // Before: balance=1000, pendingRefund=1000, refunds=[{amount:1000, processed:false}]
            const newTransferAmount = 300;
            await ledger.connect(user1).transferFund(provider1Address, "fine-tuning", newTransferAmount);
            // During transfer: cancelRetrievingAmount = min(300, 1000) = 300
            // - Refund is partially cancelled: refund amount reduces by 300
            // - PendingRefund becomes 1000-300=700
            // After: balance=1000, pendingRefund=700, refunds=[{amount:700, processed:false}], validRefundsLength=1
            
            account = await serving.getAccount(user1Address, provider1);
            expect(Number(account.balance)).to.equal(1000);
            // Should cancel min(300, initialPendingRefund) from pending refunds
            const cancelledAmount = Math.min(300, initialPendingRefund);
            expect(Number(account.pendingRefund)).to.equal(initialPendingRefund - cancelledAmount);
        });

        it("should create multiple dirty data entries and demonstrate cleanup threshold", async () => {
            // Strategy: Create multiple refunds through partial cancellation, then process them
            
            // Step 1: Create a large refund
            await ledger.connect(user1).retrieveFund([provider1Address], "fine-tuning");
            
            let account = await serving.getAccount(user1Address, provider1);
            expect(account.refunds.length).to.equal(1);
            expect(Number(account.pendingRefund)).to.equal(1000);
            // After: refunds=[{amount:1000, processed:false}], validRefundsLength=1
            
            // Step 2: Use partial cancellation to split the refund into smaller pieces
            await ledger.connect(user1).transferFund(provider1Address, "fine-tuning", 10);
            // After: refunds=[{amount:990, processed:false}], validRefundsLength=1
            
            // Now request another refund for the new balance
            await ledger.connect(user1).retrieveFund([provider1Address], "fine-tuning");
            // After: refunds=[{amount:990, processed:false}, {amount:10, processed:false}], validRefundsLength=2
            
            account = await serving.getAccount(user1Address, provider1);
            console.log(`After partial cancellation and new refund: refunds.length=${account.refunds.length}, pendingRefund=${Number(account.pendingRefund)}`);
            
            // Step 3: Repeat the pattern to create more refunds
            // The key insight: each transferFund + retrieveFund cycle may create new refund entries
            
            while (account.refunds.length < MAX_REFUNDS_PER_ACCOUNT) {
                // Small transfer and refund to potentially create new entries
                await ledger.connect(user1).transferFund(provider1Address, "fine-tuning", 10);
                await ledger.connect(user1).retrieveFund([provider1Address], "fine-tuning");
                
                account = await serving.getAccount(user1Address, provider1);
                
                if (account.refunds.length == MAX_REFUNDS_PER_ACCOUNT) {
                    account = await serving.getAccount(user1Address, provider1);
                    expect(account.refunds.length).to.equal(MAX_REFUNDS_PER_ACCOUNT);
                    
                    // Now try to add one more refund - this should fail with TooManyRefunds error
                    await ledger.connect(user1).transferFund(provider1Address, "fine-tuning", 10);
                    await expect(
                        ledger.connect(user1).retrieveFund([provider1Address], "fine-tuning")
                    ).to.be.revertedWithCustomError(serving, "TooManyRefunds")
                        .withArgs(user1Address, provider1Address);
                    
                    console.log(`Reached MAX_REFUNDS_PER_ACCOUNT: ${account.refunds.length}`);
                    }

            }
            
            // Step 4: Process all refunds to create dirty data
            await time.increase(lockTime + 1);
            await ledger.connect(user1).retrieveFund([provider1Address], "fine-tuning");
            
            account = await serving.getAccount(user1Address, provider1);
            
            // Verify cleanup was triggered since we had MAX_REFUNDS_PER_ACCOUNT dirty entries > REFUND_CLEANUP_THRESHOLD.
            // Physical cleanup should have occurred, reducing from MAX_REFUNDS_PER_ACCOUNT to 1 (left one since retrieveFund adds one fund while processing other refunds)
            expect(account.refunds.length).to.be.equal(1);
            
        });

    });

    describe("Service provider", () => {
        it("should get service", async () => {
            const service = await serving.getService(provider1Address);

            expect(service.url).to.equal(provider1Url);
            expect(service.quota.cpuCount).to.equal(provider1Quota.cpuCount);
            expect(service.quota.nodeMemory).to.equal(provider1Quota.nodeMemory);
            expect(service.quota.gpuCount).to.equal(provider1Quota.gpuCount);
            expect(service.quota.nodeStorage).to.equal(provider1Quota.nodeStorage);
            expect(service.quota.gpuType).to.equal(provider1Quota.gpuType);
            expect(service.pricePerToken).to.equal(provider1PricePerToken);
            expect(service.providerSigner).to.equal(provider1Signer);
            expect(service.occupied).to.equal(false);
        });

        it("should get all services", async () => {
            const services = await serving.getAllServices();
            const addresses = (services as ServiceStructOutput[]).map((s) => s.provider);
            const urls = (services as ServiceStructOutput[]).map((s) => s.url);
            const pricePerTokens = (services as ServiceStructOutput[]).map((s) => s.pricePerToken);
            const providerSigners = (services as ServiceStructOutput[]).map((s) => s.providerSigner);
            const occupieds = (services as ServiceStructOutput[]).map((s) => s.occupied);

            expect(addresses).to.have.members([provider1Address, provider2Address]);
            expect(urls).to.have.members([provider1Url, provider2Url]);
            expect(pricePerTokens).to.have.members([BigInt(provider1PricePerToken), BigInt(provider2PricePerToken)]);
            expect(providerSigners).to.have.members([provider1Signer, provider2Signer]);
            expect(occupieds).to.have.members([false, false]);
        });

        it("should update service", async () => {
            const modifiedPriceUrl = "https://example-modified.com";
            const modifiedQuota: QuotaStruct = {
                cpuCount: BigInt(16),
                nodeMemory: BigInt(64),
                gpuCount: BigInt(2),
                nodeStorage: BigInt(100000),
                gpuType: "H200",
            };
            const modifiedPricePerToken = 200;
            const modifiedProviderSinger = "0xabcdef1234567890abcdef1234567890abcdef12";
            const modifiedOccupied = true;
            const modifiedModels = ["model"];

            await expect(
                serving
                    .connect(provider1)
                    .addOrUpdateService(
                        modifiedPriceUrl,
                        modifiedQuota,
                        modifiedPricePerToken,
                        modifiedProviderSinger,
                        modifiedOccupied,
                        modifiedModels
                    )
            )
                .to.emit(serving, "ServiceUpdated")
                .withArgs(
                    provider1Address,
                    modifiedPriceUrl,
                    Object.values(modifiedQuota),
                    modifiedPricePerToken,
                    (providerSinger: string) => {
                        return providerSinger.toLowerCase() === modifiedProviderSinger;
                    },
                    modifiedOccupied
                );

            const service = await serving.getService(provider1Address);

            expect(service.url).to.equal(modifiedPriceUrl);
            expect(service.quota.cpuCount).to.equal(modifiedQuota.cpuCount);
            expect(service.quota.nodeMemory).to.equal(modifiedQuota.nodeMemory);
            expect(service.quota.gpuCount).to.equal(modifiedQuota.gpuCount);
            expect(service.quota.nodeStorage).to.equal(modifiedQuota.nodeStorage);
            expect(service.quota.gpuType).to.equal(modifiedQuota.gpuType);
            expect(service.pricePerToken).to.equal(modifiedPricePerToken);
            expect(service.providerSigner.toLowerCase()).to.equal(modifiedProviderSinger);
            expect(service.occupied).to.equal(modifiedOccupied);
            expect(service.models.length).to.equal(modifiedModels.length);
            for (const index in modifiedModels) {
                expect(service.models[index]).to.equal(modifiedModels[index]);
            }
        });

        it("should remove service correctly", async function () {
            await expect(serving.connect(provider1).removeService())
                .to.emit(serving, "ServiceRemoved")
                .withArgs(provider1Address);

            const services = await serving.getAllServices();
            expect(services.length).to.equal(1);
        });
    });

    describe("Settle fees", () => {
        const modelRootHash = "0x1234567890abcdef1234567890abcdef12345678";
        const encryptedSecret = "0x1234567890abcdef1234567890abcdef12345678";
        const taskFee = 10;
        let verifierInput: VerifierInputStruct;
        let deliverableId: string;

        beforeEach(async () => {
            await serving.acknowledgeProviderSigner(provider1, provider1Signer);
            deliverableId = ethers.hexlify(ethers.randomBytes(32));
            await serving.connect(provider1).addDeliverable(ownerAddress, deliverableId, modelRootHash);
            await serving.acknowledgeDeliverable(provider1, deliverableId);

            verifierInput = {
                taskFee,
                encryptedSecret,
                modelRootHash,
                id: deliverableId,
                nonce: BigInt(1),
                providerSigner: provider1Signer,
                user: ownerAddress,
                signature: "",
            };

            verifierInput = await backfillVerifierInput(providerPrivateKey, verifierInput);
        });

        it("should succeed", async () => {
            const estimatedGas = await serving.connect(provider1).settleFees.estimateGas(verifierInput);
            console.log(`Estimated gas for settleFees: ${estimatedGas.toString()}`);

            const tx = await serving.connect(provider1).settleFees(verifierInput);
            const receipt = await tx.wait();
            console.log(`Actual gas used for settleFees: ${receipt.gasUsed.toString()}`);
            console.log(`Gas price: ${tx.gasPrice?.toString() || 'N/A'} wei`);
            console.log(`Transaction cost: ${(receipt.gasUsed * (tx.gasPrice || BigInt(0))).toString()} wei`);

            await expect(tx)
                .to.emit(serving, "BalanceUpdated")
                .withArgs(ownerAddress, provider1Address, ownerInitialFineTuningBalance - taskFee, 0);
        });

        it("should failed due to double spending", async () => {
            await serving.connect(provider1).settleFees(verifierInput);

            await expect(serving.connect(provider1).settleFees(verifierInput)).to.be.reverted;
        });

        it("should failed due to insufficient balance", async () => {
            verifierInput.taskFee = ownerInitialFineTuningBalance + 1;

            await expect(serving.connect(provider1).settleFees(verifierInput)).to.be.reverted;
        });

        it("should failed due to no secret", async () => {
            verifierInput.encryptedSecret = "0x";
            verifierInput = await backfillVerifierInput(providerPrivateKey, verifierInput);
            await expect(serving.connect(provider1).settleFees(verifierInput)).to.be.revertedWith(
                "secret should not be empty"
            );
        });
    });

    describe("Settle not ack fees", () => {
        const modelRootHash = "0x1234567890abcdef1234567890abcdef12345678";
        const encryptedSecret = "0x1234567890abcdef1234567890abcdef12345678";
        const taskFee = 10;
        let verifierInput: VerifierInputStruct;
        let deliverableId: string;

        beforeEach(async () => {
            await serving.acknowledgeProviderSigner(provider1, provider1Signer);
            deliverableId = ethers.hexlify(ethers.randomBytes(32));
            await serving.connect(provider1).addDeliverable(ownerAddress, deliverableId, modelRootHash);

            verifierInput = {
                taskFee,
                encryptedSecret: "0x",
                modelRootHash,
                id: deliverableId,
                nonce: BigInt(1),
                providerSigner: provider1Signer,
                user: ownerAddress,
                signature: "",
            };

            verifierInput = await backfillVerifierInput(providerPrivateKey, verifierInput);
        });

        it("should succeed", async () => {
            await expect(serving.connect(provider1).settleFees(verifierInput))
                .to.emit(serving, "BalanceUpdated")
                .withArgs(
                    ownerAddress,
                    provider1Address,
                    ownerInitialFineTuningBalance - (taskFee * defaultPenaltyPercentage) / 100,
                    0
                );
        });

        it("should failed due to secret", async () => {
            verifierInput.encryptedSecret = encryptedSecret;
            verifierInput = await backfillVerifierInput(providerPrivateKey, verifierInput);
            await expect(serving.connect(provider1).settleFees(verifierInput)).to.be.revertedWith(
                "secret should be empty"
            );
        });
    });

    describe("Deliverable Limits", () => {
        // Constants from AccountLibrary contract
        const MAX_DELIVERABLES_PER_ACCOUNT = 20;
        
        it("should allow adding deliverables up to the limit", async () => {
            // Add deliverables up to the limit
            for (let i = 0; i < MAX_DELIVERABLES_PER_ACCOUNT; i++) {
                const deliverableId = ethers.hexlify(ethers.randomBytes(32));
                const modelRootHash = ethers.hexlify(ethers.randomBytes(32));
                await serving.connect(provider1).addDeliverable(ownerAddress, deliverableId, modelRootHash);
            }
            
            const account = await serving.getAccount(ownerAddress, provider1);
            expect(account.deliverables.length).to.equal(MAX_DELIVERABLES_PER_ACCOUNT);
        });
        
        it("should use circular array strategy when adding deliverables beyond the limit", async () => {
            // Store deliverable IDs to verify circular array behavior
            const deliverableIds: string[] = [];
            const modelHashes: string[] = [];
            
            // First, add deliverables up to the limit
            for (let i = 0; i < MAX_DELIVERABLES_PER_ACCOUNT; i++) {
                const deliverableId = ethers.hexlify(ethers.randomBytes(32));
                const modelRootHash = ethers.hexlify(ethers.randomBytes(32));
                deliverableIds.push(deliverableId);
                modelHashes.push(modelRootHash);
                await serving.connect(provider1).addDeliverable(ownerAddress, deliverableId, modelRootHash);
            }
            
            let account = await serving.getAccount(ownerAddress, provider1);
            expect(account.deliverables.length).to.equal(MAX_DELIVERABLES_PER_ACCOUNT);
            expect(account.deliverablesCount).to.equal(MAX_DELIVERABLES_PER_ACCOUNT);
            expect(account.deliverablesHead).to.equal(0);
            
            // Verify all original deliverables are present through getDeliverable calls
            for (let i = 0; i < MAX_DELIVERABLES_PER_ACCOUNT; i++) {
                const deliverable = await serving.getDeliverable(ownerAddress, provider1Address, deliverableIds[i]);
                expect(deliverable.modelRootHash).to.equal(modelHashes[i]);
                expect(deliverable.id).to.equal(deliverableIds[i]);
            }
            
            // Add one more deliverable - should trigger circular array behavior
            const newId1 = ethers.hexlify(ethers.randomBytes(32));
            const newHash1 = ethers.hexlify(ethers.randomBytes(32));
            await serving.connect(provider1).addDeliverable(ownerAddress, newId1, newHash1);
            
            account = await serving.getAccount(ownerAddress, provider1);
            expect(account.deliverables.length).to.equal(MAX_DELIVERABLES_PER_ACCOUNT);
            expect(account.deliverablesCount).to.equal(MAX_DELIVERABLES_PER_ACCOUNT);
            expect(account.deliverablesHead).to.equal(1); // Head moved to next position
            
            // The oldest deliverable (first one) should have been removed from the mapping
            await expect(serving.getDeliverable(ownerAddress, provider1Address, deliverableIds[0]))
                .to.be.revertedWith("Deliverable does not exist");
            
            // New deliverable should be accessible
            const newDeliverable1 = await serving.getDeliverable(ownerAddress, provider1Address, newId1);
            expect(newDeliverable1.modelRootHash).to.equal(newHash1);
            expect(newDeliverable1.id).to.equal(newId1);
            
            // Add another deliverable - should remove the second oldest
            const newId2 = ethers.hexlify(ethers.randomBytes(32));
            const newHash2 = ethers.hexlify(ethers.randomBytes(32));
            await serving.connect(provider1).addDeliverable(ownerAddress, newId2, newHash2);
            
            account = await serving.getAccount(ownerAddress, provider1);
            expect(account.deliverables.length).to.equal(MAX_DELIVERABLES_PER_ACCOUNT);
            expect(account.deliverablesCount).to.equal(MAX_DELIVERABLES_PER_ACCOUNT);
            expect(account.deliverablesHead).to.equal(2); // Head moved to next position
            
            // The second oldest deliverable should now be removed
            await expect(serving.getDeliverable(ownerAddress, provider1Address, deliverableIds[1]))
                .to.be.revertedWith("Deliverable does not exist");
            
            // Both new deliverables should be accessible
            const newDeliverable2 = await serving.getDeliverable(ownerAddress, provider1Address, newId2);
            expect(newDeliverable2.modelRootHash).to.equal(newHash2);
            expect(newDeliverable2.id).to.equal(newId2);
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

async function backfillVerifierInput(privateKey: string, v: VerifierInputStruct): Promise<VerifierInputStruct> {
    const wallet = new newEthers.Wallet(privateKey);

    const hash = newEthers.solidityPackedKeccak256(
        ["bytes", "bytes", "uint256", "address", "uint256", "address"],
        [v.encryptedSecret, v.modelRootHash, v.nonce, v.providerSigner, v.taskFee, v.user]
    );

    v.signature = await wallet.signMessage(ethers.toBeArray(hash));
    return v;
}
