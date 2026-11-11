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
    const GRACE = 7 * 24 * 60 * 60; // InferenceServing.SIGNER_GRACE
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
            { name: "provider", type: "address" },
            { name: "node", type: "address" },
            { name: "cumulative", type: "uint256" },
            { name: "epoch", type: "uint64" },
        ],
    };

    // A voucher is bound to the provider whose pool it draws on (provider1 unless said otherwise).
    async function signVoucher(
        wallet: ethers.Wallet,
        node: string,
        cumulative: bigint,
        epoch: bigint,
        provider: string = provider1Address
    ): Promise<string> {
        return wallet.signTypedData(await domain(), voucherTypes, { provider, node, cumulative, epoch });
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

        // Assay mode on for provider1; nodeA / nodeB are its listed payees
        await serving.connect(owner).setAssaySigner(provider1Address, assayWallet.address);
        await serving.connect(provider1).allowAssayNode(nodeAAddress);
        await serving.connect(provider1).allowAssayNode(nodeBAddress);
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
                provider: provider1Address,
                node: nodeAAddress,
                cumulative: 300n,
                epoch: 1n,
            });
            await expect(
                serving.connect(nodeA).claim(provider1Address, nodeAAddress, 300n, 1n, sig)
            ).to.be.revertedWithCustomError(serving, "InvalidVoucherSignature");
        });

        it("X4: a voucher for provider1 cannot be redeemed from another provider that shares the signer", async () => {
            // The attacker runs a second provider registered with the SAME assay signer and an
            // empty pool. Before the voucher bound the provider, provider1's voucher was a valid
            // claim against the attacker's pool too (and vice versa).
            await serving.connect(owner).setAssaySigner(attacker.address, assayWallet.address);
            const sig = await signVoucher(assayWallet, nodeAAddress, 300n, 1n); // bound to provider1
            await expect(
                serving.connect(nodeA).claim(attacker.address, nodeAAddress, 300n, 1n, sig)
            ).to.be.revertedWithCustomError(serving, "InvalidVoucherSignature");
            expect(await poolOf(provider1Address)).to.equal(1000n);

            // Bound to the attacker's provider (which lists nodeA) it is well-formed — and finds no pool behind it.
            await serving.connect(attacker).allowAssayNode(nodeAAddress);
            const sigB = await signVoucher(assayWallet, nodeAAddress, 300n, 1n, attacker.address);
            await expect(
                serving.connect(nodeA).claim(attacker.address, nodeAAddress, 300n, 1n, sigB)
            ).to.be.revertedWithCustomError(serving, "InsufficientAssayPool");
            expect(await serving.assayWithdrawnOf(provider1Address, nodeAAddress)).to.equal(0n);
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
            await serving.connect(provider1).allowAssayNode(revertingAddr);
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
            await serving.connect(provider1).allowAssayNode(claimerAddr);
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
            await serving.connect(provider1).allowAssayNode(heavyAddr);
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

        it("A3: assaySigner = address(0) is rejected", async () => {
            await expect(
                serving.connect(owner).setAssaySigner(provider1Address, ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(serving, "InvalidAddress");
        });

        it("A4: only the owner sets or clears a signer: the provider key cannot rotate to its own key or leave assay mode", async () => {
            for (const who of [provider1, attacker]) {
                await expect(
                    serving.connect(who).setAssaySigner(provider1Address, rogueWallet.address)
                ).to.be.revertedWith("Ownable: caller is not the owner");
                await expect(serving.connect(who).clearAssaySigner(provider1Address)).to.be.revertedWith(
                    "Ownable: caller is not the owner"
                );
            }
            expect((await serving.getAssayPayoutInfo(provider1Address)).signer).to.equal(assayWallet.address);

            await serving.connect(owner).setAssaySigner(provider1Address, rogueWallet.address);
            expect((await serving.getAssayPayoutInfo(provider1Address)).signer).to.equal(rogueWallet.address);
        });

        it("A2: an in-flight voucher from the old key claims within the grace window, dies after", async () => {
            const oldSig = await signVoucher(assayWallet, nodeAAddress, 300n, 1n);
            const newSigner = new ethers.Wallet(ethers.Wallet.createRandom().privateKey);
            await serving.connect(owner).setAssaySigner(provider1Address, newSigner.address);

            // within the grace window the old voucher still pays
            await expect(
                serving.connect(nodeA).claim(provider1Address, nodeAAddress, 300n, 1n, oldSig)
            ).to.changeEtherBalance(nodeA, 300n);

            // after the deadline an old-key voucher is dead
            const oldSig2 = await signVoucher(assayWallet, nodeAAddress, 400n, 2n);
            await time.increase(GRACE + 1);
            await expect(
                serving.connect(nodeA).claim(provider1Address, nodeAAddress, 400n, 2n, oldSig2)
            ).to.be.revertedWithCustomError(serving, "InvalidVoucherSignature");

            // the new key works
            const newSig = await newSigner.signTypedData(await domain(), voucherTypes, {
                provider: provider1Address,
                node: nodeAAddress,
                cumulative: 400n,
                epoch: 2n,
            });
            await expect(
                serving.connect(nodeA).claim(provider1Address, nodeAAddress, 400n, 2n, newSig)
            ).to.changeEtherBalance(nodeA, 100n);
        });

        it("A2b: the grace is fixed: a rotation cannot kill the old signer's vouchers early", async () => {
            const oldSig = await signVoucher(assayWallet, nodeAAddress, 300n, 1n);
            await serving.connect(owner).setAssaySigner(provider1Address, rogueWallet.address);
            const info = await serving.getAssayPayoutInfo(provider1Address);
            expect(info.prevSignerDeadline).to.equal(BigInt(await time.latest()) + BigInt(GRACE));

            await time.increase(GRACE - 60);
            await expect(
                serving.connect(nodeA).claim(provider1Address, nodeAAddress, 300n, 1n, oldSig)
            ).to.changeEtherBalance(nodeA, 300n);
        });

        it("A2c: re-setting the current signer during the grace neither restarts nor cuts it", async () => {
            const oldSig = await signVoucher(assayWallet, nodeAAddress, 300n, 1n);
            const newSigner = new ethers.Wallet(ethers.Wallet.createRandom().privateKey);
            await serving.connect(owner).setAssaySigner(provider1Address, newSigner.address);
            const deadline = (await serving.getAssayPayoutInfo(provider1Address)).prevSignerDeadline;
            await time.increase(3600);
            // same signer again (an operator re-running its deploy step)
            await serving.connect(owner).setAssaySigner(provider1Address, newSigner.address);
            const info = await serving.getAssayPayoutInfo(provider1Address);
            expect(info.prevSigner).to.equal(assayWallet.address);
            expect(info.prevSignerDeadline).to.equal(deadline);
            await expect(
                serving.connect(nodeA).claim(provider1Address, nodeAAddress, 300n, 1n, oldSig)
            ).to.changeEtherBalance(nodeA, 300n);
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

    describe("Verifier cut cap across rotation", () => {
        beforeEach(async () => {
            await settleToPool(1000n);
            await serving.connect(owner).setAssayVerifierCutCap(1000); // 10% of 1000 deposited = 100
        });

        it("the cap is per provider, not per signer address: rotating the signer does not refill it", async () => {
            const sig1 = await signVoucher(assayWallet, assayWallet.address, 60n, 1n);
            await serving.connect(attacker).claim(provider1Address, assayWallet.address, 60n, 1n, sig1);
            expect(await serving.assayVerifierPaidOf(provider1Address)).to.equal(60n);

            const newSigner = new ethers.Wallet(ethers.Wallet.createRandom().privateKey);
            await serving.connect(owner).setAssaySigner(provider1Address, newSigner.address);

            // The new signer paying itself starts from the 60 already taken: 60 more breaks the cap…
            const tooMuch = await newSigner.signTypedData(await domain(), voucherTypes, {
                provider: provider1Address,
                node: newSigner.address,
                cumulative: 60n,
                epoch: 2n,
            });
            await expect(
                serving.connect(attacker).claim(provider1Address, newSigner.address, 60n, 2n, tooMuch)
            )
                .to.be.revertedWithCustomError(serving, "VerifierCutExceedsCap")
                .withArgs(120n, 100n);

            // …40 fits exactly.
            const ok = await newSigner.signTypedData(await domain(), voucherTypes, {
                provider: provider1Address,
                node: newSigner.address,
                cumulative: 40n,
                epoch: 2n,
            });
            await expect(
                serving.connect(attacker).claim(provider1Address, newSigner.address, 40n, 2n, ok)
            ).to.changeEtherBalance(newSigner.address, 40n);
            expect(await serving.assayVerifierPaidOf(provider1Address)).to.equal(100n);

            // totalPaid is derived (deposited - pool) and conservation still holds.
            const info = await serving.getAssayPayoutInfo(provider1Address);
            expect(info.totalPaid).to.equal(100n);
            expect(info.deposited).to.equal(info.pool + info.totalPaid);
        });
    });

    describe("Node allowlist", () => {
        beforeEach(async () => {
            await settleToPool(1000n);
        });

        it("L1: a valid voucher for an address the provider never listed reverts; listing it pays", async () => {
            const stray = await attacker.getAddress();
            const sig = await signVoucher(assayWallet, stray, 300n, 1n);
            await expect(serving.connect(attacker).claim(provider1Address, stray, 300n, 1n, sig))
                .to.be.revertedWithCustomError(serving, "AssayNodeNotAllowed")
                .withArgs(provider1Address, stray);
            expect(await serving.isAssayNode(provider1Address, stray)).to.be.false;

            await expect(serving.connect(provider1).allowAssayNode(stray))
                .to.emit(serving, "AssayNodeAllowed")
                .withArgs(provider1Address, stray);
            await expect(
                serving.connect(attacker).claim(provider1Address, stray, 300n, 1n, sig)
            ).to.changeEtherBalance(attacker, 300n);
        });

        it("L2: a listing is permanent: the provider has no call that voids a listed node's vouchers", async () => {
            const names = serving.interface.fragments.filter((f) => f.type === "function").map((f) => f.format());
            expect(names).to.include("allowAssayNode(address)");
            expect(names.filter((n) => n.startsWith("setAssayNode"))).to.be.empty;
            // listing again changes nothing
            await serving.connect(provider1).allowAssayNode(nodeAAddress);
            const sig = await signVoucher(assayWallet, nodeAAddress, 300n, 1n);
            await expect(
                serving.connect(nodeA).claim(provider1Address, nodeAAddress, 300n, 1n, sig)
            ).to.changeEtherBalance(nodeA, 300n);
        });

        it("L3: a list entry is per provider: another account listing an address does not open provider1's pool", async () => {
            const stray = await attacker.getAddress();
            await serving.connect(attacker).allowAssayNode(stray);
            const sig = await signVoucher(assayWallet, stray, 300n, 1n);
            await expect(
                serving.connect(attacker).claim(provider1Address, stray, 300n, 1n, sig)
            ).to.be.revertedWithCustomError(serving, "AssayNodeNotAllowed");
        });

        it("L4: the signer's own address needs no listing but stays under the cut cap", async () => {
            await serving.connect(owner).setAssayVerifierCutCap(1000); // 10% of 1000
            const sig = await signVoucher(assayWallet, assayWallet.address, 100n, 1n);
            await expect(
                serving.connect(attacker).claim(provider1Address, assayWallet.address, 100n, 1n, sig)
            ).to.changeEtherBalance(assayWallet.address, 100n);
            const more = await signVoucher(assayWallet, assayWallet.address, 101n, 2n);
            await expect(
                serving.connect(attacker).claim(provider1Address, assayWallet.address, 101n, 2n, more)
            ).to.be.revertedWithCustomError(serving, "VerifierCutExceedsCap");
        });

        it("L5: node == address(0) cannot be listed", async () => {
            await expect(
                serving.connect(provider1).allowAssayNode(ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(serving, "InvalidAddress");
        });
    });

    describe("Leaving assay mode", () => {
        beforeEach(async () => {
            await settleToPool(1000n);
        });

        const ownerWithdraw = () => serving.connect(owner).withdrawAssayPool(provider1Address);

        it("E1: clear: in-flight vouchers still pay, settlements go to the wallet, the owner returns the rest after the grace", async () => {
            const inFlight = await signVoucher(assayWallet, nodeAAddress, 300n, 1n);
            await expect(serving.connect(owner).clearAssaySigner(provider1Address))
                .to.emit(serving, "AssaySignerUpdated")
                .withArgs(provider1Address, assayWallet.address, ethers.ZeroAddress, (d: bigint) => d > 0n);
            let info = await serving.getAssayPayoutInfo(provider1Address);
            expect(info.signer).to.equal(ethers.ZeroAddress);
            expect(info.prevSigner).to.equal(assayWallet.address);
            expect(info.prevSignerDeadline).to.equal(BigInt(await time.latest()) + BigInt(GRACE));

            // a settlement after the clear pays the wallet, not the pool
            const settlement = await makeSettlement(ownerAddress, 200n);
            await expect(serving.connect(provider1).settleFeesWithTEE([settlement])).to.changeEtherBalance(
                provider1,
                200n
            );
            expect(await poolOf(provider1Address)).to.equal(1000n);

            // the old signer's voucher still clears inside the grace
            await expect(
                serving.connect(nodeA).claim(provider1Address, nodeAAddress, 300n, 1n, inFlight)
            ).to.changeEtherBalance(nodeA, 300n);
            // the pool is locked while the grace runs
            await expect(ownerWithdraw()).to.be.revertedWithCustomError(serving, "AssayPoolLocked");

            await time.increase(GRACE + 1);
            const late = await signVoucher(assayWallet, nodeAAddress, 400n, 2n);
            await expect(
                serving.connect(nodeA).claim(provider1Address, nodeAAddress, 400n, 2n, late)
            ).to.be.revertedWithCustomError(serving, "AssaySignerNotSet");
            await expect(ownerWithdraw()).to.emit(serving, "AssayPoolWithdrawn").withArgs(provider1Address, 700n);
            info = await serving.getAssayPayoutInfo(provider1Address);
            expect(info.pool).to.equal(0n);
            expect(info.deposited).to.equal(300n); // the 700 withdrawn no longer counts as deposited
            expect(info.totalPaid).to.equal(300n); // = what nodes claimed, withdrawals excluded
            await expect(ownerWithdraw()).to.be.revertedWithCustomError(serving, "AssayPoolEmpty");
        });

        it("E2: the provider cannot drain the pool: no withdrawal of its own, none by the owner inside the grace", async () => {
            const inFlight = await signVoucher(assayWallet, nodeAAddress, 300n, 1n);
            await serving.connect(owner).clearAssaySigner(provider1Address);
            await expect(serving.connect(provider1).withdrawAssayPool(provider1Address)).to.be.revertedWith(
                "Ownable: caller is not the owner"
            );
            await expect(ownerWithdraw()).to.be.revertedWithCustomError(serving, "AssayPoolLocked");
            // the node's voucher is still good near the end of the grace
            await time.increase(GRACE - 60);
            await expect(
                serving.connect(nodeA).claim(provider1Address, nodeAAddress, 300n, 1n, inFlight)
            ).to.changeEtherBalance(nodeA, 300n);

            // after it, the owner's call pays the provider
            await time.increase(120);
            await expect(ownerWithdraw()).to.changeEtherBalance(provider1, 700n);
        });

        it("E3: opting back in resumes pooling; the cut history survives, less the share forgiven by the withdrawal", async () => {
            await serving.connect(owner).setAssayVerifierCutCap(1000);
            const cut = await signVoucher(assayWallet, assayWallet.address, 60n, 1n);
            await serving.connect(attacker).claim(provider1Address, assayWallet.address, 60n, 1n, cut);
            await serving.connect(owner).clearAssaySigner(provider1Address);
            await time.increase(GRACE + 1);
            await ownerWithdraw();

            await serving.connect(owner).setAssaySigner(provider1Address, assayWallet.address);
            await settleToPool(1000n);
            expect(await poolOf(provider1Address)).to.equal(1000n);
            // withdraw of 940: deposited 60, cap 6, verifierPaid clamped 60 → 6; then +1000 deposited → cap 106:
            // 100 more cut fits (cumulative 160), 101 does not
            expect(await serving.assayVerifierPaidOf(provider1Address)).to.equal(6n);
            const tooMuch = await signVoucher(assayWallet, assayWallet.address, 161n, 2n);
            await expect(
                serving.connect(attacker).claim(provider1Address, assayWallet.address, 161n, 2n, tooMuch)
            ).to.be.revertedWithCustomError(serving, "VerifierCutExceedsCap");
            const ok = await signVoucher(assayWallet, assayWallet.address, 160n, 2n);
            await expect(
                serving.connect(attacker).claim(provider1Address, assayWallet.address, 160n, 2n, ok)
            ).to.changeEtherBalance(assayWallet.address, 100n);
            expect(await serving.assayVerifierPaidOf(provider1Address)).to.equal(106n);
        });

        it("E7: a withdrawal forgives the cut already taken against the withdrawn money, so the verifier's next cumulative cut clears", async () => {
            await serving.connect(owner).setAssayVerifierCutCap(1000); // 10%
            const cut1 = await signVoucher(assayWallet, assayWallet.address, 100n, 1n);
            await serving.connect(attacker).claim(provider1Address, assayWallet.address, 100n, 1n, cut1);
            const nodeSig = await signVoucher(assayWallet, nodeAAddress, 500n, 1n);
            await serving.connect(nodeA).claim(provider1Address, nodeAAddress, 500n, 1n, nodeSig);
            await serving.connect(owner).clearAssaySigner(provider1Address);
            await time.increase(GRACE + 1);
            await ownerWithdraw(); // 400 back; deposited 600, cap 60
            expect(await serving.assayVerifierPaidOf(provider1Address)).to.equal(60n);

            await serving.connect(owner).setAssaySigner(provider1Address, assayWallet.address);
            await settleToPool(1000n); // deposited 1600, cap 160: 100 more cut fits
            const cut2 = await signVoucher(assayWallet, assayWallet.address, 200n, 2n);
            await expect(
                serving.connect(attacker).claim(provider1Address, assayWallet.address, 200n, 2n, cut2)
            ).to.changeEtherBalance(assayWallet.address, 100n);
            expect(await serving.assayVerifierPaidOf(provider1Address)).to.equal(160n);
            const cut3 = await signVoucher(assayWallet, assayWallet.address, 201n, 3n);
            await expect(
                serving.connect(attacker).claim(provider1Address, assayWallet.address, 201n, 3n, cut3)
            ).to.be.revertedWithCustomError(serving, "VerifierCutExceedsCap");
        });

        it("E4: guards — clear without a signer, withdraw while in assay mode, withdraw by a non-owner", async () => {
            await expect(ownerWithdraw()).to.be.revertedWithCustomError(serving, "AssayPoolLocked");
            await expect(serving.connect(attacker).withdrawAssayPool(provider1Address)).to.be.revertedWith(
                "Ownable: caller is not the owner"
            );
            await expect(serving.connect(owner).clearAssaySigner(attacker.address)).to.be.revertedWithCustomError(
                serving,
                "AssaySignerNotSet"
            );
        });

        it("E5: re-registering a signer while the clear grace runs keeps that grace; the pool relocks", async () => {
            const inFlight = await signVoucher(assayWallet, nodeAAddress, 300n, 1n);
            await serving.connect(owner).clearAssaySigner(provider1Address);
            const deadline = (await serving.getAssayPayoutInfo(provider1Address)).prevSignerDeadline;
            const newSigner = new ethers.Wallet(ethers.Wallet.createRandom().privateKey);
            await time.increase(3600);
            await serving.connect(owner).setAssaySigner(provider1Address, newSigner.address);
            const info = await serving.getAssayPayoutInfo(provider1Address);
            expect(info.prevSigner).to.equal(assayWallet.address);
            expect(info.prevSignerDeadline).to.equal(deadline);
            await expect(
                serving.connect(nodeA).claim(provider1Address, nodeAAddress, 300n, 1n, inFlight)
            ).to.changeEtherBalance(nodeA, 300n);
            await time.increase(GRACE);
            // still in assay mode: the pool stays locked past the old deadline
            await expect(ownerWithdraw()).to.be.revertedWithCustomError(serving, "AssayPoolLocked");
            const late = await signVoucher(assayWallet, nodeAAddress, 400n, 2n);
            await expect(
                serving.connect(nodeA).claim(provider1Address, nodeAAddress, 400n, 2n, late)
            ).to.be.revertedWithCustomError(serving, "InvalidVoucherSignature");
        });

        it("E6: withdrawn money does not back the cut cap: after exit + re-entry the cut is a share of new deposits only", async () => {
            await serving.connect(owner).setAssayVerifierCutCap(1000); // 10%
            await serving.connect(owner).clearAssaySigner(provider1Address);
            await time.increase(GRACE + 1);
            await ownerWithdraw(); // 1000 back; deposited → 0
            await serving.connect(owner).setAssaySigner(provider1Address, assayWallet.address);
            await settleToPool(100n);
            // cap = 10% of 100, not of 1100: a self-voucher for the whole new pool reverts
            const grab = await signVoucher(assayWallet, assayWallet.address, 100n, 1n);
            await expect(
                serving.connect(attacker).claim(provider1Address, assayWallet.address, 100n, 1n, grab)
            )
                .to.be.revertedWithCustomError(serving, "VerifierCutExceedsCap")
                .withArgs(100n, 10n);
            const cut = await signVoucher(assayWallet, assayWallet.address, 10n, 1n);
            await expect(
                serving.connect(attacker).claim(provider1Address, assayWallet.address, 10n, 1n, cut)
            ).to.changeEtherBalance(assayWallet.address, 10n);
        });
    });

    describe("Cross-language parity (testplan §7)", () => {
        it("a voucher signed by the Python assay (eth_account) recovers to the same signer", () => {
            // Vector produced by pipeline/tests/test_payout.py::test_parity_vector_stable —
            // regenerate there if the voucher encoding ever changes.
            const pySig =
                "0x41e397985f94dc5e736e647aeee47e62d4b1b671e0464e5e109b2094c27e95c3410d6dd3f27af754479b772575f3c8146efe425afa7cf81ae1658abb651487f01b";
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
                {
                    provider: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
                    node: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
                    cumulative: 12345n,
                    epoch: 7n,
                },
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
