import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

/**
 * Contract verification script for BeaconProxy pattern
 * 
 * Usage:
 * IMPL_ADDRESS=0x123... BEACON_ADDRESS=0x456... PROXY_ADDRESS=0x789... npx hardhat deploy --tags verify-contracts --network zgTestnetV4
 * 
 * Or verify individually:
 * IMPL_ADDRESS=0x123... npx hardhat deploy --tags verify-impl --network zgTestnetV4
 * BEACON_ADDRESS=0x456... IMPL_ADDRESS=0x123... npx hardhat deploy --tags verify-beacon --network zgTestnetV4
 * PROXY_ADDRESS=0x789... BEACON_ADDRESS=0x456... npx hardhat deploy --tags verify-proxy --network zgTestnetV4
 */

const deploy: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
    const { run, network } = hre;
    
    // Get addresses from environment
    const implAddress = process.env.IMPL_ADDRESS;
    const beaconAddress = process.env.BEACON_ADDRESS;
    const proxyAddress = process.env.PROXY_ADDRESS;
    
    console.log(`🔍 Contract Verification on network: ${network.name}`);
    
    // Helper function to run verification with error handling
    async function verifyContract(
        name: string,
        address: string,
        constructorArguments: any[] = [],
        contract?: string
    ) {
        try {
            console.log(`\n🚀 Verifying ${name} at ${address}...`);
            
            const verifyParams: any = {
                address,
                constructorArguments,
            };
            
            if (contract) {
                verifyParams.contract = contract;
            }
            
            await run("verify:verify", verifyParams);
            console.log(`✅ ${name} verified successfully`);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage.includes("already verified")) {
                console.log(`✅ ${name} is already verified`);
            } else {
                console.error(`❌ Failed to verify ${name}:`, errorMessage);
            }
        }
    }
    
    // 1. Verify Implementation
    if (implAddress) {
        await verifyContract("Implementation", implAddress);
    } else {
        console.log(`⚠️  IMPL_ADDRESS not provided, skipping implementation verification`);
    }
    
    // 2. Verify UpgradeableBeacon
    if (beaconAddress && implAddress) {
        await verifyContract(
            "UpgradeableBeacon",
            beaconAddress,
            [implAddress]
        );
    } else {
        console.log(`⚠️  BEACON_ADDRESS or IMPL_ADDRESS not provided, skipping beacon verification`);
    }
    
    // 3. Verify BeaconProxy
    if (proxyAddress && beaconAddress) {
        await verifyContract(
            "BeaconProxy",
            proxyAddress,
            [beaconAddress, "0x"],
            "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol:BeaconProxy"
        );
    } else {
        console.log(`⚠️  PROXY_ADDRESS or BEACON_ADDRESS not provided, skipping proxy verification`);
    }
    
    console.log(`\n🎉 Verification process completed!`);
    
    // Show usage examples
    if (!implAddress || !beaconAddress || !proxyAddress) {
        console.log(`\n📖 Usage Examples:`);
        console.log(`   Full verification:`);
        console.log(`   IMPL_ADDRESS=0x123... BEACON_ADDRESS=0x456... PROXY_ADDRESS=0x789... npx hardhat deploy --tags verify-contracts --network ${network.name}`);
        console.log(`\n   Individual verifications:`);
        console.log(`   IMPL_ADDRESS=0x123... npx hardhat deploy --tags verify-impl --network ${network.name}`);
        console.log(`   BEACON_ADDRESS=0x456... IMPL_ADDRESS=0x123... npx hardhat deploy --tags verify-beacon --network ${network.name}`);
        console.log(`   PROXY_ADDRESS=0x789... BEACON_ADDRESS=0x456... npx hardhat deploy --tags verify-proxy --network ${network.name}`);
    }
};

// Individual verification functions
const verifyImpl: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
    const { run, network } = hre;
    const implAddress = process.env.IMPL_ADDRESS;
    
    if (!implAddress) {
        console.error(`❌ IMPL_ADDRESS is required`);
        return;
    }
    
    try {
        console.log(`🚀 Verifying Implementation at ${implAddress} on ${network.name}...`);
        await run("verify:verify", {
            address: implAddress,
            constructorArguments: [],
        });
        console.log(`✅ Implementation verified successfully`);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes("already verified")) {
            console.log(`✅ Implementation is already verified`);
        } else {
            console.error(`❌ Failed to verify implementation:`, errorMessage);
        }
    }
};

const verifyBeacon: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
    const { run, network } = hre;
    const beaconAddress = process.env.BEACON_ADDRESS;
    const implAddress = process.env.IMPL_ADDRESS;
    
    if (!beaconAddress || !implAddress) {
        console.error(`❌ Both BEACON_ADDRESS and IMPL_ADDRESS are required`);
        return;
    }
    
    try {
        console.log(`🚀 Verifying Beacon at ${beaconAddress} on ${network.name}...`);
        await run("verify:verify", {
            address: beaconAddress,
            constructorArguments: [implAddress],
        });
        console.log(`✅ Beacon verified successfully`);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes("already verified")) {
            console.log(`✅ Beacon is already verified`);
        } else {
            console.error(`❌ Failed to verify beacon:`, errorMessage);
        }
    }
};

const verifyProxy: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
    const { run, network } = hre;
    const proxyAddress = process.env.PROXY_ADDRESS;
    const beaconAddress = process.env.BEACON_ADDRESS;
    
    if (!proxyAddress || !beaconAddress) {
        console.error(`❌ Both PROXY_ADDRESS and BEACON_ADDRESS are required`);
        return;
    }
    
    try {
        console.log(`🚀 Verifying Proxy at ${proxyAddress} on ${network.name}...`);
        await run("verify:verify", {
            address: proxyAddress,
            constructorArguments: [beaconAddress, "0x"],
            contract: "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol:BeaconProxy",
        });
        console.log(`✅ Proxy verified successfully`);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes("already verified")) {
            console.log(`✅ Proxy is already verified`);
        } else {
            console.error(`❌ Failed to verify proxy:`, errorMessage);
        }
    }
};

export default deploy;
deploy.tags = ["verify-contracts"];

// Export individual verification functions
export { verifyImpl, verifyBeacon, verifyProxy };

// Individual tags
verifyImpl.tags = ["verify-impl"];
verifyBeacon.tags = ["verify-beacon"];
verifyProxy.tags = ["verify-proxy"];