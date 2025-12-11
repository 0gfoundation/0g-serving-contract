import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";
import dotenv from "dotenv";
import "hardhat-deploy";
import "hardhat-deploy-ethers";
import "hardhat-gas-reporter";
import { HardhatUserConfig } from "hardhat/config";
dotenv.config();

const ZG_TESTNET_V4_PRIVATE_KEY = process.env.ZG_TESTNET_V4_PRIVATE_KEY || "";
const ZG_TESTNET_DEV_PRIVATE_KEY = process.env.ZG_TESTNET_DEV_PRIVATE_KEY || "";
const ZG_MAINNET_PRIVATE_KEY = process.env.ZG_MAINNET_PRIVATE_KEY || "";

import "./src/tasks/upgrade";

/** @type import('hardhat/config').HardhatUserConfig */
const config: HardhatUserConfig = {
    paths: {
        artifacts: "artifacts",
        cache: "build/cache",
        sources: "contracts",
        deploy: "src/deploy",
    },
    solidity: {
        version: "0.8.20",
        settings: {
            outputSelection: {
                "*": {
                    "*": [
                        "evm.bytecode.object",
                        "evm.deployedBytecode.object",
                        "abi",
                        "evm.bytecode.sourceMap",
                        "evm.deployedBytecode.sourceMap",
                        "metadata",
                    ],
                    "": ["ast"],
                },
            },
            evmVersion: "istanbul",
            viaIR: true,
            optimizer: {
                enabled: true,
                runs: 200,
            },
        },
    },
    namedAccounts: {
        deployer: {
            default: 0,
        },
    },
    networks: {
        hardhat: {
            allowUnlimitedContractSize: true,
            allowBlocksWithSameTimestamp: true,
            blockGasLimit: 100000000,
            gas: 100000000,
            accounts: [
                {
                    privateKey: "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
                    balance: "1000000000000000000000",
                },
                {
                    privateKey: "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
                    balance: "1000000000000000000000",
                },
                {
                    privateKey: "5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
                    balance: "1000000000000000000000",
                },
                {
                    privateKey: "7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
                    balance: "1000000000000000000000",
                },
            ],
        },
        zgTestnetV4: {
            url: "https://evmrpc-testnet.0g.ai",
            accounts: [ZG_TESTNET_V4_PRIVATE_KEY],
            chainId: 16602,
            gasPrice: 12000000000,
        },
        zgTestnetDev: {
            url: "https://evmrpc-testnet.0g.ai",
            accounts: [ZG_TESTNET_DEV_PRIVATE_KEY],
            chainId: 16602,
            gasPrice: 12000000000,
        },
        zgMainnet: {
            url: "https://evmrpc.0g.ai",
            accounts: [ZG_MAINNET_PRIVATE_KEY],
            chainId: 16661,
            gasPrice: 12000000000,
        },
    },
    etherscan: {
        apiKey: {
            zgTestnetV4: "00",
            zgTestnetDev: "00",
            zgMainnet: "00",
        },
        customChains: [
            {
                network: "zgTestnetV4",
                chainId: 16602,
                urls: {
                    apiURL: "https://chainscan-galileo.0g.ai/open/api",
                    browserURL: "https://chainscan-galileo.0g.ai",
                },
            },
            {
                network: "zgTestnetDev",
                chainId: 16602,
                urls: {
                    apiURL: "https://chainscan-galileo.0g.ai/open/api",
                    browserURL: "https://chainscan-galileo.0g.ai",
                },
            },
            {
                network: "zgMainnet",
                chainId: 16661,
                urls: {
                    apiURL: "https://chainscan.0g.ai/open/api",
                    browserURL: "https://chainscan.0g.ai",
                },
            },
        ],
    },
    gasReporter: {
        currency: "Gwei",
        gasPrice: 12,
        enabled: true,
        outputFile: "gas-report.txt",
        noColors: true,
    },
};

export default config;
