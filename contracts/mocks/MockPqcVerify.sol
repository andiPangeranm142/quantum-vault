// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title MockPqcVerify — local stand-in for the pqcVerify precompile (TESTS ONLY).
/// @notice The test suite copies this contract's deployed bytecode onto the
///         real precompile address 0x0A01 (hardhat_setCode), so QuantumVault's
///         proof checks hit this mock on the local network. A local EVM
///         cannot do real ML-DSA verification, so the mock answers from a
///         registry the test drives: a (pubkey, message, signature) triple
///         verifies exactly when the test explicitly allowed it. That still
///         exercises everything the contract itself is responsible for —
///         that it passes the REGISTERED pubkey (not a caller-supplied one),
///         that it builds the digest the test expects, and that it reverts
///         when verification fails. The real cryptography is verified
///         separately, live on Diana: a signature from the qorechain sdk's
///         pqcSign verifies true through the real 0x0A01 precompile, and the
///         same signature over a different message verifies false.
/// @dev This performs NO cryptography and is NOT the real precompile. Never
///      deploy it to a live network; on Diana the real 0x0A01 answers.
contract MockPqcVerify {
    /// @notice Triples the test has allowed, keyed by their packed hash.
    mapping(bytes32 => bool) private _allowed;

    /// @notice Test helper: mark one (pubkey, message, signature) triple as
    ///         verifying successfully.
    function allow(
        bytes calldata pubkey,
        bytes calldata message,
        bytes calldata signature
    ) external {
        _allowed[_key(pubkey, message, signature)] = true;
    }

    /// @notice Test helper: revoke a previously allowed triple.
    function deny(
        bytes calldata pubkey,
        bytes calldata message,
        bytes calldata signature
    ) external {
        _allowed[_key(pubkey, message, signature)] = false;
    }

    /// @notice Same signature as the real 0x0A01 precompile.
    function pqcVerify(
        bytes calldata pubkey,
        bytes calldata signature,
        bytes calldata message
    ) external view returns (bool valid) {
        return _allowed[_key(pubkey, message, signature)];
    }

    function _key(
        bytes calldata pubkey,
        bytes calldata message,
        bytes calldata signature
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(pubkey, message, signature));
    }
}
