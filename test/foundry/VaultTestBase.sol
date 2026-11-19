// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../../contracts/QuantumVault.sol";
import "../../contracts/mocks/MockPqcKeyStatus.sol";
import "../../contracts/mocks/MockPqcVerify.sol";

/// @title VaultTestBase — shared Foundry setup for QuantumVault tests.
/// @notice Deploys the vault and etches the mock precompiles onto their real
///         addresses (0x0A01 / 0x0A02), mirroring the Hardhat suite's
///         hardhat_setCode approach. The mocks stand in for the precompile
///         interfaces only — no real ML-DSA cryptography runs locally; the
///         real cryptography is verified live on Diana (see README).
abstract contract VaultTestBase is Test {
    address internal constant KEY_STATUS_PRECOMPILE =
        0x0000000000000000000000000000000000000a02;
    address internal constant VERIFY_PRECOMPILE =
        0x0000000000000000000000000000000000000a01;

    QuantumVault internal vault;
    MockPqcKeyStatus internal keyStatus;
    MockPqcVerify internal verify;

    function _deployVaultAndMocks() internal {
        vault = new QuantumVault();
        MockPqcKeyStatus keyStatusImpl = new MockPqcKeyStatus();
        MockPqcVerify verifyImpl = new MockPqcVerify();
        vm.etch(KEY_STATUS_PRECOMPILE, address(keyStatusImpl).code);
        vm.etch(VERIFY_PRECOMPILE, address(verifyImpl).code);
        keyStatus = MockPqcKeyStatus(KEY_STATUS_PRECOMPILE);
        verify = MockPqcVerify(VERIFY_PRECOMPILE);
    }

    /// @notice `n` bytes of the same value — distinct dummy pubkeys and
    ///         signatures per actor. The mocks do not validate key or
    ///         signature lengths; distinct values prove the contract passes
    ///         the REGISTERED pubkey to pqcVerify.
    function _repeatByte(
        bytes1 b,
        uint256 n
    ) internal pure returns (bytes memory) {
        bytes memory out = new bytes(n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = b;
        }
        return out;
    }
}
