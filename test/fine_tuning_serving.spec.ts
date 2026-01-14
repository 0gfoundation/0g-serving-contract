import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { Block, ethers as newEthers, TransactionReceipt } from "ethers";
import { deployments, ethers } from "hardhat";
import { Deployment } from "hardhat-deploy/types";
import { beforeEach } from "mocha";
import { FineTuningServing as Serving, LedgerManager } from "../typechain-types";
import {
    AccountSummaryStructOutput,
    QuotaStruct,
    ServiceStructOutput,
    VerifierInputStruct,
} from "../typechain-types/contracts/fine-tuning/FineTuningServing.sol/FineTuningServing";
// Mock public key for testing - just a placeholder as ZK is no longer used
// const publicKey: [bigint, bigint] = [BigInt(1), BigInt(2)];

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

    const ownerInitialLedgerBalance = ethers.parseEther("5");
    const ownerInitialFineTuningBalance = ethers.parseEther("1");

    const user1InitialLedgerBalance = ethers.parseEther("10");
    const user1InitialFineTuningBalance = ethers.parseEther("2");
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
        await deployments.fixture(["test-services"]);
        servingDeployment = await deployments.get("FineTuningServing_test");
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
            ledger.addLedger(additionalData, {
                value: ownerInitialLedgerBalance,
            }),
            ledger.connect(user1).addLedger(additionalData, {
                value: user1InitialLedgerBalance,
            }),
        ]);

        await Promise.all([
            ledger.transferFund(provider1Address, "fine-tuning-test", ownerInitialFineTuningBalance),
            ledger.connect(user1).transferFund(provider1Address, "fine-tuning-test", user1InitialFineTuningBalance),

            serving
                .connect(provider1)
                .addOrUpdateService(provider1Url, provider1Quota, provider1PricePerToken, false, [], provider1Signer, { value: ethers.parseEther("100") }),
            serving
                .connect(provider2)
                .addOrUpdateService(provider2Url, provider2Quota, provider2PricePerToken, false, [], provider2Signer, { value: ethers.parseEther("100") }),
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
            const transferAmount = (ownerInitialLedgerBalance - ownerInitialFineTuningBalance) / BigInt(3);
            await ledger.transferFund(provider1Address, "fine-tuning-test", transferAmount);

            const account = await serving.getAccount(ownerAddress, provider1);
            expect(account.balance).to.equal(ownerInitialFineTuningBalance + transferAmount);
        });

        it("should get all users", async () => {
            const [accounts] = await serving.getAllAccounts(0, 0);
            const userAddresses = (accounts as AccountSummaryStructOutput[]).map((a) => a.user);
            const providerAddresses = (accounts as AccountSummaryStructOutput[]).map((a) => a.provider);
            const balances = (accounts as AccountSummaryStructOutput[]).map((a) => a.balance);

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
            await expect(serving.getAllAccounts(0, 51)).to.be.revertedWithCustomError(serving, "LimitTooLarge").withArgs(51);
        });

        it("should get accounts by provider", async () => {
            // Add another provider for testing
            await ledger.transferFund(provider2Address, "fine-tuning-test", ownerInitialFineTuningBalance);

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
            await ledger.transferFund(provider2Address, "fine-tuning-test", ownerInitialFineTuningBalance);

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
            await expect(serving.getAccountsByProvider(provider1Address, 0, 51)).to.be.revertedWithCustomError(serving, "LimitTooLarge").withArgs(51);
            await expect(serving.getAccountsByUser(ownerAddress, 0, 51)).to.be.revertedWithCustomError(serving, "LimitTooLarge").withArgs(51);
        });
    });

    describe("Process refund", () => {
        let unlockTime: number;

        beforeEach(async () => {
            const res = await ledger.retrieveFund([provider1Address], "fine-tuning-test");
            const receipt = await res.wait();

            const block = await ethers.provider.getBlock((receipt as TransactionReceipt).blockNumber);
            unlockTime = (block as Block).timestamp + lockTime;
        });

        it("should succeeded if the unlockTime has arrived and called", async () => {
            await time.increaseTo(unlockTime);

            await ledger.retrieveFund([provider1Address], "fine-tuning-test");
            const account = await serving.getAccount(ownerAddress, provider1);
            expect(account.balance).to.be.equal(BigInt(0));
        });
    });

    describe("Refund Array Optimization", () => {
        beforeEach(async () => {
            // Setup: Transfer funds to ensure we have a clean test account
            // After setup: balance=2.5 ether (2 from initial + 0.5 new), pendingRefund=0, refunds=[], validRefundsLength=0
            await ledger.connect(user1).transferFund(provider1Address, "fine-tuning-test", ethers.parseEther("0.5"));
        });

        it("should reuse array positions after refund processing", async () => {
            // Step 1: Create first refund
            // Before: balance=2.5 ether, pendingRefund=0, refunds=[], validRefundsLength=0
            await ledger.connect(user1).retrieveFund([provider1Address], "fine-tuning-test");
            // After: balance=2.5 ether, pendingRefund=2.5 ether, refunds=[{amount:2.5 ether, processed:false}], validRefundsLength=1

            let account = await serving.getAccount(user1Address, provider1);
            const initialBalance = account.balance;
            const initialPendingRefund = account.pendingRefund;
            expect(account.refunds.length).to.equal(1);
            expect(initialPendingRefund).to.equal(initialBalance); // pendingRefund should equal balance after retrieveFund

            // Step 2: Process refund after lock time
            // Before: refunds=[{amount:2.5 ether, processed:false}], validRefundsLength=1
            await time.increase(lockTime + 1);
            await ledger.connect(user1).retrieveFund([provider1Address], "fine-tuning-test");
            // After: balance=0, pendingRefund=0, refunds=[{amount:2.5 ether, processed:true}], validRefundsLength=0 (dirty data in position 0)

            account = await serving.getAccount(user1Address, provider1);
            expect(account.balance).to.equal(BigInt(0));
            expect(account.pendingRefund).to.equal(BigInt(0));

            // Step 3: Transfer more funds and create new refund
            // Before: balance=0, refunds=[dirty_data], validRefundsLength=0
            const newTransferAmount = ethers.parseEther("0.3");
            await ledger.connect(user1).transferFund(provider1Address, "fine-tuning-test", newTransferAmount);
            // After transfer: balance=0.3 ether, refunds=[dirty_data], validRefundsLength=0
            account = await serving.getAccount(user1Address, provider1);
            expect(account.balance).to.equal(newTransferAmount);
            expect(account.pendingRefund).to.equal(BigInt(0));

            await ledger.connect(user1).retrieveFund([provider1Address], "fine-tuning-test");
            // After new refund: balance=0.3 ether, pendingRefund=0.3 ether, refunds=[{amount:0.3 ether, processed:false}], validRefundsLength=1
            // Key optimization: Position 0 is REUSED, avoiding array.push() and saving ~15,000 gas

            account = await serving.getAccount(user1Address, provider1);
            // Array length should remain 1 (reusing processed position)
            expect(account.refunds.length).to.equal(1);
            expect(account.balance).to.equal(newTransferAmount);
            expect(account.pendingRefund).to.equal(newTransferAmount);
        });

        it("should handle refund cancellation through transfer operations", async () => {
            // Step 1: Create initial refund
            // Before: balance=2.5 ether, pendingRefund=0, refunds=[], validRefundsLength=0
            await ledger.connect(user1).retrieveFund([provider1Address], "fine-tuning-test");
            // After: balance=2.5 ether, pendingRefund=2.5 ether, refunds=[{amount:2.5 ether, processed:false}], validRefundsLength=1

            let account = await serving.getAccount(user1Address, provider1);
            const initialPendingRefund = account.pendingRefund;
            const initialBalance = account.balance;
            // State snapshot: pendingRefund should equal balance after retrieveFund
            expect(initialPendingRefund).to.equal(initialBalance);

            // Step 2: Transfer more funds - should automatically cancel some pending refunds
            // Before: balance=2.5 ether, pendingRefund=2.5 ether, refunds=[{amount:2.5 ether, processed:false}]
            const newTransferAmount = ethers.parseEther("0.3");
            await ledger.connect(user1).transferFund(provider1Address, "fine-tuning-test", newTransferAmount);
            // During transfer: cancelRetrievingAmount = min(0.3 ether, 2.5 ether) = 0.3 ether
            // - Refund is partially cancelled: refund amount reduces by 0.3 ether
            // - PendingRefund becomes 2.5-0.3=2.2 ether
            // After: balance=2.5 ether, pendingRefund=2.2 ether, refunds=[{amount:2.2 ether, processed:false}], validRefundsLength=1

            account = await serving.getAccount(user1Address, provider1);
            expect(account.balance).to.equal(initialBalance);
            // Should cancel min(newTransferAmount, initialPendingRefund) from pending refunds
            const cancelledAmount = newTransferAmount < initialPendingRefund ? newTransferAmount : initialPendingRefund;
            expect(account.pendingRefund).to.equal(initialPendingRefund - cancelledAmount);
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
            expect(service.teeSignerAddress).to.equal(provider1Signer);
            expect(service.occupied).to.equal(false);
        });

        it("should get all services", async () => {
            const services = await serving.getAllServices();
            const addresses = (services as ServiceStructOutput[]).map((s) => s.provider);
            const urls = (services as ServiceStructOutput[]).map((s) => s.url);
            const pricePerTokens = (services as ServiceStructOutput[]).map((s) => s.pricePerToken);
            const teeSignerAddresses = (services as ServiceStructOutput[]).map((s) => s.teeSignerAddress);
            const occupieds = (services as ServiceStructOutput[]).map((s) => s.occupied);

            expect(addresses).to.have.members([provider1Address, provider2Address]);
            expect(urls).to.have.members([provider1Url, provider2Url]);
            expect(pricePerTokens).to.have.members([BigInt(provider1PricePerToken), BigInt(provider2PricePerToken)]);
            expect(teeSignerAddresses).to.have.members([provider1Signer, provider2Signer]);
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
                        modifiedOccupied,
                        modifiedModels,
                        modifiedProviderSinger
                    )
            )
                .to.emit(serving, "ServiceUpdated")
                .withArgs(
                    provider1Address,
                    modifiedPriceUrl,
                    Object.values(modifiedQuota),
                    modifiedPricePerToken,
                    (teeSignerAddress: string) => {
                        return teeSignerAddress.toLowerCase() === modifiedProviderSinger;
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
            expect(service.teeSignerAddress.toLowerCase()).to.equal(modifiedProviderSinger);
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
            // Owner acknowledges the service's TEE signer
            await serving.connect(owner).acknowledgeTEESignerByOwner(provider1Address);
            // User acknowledges the provider (note: auto-acknowledged when transferring funds in beforeEach)
            deliverableId = ethers.hexlify(ethers.randomBytes(32));
            await serving.connect(provider1).addDeliverable(ownerAddress, deliverableId, modelRootHash);
            await serving.acknowledgeDeliverable(provider1Address, deliverableId);

            verifierInput = {
                taskFee,
                encryptedSecret,
                modelRootHash,
                id: deliverableId,
                nonce: BigInt(1),
                user: ownerAddress,
                signature: "",
            };

            verifierInput = await backfillVerifierInput(providerPrivateKey, verifierInput, serving);
        });

        it("should succeed", async () => {
            const estimatedGas = await serving.connect(provider1).settleFees.estimateGas(verifierInput);
            console.log(`Estimated gas for settleFees: ${estimatedGas.toString()}`);

            const tx = await serving.connect(provider1).settleFees(verifierInput);
            const receipt = await tx.wait();
            console.log(`Actual gas used for settleFees: ${receipt?.gasUsed.toString()}`);
            console.log(`Gas price: ${tx.gasPrice?.toString() || "N/A"} wei`);
            const gasUsed = receipt?.gasUsed || BigInt(0);
            const gasPrice = tx.gasPrice || BigInt(0);
            console.log(`Transaction cost: ${(gasUsed * gasPrice).toString()} wei`);

            await expect(tx)
                .to.emit(serving, "BalanceUpdated")
                .withArgs(ownerAddress, provider1Address, ownerInitialFineTuningBalance - BigInt(taskFee), 0n);
        });

        it("should failed due to double spending", async () => {
            await serving.connect(provider1).settleFees(verifierInput);

            await expect(serving.connect(provider1).settleFees(verifierInput)).to.be.reverted;
        });

        it("should failed due to insufficient balance", async () => {
            verifierInput.taskFee = ownerInitialFineTuningBalance + BigInt(1);

            await expect(serving.connect(provider1).settleFees(verifierInput)).to.be.reverted;
        });

        it("should failed due to no secret", async () => {
            verifierInput.encryptedSecret = "0x";
            verifierInput = await backfillVerifierInput(providerPrivateKey, verifierInput, serving);
            await expect(serving.connect(provider1).settleFees(verifierInput)).to.be.revertedWithCustomError(
                serving,
                "SecretShouldNotBeEmpty"
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
            // Owner acknowledges the service's TEE signer
            await serving.connect(owner).acknowledgeTEESignerByOwner(provider1Address);
            // User acknowledges the provider (note: auto-acknowledged when transferring funds in beforeEach)
            deliverableId = ethers.hexlify(ethers.randomBytes(32));
            await serving.connect(provider1).addDeliverable(ownerAddress, deliverableId, modelRootHash);

            verifierInput = {
                taskFee,
                encryptedSecret: "0x",
                modelRootHash,
                id: deliverableId,
                nonce: BigInt(1),
                user: ownerAddress,
                signature: "",
            };

            verifierInput = await backfillVerifierInput(providerPrivateKey, verifierInput, serving);
        });

        it("should succeed", async () => {
            await expect(serving.connect(provider1).settleFees(verifierInput))
                .to.emit(serving, "BalanceUpdated")
                .withArgs(
                    ownerAddress,
                    provider1Address,
                    ownerInitialFineTuningBalance - (BigInt(taskFee) * BigInt(defaultPenaltyPercentage)) / 100n,
                    0n
                );
        });

        it("should failed due to secret", async () => {
            verifierInput.encryptedSecret = encryptedSecret;
            verifierInput = await backfillVerifierInput(providerPrivateKey, verifierInput, serving);
            await expect(serving.connect(provider1).settleFees(verifierInput)).to.be.revertedWithCustomError(
                serving,
                "SecretShouldBeEmpty"
            );
        });
    });

    describe("Deliverable Limits", () => {
        // Constants from AccountLibrary contract
        const MAX_DELIVERABLES_PER_ACCOUNT = 20;

        it("should allow adding deliverables up to the limit", async () => {
            // Owner acknowledges the service's TEE signer
            await serving.connect(owner).acknowledgeTEESignerByOwner(provider1Address);

            // Add deliverables up to the limit (MED-4: must acknowledge each before adding next)
            for (let i = 0; i < MAX_DELIVERABLES_PER_ACCOUNT; i++) {
                const deliverableId = ethers.hexlify(ethers.randomBytes(32));
                const modelRootHash = ethers.hexlify(ethers.randomBytes(32));
                await serving.connect(provider1).addDeliverable(ownerAddress, deliverableId, modelRootHash);
                // MED-4: Acknowledge immediately to allow adding next deliverable
                await serving.acknowledgeDeliverable(provider1Address, deliverableId);
            }

            const account = await serving.getAccount(ownerAddress, provider1Address);
            expect(account.deliverables.length).to.equal(MAX_DELIVERABLES_PER_ACCOUNT);
        });

        it("should use circular array strategy when adding deliverables beyond the limit", async () => {
            // Owner acknowledges the service's TEE signer
            await serving.connect(owner).acknowledgeTEESignerByOwner(provider1Address);

            // Store deliverable IDs to verify circular array behavior
            const deliverableIds: string[] = [];
            const modelHashes: string[] = [];

            // First, add deliverables up to the limit (MED-4: must acknowledge each)
            for (let i = 0; i < MAX_DELIVERABLES_PER_ACCOUNT; i++) {
                const deliverableId = ethers.hexlify(ethers.randomBytes(32));
                const modelRootHash = ethers.hexlify(ethers.randomBytes(32));
                deliverableIds.push(deliverableId);
                modelHashes.push(modelRootHash);
                await serving.connect(provider1).addDeliverable(ownerAddress, deliverableId, modelRootHash);
                // MED-4: Acknowledge immediately to allow adding next deliverable
                await serving.acknowledgeDeliverable(provider1Address, deliverableId);
            }

            let account = await serving.getAccount(ownerAddress, provider1Address);
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
            await serving.acknowledgeDeliverable(provider1Address, newId1);

            account = await serving.getAccount(ownerAddress, provider1Address);
            expect(account.deliverables.length).to.equal(MAX_DELIVERABLES_PER_ACCOUNT);
            expect(account.deliverablesCount).to.equal(MAX_DELIVERABLES_PER_ACCOUNT);
            expect(account.deliverablesHead).to.equal(1); // Head moved to next position

            // The oldest deliverable (first one) should have been removed from the mapping
            await expect(serving.getDeliverable(ownerAddress, provider1Address, deliverableIds[0]))
                .to.be.revertedWithCustomError(serving, "DeliverableNotExists")
                .withArgs(deliverableIds[0]);

            // New deliverable should be accessible
            const newDeliverable1 = await serving.getDeliverable(ownerAddress, provider1Address, newId1);
            expect(newDeliverable1.modelRootHash).to.equal(newHash1);
            expect(newDeliverable1.id).to.equal(newId1);

            // Add another deliverable - should remove the second oldest
            const newId2 = ethers.hexlify(ethers.randomBytes(32));
            const newHash2 = ethers.hexlify(ethers.randomBytes(32));
            await serving.connect(provider1).addDeliverable(ownerAddress, newId2, newHash2);
            await serving.acknowledgeDeliverable(provider1, newId2);

            account = await serving.getAccount(ownerAddress, provider1);
            expect(account.deliverables.length).to.equal(MAX_DELIVERABLES_PER_ACCOUNT);
            expect(account.deliverablesCount).to.equal(MAX_DELIVERABLES_PER_ACCOUNT);
            expect(account.deliverablesHead).to.equal(2); // Head moved to next position

            // The second oldest deliverable should now be removed
            await expect(serving.getDeliverable(ownerAddress, provider1Address, deliverableIds[1]))
                .to.be.revertedWithCustomError(serving, "DeliverableNotExists")
                .withArgs(deliverableIds[1]);

            // Both new deliverables should be accessible
            const newDeliverable2 = await serving.getDeliverable(ownerAddress, provider1Address, newId2);
            expect(newDeliverable2.modelRootHash).to.equal(newHash2);
            expect(newDeliverable2.id).to.equal(newId2);
        });
    });

    describe("deleteAccount", () => {
        it("should delete account", async () => {
            // Need to retrieve funds from ALL services before deleting
            await Promise.all([
                ledger.retrieveFund([provider1Address], "fine-tuning-test"),
                ledger.retrieveFund([provider1Address], "inference-test"),
                ledger.connect(user1).retrieveFund([provider1Address], "fine-tuning-test"),
                ledger.connect(user1).retrieveFund([provider1Address], "inference-test"),
            ]);

            // Wait for unlock time
            await ethers.provider.send("evm_increaseTime", [86401]);
            await ethers.provider.send("evm_mine", []);

            // Process refunds from all services
            await Promise.all([
                ledger.retrieveFund([provider1Address], "fine-tuning-test"),
                ledger.retrieveFund([provider1Address], "inference-test"),
                ledger.connect(user1).retrieveFund([provider1Address], "fine-tuning-test"),
                ledger.connect(user1).retrieveFund([provider1Address], "inference-test"),
            ]);

            // Refund all available balance from ledger (this will auto-delete if totalBalance reaches 0)
            const ownerLedger = await ledger.getLedger(ownerAddress);
            if (ownerLedger.availableBalance > 0) {
                await ledger.refund(ownerLedger.availableBalance);
            }

            // Account should be auto-deleted if all funds were withdrawn
            // If not auto-deleted, manually delete
            try {
                await ledger.getLedger(ownerAddress);
                await expect(ledger.deleteLedger()).not.to.be.reverted;
            } catch (error) {
                // Account already deleted, which is expected
            }
            const [accounts] = await serving.getAllAccounts(0, 0);
            expect(accounts.length).to.equal(1);
        });
    });
});

async function backfillVerifierInput(privateKey: string, v: VerifierInputStruct, servingContract: Serving): Promise<VerifierInputStruct> {
    const wallet = new newEthers.Wallet(privateKey);

    // EIP-712 Domain Separator
    const DOMAIN_TYPEHASH = newEthers.id("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    const MESSAGE_TYPEHASH = newEthers.id(
        "VerifierMessage(string id,bytes encryptedSecret,bytes modelRootHash,uint256 nonce,uint256 taskFee,address user)"
    );
    const DOMAIN_NAME = "0G Fine-Tuning Serving";
    const DOMAIN_VERSION = "1";

    const chainId = (await ethers.provider.getNetwork()).chainId;
    const servingAddress = await servingContract.getAddress();

    // Compute domain separator
    const domainSeparator = newEthers.keccak256(
        newEthers.AbiCoder.defaultAbiCoder().encode(
            ["bytes32", "bytes32", "bytes32", "uint256", "address"],
            [
                DOMAIN_TYPEHASH,
                newEthers.id(DOMAIN_NAME),
                newEthers.id(DOMAIN_VERSION),
                chainId,
                servingAddress
            ]
        )
    );

    // Compute struct hash
    const structHash = newEthers.keccak256(
        newEthers.AbiCoder.defaultAbiCoder().encode(
            ["bytes32", "bytes32", "bytes32", "bytes32", "uint256", "uint256", "address"],
            [
                MESSAGE_TYPEHASH,
                newEthers.id(v.id),  // CRIT-2 FIX: Include 'id' to prevent signature reuse
                newEthers.keccak256(v.encryptedSecret),
                newEthers.keccak256(v.modelRootHash),
                v.nonce,
                v.taskFee,
                v.user
            ]
        )
    );

    // Compute EIP-712 typed data hash
    const digest = newEthers.keccak256(
        newEthers.solidityPacked(
            ["string", "bytes32", "bytes32"],
            ["\x19\x01", domainSeparator, structHash]
        )
    );

    // Sign the digest directly (not using signMessage which adds prefix)
    v.signature = wallet.signingKey.sign(digest).serialized;
    return v;
}

describe("FineTuning Serving - Receive Function", () => {
    let serving: Serving;
    let ledger: LedgerManager;
    let user1: HardhatEthersSigner;
    let user1Address: string;

    beforeEach(async () => {
        await deployments.fixture(["test-services"]);

        const fineTuningServingDeployment = await deployments.get("FineTuningServing_test");
        const ledgerManagerDeployment = await deployments.get("LedgerManager");

        serving = await ethers.getContractAt("FineTuningServing", fineTuningServingDeployment.address);
        ledger = await ethers.getContractAt("LedgerManager", ledgerManagerDeployment.address);

        user1 = (await ethers.getSigners())[1];
        user1Address = await user1.getAddress();
    });

    describe("Receive function", () => {
        it("should work alongside normal ledger operations", async () => {
            const directTransfer = ethers.parseEther("0.3");
            const normalDeposit = ethers.parseEther("5");

            // Direct transfer should be rejected
            await expect(
                user1.sendTransaction({
                    to: await serving.getAddress(),
                    value: directTransfer,
                })
            ).to.be.revertedWithCustomError(serving, "DirectDepositsDisabled");

            // Normal deposit through ledger should still work
            await ledger.connect(user1).depositFund({ value: normalDeposit });

            // Verify only normal deposit balance exists
            const ledgerInfo = await ledger.getLedger(user1Address);
            expect(ledgerInfo.availableBalance).to.equal(normalDeposit);
            expect(ledgerInfo.totalBalance).to.equal(normalDeposit);
        });
    });
});
