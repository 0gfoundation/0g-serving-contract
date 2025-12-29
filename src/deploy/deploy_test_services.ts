import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { CONTRACTS, deployInBeaconProxy, getTypedContract } from "../utils/utils";

/**
 * Test deployment script that creates versioned inference and fine-tuning services
 * for testing purposes. This follows the production deployment pattern.
 */

const lockTime = parseInt(process.env["LOCK_TIME"] || "86400");
const penaltyPercentage = parseInt(process.env["PENALTY_PERCENTAGE"] || "30");

const deploy: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
    const { deployer } = await hre.getNamedAccounts();
    
    console.log(`🧪 Deploying test services with versioned deployments...`);
    
    // Get LedgerManager (must be deployed first)
    let ledgerManager;
    try {
        ledgerManager = await getTypedContract(hre, CONTRACTS.LedgerManager);
    } catch (error) {
        console.error(`❌ LedgerManager not found. Please deploy it first with: npx hardhat deploy --tags ledger`);
        throw error;
    }
    
    const ledgerManagerAddress = await ledgerManager.getAddress();
    
    // Deploy InferenceServing_test version
    const inferenceVersion = "test";
    const inferenceDeploymentName = `InferenceServing_${inferenceVersion}`;
    
    console.log(`🚀 Deploying InferenceServing ${inferenceVersion} for tests...`);
    
    // Create versioned ContractMeta for InferenceServing
    const inferenceVersionedContractMeta = {
        factory: CONTRACTS.InferenceServing.factory,
        name: inferenceDeploymentName,
        contractName: () => CONTRACTS.InferenceServing.contractName()
    };
    
    await deployInBeaconProxy(hre, inferenceVersionedContractMeta);

    // Get the deployed contract address and initialize
    const inferenceAddress = (await hre.ethers.getContract(inferenceDeploymentName)).target as string;
    const inferenceContract = CONTRACTS.InferenceServing.factory.connect(
        inferenceAddress, 
        await hre.ethers.getSigner(deployer)
    );
    
    console.log(`🔧 Initializing InferenceServing ${inferenceVersion}...`);
    const initTx1 = await inferenceContract.initialize(lockTime, ledgerManagerAddress, deployer);
    await initTx1.wait();
    console.log(`✅ InferenceServing ${inferenceVersion} deployed at: ${inferenceAddress}`);
    
    // Deploy FineTuningServing_test version  
    const fineTuningVersion = "test";
    const fineTuningDeploymentName = `FineTuningServing_${fineTuningVersion}`;
    
    console.log(`🚀 Deploying FineTuningServing ${fineTuningVersion} for tests...`);
    
    // Create versioned ContractMeta for FineTuningServing
    const fineTuningVersionedContractMeta = {
        factory: CONTRACTS.FineTuningServing.factory,
        name: fineTuningDeploymentName,
        contractName: () => CONTRACTS.FineTuningServing.contractName()
    };
    
    await deployInBeaconProxy(hre, fineTuningVersionedContractMeta);

    // Get the deployed contract address and initialize
    const fineTuningAddress = (await hre.ethers.getContract(fineTuningDeploymentName)).target as string;
    const fineTuningContract = CONTRACTS.FineTuningServing.factory.connect(
        fineTuningAddress,
        await hre.ethers.getSigner(deployer)
    );
    
    console.log(`🔧 Initializing FineTuningServing ${fineTuningVersion}...`);
    const initTx2 = await fineTuningContract.initialize(lockTime, ledgerManagerAddress, deployer, penaltyPercentage);
    await initTx2.wait();
    console.log(`✅ FineTuningServing ${fineTuningVersion} deployed at: ${fineTuningAddress}`);
    
    // Register services with LedgerManager
    console.log(`📝 Registering services with LedgerManager...`);
    
    // Register InferenceServing
    console.log(`🔗 Registering InferenceServing ${inferenceVersion}...`);
    const registerInferenceTx = await ledgerManager.registerService(
        "inference",
        inferenceVersion,
        inferenceAddress,
        `Test InferenceServing ${inferenceVersion} for unit tests`
    );
    await registerInferenceTx.wait();
    
    // Set inference as recommended
    const setInferenceRecommendedTx = await ledgerManager.setRecommendedService(
        "inference",
        inferenceVersion
    );
    await setInferenceRecommendedTx.wait();
    
    // Register FineTuningServing
    console.log(`🔗 Registering FineTuningServing ${fineTuningVersion}...`);
    const registerFineTuningTx = await ledgerManager.registerService(
        "fine-tuning",
        fineTuningVersion,
        fineTuningAddress,
        `Test FineTuningServing ${fineTuningVersion} for unit tests`
    );
    await registerFineTuningTx.wait();
    
    // Set fine-tuning as recommended
    const setFineTuningRecommendedTx = await ledgerManager.setRecommendedService(
        "fine-tuning",
        fineTuningVersion
    );
    await setFineTuningRecommendedTx.wait();
    
    console.log(`✅ Services registered and set as recommended`);
    console.log(`📍 InferenceServing: ${inferenceAddress} (${inferenceDeploymentName})`);
    console.log(`📍 FineTuningServing: ${fineTuningAddress} (${fineTuningDeploymentName})`);
    console.log(`\n🎉 Test deployment completed!`);
};

export default deploy;
deploy.tags = ["test-services"];
deploy.dependencies = ["LedgerManager"];