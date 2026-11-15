// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title MockPqcKeyStatus — local stand-in for the pqcKeyStatus precompile (TESTS ONLY).
/// @notice The test suite copies this contract's deployed bytecode onto the
///         real precompile address 0x0A02 (hardhat_setCode), so QuantumVault's
///         calls to the precompile hit this mock on the local network.
///         Answers come from a registry the test drives, mirroring what
///         MsgRegisterPQCKeyV2 produces on Diana: the registered flag, the
///         algorithm id (1 = ML-DSA-87), the registered pubkey bytes and the
///         possessionProven flag — the exact 4-value return shape the live
///         precompile has produced since chain v3.2.4 (verified by a raw
///         eth_call against Diana before this mock was written).
/// @dev This performs NO cryptography and is NOT the real precompile. Never
///      deploy it to a live network; on Diana the real 0x0A02 answers.
contract MockPqcKeyStatus {
    struct KeyRecord {
        bool registered;
        bool possessionProven;
        bytes pubkey;
    }

    mapping(address => KeyRecord) private _records;

    /// @notice Test helper: set (or overwrite) the key record for an account.
    /// @param account The account whose record to set.
    /// @param pubkey The pubkey the precompile should report as registered.
    /// @param possessionProven Whether possession was proven at registration.
    ///        Pass false to simulate a key that exists but was never proven.
    function setKey(
        address account,
        bytes calldata pubkey,
        bool possessionProven
    ) external {
        _records[account] = KeyRecord({
            registered: true,
            possessionProven: possessionProven,
            pubkey: pubkey
        });
    }

    /// @notice Test helper: erase an account's key record entirely, as if
    ///         the account never registered a key.
    function clearKey(address account) external {
        delete _records[account];
    }

    /// @notice Same signature and return order as the real 0x0A02 precompile.
    function pqcKeyStatus(
        address account
    )
        external
        view
        returns (
            bool registered,
            uint8 algorithmId,
            bytes memory pubkey,
            bool possessionProven
        )
    {
        KeyRecord storage record = _records[account];
        return (
            record.registered,
            record.registered ? uint8(1) : uint8(0), // 1 = ML-DSA-87
            record.pubkey,
            record.possessionProven
        );
    }
}
