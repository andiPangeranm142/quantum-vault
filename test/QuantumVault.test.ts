import { expect } from "chai";
import { ethers, artifacts } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { QuantumVault, MockPqcKeyStatus, MockPqcVerify } from "../typechain-types";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const KEY_STATUS_PRECOMPILE = "0x0000000000000000000000000000000000000A02";
const VERIFY_PRECOMPILE = "0x0000000000000000000000000000000000000A01";

// The mocks do not validate key/signature lengths (they stand in for the
// precompiles' interfaces, not their cryptography), so short dummy values
// keep the tests fast. Distinct pubkeys per user prove the contract passes
// the REGISTERED pubkey to pqcVerify.
const ALICE_PUBKEY = "0x" + "aa".repeat(32);
const BOB_PUBKEY = "0x" + "bb".repeat(32);
const DUMMY_SIGNATURE = "0x" + "cc".repeat(64);

const DAY = 24 * 60 * 60;

/**
 * Rules under test:
 *  - Deposits lock QOR until a chosen unlock time (future, at most 2 years).
 *  - Withdrawals require the unlock time to have passed AND a registered
 *    ML-DSA key with proven possession (pqcKeyStatus precompile, 0x0A02).
 *  - withdrawWithProof additionally requires an ML-DSA signature over the
 *    exact withdrawal digest, verified via the pqcVerify precompile (0x0A01)
 *    against the REGISTERED pubkey.
 *  - Locally, both precompiles are mocks installed at their real addresses
 *    via hardhat_setCode; the real cryptography is verified live on Diana.
 */
async function installMock(
  name: "MockPqcKeyStatus" | "MockPqcVerify",
  address: string,
): Promise<MockPqcKeyStatus | MockPqcVerify> {
  const artifact = await artifacts.readArtifact(name);
  await ethers.provider.send("hardhat_setCode", [address, artifact.deployedBytecode]);
  return (await ethers.getContractAt(name, address)) as unknown as
    | MockPqcKeyStatus
    | MockPqcVerify;
}

describe("QuantumVault", function () {
  let vault: QuantumVault;
  let keyStatus: MockPqcKeyStatus;
  let verify: MockPqcVerify;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let carol: HardhatEthersSigner; // never registers a key
  let dave: HardhatEthersSigner; // registers a key but never proves possession

  beforeEach(async function () {
    [, alice, bob, carol, dave] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("QuantumVault");
    vault = await factory.deploy();
    await vault.waitForDeployment();

    keyStatus = (await installMock(
      "MockPqcKeyStatus",
      KEY_STATUS_PRECOMPILE,
    )) as MockPqcKeyStatus;
    verify = (await installMock("MockPqcVerify", VERIFY_PRECOMPILE)) as MockPqcVerify;

    await keyStatus.setKey(alice.address, ALICE_PUBKEY, true);
    await keyStatus.setKey(bob.address, BOB_PUBKEY, true);
    await keyStatus.setKey(dave.address, "0x" + "dd".repeat(32), false);
    await keyStatus.clearKey(carol.address);
  });

  async function deposit(
    user: HardhatEthersSigner,
    amount: bigint,
    lockSeconds: number,
  ): Promise<number> {
    const unlockTime = (await time.latest()) + lockSeconds;
    const tx = await vault.connect(user).deposit(unlockTime, { value: amount });
    const receipt = await tx.wait();
    const lockId = Number(
      (receipt?.logs ?? [])
        .map((log) => {
          try {
            return vault.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((parsed) => parsed?.name === "Deposited")?.args?.[1] ?? 0,
    );
    return lockId;
  }

  describe("deployment", function () {
    it("starts with zero totals", async function () {
      expect(await vault.totalLocked()).to.equal(0);
      expect(await vault.totalDeposited()).to.equal(0);
      expect(await vault.totalWithdrawn()).to.equal(0);
      expect(await vault.lockCount()).to.equal(0);
    });

    it("exposes the documented constants", async function () {
      expect(await vault.MIN_DEPOSIT()).to.equal(ethers.parseEther("0.001"));
      expect(await vault.MAX_LOCK_DURATION()).to.equal(730n * 24n * 60n * 60n);
    });
  });

  describe("deposit", function () {
    it("creates a lock with sequential ids and updates totals", async function () {
      const unlockTime = (await time.latest()) + DAY;
      await expect(vault.connect(alice).deposit(unlockTime, { value: ethers.parseEther("1") }))
        .to.emit(vault, "Deposited")
        .withArgs(alice.address, 0, ethers.parseEther("1"), unlockTime);
      const unlock2 = (await time.latest()) + 2 * DAY;
      await vault.connect(alice).deposit(unlock2, { value: ethers.parseEther("0.5") });

      expect(await vault.lockCountOf(alice.address)).to.equal(2);
      const lock0 = await vault.getLock(alice.address, 0);
      expect(lock0.amount).to.equal(ethers.parseEther("1"));
      expect(lock0.unlockTime).to.equal(unlockTime);
      expect(lock0.withdrawn).to.equal(false);
      const lock1 = await vault.getLock(alice.address, 1);
      expect(lock1.amount).to.equal(ethers.parseEther("0.5"));
      expect(await vault.totalLocked()).to.equal(ethers.parseEther("1.5"));
      expect(await vault.totalDeposited()).to.equal(ethers.parseEther("1.5"));
      expect(await vault.lockCount()).to.equal(2);
    });

    it("rejects a zero deposit", async function () {
      const unlockTime = (await time.latest()) + DAY;
      await expect(
        vault.connect(alice).deposit(unlockTime, { value: 0 }),
      ).to.be.revertedWithCustomError(vault, "ZeroDeposit");
    });

    it("rejects a deposit below the minimum", async function () {
      const unlockTime = (await time.latest()) + DAY;
      await expect(
        vault.connect(alice).deposit(unlockTime, { value: ethers.parseEther("0.0005") }),
      )
        .to.be.revertedWithCustomError(vault, "DepositTooSmall")
        .withArgs(ethers.parseEther("0.0005"), ethers.parseEther("0.001"));
    });

    it("rejects an unlock time in the past", async function () {
      const past = (await time.latest()) - 1;
      await expect(
        vault.connect(alice).deposit(past, { value: ethers.parseEther("1") }),
      ).to.be.revertedWithCustomError(vault, "UnlockTimeInPast");
    });

    it("rejects a lock longer than the maximum", async function () {
      const tooFar = (await time.latest()) + 731 * DAY;
      await expect(
        vault.connect(alice).deposit(tooFar, { value: ethers.parseEther("1") }),
      ).to.be.revertedWithCustomError(vault, "LockTooLong");
    });

    it("keeps each user's locks independent", async function () {
      const unlockTime = (await time.latest()) + DAY;
      await vault.connect(alice).deposit(unlockTime, { value: ethers.parseEther("1") });
      await vault.connect(bob).deposit(unlockTime, { value: ethers.parseEther("2") });
      expect(await vault.lockCountOf(alice.address)).to.equal(1);
      expect(await vault.lockCountOf(bob.address)).to.equal(1);
      expect((await vault.getLock(bob.address, 0)).amount).to.equal(ethers.parseEther("2"));
    });
  });

  describe("withdraw", function () {
    it("refuses a withdrawal before the unlock time", async function () {
      await deposit(alice, ethers.parseEther("1"), DAY);
      await expect(vault.connect(alice).withdraw(0)).to.be.revertedWithCustomError(
        vault,
        "StillLocked",
      );
    });

    it("refuses a withdrawal with no registered PQC key", async function () {
      await deposit(carol, ethers.parseEther("1"), 60);
      await time.increase(61);
      await expect(vault.connect(carol).withdraw(0))
        .to.be.revertedWithCustomError(vault, "PqcKeyNotRegistered")
        .withArgs(carol.address);
    });

    it("refuses a withdrawal when possession was never proven", async function () {
      await deposit(dave, ethers.parseEther("1"), 60);
      await time.increase(61);
      await expect(vault.connect(dave).withdraw(0))
        .to.be.revertedWithCustomError(vault, "PossessionNotProven")
        .withArgs(dave.address);
    });

    it("returns the funds after unlock and updates totals", async function () {
      await deposit(alice, ethers.parseEther("1"), 60);
      await time.increase(61);
      await expect(vault.connect(alice).withdraw(0))
        .to.emit(vault, "Withdrawn")
        .withArgs(alice.address, 0, ethers.parseEther("1"), false);
      expect((await vault.getLock(alice.address, 0)).withdrawn).to.equal(true);
      expect(await vault.totalLocked()).to.equal(0);
      expect(await vault.totalWithdrawn()).to.equal(ethers.parseEther("1"));
      expect(await ethers.provider.getBalance(await vault.getAddress())).to.equal(0);
    });

    it("changes the withdrawer's balance by the lock amount", async function () {
      await deposit(alice, ethers.parseEther("0.25"), 60);
      await time.increase(61);
      await expect(vault.connect(alice).withdraw(0)).to.changeEtherBalance(
        alice,
        ethers.parseEther("0.25"),
      );
    });

    it("refuses a second withdrawal of the same lock", async function () {
      await deposit(alice, ethers.parseEther("1"), 60);
      await time.increase(61);
      await vault.connect(alice).withdraw(0);
      await expect(vault.connect(alice).withdraw(0))
        .to.be.revertedWithCustomError(vault, "AlreadyWithdrawn")
        .withArgs(alice.address, 0);
    });

    it("refuses an unknown lock id", async function () {
      await expect(vault.connect(alice).withdraw(0))
        .to.be.revertedWithCustomError(vault, "LockNotFound")
        .withArgs(alice.address, 0);
    });

    it("cannot withdraw another user's lock (per-owner lock ids)", async function () {
      await deposit(bob, ethers.parseEther("2"), 60);
      await deposit(alice, ethers.parseEther("1"), 60);
      await time.increase(61);
      // Alice's lock 0 is hers; withdrawing it leaves Bob's lock 0 untouched.
      await vault.connect(alice).withdraw(0);
      expect((await vault.getLock(bob.address, 0)).withdrawn).to.equal(false);
      expect(await vault.totalLocked()).to.equal(ethers.parseEther("2"));
    });
  });

  describe("withdrawWithProof", function () {
    it("builds the documented digest", async function () {
      const amount = ethers.parseEther("1");
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const expected = ethers.solidityPackedKeccak256(
        ["string", "uint256", "address", "address", "uint256", "uint256"],
        ["QuantumVault.withdraw", chainId, await vault.getAddress(), alice.address, 0, amount],
      );
      expect(await vault.withdrawalDigest(alice.address, 0, amount)).to.equal(expected);
    });

    it("refuses a proof that was never allowed", async function () {
      await deposit(alice, ethers.parseEther("1"), 60);
      await time.increase(61);
      await expect(vault.connect(alice).withdrawWithProof(0, DUMMY_SIGNATURE))
        .to.be.revertedWithCustomError(vault, "InvalidProof");
    });

    it("succeeds with a proof allowed for the registered key and digest", async function () {
      const amount = ethers.parseEther("1");
      await deposit(alice, amount, 60);
      const digest = await vault.withdrawalDigest(alice.address, 0, amount);
      await verify.allow(ALICE_PUBKEY, digest, DUMMY_SIGNATURE);
      await time.increase(61);
      await expect(vault.connect(alice).withdrawWithProof(0, DUMMY_SIGNATURE))
        .to.emit(vault, "Withdrawn")
        .withArgs(alice.address, 0, amount, true);
      expect(await vault.totalWithdrawn()).to.equal(amount);
    });

    it("refuses a proof allowed under a different pubkey", async function () {
      // The proof is allowed for BOB's key, but Alice's registered key is
      // what the contract passes to pqcVerify — so it must fail.
      const amount = ethers.parseEther("1");
      await deposit(alice, amount, 60);
      const digest = await vault.withdrawalDigest(alice.address, 0, amount);
      await verify.allow(BOB_PUBKEY, digest, DUMMY_SIGNATURE);
      await time.increase(61);
      await expect(
        vault.connect(alice).withdrawWithProof(0, DUMMY_SIGNATURE),
      ).to.be.revertedWithCustomError(vault, "InvalidProof");
    });

    it("refuses a proof allowed for a different digest", async function () {
      const amount = ethers.parseEther("1");
      await deposit(alice, amount, 60);
      const otherDigest = ethers.solidityPackedKeccak256(["string"], ["something else"]);
      await verify.allow(ALICE_PUBKEY, otherDigest, DUMMY_SIGNATURE);
      await time.increase(61);
      await expect(
        vault.connect(alice).withdrawWithProof(0, DUMMY_SIGNATURE),
      ).to.be.revertedWithCustomError(vault, "InvalidProof");
    });

    it("still enforces the timelock and the key gate with a valid proof", async function () {
      const amount = ethers.parseEther("1");
      await deposit(alice, amount, DAY);
      const digest = await vault.withdrawalDigest(alice.address, 0, amount);
      await verify.allow(ALICE_PUBKEY, digest, DUMMY_SIGNATURE);
      await expect(
        vault.connect(alice).withdrawWithProof(0, DUMMY_SIGNATURE),
      ).to.be.revertedWithCustomError(vault, "StillLocked");

      await deposit(carol, amount, 60);
      const carolDigest = await vault.withdrawalDigest(carol.address, 0, amount);
      await verify.allow("0x" + "ee".repeat(32), carolDigest, DUMMY_SIGNATURE);
      await time.increase(61);
      await expect(
        vault.connect(carol).withdrawWithProof(0, DUMMY_SIGNATURE),
      ).to.be.revertedWithCustomError(vault, "PqcKeyNotRegistered");
    });

    it("refuses a second proof withdrawal of the same lock", async function () {
      const amount = ethers.parseEther("1");
      await deposit(alice, amount, 60);
      const digest = await vault.withdrawalDigest(alice.address, 0, amount);
      await verify.allow(ALICE_PUBKEY, digest, DUMMY_SIGNATURE);
      await time.increase(61);
      await vault.connect(alice).withdrawWithProof(0, DUMMY_SIGNATURE);
      await expect(
        vault.connect(alice).withdrawWithProof(0, DUMMY_SIGNATURE),
      ).to.be.revertedWithCustomError(vault, "AlreadyWithdrawn");
    });
  });

  describe("views", function () {
    it("hasPqcKey reflects the precompile registry", async function () {
      const [aliceReg, aliceProv] = await vault.hasPqcKey(alice.address);
      expect(aliceReg).to.equal(true);
      expect(aliceProv).to.equal(true);
      const [carolReg, carolProv] = await vault.hasPqcKey(carol.address);
      expect(carolReg).to.equal(false);
      expect(carolProv).to.equal(false);
      const [daveReg, daveProv] = await vault.hasPqcKey(dave.address);
      expect(daveReg).to.equal(true);
      expect(daveProv).to.equal(false);
    });

    it("getLock refuses an unknown lock id", async function () {
      await expect(vault.getLock(alice.address, 0))
        .to.be.revertedWithCustomError(vault, "LockNotFound")
        .withArgs(alice.address, 0);
    });
  });
});
