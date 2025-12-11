import * as fs from "fs";
import { task, types } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import path from "path";
import { UpgradeableBeacon } from "../../typechain-types";
import { CONTRACTS, transact, validateError } from "../utils/utils";

interface UpgradeInfo {
    network: string;
    chainId: string;
    timestamp: string;
    contractName: string;
    artifact: string;
    newImplementation: string;
    beacon: string;
    currentImplementation: string;
    action: {
        method: string;
        methodSignature: string;
        parameter: string;
    };
    instructions: string[];
}

/**
 * Deploy new implementation without calling upgradeTo on beacon.
 * Use this when beacon ownership has been transferred to Foundation.
 * The Foundation will execute upgradeTo manually on chain explorer.
 */
task("upgrade:deployImpl", "Deploy new implementation without upgrading beacon (for foundation-owned beacons)")
    .addParam("name", "name of the proxy contract", undefined, types.string, false)
    .addParam("artifact", "name of the implementation contract", undefined, types.string, false)
    .setAction(async (taskArgs: { name: string; artifact: string }, hre) => {
        const { deployments, getNamedAccounts } = hre;
        const { deployer } = await getNamedAccounts();
        const chainId = (await hre.ethers.provider.getNetwork()).chainId;

        // 1. Get beacon contract and current implementation
        const beacon: UpgradeableBeacon = await hre.ethers.getContract(`${taskArgs.name}Beacon`, deployer);
        const beaconAddress = await beacon.getAddress();
        const currentImpl = await beacon.implementation();

        console.log(`\n=== Deploying New Implementation ===`);
        console.log(`Contract: ${taskArgs.name}`);
        console.log(`Artifact: ${taskArgs.artifact}`);
        console.log(`Beacon: ${beaconAddress}`);
        console.log(`Current Implementation: ${currentImpl}`);

        // 2. Deploy new implementation
        const result = await deployments.deploy(`${taskArgs.name}Impl`, {
            from: deployer,
            contract: taskArgs.artifact,
            log: true,
        });
        console.log(`\nNew implementation deployed: ${result.address}`);

        // 3. Generate upgrade info for Foundation
        const upgradeInfo: UpgradeInfo = {
            network: hre.network.name,
            chainId: chainId.toString(),
            timestamp: new Date().toISOString(),
            contractName: taskArgs.name,
            artifact: taskArgs.artifact,
            newImplementation: result.address,
            beacon: beaconAddress,
            currentImplementation: currentImpl,
            action: {
                method: "upgradeTo(address)",
                methodSignature: "0x3659cfe6",
                parameter: result.address,
            },
            instructions: [
                `1. Open beacon contract on chain explorer: ${beaconAddress}`,
                `2. Navigate to "Write Contract" or "Write as Proxy" tab`,
                `3. Connect Foundation wallet (must be beacon owner)`,
                `4. Find and call upgradeTo(address) method`,
                `5. Input new implementation address: ${result.address}`,
                `6. Confirm and submit transaction`,
                `7. Verify upgrade by calling implementation() - should return: ${result.address}`,
            ],
        };

        // 4. Save upgrade info to file
        const outputDir = path.resolve(__dirname, "../../upgrade-pending");
        fs.mkdirSync(outputDir, { recursive: true });
        const outputFileName = `${taskArgs.name}-${hre.network.name}-${Date.now()}.json`;
        const outputPath = path.join(outputDir, outputFileName);
        fs.writeFileSync(outputPath, JSON.stringify(upgradeInfo, null, 2));

        // 5. Print summary
        console.log(`\n${"=".repeat(60)}`);
        console.log(`  UPGRADE INSTRUCTION FOR FOUNDATION`);
        console.log(`${"=".repeat(60)}`);
        console.log(`\nBeacon Address: ${beaconAddress}`);
        console.log(`New Implementation: ${result.address}`);
        console.log(`\nMethod to call: upgradeTo(address)`);
        console.log(`Parameter: ${result.address}`);
        console.log(`\nFull upgrade info saved to: ${outputPath}`);
        console.log(`\n${"=".repeat(60)}`);
        console.log(`\nNext steps for developer:`);
        console.log(`1. Verify the new implementation contract:`);
        console.log(`   npx hardhat verify --network ${hre.network.name} ${result.address}`);
        console.log(`\n2. Import storage layout:`);
        console.log(`   npx hardhat upgrade:forceImportAll --network ${hre.network.name}`);
        console.log(`\n3. Commit changes:`);
        console.log(`   git add deployments/ .openzeppelin/ upgrade-pending/`);
        console.log(`   git commit -m "Deploy new impl for ${taskArgs.name} upgrade"`);
        console.log(`\n4. Send upgrade-pending/${outputFileName} to Foundation`);
        console.log(`${"=".repeat(60)}\n`);

        return upgradeInfo;
    });

task("upgrade", "upgrade contract")
    .addParam("name", "name of the proxy contract", undefined, types.string, false)
    .addParam("artifact", "name of the implementation contract", undefined, types.string, false)
    .addParam("execute", "settle transaction on chain", false, types.boolean, true)
    .setAction(async (taskArgs: { name: string; artifact: string; execute: boolean }, hre) => {
        const { deployments, getNamedAccounts } = hre;
        const { deployer } = await getNamedAccounts();
        const beacon: UpgradeableBeacon = await hre.ethers.getContract(`${taskArgs.name}Beacon`, deployer);

        const result = await deployments.deploy(`${taskArgs.name}Impl`, {
            from: deployer,
            contract: taskArgs.artifact,
            log: true,
        });
        console.log(`new implementation deployed: ${result.address}`);

        await transact(beacon, "upgradeTo", [result.address], taskArgs.execute);
    });

task("upgrade:validate", "validate upgrade")
    .addParam("old", "name of the old contract", undefined, types.string, false)
    .addParam("new", "artifact of the new contract", undefined, types.string, false)
    .setAction(async (taskArgs: { old: string; new: string }, hre) => {
        const oldAddr = await (await hre.ethers.getContract(`${taskArgs.old}Impl`)).getAddress();
        const newImpl = await hre.ethers.getContractFactory(taskArgs.new);
        const chainId = (await hre.ethers.provider.getNetwork()).chainId;
        const tmpFileName = `unknown-${chainId}.json`;
        const tmpFilePath = path.resolve(__dirname, `../../.openzeppelin/${tmpFileName}`);
        const fileName = `${hre.network.name}-${chainId}.json`;
        const filePath = path.resolve(__dirname, `../../.openzeppelin/${fileName}`);
        if (fs.existsSync(filePath)) {
            fs.copyFileSync(filePath, tmpFilePath);
        } else {
            throw Error(`network file ${filePath} not found!`);
        }
        await hre.upgrades.validateUpgrade(oldAddr, newImpl, {
            unsafeAllow: ["constructor", "state-variable-immutable"],
            kind: "beacon",
        });
        fs.rmSync(tmpFilePath);
    });

task("upgrade:forceImportAll", "import contracts").setAction(async (_taskArgs, hre) => {
    const proxied = await getProxyInfo(hre);
    console.log(`proxied: ${Array.from(proxied).join(", ")}`);
    const chainId = (await hre.ethers.provider.getNetwork()).chainId;
    console.log(`chainId: ${chainId}`);
    const tmpFileName = `unknown-${chainId}.json`;
    const tmpFilePath = path.resolve(__dirname, `../../.openzeppelin/${tmpFileName}`);
    if (fs.existsSync(tmpFilePath)) {
        console.log(`removing tmp network file ${tmpFilePath}..`);
        fs.rmSync(tmpFilePath);
    }
    
    // Helper function to add delay
    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    
    for (const name of Array.from(proxied)) {
        // Add 500ms delay between each contract to avoid RPC rate limits
        if (Array.from(proxied).indexOf(name) > 0) {
            console.log(`Waiting 500ms to avoid RPC rate limit...`);
            await delay(500);
        }
        
        const addr = await (await hre.ethers.getContract(`${name}Impl`)).getAddress();
        
        // Determine the correct artifact name
        let artifactName = name;
        if (name.includes('_v')) {
            // For versioned contracts, extract the base contract name
            // e.g., "InferenceServing_v1.0" -> "InferenceServing"
            artifactName = name.split('_v')[0];
        }
        
        const factory = await hre.ethers.getContractFactory(artifactName);
        try {
            await hre.upgrades.forceImport(addr, factory, {
                kind: "beacon",
            });
            console.log(`force imported ${name}.`);
        } catch (e) {
            validateError(e, "The following deployment clashes with an existing one at");
            console.log(`${name} already imported.`);
        }
    }
    if (fs.existsSync(tmpFilePath)) {
        const newFileName = `${hre.network.name}-${chainId}.json`;
        const newFilePath = path.resolve(__dirname, `../../.openzeppelin/${newFileName}`);
        console.log(`renaming tmp network file ${tmpFileName} to ${newFileName}..`);
        fs.renameSync(tmpFilePath, newFilePath);
    }
});

export async function getProxyInfo(hre: HardhatRuntimeEnvironment) {
    const proxied = new Set<string>();
    
    // First, check standard contracts (without versions)
    for (const contractMeta of Object.values(CONTRACTS)) {
        const name = contractMeta.name;
        try {
            await hre.ethers.getContract(`${name}Beacon`);
            proxied.add(name);
        } catch (e) {
            validateError(e, "No Contract deployed with name");
        }
    }
    
    // Then, check versioned contracts
    const { deployments } = hre;
    const allDeployments = await deployments.all();
    
    for (const [deploymentName] of Object.entries(allDeployments)) {
        // Check if this is a versioned beacon contract
        if (deploymentName.endsWith('Beacon') && deploymentName.includes('_v')) {
            // Extract the base name (e.g., "InferenceServing_v1.0Beacon" -> "InferenceServing_v1.0")
            const baseName = deploymentName.replace('Beacon', '');
            
            // Check if corresponding Impl exists
            try {
                await hre.ethers.getContract(`${baseName}Impl`);
                proxied.add(baseName);
            } catch (e) {
                // Impl doesn't exist, skip this one
            }
        }
    }
    
    return proxied;
}
