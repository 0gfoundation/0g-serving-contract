import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { Block, TransactionReceipt } from "ethers";
import { deployments, ethers } from "hardhat";
import { Deployment } from "hardhat-deploy/types";
import { beforeEach } from "mocha";
import { FineTuningServing, InferenceServing, LedgerManager } from "../typechain-types";
import { LedgerStructOutput } from "../typechain-types/contracts/ledger/LedgerManager.sol/LedgerManager";
// Mock public key for testing - just a placeholder as ZK is no longer used

describe("Ledger manager", () => {
    let inferenceServing: InferenceServing;
    let inferenceServingDeployment: Deployment;

    let fineTuningServing: FineTuningServing;
    let fineTuningServingDeployment: Deployment;

    let ledger: LedgerManager;
    let LedgerManagerDeployment: Deployment;

    let owner: HardhatEthersSigner, user1: HardhatEthersSigner, provider1: HardhatEthersSigner;
    let ownerAddress: string, user1Address: string, provider1Address: string;

    const ownerInitialLedgerBalance = 1000;
    const ownerInitialFineTuningBalance = ownerInitialLedgerBalance / 4;
    const ownerInitialInferenceBalance = ownerInitialLedgerBalance / 4;

    const user1InitialLedgerBalance = 2000;
    const user1InitialFineTuningBalance = user1InitialLedgerBalance / 4;
    const user1InitialInferenceBalance = user1InitialLedgerBalance / 4;
    const lockTime = 24 * 60 * 60;

    const additionalData = "";

    beforeEach(async () => {
        await deployments.fixture(["test-services"]);
        inferenceServingDeployment = await deployments.get("InferenceServing_test");
        fineTuningServingDeployment = await deployments.get("FineTuningServing_test");
        LedgerManagerDeployment = await deployments.get("LedgerManager");

        inferenceServing = await ethers.getContractAt("InferenceServing", inferenceServingDeployment.address);
        fineTuningServing = await ethers.getContractAt("FineTuningServing", fineTuningServingDeployment.address);
        ledger = await ethers.getContractAt("LedgerManager", LedgerManagerDeployment.address);

        [owner, user1, provider1] = await ethers.getSigners();
        [ownerAddress, user1Address, provider1Address] = await Promise.all([
            owner.getAddress(),
            user1.getAddress(),
            provider1.getAddress(),
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
    });

    it("should get all ledgers", async () => {
        const [ledgers, total] = await ledger.getAllLedgers(0, 0); // offset=0, limit=0 means get all
        expect(total).to.equal(BigInt(2));
        const userAddresses = (ledgers as LedgerStructOutput[]).map((a) => a.user);
        const availableBalances = (ledgers as LedgerStructOutput[]).map((a) => a.availableBalance);
        const additionalInfos = (ledgers as LedgerStructOutput[]).map((a) => a.additionalInfo);

        expect(userAddresses).to.have.members([ownerAddress, user1Address]);
        expect(availableBalances).to.have.members([
            BigInt(ownerInitialLedgerBalance),
            BigInt(user1InitialLedgerBalance),
        ]);
        expect(additionalInfos).to.have.members(["", ""]);
    });

    it("should deposit fund", async () => {
        const depositAmount = 1000;
        await ledger.depositFund({
            value: depositAmount,
        });

        const account = await ledger.getLedger(ownerAddress);
        expect(account.availableBalance).to.equal(BigInt(ownerInitialLedgerBalance + depositAmount));
    });

    describe("Transfer fund", () => {
        it("should transfer fund to serving contract", async () => {
            await Promise.all([
                ledger.transferFund(provider1Address, "fine-tuning-test", ownerInitialFineTuningBalance),
                ledger.transferFund(provider1Address, "inference-test", ownerInitialInferenceBalance),
                ledger.connect(user1).transferFund(provider1Address, "fine-tuning-test", user1InitialFineTuningBalance),
                ledger.connect(user1).transferFund(provider1Address, "inference-test", user1InitialInferenceBalance),
            ]);

            const [ledgers] = await ledger.getAllLedgers(0, 0);
            const userAddresses = (ledgers as LedgerStructOutput[]).map((a) => a.user);
            const availableBalances = (ledgers as LedgerStructOutput[]).map((a) => a.availableBalance);
            expect(userAddresses).to.have.members([ownerAddress, user1Address]);
            expect(availableBalances).to.have.members([
                BigInt(ownerInitialLedgerBalance - ownerInitialFineTuningBalance - ownerInitialInferenceBalance),
                BigInt(user1InitialLedgerBalance - user1InitialFineTuningBalance - user1InitialInferenceBalance),
            ]);

            const inferenceAccount = await inferenceServing.getAccount(ownerAddress, provider1);
            const fineTuningAccount = await fineTuningServing.getAccount(ownerAddress, provider1);
            expect(inferenceAccount.balance).to.equal(BigInt(ownerInitialInferenceBalance));
            expect(fineTuningAccount.balance).to.equal(BigInt(ownerInitialFineTuningBalance));
        });

        it("should cancel the retrieved fund and transfer the remain fund when transfer fund larger than total retrieved fund", async () => {
            await Promise.all([
                ledger.transferFund(provider1Address, "fine-tuning-test", ownerInitialFineTuningBalance / 2),
                ledger.transferFund(provider1Address, "inference-test", ownerInitialInferenceBalance / 2),
            ]);

            await ledger.retrieveFund([provider1Address], "fine-tuning-test");
            await ledger.retrieveFund([provider1Address], "inference-test");

            let inferenceAccount = await inferenceServing.getAccount(ownerAddress, provider1);
            let fineTuningAccount = await fineTuningServing.getAccount(ownerAddress, provider1);
            expect(inferenceAccount.balance).to.equal(BigInt(ownerInitialInferenceBalance / 2));
            expect(fineTuningAccount.balance).to.equal(BigInt(ownerInitialFineTuningBalance / 2));
            expect(inferenceAccount.pendingRefund).to.equal(BigInt(ownerInitialInferenceBalance / 2));
            expect(fineTuningAccount.pendingRefund).to.equal(BigInt(ownerInitialFineTuningBalance / 2));

            await Promise.all([
                ledger.transferFund(provider1Address, "fine-tuning-test", ownerInitialFineTuningBalance),
                ledger.transferFund(provider1Address, "inference-test", ownerInitialInferenceBalance),
            ]);

            inferenceAccount = await inferenceServing.getAccount(ownerAddress, provider1);
            fineTuningAccount = await fineTuningServing.getAccount(ownerAddress, provider1);
            expect(inferenceAccount.balance).to.equal(BigInt(ownerInitialInferenceBalance));
            expect(fineTuningAccount.balance).to.equal(BigInt(ownerInitialFineTuningBalance));
            expect(inferenceAccount.pendingRefund).to.equal(BigInt(0));
            expect(fineTuningAccount.pendingRefund).to.equal(BigInt(0));
        });

        it("should cancel the retrieved fund even when transfer fund smaller than total retrieved fund", async () => {
            await Promise.all([
                ledger.transferFund(provider1Address, "fine-tuning-test", ownerInitialFineTuningBalance),
                ledger.transferFund(provider1Address, "inference-test", ownerInitialInferenceBalance),
            ]);

            await ledger.retrieveFund([provider1Address], "fine-tuning-test");
            await ledger.retrieveFund([provider1Address], "inference-test");

            let inferenceAccount = await inferenceServing.getAccount(ownerAddress, provider1);
            let fineTuningAccount = await fineTuningServing.getAccount(ownerAddress, provider1);
            expect(inferenceAccount.balance).to.equal(BigInt(ownerInitialInferenceBalance));
            expect(fineTuningAccount.balance).to.equal(BigInt(ownerInitialFineTuningBalance));
            expect(inferenceAccount.pendingRefund).to.equal(BigInt(ownerInitialInferenceBalance));
            expect(fineTuningAccount.pendingRefund).to.equal(BigInt(ownerInitialFineTuningBalance));

            // The transfer fund is smaller than the total retrieved fund, so only part of the pending refund should be canceled
            await Promise.all([
                ledger.transferFund(provider1Address, "fine-tuning-test", ownerInitialFineTuningBalance / 2),
                ledger.transferFund(provider1Address, "inference-test", ownerInitialInferenceBalance / 2),
            ]);

            inferenceAccount = await inferenceServing.getAccount(ownerAddress, provider1);
            fineTuningAccount = await fineTuningServing.getAccount(ownerAddress, provider1);
            expect(inferenceAccount.balance).to.equal(BigInt(ownerInitialInferenceBalance));
            expect(fineTuningAccount.balance).to.equal(BigInt(ownerInitialFineTuningBalance));
            expect(inferenceAccount.pendingRefund).to.equal(BigInt(ownerInitialInferenceBalance / 2));
            expect(fineTuningAccount.pendingRefund).to.equal(BigInt(ownerInitialFineTuningBalance / 2));
        });

        it("should handle array optimization during multiple transfer operations", async () => {
            // Step 1: Setup initial account and create refund
            // Before: balance=0, pendingRefund=0, refunds=[], validRefundsLength=0
            await ledger.transferFund(provider1Address, "fine-tuning-test", 800);
            // After transfer: balance=800, pendingRefund=0, refunds=[], validRefundsLength=0
            await ledger.retrieveFund([provider1Address], "fine-tuning-test");
            // After refund request: balance=800, pendingRefund=800, refunds=[{amount:800, processed:false}], validRefundsLength=1

            let account = await fineTuningServing.getAccount(ownerAddress, provider1);
            expect(account.refunds.length).to.equal(1);
            expect(account.pendingRefund).to.equal(800);

            // Step 2: Transfer with full cancellation
            // Before: balance=800, pendingRefund=800, refunds=[{amount:800, processed:false}]
            await ledger.transferFund(provider1Address, "fine-tuning-test", 1000);
            // During transfer: cancelRetrievingAmount = min(1000, 800) = 800 (full cancellation)
            // - Entire refund is cancelled: refund marked as processed
            // - PendingRefund becomes 800-800=0
            // After: balance=1000, pendingRefund=0, refunds=[{amount:800, processed:true}], validRefundsLength=0

            account = await fineTuningServing.getAccount(ownerAddress, provider1);
            expect(account.pendingRefund).to.equal(0);
            expect(account.balance).to.equal(1000);

            // Step 3: Create new refund - should reuse array position
            // Before: balance=1000, pendingRefund=0, refunds=[dirty_data], validRefundsLength=0
            await ledger.retrieveFund([provider1Address], "fine-tuning-test");
            // After: balance=1000, pendingRefund=1000, refunds=[{amount:1000, processed:false}], validRefundsLength=1
            // Key optimization: Same array position is REUSED (index 0), no array expansion

            account = await fineTuningServing.getAccount(ownerAddress, provider1);
            expect(account.refunds.length).to.equal(1); // Reusing position
            expect(account.pendingRefund).to.equal(1000);
        });
    });

    it("should refund fund", async () => {
        await ledger.transferFund(provider1Address, "fine-tuning-test", ownerInitialFineTuningBalance);

        let account = await ledger.getLedger(ownerAddress);
        expect(account.totalBalance).to.equal(BigInt(ownerInitialLedgerBalance));
        expect(account.availableBalance).to.equal(BigInt(ownerInitialLedgerBalance - ownerInitialFineTuningBalance));

        await expect(ledger.refund(ownerInitialLedgerBalance)).to.be.reverted;
        await expect(ledger.refund(ownerInitialLedgerBalance - ownerInitialFineTuningBalance)).not.to.be.reverted;

        account = await ledger.getLedger(ownerAddress);
        expect(account.availableBalance).to.equal(BigInt(0));
    });

    describe("Retrieve Fund from fine-tuning sub-account", () => {
        let unlockTime: number;

        beforeEach(async () => {
            await Promise.all([ledger.transferFund(provider1Address, "fine-tuning-test", ownerInitialFineTuningBalance)]);

            const res = await ledger.retrieveFund([provider1Address], "fine-tuning-test");
            const receipt = await res.wait();

            const block = await ethers.provider.getBlock((receipt as TransactionReceipt).blockNumber);
            unlockTime = (block as Block).timestamp + lockTime;
        });

        it("should not receive fund if the unlockTime hasn't arrived and called ", async () => {
            await time.increaseTo(unlockTime - 1);

            await ledger.retrieveFund([provider1Address], "fine-tuning-test");
            const fineTuningAccount = await fineTuningServing.getAccount(ownerAddress, provider1);
            const ledgerAccount = await ledger.getLedger(ownerAddress);

            expect(fineTuningAccount.balance).to.be.equal(BigInt(ownerInitialFineTuningBalance));
            expect(ledgerAccount.availableBalance).to.be.equal(
                BigInt(ownerInitialLedgerBalance - ownerInitialFineTuningBalance)
            );
        });

        it("should receive fund if the unlockTime has arrived and called", async () => {
            await time.increaseTo(unlockTime + 1);

            await ledger.retrieveFund([provider1Address], "fine-tuning-test");
            const fineTuningAccount = await fineTuningServing.getAccount(ownerAddress, provider1);
            const ledgerAccount = await ledger.getLedger(ownerAddress);

            expect(fineTuningAccount.balance).to.be.equal(BigInt(0));
            expect(ledgerAccount.availableBalance).to.be.equal(BigInt(ownerInitialLedgerBalance));
        });
    });

    describe("Retrieve Fund from inference sub-account", () => {
        let unlockTime: number;

        beforeEach(async () => {
            await Promise.all([ledger.transferFund(provider1Address, "inference-test", ownerInitialInferenceBalance)]);

            const res = await ledger.retrieveFund([provider1Address], "inference-test");
            const receipt = await res.wait();

            const block = await ethers.provider.getBlock((receipt as TransactionReceipt).blockNumber);
            unlockTime = (block as Block).timestamp + lockTime;
        });

        it("should not receive fund if the unlockTime hasn't arrived and called ", async () => {
            await time.increaseTo(unlockTime - 1);

            await ledger.retrieveFund([provider1Address], "inference-test");
            const inferenceAccount = await inferenceServing.getAccount(ownerAddress, provider1);
            const ledgerAccount = await ledger.getLedger(ownerAddress);

            expect(inferenceAccount.balance).to.be.equal(BigInt(ownerInitialInferenceBalance));
            expect(ledgerAccount.availableBalance).to.be.equal(
                BigInt(ownerInitialLedgerBalance - ownerInitialInferenceBalance)
            );
        });

        it("should receive fund if the unlockTime has arrived and called", async () => {
            await time.increaseTo(unlockTime + 1);

            await ledger.retrieveFund([provider1Address], "inference-test");
            const inferenceAccount = await inferenceServing.getAccount(ownerAddress, provider1);
            const ledgerAccount = await ledger.getLedger(ownerAddress);

            expect(inferenceAccount.balance).to.be.equal(BigInt(0));
            expect(ledgerAccount.availableBalance).to.be.equal(BigInt(ownerInitialLedgerBalance));
        });
    });

    it("should delete account", async () => {
        await Promise.all([
            ledger.transferFund(provider1Address, "fine-tuning-test", ownerInitialFineTuningBalance),
            ledger.connect(user1).transferFund(provider1Address, "fine-tuning-test", user1InitialFineTuningBalance),
        ]);

        let [accounts] = await fineTuningServing.getAllAccounts(0, 0);
        expect(accounts.length).to.equal(2);

        // Need to retrieve funds first before deleting
        await ledger.retrieveFund([provider1Address], "fine-tuning-test");
        await ledger.connect(user1).retrieveFund([provider1Address], "fine-tuning-test");
        
        // Wait for unlock time
        await ethers.provider.send("evm_increaseTime", [86401]);
        await ethers.provider.send("evm_mine", []);
        
        // Process refunds
        await ledger.retrieveFund([provider1Address], "fine-tuning-test");
        await ledger.connect(user1).retrieveFund([provider1Address], "fine-tuning-test");
        
        // Refund remaining balance from ledger
        const ownerLedger = await ledger.getLedger(ownerAddress);
        if (ownerLedger.totalBalance > 0) {
            await ledger.refund(ownerLedger.totalBalance);
        }
        
        // Now can delete
        await expect(ledger.deleteLedger()).not.to.be.reverted;
        [accounts] = await fineTuningServing.getAllAccounts(0, 0);
        expect(accounts.length).to.equal(1);
    });

    describe("Service Registry Management", () => {
        it("should register a new service", async () => {
            // Deploy a new test contract to register
            const TestContract = await ethers.getContractFactory("InferenceServing");
            const testService = await TestContract.deploy();
            await testService.waitForDeployment();
            const testServiceAddress = await testService.getAddress();
            
            // Initialize the test service
            await testService.initialize(lockTime, LedgerManagerDeployment.address, ownerAddress);
            
            // Register the service
            await expect(
                ledger.registerService(
                    "inference-test",
                    "v2.0",
                    testServiceAddress,
                    "Test Inference Service v2.0"
                )
            ).to.emit(ledger, "ServiceRegistered");
            
            // Verify service was registered
            const serviceInfo = await ledger.getServiceInfo(testServiceAddress);
            expect(serviceInfo.serviceType).to.equal("inference-test");
            expect(serviceInfo.version).to.equal("v2.0");
            expect(serviceInfo.description).to.equal("Test Inference Service v2.0");
            expect(serviceInfo.isRecommended).to.equal(false);
        });

        it("should get service by name", async () => {
            // The test deployment already registered inference-test and fine-tuning-test
            const inferenceAddress = await ledger.getServiceAddressByName("inference-test");
            expect(inferenceAddress).to.equal(inferenceServingDeployment.address);
            
            const fineTuningAddress = await ledger.getServiceAddressByName("fine-tuning-test");
            expect(fineTuningAddress).to.equal(fineTuningServingDeployment.address);
        });

        it("should get all active services", async () => {
            const services = await ledger.getAllActiveServices();
            
            // Should have at least the two test services registered
            expect(services.length).to.be.at.least(2);
            
            // Find our test services
            const inferenceService = services.find(s => s.serviceType === "inference" && s.version === "test");
            const fineTuningService = services.find(s => s.serviceType === "fine-tuning" && s.version === "test");
            
            expect(inferenceService).to.not.be.undefined;
            expect(fineTuningService).to.not.be.undefined;
            expect(inferenceService!.isRecommended).to.equal(true);
            expect(fineTuningService!.isRecommended).to.equal(true);
        });

        it("should get recommended service", async () => {
            // Get recommended inference service
            const [inferenceVersion, inferenceAddress] = await ledger.getRecommendedService("inference");
            expect(inferenceVersion).to.equal("test");
            expect(inferenceAddress).to.equal(inferenceServingDeployment.address);
            
            // Get recommended fine-tuning service
            const [fineTuningVersion, fineTuningAddress] = await ledger.getRecommendedService("fine-tuning");
            expect(fineTuningVersion).to.equal("test");
            expect(fineTuningAddress).to.equal(fineTuningServingDeployment.address);
        });

        it("should set and update recommended service", async () => {
            // Deploy another version
            const TestContract = await ethers.getContractFactory("InferenceServing");
            const newService = await TestContract.deploy();
            await newService.waitForDeployment();
            const newServiceAddress = await newService.getAddress();
            
            // Initialize and register
            await newService.initialize(lockTime, LedgerManagerDeployment.address, ownerAddress);
            await ledger.registerService(
                "inference",
                "v2.0",
                newServiceAddress,
                "Inference Service v2.0"
            );
            
            // Set new version as recommended
            await expect(
                ledger.setRecommendedService("inference", "v2.0")
            ).to.emit(ledger, "RecommendedServiceUpdated");
            
            // Verify the new version is recommended
            const [version, address] = await ledger.getRecommendedService("inference");
            expect(version).to.equal("v2.0");
            expect(address).to.equal(newServiceAddress);
            
            // Verify old version is no longer recommended
            const isTestRecommended = await ledger.isRecommendedVersion("inference", "test");
            expect(isTestRecommended).to.equal(false);
            
            const isV2Recommended = await ledger.isRecommendedVersion("inference", "v2.0");
            expect(isV2Recommended).to.equal(true);
        });

        it("should get all versions of a service type", async () => {
            // Deploy and register multiple versions
            const TestContract = await ethers.getContractFactory("InferenceServing");
            
            const v1Service = await TestContract.deploy();
            await v1Service.waitForDeployment();
            await v1Service.initialize(lockTime, LedgerManagerDeployment.address, ownerAddress);
            await ledger.registerService(
                "inference",
                "v1.0",
                await v1Service.getAddress(),
                "Inference v1.0"
            );
            
            const v2Service = await TestContract.deploy();
            await v2Service.waitForDeployment();
            await v2Service.initialize(lockTime, LedgerManagerDeployment.address, ownerAddress);
            await ledger.registerService(
                "inference",
                "v2.0", 
                await v2Service.getAddress(),
                "Inference v2.0"
            );
            
            // Get all versions
            const [versions, addresses, isRecommendedFlags] = await ledger.getAllVersions("inference");
            
            // Should have test, v1.0, and v2.0 (possibly more from previous tests)
            expect(versions.length).to.be.at.least(3);
            expect(versions).to.include.members(["test", "v1.0", "v2.0"]);
            
            // Check that we have corresponding addresses and recommendation flags
            expect(addresses.length).to.equal(versions.length);
            expect(isRecommendedFlags.length).to.equal(versions.length);
            
            // Find the test version and verify it's recommended
            const testIndex = versions.indexOf("test");
            if (testIndex !== -1) {
                expect(isRecommendedFlags[testIndex]).to.equal(true);
            }
        });

        it("should fail to register duplicate service", async () => {
            await expect(
                ledger.registerService(
                    "inference-test",
                    "test",
                    inferenceServingDeployment.address,
                    "Duplicate service"
                )
            ).to.be.revertedWith("Service already registered");
        });

        it("should fail to register service with existing name", async () => {
            const TestContract = await ethers.getContractFactory("InferenceServing");
            const newService = await TestContract.deploy();
            await newService.waitForDeployment();
            await newService.initialize(lockTime, LedgerManagerDeployment.address, ownerAddress);
            
            // Try to register with an existing service name (inference-test)
            await expect(
                ledger.registerService(
                    "inference",
                    "test",
                    await newService.getAddress(),
                    "Another inference test"
                )
            ).to.be.revertedWith("Service name already exists");
        });

        it("should fail to set non-existent service as recommended", async () => {
            await expect(
                ledger.setRecommendedService("inference-test", "v99.9")
            ).to.be.revertedWith("Service not found");
        });

        it("should revert when getting recommended service for non-existent type", async () => {
            await expect(
                ledger.getRecommendedService("non-existent-type")
            ).to.be.revertedWith("No recommended service found for this type");
        });

        it("should only allow owner to register services", async () => {
            const TestContract = await ethers.getContractFactory("InferenceServing");
            const newService = await TestContract.deploy();
            await newService.waitForDeployment();
            await newService.initialize(lockTime, LedgerManagerDeployment.address, ownerAddress);
            
            await expect(
                ledger.connect(user1).registerService(
                    "inference-test",
                    "v3.0",
                    await newService.getAddress(),
                    "Unauthorized registration"
                )
            ).to.be.reverted;
        });

        it("should only allow owner to set recommended service", async () => {
            await expect(
                ledger.connect(user1).setRecommendedService("inference-test", "test")
            ).to.be.reverted;
        });
    });

    describe("Receive function", () => {
        it("should automatically deposit funds when receiving ETH via transfer", async () => {
            const depositAmount = 1000;  // Use wei like other tests in this file
            
            // Get initial balance (user1 already has an account from beforeEach)
            const initialLedger = await ledger.getLedger(user1Address);
            const initialBalance = initialLedger.availableBalance;
            
            // Send ETH directly to the contract
            const ledgerAddress = await ledger.getAddress();
            const tx = await user1.sendTransaction({
                to: ledgerAddress,
                value: depositAmount
            });
            const receipt = await tx.wait();
            expect(receipt?.status).to.equal(1);  // Ensure transaction succeeded
            
            // Check that the funds were added to existing balance
            const ledgerInfo = await ledger.getLedger(user1Address);
            expect(ledgerInfo.availableBalance).to.equal(initialBalance + BigInt(depositAmount));
            expect(ledgerInfo.totalBalance).to.equal(initialBalance + BigInt(depositAmount));
        });

        it("should create a new account if it doesn't exist when receiving ETH", async () => {
            const depositAmount = 500;  // Use wei
            const signers = await ethers.getSigners();
            const newUser = signers[3]; // Get a new signer (avoid index 5 which may not exist)
            const newUserAddress = await newUser.getAddress();
            
            // Verify account doesn't exist
            await expect(ledger.getLedger(newUserAddress)).to.be.revertedWithCustomError(
                ledger,
                "LedgerNotExists"
            );
            
            // Send ETH directly to the contract
            const tx = await newUser.sendTransaction({
                to: await ledger.getAddress(),
                value: depositAmount
            });
            await tx.wait();
            
            // Check that account was created with correct balance
            const ledgerInfo = await ledger.getLedger(newUserAddress);
            expect(ledgerInfo.availableBalance).to.equal(BigInt(depositAmount));
            expect(ledgerInfo.totalBalance).to.equal(BigInt(depositAmount));
            expect(ledgerInfo.user).to.equal(newUserAddress);
        });

        it("should add to existing balance when receiving multiple ETH transfers", async () => {
            const firstDeposit = 500;  // Use wei
            const secondDeposit = 300;  // Use wei
            
            // Get initial balance  
            const initialLedger = await ledger.getLedger(user1Address);
            const initialBalance = initialLedger.availableBalance;
            
            // First transfer
            await user1.sendTransaction({
                to: await ledger.getAddress(),
                value: firstDeposit
            });
            
            // Second transfer
            await user1.sendTransaction({
                to: await ledger.getAddress(),
                value: secondDeposit
            });
            
            // Check total balance
            const ledgerInfo = await ledger.getLedger(user1Address);
            expect(ledgerInfo.availableBalance).to.equal(initialBalance + BigInt(firstDeposit) + BigInt(secondDeposit));
            expect(ledgerInfo.totalBalance).to.equal(initialBalance + BigInt(firstDeposit) + BigInt(secondDeposit));
        });

        it("should handle concurrent transfers from different users", async () => {
            const amount1 = 1000;  // Use wei
            const amount2 = 2000;  // Use wei
            
            // Get initial balance for owner (who already has account)
            const initialOwnerLedger = await ledger.getLedger(ownerAddress);
            const initialOwnerBalance = initialOwnerLedger.availableBalance;
            
            // Send from two different users (owner has account, provider1 doesn't)
            await Promise.all([
                owner.sendTransaction({
                    to: await ledger.getAddress(),
                    value: amount1
                }),
                provider1.sendTransaction({
                    to: await ledger.getAddress(),
                    value: amount2
                })
            ]);
            
            // Check both balances
            const ownerLedger = await ledger.getLedger(ownerAddress);
            const providerLedger = await ledger.getLedger(provider1Address);
            
            expect(ownerLedger.availableBalance).to.equal(initialOwnerBalance + BigInt(amount1));
            expect(providerLedger.availableBalance).to.equal(BigInt(amount2));
        });

        it("should not interfere with normal business transfer flows", async () => {
            // This test verifies that receive() doesn't interfere with normal transferFund -> processRefund flows
            
            // Step 1: Transfer funds to FineTuning service (normal business flow)
            const transferAmount = 500; // wei like other tests
            await ledger.transferFund(provider1Address, "fine-tuning-test", transferAmount);
            
            // Get initial state
            const initialOwnerLedger = await ledger.getLedger(ownerAddress);
            const initialAvailableBalance = initialOwnerLedger.availableBalance;
            
            console.log("Before retrieveFund - Owner available balance:", initialAvailableBalance.toString());
            
            // Step 2: Set up refund and wait for unlock time  
            await ledger.retrieveFund([provider1Address], "fine-tuning-test");
            await ethers.provider.send("evm_increaseTime", [86401]); // 24+ hours
            await ethers.provider.send("evm_mine");
            
            // Step 3: Retrieve funds (this triggers FineTuning -> LedgerManager ETH transfer)
            await ledger.retrieveFund([provider1Address], "fine-tuning-test");
            
            // Step 4: Verify balance increased correctly (without double-counting from receive)
            const finalOwnerLedger = await ledger.getLedger(ownerAddress);
            const finalAvailableBalance = finalOwnerLedger.availableBalance;
            const balanceIncrease = finalAvailableBalance - initialAvailableBalance;
            
            console.log("After retrieveFund - Owner available balance:", finalAvailableBalance.toString());
            console.log("Balance increase:", balanceIncrease.toString());
            console.log("Expected increase:", transferAmount.toString());
            
            // The balance should increase by exactly the transfer amount, not double
            // If receive() incorrectly processed the business transfer, it would be 2x
            expect(balanceIncrease).to.equal(BigInt(transferAmount), 
                "Balance should increase by transfer amount only, receive() should not double-count business transfers");
            
            // Verify the increase is exactly what we expect (not 0, not 2x)
            expect(balanceIncrease).to.not.equal(BigInt(0), "Balance should have increased");
            expect(balanceIncrease).to.not.equal(BigInt(transferAmount * 2), "Balance should not be double-counted by receive()");
        });
    });
});
