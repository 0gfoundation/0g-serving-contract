import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { CONTRACTS, deployInBeaconProxy, getTypedContract } from "../utils/utils";

const deploy: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
    const { deployer } = await hre.getNamedAccounts();
    
    console.log(`🚀 Deploying LedgerManager...`);
    await deployInBeaconProxy(hre, CONTRACTS.LedgerManager);
    
    const ledgerManager = await getTypedContract(hre, CONTRACTS.LedgerManager);
    
    console.log(`⚙️ Initializing LedgerManager...`);
    if (!(await ledgerManager.initialized())) {
        await (await ledgerManager.initialize(deployer)).wait();
        console.log(`✅ LedgerManager initialized`);
    } else {
        console.log(`ℹ️ LedgerManager already initialized`);
    }
    
    const ledgerManagerAddress = await ledgerManager.getAddress();
    console.log(`📍 LedgerManager deployed at: ${ledgerManagerAddress}`);
    console.log(`\n📖 Next steps:`);
    console.log(`   Deploy services with: npx hardhat deploy --tags inference-v1.0`);
    console.log(`   Or deploy fine-tuning: npx hardhat deploy --tags fine-tuning-v1.0`);
};

deploy.tags = [CONTRACTS.LedgerManager.name, "ledger"];
deploy.dependencies = []; // Remove service dependencies for independent deployment
export default deploy;
