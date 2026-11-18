// Sources flattened with hardhat v2.29.2 https://hardhat.org

// SPDX-License-Identifier: Apache-2.0

// File contracts/QuantumVault.sol

// Original license: SPDX_License_Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title IQorePqcKeyStatus — interface for the QoreChain pqcKeyStatus precompile.
/// @notice The live precompile returns FOUR values since chain v3.2.4
///         (registered, algorithmId, pubkey, possessionProven). This was
///         verified against the live Diana precompile with a raw eth_call
///         before this contract was written: a registered account returns
///         2,752 bytes decoding to (true, 1, 2592-byte pubkey, true), and an
///         unregistered account returns (false, 0, empty, false). The
///         qorechain/evm 0.14.0 type definitions still describe only three
///         values — do not trust them over the live chain.
interface IQorePqcKeyStatus {
    /// @return registered       The account has an ML-DSA key registered on chain.
    /// @return algorithmId      Signature algorithm id (1 = ML-DSA-87 / FIPS 204).
    /// @return pubkey           The public key actually registered on chain.
    /// @return possessionProven The account proved possession of the private key
    ///                          at registration time (MsgRegisterPQCKeyV2).
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
        );
}

/// @title IQorePqcVerify — interface for the QoreChain pqcVerify precompile.
/// @notice Verifies an ML-DSA signature against a public key and a message,
///         on chain. Verified live on Diana before this contract was written:
///         a signature produced by the qorechain sdk's pqcSign over a message
///         verifies true, and the same signature over a different message
///         verifies false.
interface IQorePqcVerify {
    /// @return valid True when the signature is a valid ML-DSA signature by
    ///         `pubkey` over `message`.
    function pqcVerify(
        bytes calldata pubkey,
        bytes calldata signature,
        bytes calldata message
    ) external view returns (bool valid);
}

/// @title QuantumVault
/// @notice A time-locked savings vault for the QoreChain testnet.
///         A user deposits QOR locked until a chosen unlock time. Withdrawals
///         are the sensitive action, and they receive post-quantum protection
///         on three independent layers:
///
///         1. CHAIN-GATED WINDOW. Every EVM transaction on QoreChain is only
///            admitted inside a post-quantum authorisation window opened by
///            a hybrid-signed (secp256k1 + ML-DSA-87) native message. A
///            leaked ECDSA key alone cannot send any transaction at all —
///            including a withdrawal — because it cannot open a window.
///         2. CONTRACT-VERIFIED KEY. Before releasing funds, this contract
///            calls the pqcKeyStatus precompile (0x0A02) for the withdrawer
///            and requires a registered ML-DSA key whose possession was
///            proven at registration. No key, or an unproven key: revert.
///         3. PROOF WITHDRAWAL (optional, stronger). `withdrawWithProof`
///            additionally requires an ML-DSA-87 signature over the exact
///            withdrawal intent — chain, contract, withdrawer, lock id and
///            amount — verified on chain via the pqcVerify precompile
///            (0x0A01) against the REGISTERED public key (never a
///            caller-supplied one). A stolen window cannot be abused for a
///            withdrawal the key owner never signed, because the signature
///            commits to the exact withdrawal.
///
///         The contract holds deposited funds and has no owner, no admin and
///         no privileged function: nobody — not even the deployer — can move
///         funds except through a withdrawal by the lock's owner after its
///         unlock time. There is no emergency withdrawal, no pause and no
///         upgrade path, by design.
///
///         Honest limits (see README): the timelock is enforced by
///         block.timestamp, which a block proposer can shift by a few
///         seconds; the contract cannot see whether a window is open (native
///         state is not observable from the EVM), so layer 1 is enforced by
///         the chain, not by this contract; and a lost ML-DSA key means the
///         funds in that account's locks cannot be withdrawn by anyone.
contract QuantumVault {
    /// @notice The pqcKeyStatus precompile on QoreChain Diana (chain v3.2.4+).
    address public constant PQC_KEY_STATUS_PRECOMPILE =
        0x0000000000000000000000000000000000000a02;

    /// @notice The pqcVerify precompile on QoreChain Diana.
    address public constant PQC_VERIFY_PRECOMPILE =
        0x0000000000000000000000000000000000000a01;

    /// @notice The longest a deposit may lock for (2 years).
    uint256 public constant MAX_LOCK_DURATION = 730 days;

    /// @notice The smallest deposit accepted (dust guard).
    uint256 public constant MIN_DEPOSIT = 0.001 ether;

    /// @notice One time-locked deposit. Lock ids are per-owner, sequential
    ///         from 0 in deposit order.
    struct Lock {
        uint256 amount;
        uint256 unlockTime;
        bool withdrawn;
    }

    /// @notice Locks per owner.
    mapping(address => Lock[]) private _locks;

    /// @notice QOR currently locked across all owners.
    uint256 public totalLocked;

    /// @notice QOR ever deposited.
    uint256 public totalDeposited;

    /// @notice QOR ever withdrawn.
    uint256 public totalWithdrawn;

    /// @notice Locks ever created.
    uint256 public lockCount;

    /// @notice Emitted for every deposit.
    event Deposited(
        address indexed depositor,
        uint256 indexed lockId,
        uint256 amount,
        uint256 unlockTime
    );

    /// @notice Emitted for every withdrawal. `withProof` is true when the
    ///         withdrawal carried an ML-DSA signature verified on chain.
    event Withdrawn(
        address indexed withdrawer,
        uint256 indexed lockId,
        uint256 amount,
        bool withProof
    );

    error ZeroDeposit();
    error DepositTooSmall(uint256 amount, uint256 minimum);
    error UnlockTimeInPast(uint256 unlockTime);
    error LockTooLong(uint256 unlockTime, uint256 maxUnlockTime);
    error LockNotFound(address owner, uint256 lockId);
    error AlreadyWithdrawn(address owner, uint256 lockId);
    error StillLocked(uint256 unlockTime, uint256 currentTime);
    /// @notice The withdrawer has no ML-DSA key registered on chain.
    error PqcKeyNotRegistered(address owner);
    /// @notice The withdrawer's ML-DSA key was never proven (no proof of
    ///         possession at registration).
    error PossessionNotProven(address owner);
    /// @notice The ML-DSA signature did not verify against the registered key.
    error InvalidProof();
    error TransferFailed();

    // ------------------------------------------------------------------
    // Write API
    // ------------------------------------------------------------------

    /// @notice Deposit QOR locked until `unlockTime`.
    /// @param unlockTime Unix timestamp from which the deposit may be
    ///        withdrawn. Must be in the future and at most MAX_LOCK_DURATION
    ///        ahead. Deposits need no PQC key: only withdrawals are
    ///        sensitive, and anyone may lock funds in for themselves.
    /// @return lockId The new lock's id for the caller (sequential from 0).
    function deposit(
        uint256 unlockTime
    ) external payable returns (uint256 lockId) {
        if (msg.value == 0) revert ZeroDeposit();
        if (msg.value < MIN_DEPOSIT)
            revert DepositTooSmall(msg.value, MIN_DEPOSIT);
        if (unlockTime <= block.timestamp)
            revert UnlockTimeInPast(unlockTime);
        if (unlockTime > block.timestamp + MAX_LOCK_DURATION)
            revert LockTooLong(unlockTime, block.timestamp + MAX_LOCK_DURATION);

        lockId = _locks[msg.sender].length;
        _locks[msg.sender].push(
            Lock({ amount: msg.value, unlockTime: unlockTime, withdrawn: false })
        );
        totalLocked += msg.value;
        totalDeposited += msg.value;
        lockCount += 1;
        emit Deposited(msg.sender, lockId, msg.value, unlockTime);
    }

    /// @notice Withdraw a lock after its unlock time.
    /// @dev Requires the caller to hold a registered ML-DSA key with proven
    ///      possession (pqcKeyStatus precompile). The transaction itself is
    ///      additionally admitted only inside a hybrid-signed EVM window
    ///      (enforced by the chain).
    function withdraw(uint256 lockId) external {
        _withdraw(lockId, false, "");
    }

    /// @notice Withdraw a lock with an on-chain-verified ML-DSA signature.
    /// @param lockId The lock to withdraw.
    /// @param signature An ML-DSA-87 signature, by the caller's REGISTERED
    ///        key, over the digest returned by `withdrawalDigest` for this
    ///        lock. Verified on chain via the pqcVerify precompile against
    ///        the registered public key from pqcKeyStatus — the caller
    ///        cannot substitute their own key.
    function withdrawWithProof(uint256 lockId, bytes calldata signature) external {
        _withdraw(lockId, true, signature);
    }

    /// @notice The digest a proof withdrawal must be signed over.
    /// @dev Domain-separated: the literal tag, the chain id, this contract,
    ///      the owner, the lock id and the exact amount. A signature for one
    ///      lock, chain or contract cannot be replayed anywhere else, and a
    ///      withdrawn lock cannot be withdrawn again, so the digest is
    ///      single-use by construction.
    function withdrawalDigest(
        address owner,
        uint256 lockId,
        uint256 amount
    ) public view returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(
                    "QuantumVault.withdraw",
                    block.chainid,
                    address(this),
                    owner,
                    lockId,
                    amount
                )
            );
    }

    // ------------------------------------------------------------------
    // Read API (frontend)
    // ------------------------------------------------------------------

    /// @notice How many locks an owner has (withdrawn ones included).
    function lockCountOf(address owner) external view returns (uint256) {
        return _locks[owner].length;
    }

    /// @notice One lock of one owner.
    function getLock(
        address owner,
        uint256 lockId
    ) external view returns (Lock memory) {
        if (lockId >= _locks[owner].length)
            revert LockNotFound(owner, lockId);
        return _locks[owner][lockId];
    }

    /// @notice Live PQC key check for an owner, straight from the 0x0A02
    ///         precompile — the same check withdrawals enforce.
    /// @return registered Whether an ML-DSA key is registered.
    /// @return possessionProven Whether possession was proven at registration.
    function hasPqcKey(
        address owner
    ) external view returns (bool registered, bool possessionProven) {
        (registered, , , possessionProven) = IQorePqcKeyStatus(
            PQC_KEY_STATUS_PRECOMPILE
        ).pqcKeyStatus(owner);
    }

    // ------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------

    /// @dev Shared withdrawal path. Checks-effects-interactions: every state
    ///      change happens before the external call, so reentrancy cannot
    ///      double-spend a lock.
    function _withdraw(
        uint256 lockId,
        bool withProof,
        bytes memory signature
    ) internal {
        if (lockId >= _locks[msg.sender].length)
            revert LockNotFound(msg.sender, lockId);
        Lock storage lock = _locks[msg.sender][lockId];
        if (lock.withdrawn) revert AlreadyWithdrawn(msg.sender, lockId);
        if (block.timestamp < lock.unlockTime)
            revert StillLocked(lock.unlockTime, block.timestamp);

        // Post-quantum gate: registered ML-DSA key with proven possession.
        (bool registered, , bytes memory pubkey, bool possessionProven) = IQorePqcKeyStatus(
            PQC_KEY_STATUS_PRECOMPILE
        ).pqcKeyStatus(msg.sender);
        if (!registered) revert PqcKeyNotRegistered(msg.sender);
        if (!possessionProven) revert PossessionNotProven(msg.sender);

        if (withProof) {
            bytes32 digest = withdrawalDigest(msg.sender, lockId, lock.amount);
            bool valid = IQorePqcVerify(PQC_VERIFY_PRECOMPILE).pqcVerify(
                pubkey,
                signature,
                abi.encodePacked(digest)
            );
            if (!valid) revert InvalidProof();
        }

        lock.withdrawn = true;
        totalLocked -= lock.amount;
        totalWithdrawn += lock.amount;
        emit Withdrawn(msg.sender, lockId, lock.amount, withProof);

        (bool ok, ) = payable(msg.sender).call{ value: lock.amount }("");
        if (!ok) revert TransferFailed();
    }
}
