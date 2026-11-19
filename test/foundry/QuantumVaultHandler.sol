// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../../contracts/QuantumVault.sol";
import "../../contracts/mocks/MockPqcVerify.sol";

/// @title VaultActor — one invariant-test user of the vault.
/// @notice A minimal contract actor: it deposits its own funds, withdraws its
///         own locks, and can receive ETH. Each actor holds a registered
///         ML-DSA key with proven possession (mocked precompile), so
///         withdrawals exercise the real contract path rather than the key
///         gate. Withdrawal attempts return a success flag instead of
///         bubbling reverts, so the handler can assert the outcome matches
///         the lock's state.
contract VaultActor {
    QuantumVault public immutable vault;

    constructor(QuantumVault _vault) {
        vault = _vault;
    }

    receive() external payable {}

    function tryDeposit(
        uint256 unlockTime,
        uint256 amount
    ) external returns (bool success, uint256 lockId) {
        try vault.deposit{value: amount}(unlockTime) returns (uint256 id) {
            return (true, id);
        } catch {
            return (false, 0);
        }
    }

    function tryWithdraw(uint256 lockId) external returns (bool success) {
        try vault.withdraw(lockId) {
            return true;
        } catch {
            return false;
        }
    }

    function tryWithdrawWithProof(
        uint256 lockId,
        bytes calldata signature
    ) external returns (bool success) {
        try vault.withdrawWithProof(lockId, signature) {
            return true;
        } catch {
            return false;
        }
    }
}

/// @title QuantumVaultHandler — handler for the invariant suite.
/// @notice Drives random sequences of deposits, plain withdrawals, proof
///         withdrawals and time warps across several actors, and mirrors
///         every lock in ghost state. Each withdrawal attempt asserts that
///         its outcome matches the lock's state: a withdrawal must succeed
///         exactly when the lock is un-withdrawn and past its unlock time,
///         and must fail otherwise (still locked, or already withdrawn).
///         The invariant test then compares the ghost mirror against the
///         contract's own totals and per-owner reads.
contract QuantumVaultHandler is Test {
    QuantumVault public vault;
    MockPqcVerify public verify;

    VaultActor[] public actors;
    mapping(address => bytes) public actorPubkey;
    bytes internal _signature;

    struct GhostLock {
        uint256 amount;
        uint256 unlockTime;
        bool withdrawn;
    }

    mapping(address => GhostLock[]) internal _ghostLocks;
    uint256 public ghostDeposited;
    uint256 public ghostWithdrawn;
    mapping(address => uint256) public ghostLockedByActor;

    /// @notice Withdrawal attempts made while the lock was still locked.
    uint256 public earlyWithdrawAttempts;
    /// @notice Of those attempts, how many reverted (must equal attempts).
    uint256 public earlyWithdrawReverts;
    uint256 public successfulWithdrawals;

    constructor(
        QuantumVault _vault,
        MockPqcVerify _verify,
        VaultActor[] memory _actors,
        bytes[] memory _pubkeys,
        bytes memory _sig
    ) {
        vault = _vault;
        verify = _verify;
        _signature = _sig;
        for (uint256 i = 0; i < _actors.length; i++) {
            actors.push(_actors[i]);
            actorPubkey[address(_actors[i])] = _pubkeys[i];
        }
    }

    // ------------------------------------------------------------------
    // Actions (called by the invariant fuzzer)
    // ------------------------------------------------------------------

    /// @notice Deposit a bounded amount for a bounded lock duration. With
    ///         bounded inputs and funded actors this must always succeed,
    ///         and the lock id must be the next sequential id for the actor.
    function deposit(
        uint256 actorSeed,
        uint256 amount,
        uint256 duration
    ) public {
        VaultActor actor = actors[actorSeed % actors.length];
        amount = bound(amount, vault.MIN_DEPOSIT(), 10 ether);
        duration = bound(duration, 1, vault.MAX_LOCK_DURATION());
        uint256 unlockTime = block.timestamp + duration;

        uint256 expectedLockId = _ghostLocks[address(actor)].length;
        (bool ok, uint256 lockId) = actor.tryDeposit(unlockTime, amount);
        assertTrue(ok, "bounded deposit must succeed");
        assertEq(lockId, expectedLockId, "lock ids must be sequential");

        _ghostLocks[address(actor)].push(
            GhostLock({
                amount: amount,
                unlockTime: unlockTime,
                withdrawn: false
            })
        );
        ghostDeposited += amount;
        ghostLockedByActor[address(actor)] += amount;
    }

    /// @notice Attempt a plain withdrawal of a random lock of a random actor.
    function withdraw(uint256 actorSeed, uint256 lockSeed) public {
        VaultActor actor = actors[actorSeed % actors.length];
        uint256 count = _ghostLocks[address(actor)].length;
        if (count == 0) return;
        _attemptWithdraw(actor, lockSeed % count, false);
    }

    /// @notice Attempt a proof withdrawal of a random lock of a random actor.
    ///         The proof triple is allowed in the mock first, for the
    ///         actor's REGISTERED pubkey and the exact withdrawal digest,
    ///         so a valid proof is always presented and only the timelock /
    ///         already-withdrawn state decides the outcome.
    function withdrawWithProof(uint256 actorSeed, uint256 lockSeed) public {
        VaultActor actor = actors[actorSeed % actors.length];
        uint256 count = _ghostLocks[address(actor)].length;
        if (count == 0) return;
        _attemptWithdraw(actor, lockSeed % count, true);
    }

    /// @notice Move time forward by up to 30 days so locks mature.
    function warpTime(uint256 seconds_) public {
        seconds_ = bound(seconds_, 0, 30 days);
        vm.warp(block.timestamp + seconds_);
    }

    // ------------------------------------------------------------------
    // Shared withdrawal logic
    // ------------------------------------------------------------------

    function _attemptWithdraw(
        VaultActor actor,
        uint256 lockId,
        bool withProof
    ) internal {
        QuantumVault.Lock memory lock = vault.getLock(address(actor), lockId);
        GhostLock storage ghost = _ghostLocks[address(actor)][lockId];

        // The ghost mirror must already agree with the chain.
        assertEq(lock.amount, ghost.amount, "ghost amount drift");
        assertEq(lock.unlockTime, ghost.unlockTime, "ghost unlockTime drift");
        assertEq(lock.withdrawn, ghost.withdrawn, "ghost withdrawn drift");

        bool shouldSucceed = !lock.withdrawn &&
            block.timestamp >= lock.unlockTime;
        bool ok;
        if (withProof) {
            bytes32 digest = vault.withdrawalDigest(
                address(actor),
                lockId,
                lock.amount
            );
            verify.allow(
                actorPubkey[address(actor)],
                abi.encodePacked(digest),
                _signature
            );
            ok = actor.tryWithdrawWithProof(lockId, _signature);
        } else {
            ok = actor.tryWithdraw(lockId);
        }

        if (!lock.withdrawn && block.timestamp < lock.unlockTime) {
            earlyWithdrawAttempts++;
            if (!ok) earlyWithdrawReverts++;
        }
        assertEq(
            ok,
            shouldSucceed,
            "withdraw outcome must match lock state"
        );

        if (ok) {
            ghost.withdrawn = true;
            ghostWithdrawn += lock.amount;
            ghostLockedByActor[address(actor)] -= lock.amount;
            successfulWithdrawals++;
        }
    }

    // ------------------------------------------------------------------
    // Ghost-state readers for the invariant test
    // ------------------------------------------------------------------

    function actorCount() public view returns (uint256) {
        return actors.length;
    }

    function actorAt(uint256 i) public view returns (address) {
        return address(actors[i]);
    }

    function ghostLockCount(address actor) public view returns (uint256) {
        return _ghostLocks[actor].length;
    }

    function ghostLock(
        address actor,
        uint256 lockId
    )
        public
        view
        returns (uint256 amount, uint256 unlockTime, bool withdrawn)
    {
        GhostLock storage g = _ghostLocks[actor][lockId];
        return (g.amount, g.unlockTime, g.withdrawn);
    }
}
