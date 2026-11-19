// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "./VaultTestBase.sol";

/// @title ReentrantActor — a malicious receiver for the reentrancy test.
/// @notice On receiving ETH from a withdrawal it immediately tries to
///         withdraw the same lock again. The vault marks the lock withdrawn
///         before the external call (checks-effects-interactions), so the
///         reentrant call must revert and each lock pays at most once.
///         Relates to QCAI stage 1 finding 2 (MEDIUM, "not exploitable").
contract ReentrantActor {
    QuantumVault public immutable vault;
    uint256 public targetLock;
    bool public receiveCalled;
    bool public reentrySucceeded;

    constructor(QuantumVault _vault) {
        vault = _vault;
    }

    receive() external payable {
        receiveCalled = true;
        try vault.withdraw(targetLock) {
            reentrySucceeded = true;
        } catch {
            // Expected: the lock is already marked withdrawn.
        }
    }

    function depositSelf(
        uint256 unlockTime,
        uint256 amount
    ) external returns (uint256) {
        return vault.deposit{value: amount}(unlockTime);
    }

    function withdrawSelf(uint256 lockId) external {
        targetLock = lockId;
        vault.withdraw(lockId);
    }
}

/// @title QuantumVaultFuzzTest — property (fuzz) tests.
/// @notice Direct fuzz proofs of the vault's core properties for arbitrary
///         amounts, lock durations and elapsed times, plus a reentrancy
///         test. The user is a single EOA with a registered ML-DSA key
///         (mocked precompile); multi-actor sequences live in the invariant
///         suite (QuantumVaultInvariant.t.sol).
contract QuantumVaultFuzzTest is VaultTestBase {
    address internal user;
    bytes internal userPubkey;
    bytes internal dummySignature;

    function setUp() public {
        _deployVaultAndMocks();
        user = makeAddr("user");
        vm.deal(user, 1_000_000 ether);
        userPubkey = _repeatByte(bytes1(0xaa), 32);
        dummySignature = _repeatByte(bytes1(0xcc), 64);
        keyStatus.setKey(user, userPubkey, true);
    }

    /// @notice (b) No early withdrawal: for any amount, lock duration and
    ///         elapsed time short of the unlock time, withdraw reverts
    ///         with StillLocked.
    function testFuzz_WithdrawBeforeUnlockAlwaysReverts(
        uint256 amount,
        uint256 lockDuration,
        uint256 elapsed
    ) public {
        amount = bound(amount, vault.MIN_DEPOSIT(), 100 ether);
        lockDuration = bound(lockDuration, 1, vault.MAX_LOCK_DURATION());
        elapsed = bound(elapsed, 0, lockDuration - 1);

        uint256 unlockTime = block.timestamp + lockDuration;
        vm.prank(user);
        uint256 lockId = vault.deposit{value: amount}(unlockTime);
        vm.warp(block.timestamp + elapsed);

        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(
                QuantumVault.StillLocked.selector,
                unlockTime,
                block.timestamp
            )
        );
        vault.withdraw(lockId);
    }

    /// @notice (b) Proof withdrawals respect the timelock too, even with a
    ///         valid proof already allowed in the mock.
    function testFuzz_ProofWithdrawBeforeUnlockAlwaysReverts(
        uint256 amount,
        uint256 lockDuration,
        uint256 elapsed
    ) public {
        amount = bound(amount, vault.MIN_DEPOSIT(), 100 ether);
        lockDuration = bound(lockDuration, 1, vault.MAX_LOCK_DURATION());
        elapsed = bound(elapsed, 0, lockDuration - 1);

        uint256 unlockTime = block.timestamp + lockDuration;
        vm.prank(user);
        uint256 lockId = vault.deposit{value: amount}(unlockTime);
        bytes32 digest = vault.withdrawalDigest(user, lockId, amount);
        verify.allow(userPubkey, abi.encodePacked(digest), dummySignature);
        vm.warp(block.timestamp + elapsed);

        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(
                QuantumVault.StillLocked.selector,
                unlockTime,
                block.timestamp
            )
        );
        vault.withdrawWithProof(lockId, dummySignature);
    }

    /// @notice Complement of (b): once the unlock time is reached, the same
    ///         withdrawal succeeds and pays exactly the lock amount.
    function testFuzz_WithdrawAfterUnlockSucceeds(
        uint256 amount,
        uint256 lockDuration,
        uint256 extraWait
    ) public {
        amount = bound(amount, vault.MIN_DEPOSIT(), 100 ether);
        lockDuration = bound(lockDuration, 1, vault.MAX_LOCK_DURATION());
        extraWait = bound(extraWait, 0, 365 days);

        vm.prank(user);
        uint256 lockId = vault.deposit{value: amount}(
            block.timestamp + lockDuration
        );
        uint256 balanceBefore = user.balance;
        vm.warp(block.timestamp + lockDuration + extraWait);

        vm.prank(user);
        vault.withdraw(lockId);

        assertEq(user.balance - balanceBefore, amount, "payout must equal lock");
        assertEq(vault.totalWithdrawn(), amount, "totalWithdrawn must equal lock");
        assertEq(vault.totalLocked(), 0, "nothing left locked");
    }

    /// @notice Proof withdrawal after unlock succeeds with a valid proof.
    function testFuzz_ProofWithdrawAfterUnlockSucceeds(
        uint256 amount,
        uint256 lockDuration
    ) public {
        amount = bound(amount, vault.MIN_DEPOSIT(), 100 ether);
        lockDuration = bound(lockDuration, 1, vault.MAX_LOCK_DURATION());

        vm.prank(user);
        uint256 lockId = vault.deposit{value: amount}(
            block.timestamp + lockDuration
        );
        bytes32 digest = vault.withdrawalDigest(user, lockId, amount);
        verify.allow(userPubkey, abi.encodePacked(digest), dummySignature);
        uint256 balanceBefore = user.balance;
        vm.warp(block.timestamp + lockDuration);

        vm.prank(user);
        vault.withdrawWithProof(lockId, dummySignature);

        assertEq(user.balance - balanceBefore, amount, "payout must equal lock");
        assertEq(vault.totalWithdrawn(), amount, "totalWithdrawn must equal lock");
    }

    /// @notice (a) Conservation across a full deposit/withdraw cycle:
    ///         deposited - withdrawn always equals the contract balance
    ///         and totalLocked, before and after the withdrawal.
    function testFuzz_DepositWithdrawConservation(
        uint256 amount,
        uint256 lockDuration
    ) public {
        amount = bound(amount, vault.MIN_DEPOSIT(), 100 ether);
        lockDuration = bound(lockDuration, 1, vault.MAX_LOCK_DURATION());

        vm.prank(user);
        uint256 lockId = vault.deposit{value: amount}(
            block.timestamp + lockDuration
        );
        assertEq(
            vault.totalDeposited() - vault.totalWithdrawn(),
            address(vault).balance,
            "conservation must hold after deposit"
        );
        assertEq(
            vault.totalLocked(),
            address(vault).balance,
            "totalLocked must equal balance after deposit"
        );

        vm.warp(block.timestamp + lockDuration);
        vm.prank(user);
        vault.withdraw(lockId);

        assertEq(
            vault.totalDeposited() - vault.totalWithdrawn(),
            address(vault).balance,
            "conservation must hold after withdrawal"
        );
        assertEq(
            vault.totalLocked(),
            address(vault).balance,
            "totalLocked must equal balance after withdrawal"
        );
        assertEq(address(vault).balance, 0, "vault must be empty");
    }

    /// @notice Reentrancy: a malicious receiver that re-enters withdraw
    ///         from its receive() cannot double-withdraw a lock.
    function test_ReentrancyCannotDoubleWithdraw() public {
        ReentrantActor actor = new ReentrantActor(vault);
        vm.deal(address(actor), 10 ether);
        keyStatus.setKey(address(actor), userPubkey, true);

        uint256 lockId = actor.depositSelf(block.timestamp + 60, 1 ether);
        vm.warp(block.timestamp + 61);
        actor.withdrawSelf(lockId);

        assertTrue(actor.receiveCalled(), "receive() must have run");
        assertFalse(
            actor.reentrySucceeded(),
            "reentrant withdraw must not succeed"
        );
        assertEq(
            vault.totalWithdrawn(),
            1 ether,
            "lock must pay exactly once"
        );
        assertEq(address(vault).balance, 0, "vault must be empty");
        assertEq(address(actor).balance, 10 ether, "actor made whole");
    }
}
