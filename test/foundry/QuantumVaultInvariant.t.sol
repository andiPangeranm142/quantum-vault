// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "./VaultTestBase.sol";
import "./QuantumVaultHandler.sol";

/// @title QuantumVaultInvariantTest — handler-based invariant suite.
/// @notice Random sequences of deposits, withdrawals, proof withdrawals and
///         time warps across 4 actors, run by Foundry's invariant fuzzer.
///         Proves three properties over every sequence:
///           (a) conservation — deposited minus withdrawn always equals the
///               contract balance, totalLocked, and the sum of un-withdrawn
///               locks;
///           (b) no early withdrawal — every withdrawal attempted before its
///               unlock time reverts (counted in the handler; the fuzz
///               suite in QuantumVaultFuzz.t.sol proves the same property
///               directly for arbitrary amounts and durations);
///           (c) lock accounting — per-owner lock counts, amounts and
///               withdrawn flags stay consistent with an independent ghost
///               mirror of every lock.
contract QuantumVaultInvariantTest is StdInvariant, VaultTestBase {
    QuantumVaultHandler internal handler;

    function setUp() public {
        _deployVaultAndMocks();

        VaultActor[] memory actors = new VaultActor[](4);
        bytes[] memory pubkeys = new bytes[](4);
        bytes1[4] memory marks = [bytes1(0xaa), bytes1(0xbb), bytes1(0xdd), bytes1(0xee)];
        for (uint256 i = 0; i < 4; i++) {
            actors[i] = new VaultActor(vault);
            // Generous funding: at most `depth` deposits of at most
            // 10 ether each can happen per invariant run.
            vm.deal(address(actors[i]), 1_000_000 ether);
            pubkeys[i] = _repeatByte(marks[i], 32);
            keyStatus.setKey(address(actors[i]), pubkeys[i], true);
        }

        handler = new QuantumVaultHandler(
            vault,
            verify,
            actors,
            pubkeys,
            _repeatByte(bytes1(0xcc), 64)
        );
        targetContract(address(handler));
    }

    /// @notice (a) Conservation: deposited - withdrawn == totalLocked ==
    ///         contract balance, and the contract's totals match the
    ///         handler's independently tracked ghost totals.
    function invariant_Conservation() public view {
        assertEq(
            vault.totalDeposited() - vault.totalWithdrawn(),
            vault.totalLocked(),
            "deposited - withdrawn must equal totalLocked"
        );
        assertEq(
            vault.totalLocked(),
            address(vault).balance,
            "totalLocked must equal contract balance"
        );
        assertEq(
            handler.ghostDeposited(),
            vault.totalDeposited(),
            "ghost deposited must match totalDeposited"
        );
        assertEq(
            handler.ghostWithdrawn(),
            vault.totalWithdrawn(),
            "ghost withdrawn must match totalWithdrawn"
        );
    }

    /// @notice (c) Lock accounting: every actor's lock count, every lock's
    ///         amount / unlock time / withdrawn flag, and the sum of
    ///         un-withdrawn locks match the ghost mirror and totalLocked.
    function invariant_LockAccounting() public view {
        uint256 totalUnwithdrawn;
        uint256 totalLocks;
        for (uint256 i = 0; i < handler.actorCount(); i++) {
            address actor = handler.actorAt(i);
            uint256 count = vault.lockCountOf(actor);
            assertEq(
                count,
                handler.ghostLockCount(actor),
                "per-owner lock count must match ghost"
            );
            totalLocks += count;
            uint256 unwithdrawn;
            for (uint256 j = 0; j < count; j++) {
                QuantumVault.Lock memory lock = vault.getLock(actor, j);
                (
                    uint256 gAmount,
                    uint256 gUnlock,
                    bool gWithdrawn
                ) = handler.ghostLock(actor, j);
                assertEq(lock.amount, gAmount, "lock amount must match ghost");
                assertEq(
                    lock.unlockTime,
                    gUnlock,
                    "lock unlockTime must match ghost"
                );
                assertEq(
                    lock.withdrawn,
                    gWithdrawn,
                    "lock withdrawn flag must match ghost"
                );
                if (!lock.withdrawn) {
                    unwithdrawn += lock.amount;
                }
            }
            assertEq(
                unwithdrawn,
                handler.ghostLockedByActor(actor),
                "per-owner un-withdrawn sum must match ghost"
            );
            totalUnwithdrawn += unwithdrawn;
        }
        assertEq(totalLocks, vault.lockCount(), "lockCount must match");
        assertEq(
            totalUnwithdrawn,
            vault.totalLocked(),
            "sum of un-withdrawn locks must equal totalLocked"
        );
    }

    /// @notice (b) No early withdrawal: every withdrawal attempted before
    ///         its unlock time reverted. (The handler counts attempts and
    ///         reverts; see also the direct fuzz proof in
    ///         QuantumVaultFuzz.t.sol.)
    function invariant_EarlyWithdrawalsAlwaysRevert() public view {
        assertEq(
            handler.earlyWithdrawReverts(),
            handler.earlyWithdrawAttempts(),
            "every early withdrawal attempt must revert"
        );
    }

    /// @notice Deterministic check that the handler's early-withdrawal
    ///         counters actually move: a withdrawal attempted while locked
    ///         is counted as an attempt and a revert, and the same lock
    ///         withdraws successfully once time passes its unlock time.
    ///         This pins down the mechanism behind
    ///         invariant_EarlyWithdrawalsAlwaysRevert so it cannot pass
    ///         vacuously (0 attempts == 0 reverts) without the counting
    ///         itself being proven to work.
    function test_HandlerCountsEarlyWithdrawals() public {
        handler.deposit(0, 1 ether, 365 days);
        handler.withdraw(0, 0);
        assertEq(handler.earlyWithdrawAttempts(), 1, "one early attempt");
        assertEq(handler.earlyWithdrawReverts(), 1, "one early revert");
        assertEq(handler.successfulWithdrawals(), 0, "no success yet");

        // warpTime is bounded to 30 days per call (fuzzing), so move time
        // directly past the 365-day lock here.
        vm.warp(block.timestamp + 366 days);
        handler.withdraw(0, 0);
        assertEq(handler.successfulWithdrawals(), 1, "withdraw succeeds");
        assertEq(handler.ghostWithdrawn(), 1 ether, "ghost tracks payout");
        assertEq(vault.totalWithdrawn(), 1 ether, "chain tracks payout");
    }
}
