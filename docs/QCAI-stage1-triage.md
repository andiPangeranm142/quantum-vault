# QCAI audit — stage 1 triage (19 Nov 2026)

- Audit: QoreChain dashboard QCAI, Blockchain = QoreChain, source
  `flattened/QuantumVault.flattened.sol` (311 lines, no mocks), run 19 Nov 2026.
- Result: **score 85/100, risk MEDIUM, quantum readiness QUANTUM-SAFE,
  4 findings.** Report: `docs/QCAI-audit-stage1.pdf`.
- Cost: 150 QOR (testnet, confirmed on the dashboard).
- Stage 2 (deeper review): scheduled 20 Nov 2026 (next UTC day).

## Finding 1 — HIGH — Potential ML-DSA Key Reuse Vulnerability (withdrawWithProof)

**Verdict: FALSE POSITIVE — no code change.**

`_withdraw` reads the public key from the `pqcKeyStatus` precompile return
for `msg.sender` — i.e. the key registered on chain for that account — and
passes exactly that key to `pqcVerify`. There is no caller-supplied key
anywhere in the path; a signature produced by any other key fails
verification and the transaction reverts. The recommendation ("add explicit
checks that the public key used in verification exactly matches the
registered key") is already satisfied by construction: the verified key IS
the registered key, read from the chain in the same call. The digest is
domain-separated per chain, contract, owner, lock and amount, so the key is
never reused across contexts. Evidence: two live proof withdrawals
(locks 3 and 4) verified on chain.

## Finding 2 — MEDIUM — Reentrancy Risk in Withdrawal Process (_withdraw)

**Verdict: NOT EXPLOITABLE as designed — accepted risk, no code change.**

`_withdraw` follows checks-effects-interactions: `lock.withdrawn = true`,
totals updated, event emitted — all before the external `call`. A reentrant
`withdraw()` on the same lock reverts with `AlreadyWithdrawn`; each lock
pays at most once. A reentrancy guard would require redeploying the
contract, which would orphan the live locks (including the 0.5 QOR Q-Day
Drill lock, unlocks 18 Dec 2026) — not justified for an attack path the
code already blocks.

## Finding 3 — LOW — Signature Verification Digest Mismatch (withdrawWithProof)

**Verdict: FALSE POSITIVE — no code change.**

`abi.encodePacked(digest)` with `digest` a `bytes32` produces exactly the
32 bytes of the digest — identical to passing the digest directly. Signing
and verification operate on the same 32 bytes. Empirically proven: two live
proof withdrawals (lock 3, block 10151383; lock 4, block 10335795) verified
on chain with 4,627-byte ML-DSA-87 signatures.

## Finding 4 — INFO — No Emergency Withdrawal Mechanism (design)

**Verdict: ACCEPTED BY DESIGN — no code change.**

No owner, no admin, no pause, no upgrade path is the vault's core design,
documented in the README ("Honest limitations") and the contract NatSpec.
Any recovery mechanism would be a privileged backdoor. A lost ML-DSA key
means unrecoverable funds — disclosed, not hidden.

## Summary

| # | Severity | Verdict |
|---|----------|---------|
| 1 | HIGH | False positive |
| 2 | MEDIUM | Not exploitable (checks-effects-interactions); accepted risk |
| 3 | LOW | False positive |
| 4 | INFO | Accepted by design |

No finding requires a code change. No redeploy. Stage 2 will re-assess.
