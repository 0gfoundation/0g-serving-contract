import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { CONTRACTS, deployInBeaconProxy, getTypedContract } from "../utils/utils";

/**
 * Universal service deployment script
 * 
 * Usage:
 * SERVICE_TYPE=inference SERVICE_VERSION=v1.0 npx hardhat deploy --tags deploy-service
 * SERVICE_TYPE=inference SERVICE_VERSION=v2.0 npx hardhat deploy --tags deploy-service
 * SERVICE_TYPE=fine-tuning SERVICE_VERSION=v1.0 npx hardhat deploy --tags deploy-service
 * SERVICE_TYPE=fine-tuning SERVICE_VERSION=v3.5 npx hardhat deploy --tags deploy-service
 */

const lockTime = parseInt(process.env["LOCK_TIME"] || "86400");
const penaltyPercentage = parseInt(process.env["PENALTY_PERCENTAGE"] || "30");

const deploy: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
    const { deployer } = await hre.getNamedAccounts();
    
    // Get required parameters from environment
    const serviceType = process.env.SERVICE_TYPE;
    const serviceVersion = process.env.SERVICE_VERSION;
    const setAsRecommended = process.env.SET_RECOMMENDED === "true";
    
    if (!serviceType || !serviceVersion) {
        console.error(`❌ Missing required environment variables:`);
        console.error(`   SERVICE_TYPE (inference/fine-tuning) and SERVICE_VERSION are required`);
        console.error(`\n📖 Usage examples:`);
        console.error(`   SERVICE_TYPE=inference SERVICE_VERSION=v1.0 npx hardhat deploy --tags deploy-service`);
        console.error(`   SERVICE_TYPE=fine-tuning SERVICE_VERSION=v2.0 npx hardhat deploy --tags deploy-service`);
        throw new Error("Missing required environment variables");
    }
    
    // Validate service type
    if (!["inference", "fine-tuning"].includes(serviceType)) {
        throw new Error(`Invalid SERVICE_TYPE: ${serviceType}. Must be 'inference' or 'fine-tuning'`);
    }
    
    console.log(`🚀 Deploying ${serviceType} service ${serviceVersion}...`);
    
    // Determine contract type and get contract meta
    const contractMeta = serviceType === "inference" ? CONTRACTS.InferenceServing : CONTRACTS.FineTuningServing;
    const deploymentName = `${contractMeta.name}_${serviceVersion}`;
    
    // Get LedgerManager (must be deployed first)
    let ledgerManager;
    try {
        ledgerManager = await getTypedContract(hre, CONTRACTS.LedgerManager);
    } catch (error) {
        console.error(`❌ LedgerManager not found. Please deploy it first with: npx hardhat deploy --tags ledger`);
        throw error;
    }
    
    const ledgerManagerAddress = await ledgerManager.getAddress();
    
    // Deploy the service contract using BeaconProxy pattern
    console.log(`🚀 Deploying ${serviceType} ${serviceVersion} using BeaconProxy...`);
    
    // Create a versioned ContractMeta for this deployment
    const versionedContractMeta = {
        factory: contractMeta.factory,
        name: deploymentName,
        contractName: () => contractMeta.contractName()
    };
    
    // Use the standard deployInBeaconProxy function
    await deployInBeaconProxy(hre, versionedContractMeta);
    
    // Get the deployed contract and initialize it
    const serviceAddress = (await hre.ethers.getContract(deploymentName)).target as string;
    
    // Initialize the contract with proper typing
    console.log(`🔧 Initializing ${serviceType} ${serviceVersion}...`);
    let initTx;
    if (serviceType === "inference") {
        const inferenceContract = CONTRACTS.InferenceServing.factory.connect(serviceAddress, await hre.ethers.getSigner(deployer));
        initTx = await inferenceContract.initialize(lockTime, ledgerManagerAddress, deployer);
    } else {
        const fineTuningContract = CONTRACTS.FineTuningServing.factory.connect(serviceAddress, await hre.ethers.getSigner(deployer));
        initTx = await fineTuningContract.initialize(lockTime, ledgerManagerAddress, deployer, penaltyPercentage);
    }
    await initTx.wait();
    console.log(`✅ ${serviceType} ${serviceVersion} deployed at: ${serviceAddress}`);
    
    // Register with LedgerManager
    console.log(`📝 Registering ${serviceType} ${serviceVersion} with LedgerManager...`);
    try {
        const registerTx = await ledgerManager.registerService(
            serviceType,
            serviceVersion,
            serviceAddress,
            `${serviceType} serving service ${serviceVersion}`
        );
        await registerTx.wait();
        console.log(`✅ Service registered successfully`);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes("Service already registered")) {
            console.log(`⚠️  Service ${serviceType} ${serviceVersion} already registered, skipping...`);
        } else {
            console.error(`❌ Failed to register service:`, error);
            throw error;
        }
    }
    
    // Set as recommended if requested
    if (setAsRecommended) {
        console.log(`🎯 Setting ${serviceType} ${serviceVersion} as recommended...`);
        try {
            const recommendTx = await ledgerManager.setRecommendedService(serviceType, serviceVersion);
            await recommendTx.wait();
            console.log(`✅ ${serviceType} ${serviceVersion} set as recommended`);
        } catch (error) {
            console.error(`❌ Failed to set as recommended:`, error);
            throw error;
        }
    }
    
    console.log(`\n🎉 Deployment completed!`);
    console.log(`📍 Service Address: ${serviceAddress}`);
    console.log(`🏷️  Service Name: ${serviceType}-${serviceVersion}`);
    console.log(`📋 Deployment Name: ${deploymentName}`);
    
    if (!setAsRecommended) {
        console.log(`\n💡 To set this as the recommended version, run:`);
        console.log(`   SERVICE_TYPE=${serviceType} SERVICE_VERSION=${serviceVersion} npx hardhat deploy --tags set-recommended`);
    }
};

export default deploy;
deploy.tags = ["deploy-service"];