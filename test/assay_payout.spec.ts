import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { deployments, ethers } from "hardhat";
import { beforeEach } from "mocha";
import { InferenceServing as Serving, LedgerManager } from "../typechain-types";
import { TEESettlementDataStruct } from "../typechain-types/contracts/inference/InferenceServing";

// SPML assay payout — adversarial suite from docs/spml-payout-adversarial-testplan.md.
// Catalog row IDs (R1, S5, A2, ...) reference that document.
describe("Assay Payout", () => {
    let serving: Serving;
    let ledger: LedgerManager;
    let owner: HardhatEthersSigner, user1: HardhatEthersSigner, provider1: HardhatEthersSigner;
    let nodeA: HardhatEthersSigner, nodeB: HardhatEthersSigner, attacker: HardhatEthersSigner;
    let ownerAddress: string, provider1Address: string;
    let nodeAAddress: string, nodeBAddress: string;

    const teePrivateKey = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
    const teeWallet = new ethers.Wallet(teePrivateKey);

    const assayPrivateKey = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";
    const assayWallet = new ethers.Wallet(assayPrivateKey);

    const rogueWallet = ethers.Wallet.createRandom();

    const additionalData = "test";
    const lockTime = 24 * 60 * 60;

    let nextNonce = 1n;

    async function domain() {
        return {
            name: "0G Inference Serving",
            version: "1",
            chainId: (await ethers.provider.getNetwork()).chainId,
            verifyingContract: await serving.getAddress(),
        };
    }

    const voucherTypes = {
        PayoutVoucher: [
            { name: "node", type: "address" },
            { name: "cumulative", type: "uint256" },
            { name: "epoch", type: "uint64" },
        ],
    };

    async function signVoucher(
        wallet: ethers.Wallet,
        node: string,
        cumulative: bigint,
        epoch: bigint
    ): Promise<string> {
        return wallet.signTypedData(await domain(), voucherTypes, { node, cumulative, epoch });
    }

    async function makeSettlement(user: string, totalFee: bigint): Promise<TEESettlementDataStruct> {
        const nonce = nextNonce++;
        const requestsHash = ethers.keccak256(ethers.toUtf8Bytes(`batch-${nonce}`));
        const signature = await teeWallet.signTypedData(
            await domain(),
            {
                TEESettlement: [
                    { name: "requestsHash", type: "bytes32" },
                    { name: "nonce", type: "uint256" },
                    { name: "provider", type: "address" },
                    { name: "user", type: "address" },
                    { name: "totalFee", type: "uint256" },
                ],
            },
            { requestsHash, nonce, provider: provider1Address, user, totalFee }
        );
        return { user, provider: provider1Address, totalFee, requestsHash, nonce, signature };
    }

    // Settle `amount` of the owner's account into provider1's assay pool.
    async function settleToPool(amount: bigint) {
        const settlement = await makeSettlement(ownerAddress, amount);
        await serving.connect(provider1).settleFeesWithTEE([settlement]);
    }

    async function poolOf(provider: string): Promise<bigint> {
        const info = await serving.getAssayPayoutInfo(provider);
        return info.pool;
    }

    beforeEach(async () => {
        await deployments.fixture(["test-services"]);
        const servingDeployment = await deployments.get("InferenceServing_test");
        const ledgerDeployment = await deployments.get("LedgerManager");
        serving = await ethers.getContractAt("InferenceServing", servingDeployment.address);
        ledger = await ethers.getContractAt("LedgerManager", ledgerDeployment.address);

        [owner, user1, provider1, nodeA, nodeB, attacker] = await ethers.getSigners();
        [ownerAddress, provider1Address, nodeAAddress, nodeBAddress] = await Promise.all([
            owner.getAddress(),
            provider1.getAddress(),
            nodeA.getAddress(),
            nodeB.getAddress(),
        ]);

        nextNonce = 1n;

        await ledger.addLedger(additionalData, { value: ethers.parseEther("5") });
        await ledger.transferFund(provider1Address, "inference-test", ethers.parseEther("2"));

        await serving.connect(provider1).addOrUpdateService(
            {
                serviceType: "HTTP",
                url: "https://example-1.com",
                model: "llama-8b",
                verifiability: "SPML",
                inputPrice: 100,
                outputPrice: 100,
                additionalInfo: "",
                teeSignerAddress: teeWallet.address,
            },
            { value: ethers.parseEther("100") }
        );
        await serving.connect(owner).acknowledgeTEESignerByOwner(provider1Address);
        await serving.connect(owner).acknowledgeTEESigner(provider1Address, true);

        // Assay mode on for provider1
        await serving.connect(provider1).setAssaySigner(assayWallet.address, 0);
    });

    describe("Pool funding", () => {
        it("settlement credits the assay pool instead of the provider wallet", async () => {
            const providerBalanceBefore = await ethers.provider.getBalance(provider1Address);
            const settlement = await makeSettlement(ownerAddress, 1000n);
            await expect(serving.connect(provider1).settleFeesWithTEE([settlement]))
                .to.emit(serving, "AssayPoolFunded")
                .withArgs(provider1Address, 1000n, 1000n);
            expect(await poolOf(provider1Address)).to.equal(1000n);
            // provider paid gas but received no settlement funds
            expect(await ethers.provider.getBalance(provider1Address)).to.be.lessThan(providerBalanceBefore);
        });

        it("a provider without an assay signer still gets paid directly (legacy mode)", async () => {
            const legacyProvider = nodeB; // reuse a signer as a second provider
            await ledger.transferFund(await legacyProvider.getAddress(), "inference-test", ethers.parseEther("1"));
            await serving.connect(legacyProvider).addOrUpdateService(
                {
                    serviceType: "HTTP",
                    url: "https://example-2.com",
                    model: "llama-8b",
                    verifiability: "TeeML",
                    inputPrice: 100,
                    outputPrice: 100,
                    additionalInfo: "",
                    teeSignerAddress: teeWallet.address,
                },
                { value: ethers.parseEther("100") }
            );
            await serving.connect(owner).acknowledgeTEESignerByOwner(await legacyProvider.getAddress());
            await serving.connect(owner).acknowledgeTEESigner(await legacyProvider.getAddress(), true);

            const fee = 777n;
            const legacyAddr = await legacyProvider.getAddress();
            const requestsHash = ethers.keccak256(ethers.toUtf8Bytes("legacy-batch"));
            const signature = await teeWallet.signTypedData(
                await domain(),
                {
                    TEESettlement: [
                        { name: "requestsHash", type: "bytes32" },
                        { name: "nonce", type: "uint256" },
                        { name: "provider", type: "address" },
                        { name: "user", type: "address" },
                        { name: "totalFee", type: "uint256" },
                    ],
                },
                { requestsHash, nonce: 12345n, provider: legacyAddr, user: ownerAddress, totalFee: fee }
            );
            await expect(
                serving.connect(legacyProvider).settleFeesWithTEE([
                    { user: ownerAddress, provider: legacyAddr, totalFee: fee, requestsHash, nonce: 12345n, signature },
                ])
            ).to.changeEtherBalance(legacyProvider, fee);
            expect(await poolOf(legacyAddr)).to.equal(0n);
        });
    });

    describe("Claim — happy path", () => {
        beforeEach(async () => {
            await settleToPool(1000n);
        });

        it("pays the delta and advances withdrawn", async () => {
            const sig = await signVoucher(assayWallet, nodeAAddress, 300n, 1n);
            const claimTx = serving.connect(nodeA).claim(provider1Address, nodeAAddress, 300n, 1n, sig);
            await expect(claimTx)
                .to.emit(serving, "PayoutClaimed")
                .withArgs(provider1Address, nodeAAddress, 300n, 1n, 300n);
            await expect(claimTx).to.changeEtherBalance(nodeA, 300n);
            expect(await serving.assayWithdrawnOf(provider1Address, nodeAAddress)).to.equal(300n);

            const sig2 = await signVoucher(assayWallet, nodeAAddress, 500n, 2n);
            await expect(
                serving.connect(nodeA).claim(provider1Address, nodeAAddress, 500n, 2n, sig2)
            ).to.changeEtherBalance(nodeA, 200n);
            expect(await poolOf(provider1Address)).to.equal(500n);
        });

        it("INV1 conservation: deposited == pool + totalPaid after a claim sequence", async () => {
            const sigA = await signVoucher(assayWallet, nodeAAddress, 400n, 1n);
            await serving.connect(nodeA).claim(provider1Address, nodeAAddress, 400n, 1n, sigA);
            const sigB = await signVoucher(assayWallet, nodeBAddress, 250n, 1n);
            await serving.connect(nodeB).claim(provider1Address, nodeBAddress, 250n, 1n, sigB);
            const info = await serving.getAssayPayoutInfo(provider1Address);
            expect(info.deposited).to.equal(info.pool + info.totalPaid);
            expect(info.totalPaid).to.equal(650n);
        });
    });

    describe("Replay / double-spend (5.1)", () => {
        beforeEach(async () => {
            await settleToPool(1000n);
        });

        it("R1: the same voucher pays once, then reverts", async () => {
            const sig = await signVoucher(assayWallet, nodeAAddress, 300n, 1n);
            await serving.connect(nodeA).claim(provider1Address, nodeAAddress, 300n, 1n, sig);
            await expect(
                serving.connect(nodeA).claim(provider1Address, nodeAAddress, 300n, 1n, sig)
            ).to.be.revertedWithCustomError(serving, "NothingToClaim");
        });

        it("R2/R3: out-of-order lower cumulative reverts; net stays at the highest", async () => {
            const sig20 = await signVoucher(assayWallet, nodeAAddress, 20n, 2n);
            await serving.connect(nodeA).claim(provider1Address, nodeAAddress, 20n, 2n, sig20);
            const sig10 = await signVoucher(assayWallet, nodeAAddress, 10n, 1n);
            await expect(
                serving.connect(nodeA).claim(provider1Address, nodeAAddress, 10n, 1n, sig10)
            ).to.be.revertedWithCustomError(serving, "NothingToClaim");
            expect(await serving.assayWithdrawnOf(provider1Address, nodeAAddress)).to.equal(20n);
        });

        it("R5: same cumulative under a different epoch is not a fresh claim", async () => {
            const sig = await signVoucher(assayWallet, nodeAAddress, 300n, 1n);
            await serving.connect(nodeA).claim(provider1Address, nodeAAddress, 300n, 1n, sig);
            const sigEpoch2 = await signVoucher(assayWallet, nodeAAddress, 300n, 2n);
            await expect(
                serving.connect(nodeA).claim(provider1Address, nodeAAddress, 300n, 2n, sigEpoch2)
            ).to.be.revertedWithCustomError(serving, "NothingToClaim");
        });
    });

    describe("Signature (5.2)", () => {
        beforeEach(async () => {
            await settleToPool(1000n);
        });

        it("S1: a malleated high-s signature is rejected", async () => {
            const sig = ethers.Signature.from(await signVoucher(assayWallet, nodeAAddress, 300n, 1n));
            const N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
            const sPrime = ethers.toBeHex(N - BigInt(sig.s), 32);
            const vPrime = sig.v === 27 ? 28 : 27;
            const malleated = ethers.concat([sig.r, sPrime, new Uint8Array([vPrime])]);
            await expect(
                serving.connect(nodeA).claim(provider1Address, nodeAAddress, 300n, 1n, malleated)
            ).to.be.revertedWithCustomError(serving, "InvalidVoucherSignature");
        });

        it("S2: an out-of-range recovery id is rejected", async () => {
            const sig = ethers.Signature.from(await signVoucher(assayWallet, nodeAAddress, 300n, 1n));
            const badV = ethers.concat([sig.r, sig.s, new Uint8Array([29])]);
            await expect(
                serving.connect(nodeA).claim(provider1Address, nodeAAddress, 300n, 1n, badV)
            ).to.be.revertedWithCustomError(serving, "InvalidVoucherSignature");
        });

        it("S3: empty / wrong-length / garbage signatures revert", async () => {
            for (const bad of ["0x", "0x" + "11".repeat(64), "0x" + "11".repeat(66)]) {
                await expect(
                    serving.connect(nodeA).claim(provider1Address, nodeAAddress, 300n, 1n, bad)
                ).to.be.revertedWithCustomError(serving, "InvalidVoucherSignature");
            }
        });

        it("S4: an all-zero signature cannot match the signer", async () => {
            const zero = "0x" + "00".repeat(65);
            await expect(
                serving.connect(nodeA).claim(provider1Address, nodeAAddress, 300n, 1n, zero)
            ).to.be.revertedWithCustomError(serving, "InvalidVoucherSignature");
        });

        it("S5: mutating cumulative under an old signature recovers the wrong address", async () => {
            const sig = await signVoucher(assayWallet, nodeAAddress, 300n, 1n);
            await expect(
                serving.connect(nodeA).claim(provider1Address, nodeAAddress, 999n, 1n, sig)
            ).to.be.revertedWithCustomError(serving, "InvalidVoucherSignature");
        });

        it("S6: a voucher from a non-assay key is rejected", async () => {
            const sig = await signVoucher(rogueWallet as unknown as ethers.Wallet, nodeAAddress, 300n, 1n);
            await expect(
                serving.connect(nodeA).claim(provider1Address, nodeAAddress, 300n, 1n, sig)
            ).to.be.revertedWithCustomError(serving, "InvalidVoucherSignature");
        });
    });

    describe("Cross-domain replay (5.3)", () => {
        beforeEach(async () => {
            await settleToPool(1000n);
        });

        it("X2: a voucher bound to another contract address is rejected", async () => {
            const foreignDomain = {
                name: "0G Inference Serving",
                version: "1",
                chainId: (await ethers.provider.getNetwork()).chainId,
                verifyingContract: await ledger.getAddress(), // any other address
            };
            const sig = await assayWallet.signTypedData(foreignDomain, voucherTypes, {
                node: nodeAAddress,
                cumulative: 300n,
                epoch: 1n,
            });
            await expect(
                serving.connect(nodeA).claim(provider1Address, nodeAAddress, 300n, 1n, sig)
            ).to.be.revertedWithCustomError(serving, "InvalidVoucherSignature");
        });

        it("X3: a legacy TEESettlement signature is not a voucher", async () => {
            const sig = await assayWallet.signTypedData(
                await domain(),
                {
                    TEESettlement: [
                        { name: "requestsHash", type: "bytes32" },
                        { name: "nonce", type: "uint256" },
                        { name: "provider", type: "address" },
                        { name: "user", type: "address" },
                        { name: "totalFee", type: "uint256" },
                    ],
                },
                {
                    requestsHash: ethers.ZeroHash,
                    nonce: 1n,
                    provider: provider1Address,
                    user: nodeAAddress,
                    totalFee: 300n,
                }
            );
            await expect(
                serving.connect(nodeA).claim(provider1Address, nodeAAddress, 300n, 1n, sig)
            ).to.be.revertedWithCustomError(serving, "InvalidVoucherSignature");
        });
    });

    describe("Payee / theft (5.4)", () => {
        beforeEach(async () => {
            await settleToPool(1000n);
        });

        it("P1: anyone may submit a voucher, but funds always reach the voucher's node", async () => {
            const sig = await signVoucher(assayWallet, nodeAAddress, 300n, 1n);
            await expect(
                serving.connect(attacker).claim(provider1Address, nodeAAddress, 300n, 1n, sig)
            ).to.changeEtherBalances([nodeA, attacker], [300n, 0n]);
        });

        it("P2: claiming with a node different from the signed one reverts", async () => {
            const sig = await signVoucher(assayWallet, nodeAAddress, 300n, 1n);
            await expect(
                serving.connect(attacker).claim(provider1Address, await attacker.getAddress(), 300n, 1n, sig)
            ).to.be.revertedWithCustomError(serving, "InvalidVoucherSignature");
        });

        it("P3: node == address(0) is rejected", async () => {
            const sig = await signVoucher(assayWallet, ethers.ZeroAddress, 300n, 1n);
            await expect(
                serving.connect(attacker).claim(provider1Address, ethers.ZeroAddress, 300n, 1n, sig)
            ).to.be.revertedWithCustomError(serving, "InvalidAddress");
        });

        it("P4: a node that reverts on receive only breaks its own claim", async () => {
            const reverting = await (await ethers.getContractFactory("RevertingReceiver")).deploy();
            const revertingAddr = await reverting.getAddress();
            const sig = await signVoucher(assayWallet, revertingAddr, 300n, 1n);
            await expect(
                serving.connect(attacker).claim(provider1Address, revertingAddr, 300n, 1n, sig)
            ).to.be.revertedWithCustomError(serving, "TransferFailed");
            // nothing persisted, pool intact, another node can still claim
            expect(await serving.assayWithdrawnOf(provider1Address, revertingAddr)).to.equal(0n);
            expect(await poolOf(provider1Address)).to.equal(1000n);
            const sigA = await signVoucher(assayWallet, nodeAAddress, 100n, 1n);
            await expect(serving.connect(nodeA).claim(provider1Address, nodeAAddress, 100n, 1n, sigA)).not.to.be
                .reverted;
        });
    });

    describe("Solvency (5.5)", () => {
        it("V1/V3: a cumulative beyond the pool reverts at the solvency check", async () => {
            await settleToPool(100n);
            const sig = await signVoucher(assayWallet, nodeAAddress, 500n, 1n);
            await expect(
                serving.connect(nodeA).claim(provider1Address, nodeAAddress, 500n, 1n, sig)
            ).to.be.revertedWithCustomError(serving, "InsufficientAssayPool");
            // top the pool up; the same voucher then pays in full
            await settleToPool(400n);
            await expect(
                serving.connect(nodeA).claim(provider1Address, nodeAAddress, 500n, 1n, sig)
            ).to.changeEtherBalance(nodeA, 500n);
        });

        it("claims from an unfunded provider revert", async () => {
            const sig = await signVoucher(assayWallet, nodeAAddress, 1n, 1n);
            await expect(
                serving.connect(nodeA).claim(provider1Address, nodeAAddress, 1n, 1n, sig)
            ).to.be.revertedWithCustomError(serving, "InsufficientAssayPool");
        });
    });

    describe("Reentrancy (5.7)", () => {
        beforeEach(async () => {
            await settleToPool(1000n);
        });

        it("RE1: reentering claim from the receive hook pays exactly once", async () => {
            const claimer = await (await ethers.getContractFactory("ReentrantClaimer")).deploy();
            const claimerAddr = await claimer.getAddress();
            const sig = await signVoucher(assayWallet, claimerAddr, 300n, 1n);
            await claimer.arm(await serving.getAddress(), provider1Address, 300n, 1n, sig);
            await claimer.doClaim();
            expect(await claimer.reentered()).to.be.true;
            expect(await claimer.reentrySucceeded()).to.be.false;
            expect(await ethers.provider.getBalance(claimerAddr)).to.equal(300n);
            expect(await poolOf(provider1Address)).to.equal(700n);
        });

        it("RE3: a gas-heavy receive hook only affects its own claim", async () => {
            const heavy = await (await ethers.getContractFactory("GasHeavyReceiver")).deploy();
            const heavyAddr = await heavy.getAddress();
            const sig = await signVoucher(assayWallet, heavyAddr, 100n, 1n);
            await serving.connect(attacker).claim(provider1Address, heavyAddr, 100n, 1n, sig);
            const sigA = await signVoucher(assayWallet, nodeAAddress, 100n, 1n);
            await expect(serving.connect(nodeA).claim(provider1Address, nodeAAddress, 100n, 1n, sigA)).not.to.be
                .reverted;
        });
    });

    describe("Access control / key rotation (5.9)", () => {
        beforeEach(async () => {
            await settleToPool(1000n);
        });

        it("A1: only the contract owner sets the verifier cut cap", async () => {
            await expect(serving.connect(attacker).setAssayVerifierCutCap(1000)).to.be.revertedWith(
                "Ownable: caller is not the owner"
            );
        });

        it("another account's setAssaySigner cannot touch provider1's config", async () => {
            await serving.connect(attacker).setAssaySigner(await attacker.getAddress(), 0);
            const info = await serving.getAssayPayoutInfo(provider1Address);
            expect(info.signer).to.equal(assayWallet.address);
        });

        it("A3: assaySigner = address(0) is rejected", async () => {
            await expect(
                serving.connect(provider1).setAssaySigner(ethers.ZeroAddress, 0)
            ).to.be.revertedWithCustomError(serving, "InvalidAddress");
        });

        it("grace window beyond 7 days is rejected", async () => {
            await expect(
                serving.connect(provider1).setAssaySigner(rogueWallet.address, 8 * 24 * 60 * 60)
            ).to.be.revertedWithCustomError(serving, "GraceWindowTooLong");
        });

        it("A2: an in-flight voucher from the old key claims within the grace window, dies after", async () => {
            const oldSig = await signVoucher(assayWallet, nodeAAddress, 300n, 1n);
            const newSigner = new ethers.Wallet(ethers.Wallet.createRandom().privateKey);
            await serving.connect(provider1).setAssaySigner(newSigner.address, 3600);

            // within the grace window the old voucher still pays
            await expect(
                serving.connect(nodeA).claim(provider1Address, nodeAAddress, 300n, 1n, oldSig)
            ).to.changeEtherBalance(nodeA, 300n);

            // after the deadline an old-key voucher is dead
            const oldSig2 = await signVoucher(assayWallet, nodeAAddress, 400n, 2n);
            await time.increase(3601);
            await expect(
                serving.connect(nodeA).claim(provider1Address, nodeAAddress, 400n, 2n, oldSig2)
            ).to.be.revertedWithCustomError(serving, "InvalidVoucherSignature");

            // the new key works
            const newSig = await newSigner.signTypedData(await domain(), voucherTypes, {
                node: nodeAAddress,
                cumulative: 400n,
                epoch: 2n,
            });
            await expect(
                serving.connect(nodeA).claim(provider1Address, nodeAAddress, 400n, 2n, newSig)
            ).to.changeEtherBalance(nodeA, 100n);
        });

        it("A2b: rotation with zero grace kills old vouchers immediately", async () => {
            const oldSig = await signVoucher(assayWallet, nodeAAddress, 300n, 1n);
            await serving.connect(provider1).setAssaySigner(rogueWallet.address, 0);
            await expect(
                serving.connect(nodeA).claim(provider1Address, nodeAAddress, 300n, 1n, oldSig)
            ).to.be.revertedWithCustomError(serving, "InvalidVoucherSignature");
        });
    });

    describe("Verifier cut cap", () => {
        beforeEach(async () => {
            await settleToPool(1000n);
        });

        it("the assay signer claiming its own cut is bounded by the cap", async () => {
            const verifierNode = assayWallet.address;
            // cap unset (0 bps) — any self-claim reverts
            const sig = await signVoucher(assayWallet, verifierNode, 10n, 1n);
            await expect(
                serving.connect(attacker).claim(provider1Address, verifierNode, 10n, 1n, sig)
            ).to.be.revertedWithCustomError(serving, "VerifierCutExceedsCap");

            await serving.connect(owner).setAssayVerifierCutCap(1000); // 10%
            // 10% of 1000 deposited = 100; 10 is fine
            await expect(
                serving.connect(attacker).claim(provider1Address, verifierNode, 10n, 1n, sig)
            ).to.changeEtherBalance(assayWallet.address, 10n);
            // beyond the cap reverts
            const sigBig = await signVoucher(assayWallet, verifierNode, 101n, 2n);
            await expect(
                serving.connect(attacker).claim(provider1Address, verifierNode, 101n, 2n, sigBig)
            ).to.be.revertedWithCustomError(serving, "VerifierCutExceedsCap");
        });
    });

    describe("Cross-language parity (testplan §7)", () => {
        it("a voucher signed by the Python assay (eth_account) recovers to the same signer", () => {
            // Vector produced by pipeline/tests/test_payout.py::test_parity_vector_stable —
            // regenerate there if the voucher encoding ever changes.
            const pySig =
                "0x39efd09875b7dac3d2f8d2223e25f55d92a89c6690de3191e21c0b3f7996bcbd438060288743115ff72f330b49234791a8b75299bfad7cb493491ea24a4e7ceb1c";
            const pySigner = new ethers.Wallet("0x" + "11".repeat(32));
            const pyDomain = {
                name: "0G Inference Serving",
                version: "1",
                chainId: 31337,
                verifyingContract: "0x0165878A594ca255338adfa4d48449f69242Eb8F",
            };
            const recovered = ethers.verifyTypedData(
                pyDomain,
                voucherTypes,
                { node: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", cumulative: 12345n, epoch: 7n },
                pySig
            );
            expect(recovered).to.equal(pySigner.address);
        });
    });

    describe("Arithmetic / boundary (5.10)", () => {
        beforeEach(async () => {
            await settleToPool(1000n);
        });

        it("N1: cumulative = uint256 max cannot overflow, only fail solvency", async () => {
            const max = ethers.MaxUint256;
            const sig = await signVoucher(assayWallet, nodeAAddress, max, 1n);
            await expect(
                serving.connect(nodeA).claim(provider1Address, nodeAAddress, max, 1n, sig)
            ).to.be.revertedWithCustomError(serving, "InsufficientAssayPool");
        });

        it("N3/INV6: interleaved nodes stay independent", async () => {
            const sigA1 = await signVoucher(assayWallet, nodeAAddress, 100n, 1n);
            const sigB1 = await signVoucher(assayWallet, nodeBAddress, 50n, 1n);
            const sigA2 = await signVoucher(assayWallet, nodeAAddress, 250n, 2n);
            await serving.connect(nodeA).claim(provider1Address, nodeAAddress, 100n, 1n, sigA1);
            await serving.connect(nodeB).claim(provider1Address, nodeBAddress, 50n, 1n, sigB1);
            await serving.connect(nodeA).claim(provider1Address, nodeAAddress, 250n, 2n, sigA2);
            expect(await serving.assayWithdrawnOf(provider1Address, nodeAAddress)).to.equal(250n);
            expect(await serving.assayWithdrawnOf(provider1Address, nodeBAddress)).to.equal(50n);
            const info = await serving.getAssayPayoutInfo(provider1Address);
            expect(info.deposited).to.equal(info.pool + info.totalPaid);
        });
    });
});
