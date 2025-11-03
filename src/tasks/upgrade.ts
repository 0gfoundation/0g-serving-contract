import * as fs from "fs";
import { task, types } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import path from "path";
import { UpgradeableBeacon } from "../../typechain-types";
import { CONTRACTS, transact, validateError } from "../utils/utils";

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
