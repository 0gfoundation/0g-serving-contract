import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { CONTRACTS, getTypedContract } from "../utils/utils";

/**
 * Utility script for service management operations
 * Usage examples:
 * - npx hardhat deploy --tags set-recommended --env SERVICE_TYPE=inference --env SERVICE_VERSION=v2.0
 * - npx hardhat deploy --tags list-services
 */

const deploy: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
    
    // Get LedgerManager
    const ledgerManager = await getTypedContract(hre, CONTRACTS.LedgerManager);
    const ledgerManagerAddress = await ledgerManager.getAddress();
    
    console.log(`🔧 Service Management Utilities`);
    console.log(`📍 LedgerManager at: ${ledgerManagerAddress}`);
    
    // Set recommended service if specified
    const serviceType = process.env.SERVICE_TYPE;
    const serviceVersion = process.env.SERVICE_VERSION;
    
    if (serviceType && serviceVersion) {
        console.log(`\n⚙️ Setting ${serviceType} ${serviceVersion} as recommended...`);
        try {
            const setRecommendedTx = await ledgerManager.setRecommendedService(serviceType, serviceVersion);
            await setRecommendedTx.wait();
            console.log(`✅ ${serviceType} ${serviceVersion} set as recommended`);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`❌ Failed to set recommended: ${errorMessage}`);
        }
    }
    
    // List all services
    console.log(`\n📋 All registered services:`);
    try {
        const allServices = await ledgerManager.getAllActiveServices();
        
        if (allServices.length === 0) {
            console.log(`   No services registered yet`);
        } else {
            const servicesByType: { [key: string]: Array<{
                serviceType: string;
                fullName: string;
                serviceAddress: string;
                description: string;
                isRecommended: boolean;
                registeredAt: bigint;
            }> } = {};
            
            // Group by service type
            for (const service of allServices) {
                if (!servicesByType[service.serviceType]) {
                    servicesByType[service.serviceType] = [];
                }
                servicesByType[service.serviceType].push(service);
            }
            
            // Display grouped services
            for (const [type, services] of Object.entries(servicesByType)) {
                console.log(`\n   📦 ${type} services:`);
                for (const service of services) {
                    const status = service.isRecommended ? "🌟 RECOMMENDED" : "   Available";
                    console.log(`      ${status} ${service.fullName} -> ${service.serviceAddress}`);
                    console.log(`         Description: ${service.description}`);
                    console.log(`         Registered: ${new Date(Number(service.registeredAt) * 1000).toISOString()}`);
                }
            }
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`❌ Failed to list services: ${errorMessage}`);
    }
    
    // Show usage instructions
    console.log(`\n📖 Service Management Commands:`);
    console.log(`   Set recommended: SERVICE_TYPE=inference SERVICE_VERSION=v2.0 npx hardhat deploy --tags set-recommended`);
    console.log(`   List services:   npx hardhat deploy --tags list-services`);
    console.log(`\n📖 Deployment Commands:`);
    console.log(`   Deploy LedgerManager:     npx hardhat deploy --tags ledger`);
    console.log(`   Deploy service:           SERVICE_TYPE=inference SERVICE_VERSION=v1.0 npx hardhat deploy --tags deploy-service`);
    console.log(`   Deploy with recommend:    SERVICE_TYPE=inference SERVICE_VERSION=v2.0 SET_RECOMMENDED=true npx hardhat deploy --tags deploy-service`);
};

deploy.tags = ["service-management", "set-recommended", "list-services"];
deploy.dependencies = [];
export default deploy;