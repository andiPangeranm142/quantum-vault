# Security — Quantum Vault

Honest security documentation for the Quantum Vault contract. Every claim
here is verifiable from the contract source (`contracts/QuantumVault.sol`),
the test suites, or the QCAI audit triage
(`docs/QCAI-stage1-triage.md`). Nothing here claims a mitigation that does
not exist in the code.

- **Contract (Diana testnet):**
  `0x0abdb86be55eb51cb090fd736651dff56d57715a`
- **Status: testnet only.** Nothing in this vault has real value. Do not
  treat it as production-ready for mainnet funds.

## What the contract protects

Quantum Vault holds time-locked QOR deposits. The asset at risk is the
deposited QOR; the sensitive action is withdrawal. The contract's job is
that each lock pays out exactly once, only to its owner, only after its
unlock time, and only to an owner holding a registered ML-DSA key with
proven possession.

There is no owner, no admin, and no privileged function: nobody — not
even the deployer — can move funds except through a withdrawal by the
lock's owner after its unlock time. There is no emergency withdrawal, no
pause, and no upgrade path, by design.

## Threat model

### What an attacker would need

Withdrawals are protected on three independent layers (see the contract
NatSpec):

1. **Chain-gated window.** Every EVM transaction on QoreChain is admitted
   only inside a post-quantum authorisation window opened by a
   hybrid-signed (secp256k1 + ML-DSA-87) native message. A leaked ECDSA
   key alone cannot send any transaction at all — including a withdrawal
   — because it cannot open a window.
2. **Contract-verified key.** Before releasing funds, the contract calls
   the `pqcKeyStatus` precompile (0x0A02) for the withdrawer and requires
   a registered ML-DSA key whose possession was proven at registration.
   No key, or an unproven key: the withdrawal reverts.
3. **Proof withdrawal (optional, stronger).** `withdrawWithProof`
   additionally requires an ML-DSA-87 signature over the exact
   withdrawal intent — chain, contract, withdrawer, lock id and amount —
   verified on chain via the `pqcVerify` precompile (0x0A01) against the
   REGISTERED public key (read from `pqcKeyStatus` in the same call,
   never caller-supplied). A signature for one lock, chain or contract
   cannot be replayed anywhere else, and a withdrawn lock cannot be
   withdrawn again, so each digest is single-use by construction.

### Trust assumptions

- **The ML-DSA private key stays secret.** All three layers ultimately
  rest on the owner's ML-DSA key: whoever holds it can open a window and
  sign proofs. Key compromise is outside what this contract can defend
  against, and there is no key-recovery or rotation mechanism in the
  contract (see Known limitations).
- **The QoreChain precompiles answer truthfully.** The contract trusts
  `pqcKeyStatus` (0x0A02) for registration/possession status and the
  registered pubkey, and `pqcVerify` (0x0A01) for signature validity.
  Both interfaces were verified against the live Diana precompiles with
  raw `eth_call`s before the contract was written (see README), and two
  live proof withdrawals verified on chain (locks 3 and 4).
- **The chain enforces the EVM window.** Native window state is not
  observable from the EVM, so the contract cannot check whether a window
  is open — layer 1 is enforced by the chain, not by this code.
- **Block timestamps are approximately honest.** The timelock is
  enforced by `block.timestamp`, which a block proposer can shift by a
  few seconds. Locks are for savings horizons, not second-exact
  deadlines.
- **No reliance on block hashes.** The contract never reads `blockhash`
  or `block.number` (it uses only `block.timestamp` and
  `block.chainid`). The Diana behaviour where `BLOCKHASH` returns 0,
  documented for Quantum Flip, does not affect this contract: there is
  no randomness anywhere in it.

### What the contract itself guarantees (tested)

- **Conservation.** Deposited minus withdrawn always equals the contract
  balance, `totalLocked`, and the sum of un-withdrawn locks — proven by
  handler-based invariant tests over random deposit/withdrawal/time-warp
  sequences (see Test coverage).
- **No early withdrawal.** Withdrawing before `unlockTime` always
  reverts with `StillLocked`, for plain and proof withdrawals alike —
  proven by fuzz tests over arbitrary amounts, durations and elapsed
  times.
- **No double withdrawal.** Each lock pays at most once:
  `lock.withdrawn` is set before the external call
  (checks-effects-interactions), and a second withdrawal reverts with
  `AlreadyWithdrawn`. A reentrancy test with a malicious receiver proves
  a reentrant withdraw cannot succeed.
- **Per-owner isolation.** Lock ids are per-owner and withdrawals are
  `msg.sender`-gated: nobody can withdraw another owner's lock.

## Audit — QCAI stage 1

- **Run:** 19 Nov 2026, QoreChain dashboard QCAI, source
  `flattened/QuantumVault.flattened.sol` (311 lines, no mocks).
- **Result: score 85/100, risk MEDIUM, quantum readiness QUANTUM-SAFE,
  4 findings.** Full report: `docs/QCAI-audit-stage1.pdf`.
- **Cost:** 150 QOR (testnet).
- **Triage:** `docs/QCAI-stage1-triage.md` — the full verdict per
  finding, with evidence. Summary:

| # | Severity | Finding | Verdict |
|---|----------|---------|---------|
| 1 | HIGH | Potential ML-DSA key reuse (`withdrawWithProof`) | False positive — the verified key IS the registered key, read from `pqcKeyStatus` in the same call; no caller-supplied key exists in the path |
| 2 | MEDIUM | Reentrancy risk in `_withdraw` | Not exploitable — checks-effects-interactions; a guard would need a redeploy orphaning the live drill lock, not justified for a path the code already blocks |
| 3 | LOW | Signature verification digest mismatch | False positive — `abi.encodePacked(bytes32)` is exactly the 32 digest bytes; proven by two live proof withdrawals |
| 4 | INFO | No emergency withdrawal mechanism | Accepted by design — no owner/admin/pause is the vault's core design |

No finding required a code change. No redeploy. Stage 2 (deeper review)
was scheduled for 20 Nov 2026 at the time of writing; its results are not
in this document yet.

## Known limitations

Stated honestly — these are real, and none of them is mitigated by
anything beyond what is written here.

1. **No emergency pause or recovery, by design.** There is no pause, no
   admin withdrawal, and no upgrade path. If a bug were found in the
   deployed contract, it could not be patched in place; funds would
   remain governed by the deployed code until each lock's unlock time.
2. **Plain `withdraw()` relies on persistent possession status.**
   `_withdraw` checks the `possessionProven` flag returned by
   `pqcKeyStatus` — a fact established once, at key registration — not a
   fresh proof of possession per withdrawal. Only `withdrawWithProof`
   demands a fresh ML-DSA signature over the withdrawal intent. Users
   who want per-withdrawal proof should use `withdrawWithProof`.
3. **A lost ML-DSA key means unrecoverable funds.** If the key owner
   loses their ML-DSA key, the funds in that account's locks cannot be
   withdrawn by anyone. A production vault would need a key-rotation or
   social-recovery story; this contract deliberately has none.
4. **No reentrancy guard.** `_withdraw` relies on
   checks-effects-interactions (state updated before the external call)
   rather than a guard. This is the accepted risk from QCAI finding 2:
   a reentrant call on the same lock reverts with `AlreadyWithdrawn`,
   and the reentrancy test proves it — but there is no guard as a second
   line of defence.
5. **Timelock granularity.** `block.timestamp` can be shifted a few
   seconds by a block proposer. A lock is not a second-exact deadline.
6. **The EVM window is not checked by the contract.** Layer 1 of the
   defence exists only because the chain refuses transactions outside a
   window. If the chain's window enforcement were ever weakened, the
   contract would not notice; layers 2 and 3 would remain.
7. **Deposits are permissionless and self-directed.** Anyone may deposit
   for themselves without a PQC key (only withdrawals are sensitive),
   and a deposit always locks under `msg.sender` — there is no way to
   deposit for someone else.
8. **Tests use mock precompiles, not real ML-DSA.** The local suites
   etch mock precompiles onto 0x0A01/0x0A02 and therefore prove the
   contract's logic (which key it passes, which digest it builds, when
   it reverts) — not the cryptography. The cryptography itself is
   verified live on Diana: two proof withdrawals with real 4,627-byte
   ML-DSA-87 signatures verified on chain.

## Test coverage

Verified 19 Nov 2026, all passing:

- **25 Hardhat tests** (`test/QuantumVault.test.ts`) — every revert
  path, both withdrawal kinds, digest construction, key-gate behaviour.
  Run: `npm test`.
- **Foundry suite** (`test/foundry/`, run: `forge test` or
  `npm run test:forge`):
  - 3 handler-based invariants (`QuantumVaultInvariant.t.sol`) — 256
    runs x 100 calls = 25,600 calls across 4 actors (deposits, plain
    withdrawals, proof withdrawals and time warps in roughly equal
    shares; the exact split varies by fuzz seed): conservation, lock
    accounting against an independent ghost mirror, and
    no-early-withdrawal.
  - 5 fuzz tests (`QuantumVaultFuzz.t.sol`), 256 runs each: no early
    withdrawal (plain and proof), withdrawal after unlock (plain and
    proof), deposit/withdraw conservation.
  - 2 unit tests: reentrancy cannot double-withdraw a lock; the
    handler's early-withdrawal counters work as intended.
- **Live on Diana:** 6 locks, 2.0 QOR deposited, 1.25 QOR withdrawn
  (locks 3 and 4 with ML-DSA-87 proofs), 0.75 QOR locked, contract
  balance 0.75 QOR — zero discrepancy (verified 19 Nov 2026; see
  `deployments/usage.json`, `deployments/withdraw-lock4.json` and
  `deployments/drill-deposit.json`).

## Reporting a vulnerability

This is a testnet project for the QoreChain Developer Fest. Please
report security issues via GitHub Issues on this repository. Do not
include private keys or mnemonics in any report.
