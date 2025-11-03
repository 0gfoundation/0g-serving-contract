import { FACTORY_POSTFIX } from "@typechain/ethers-v6/dist/common";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { buildPedersenHash } from "circomlibjs";

// We use the Typechain factory class objects to fill the `CONTRACTS` mapping. These objects are used
// by hardhat-deploy to locate compiled contract artifacts. However, an exception occurs if we import
// from Typechain files before they are generated. To avoid this, we follow a two-step process:
//
// 1. We import the types at compile time to ensure type safety. Hardhat does not report an error even
// if these files are not yet generated, as long as the "--typecheck" command-line argument is not used.
import { BaseContract, ContractFactory, ContractRunner, ethers, Signer } from "ethers";
import * as TypechainTypes from "../../typechain-types";
// 2. We import the values at runtime and silently ignore any exceptions.
export let Factories = {} as typeof TypechainTypes;
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    Factories = require("../../typechain-types") as typeof TypechainTypes;
} catch (err) {
    // ignore
}

interface TypechainFactory<T> {
    new (...args: ConstructorParameters<typeof ContractFactory>): ContractFactory;
    connect: (address: string, runner?: ContractRunner | null) => T;
}

class ContractMeta<T> {
    factory: TypechainFactory<T>;
    /** Deployment name */
    name: string;

    constructor(factory: TypechainFactory<T>, name?: string) {
        this.factory = factory;
        this.name = name ?? this.contractName();
    }

    contractName() {
        // this.factory is undefined when the typechain files are not generated yet
        if (!this.factory?.name) {
            return "UnknownContract";
        }
        return this.factory.name.slice(0, -FACTORY_POSTFIX.length);
    }
}

export const DEFAULT_ADMIN_ROLE = "0x0000000000000000000000000000000000000000000000000000000000000000";
export const PAUSER_ROLE = ethers.id("PAUSER_ROLE");
const ADDR_LENGTH = 20;
const NONCE_LENGTH = 8;

export const CONTRACTS = {
    LedgerManager: new ContractMeta(Factories.LedgerManager__factory, "LedgerManager"),
    InferenceServing: new ContractMeta(Factories.InferenceServing__factory, "InferenceServing"),
    FineTuningServing: new ContractMeta(Factories.FineTuningServing__factory, "FineTuningServing"),
} as const;

type GetContractTypeFromContractMeta<F> = F extends ContractMeta<infer C> ? C : never;

type AnyContractType = GetContractTypeFromContractMeta<(typeof CONTRACTS)[keyof typeof CONTRACTS]>;

export type AnyContractMeta = ContractMeta<AnyContractType>;

const UPGRADEABLE_BEACON = "UpgradeableBeacon";
const BEACON_PROXY = "BeaconProxy";

export async function deployDirectly(
    hre: HardhatRuntimeEnvironment,
    contract: ContractMeta<unknown>,
    args: unknown[] = []
) {
    const { deployments, getNamedAccounts } = hre;
    const { deployer } = await getNamedAccounts();
    // deploy implementation
    await deployments.deploy(contract.name, {
        from: deployer,
        contract: contract.contractName(),
        args: args,
        log: true,
    });
}

export async function deployInBeaconProxy(
    hre: HardhatRuntimeEnvironment,
    contract: ContractMeta<unknown>,
    args: unknown[] = []
) {
    const { deployments, getNamedAccounts } = hre;
    const { deployer } = await getNamedAccounts();
    // deploy implementation
    await deployments.deploy(`${contract.name}Impl`, {
        from: deployer,
        contract: contract.contractName(),
        args: args,
        log: true,
    });
    const implementation = await hre.ethers.getContract(`${contract.name}Impl`);
    // deploy beacon
    await deployments.deploy(`${contract.name}Beacon`, {
        from: deployer,
        contract: UPGRADEABLE_BEACON,
        args: [await implementation.getAddress()],
        log: true,
    });
    const beacon = await hre.ethers.getContract(`${contract.name}Beacon`);
    // deploy proxy
    await deployments.deploy(contract.name, {
        from: deployer,
        contract: BEACON_PROXY,
        args: [await beacon.getAddress(), []],
        log: true,
    });
}

export async function getTypedContract<T>(
    hre: HardhatRuntimeEnvironment,
    contract: ContractMeta<T>,
    signer?: Signer | string
) {
    const address = await (await hre.ethers.getContract(contract.name)).getAddress();
    if (signer === undefined) {
        signer = (await hre.getNamedAccounts()).deployer;
    }
    if (typeof signer === "string") {
        signer = await hre.ethers.getSigner(signer);
    }
    return contract.factory.connect(address, signer);
}

export async function transact(contract: BaseContract, methodName: string, params: unknown[], execute: boolean) {
    if (execute) {
        await (await contract.getFunction(methodName).send(...params)).wait();
    } else {
        console.log(`to: ${await contract.getAddress()}`);
        console.log(`func: ${contract.interface.getFunction(methodName)?.format()}`);

        console.log(`params: ${JSON.stringify(params, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
        console.log(`data: ${contract.interface.encodeFunctionData(methodName, params)}`);
    }
}

export function validateError(e: unknown, msg: string) {
    if (e instanceof Error) {
        if (!e.toString().includes(msg)) {
            throw Error(`unexpected error: ${String(e)}`);
        }
    } else {
        throw Error(`unexpected error: ${String(e)}`);
    }
}

function bigintToBytes(input: bigint, l: number) {
    const bytes = new Uint8Array(l);
    for (let i = 0; i < l; i++) {
        bytes[i] = Number((input >> BigInt(8 * i)) & BigInt(0xff));
    }
    return bytes;
}

export async function calculatePedersenHash(nonce: bigint, userAddress: bigint, providerAddress: bigint): Promise<Uint8Array> {
    const pedersenHash = await buildPedersenHash();

    const buffer = new ArrayBuffer(NONCE_LENGTH + ADDR_LENGTH * 2);
    let offset = 0;

    // nonce (u64)
    const nonceBytes = bigintToBytes(nonce, NONCE_LENGTH);
    new Uint8Array(buffer, offset, NONCE_LENGTH).set(nonceBytes);
    offset += NONCE_LENGTH;

    // userAddress (u160)
    const userAddressBytes = bigintToBytes(userAddress, ADDR_LENGTH);
    new Uint8Array(buffer, offset, ADDR_LENGTH).set(userAddressBytes);
    offset += ADDR_LENGTH;

    // providerAddress (u160)
    const providerAddressBytes = bigintToBytes(providerAddress, ADDR_LENGTH);
    new Uint8Array(buffer, offset, ADDR_LENGTH).set(providerAddressBytes);

    const hash = pedersenHash.hash(Buffer.from(buffer));
    return hash;
}