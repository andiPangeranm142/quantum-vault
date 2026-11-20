# QCAI audit — stage 2 triage (20 Nov 2026)

- Audit: QoreChain dashboard QCAI, Blockchain = QoreChain, source
  `flattened/QuantumVault.flattened.sol` (311 lines, no mocks — same source
  as stage 1), run 20 Nov 2026. The dashboard offers no stage 2 / deeper
  review option on an existing result and keeps no audit history, so stage 2
  was run as a new audit with the identical source.
- Result: **score 85/100, risk MEDIUM, quantum readiness QUANTUM-SAFE,
  5 findings (1 HIGH, 2 MEDIUM, 1 LOW, 1 INFO).** Report:
  `docs/QCAI-audit-stage2.pdf` (generated 20 Nov 2026 08:08:24 AM).
- Cost: 150 QOR (testnet, confirmed on the dashboard) — same as stage 1.
  No real payment / mainnet funds requested.
- Score unchanged vs stage 1 (85/100, MEDIUM, QUANTUM-SAFE). Stage 2
  dropped stage 1's findings 1 (HIGH, key reuse) and 3 (LOW, digest
  mismatch) — both false positives — repeated 2 findings (reentrancy,
  no emergency withdrawal) and added 3 new ones (ML-KEM, precompile
  dependency, signature validation).

## Finding 1 — HIGH — Missing ML-KEM Support

**Verdict: NOT APPLICABLE — no code change.**

ML-KEM is a key-encapsulation mechanism for encryption. This contract
holds no confidential data: lock amounts, unlock times, owner addresses
and ML-DSA public keys are all public on chain by design. There is no
plaintext to encrypt, so there is nothing for ML-KEM to protect. The
vault needs authentication only — which ML-DSA provides — not
confidentiality. The finding conflates "quantum-safe" with "must use
every PQC primitive". Implementing ML-KEM would add code and attack
surface while protecting nothing.

## Finding 2 — MEDIUM — Reentrancy Risk in Withdrawal Path (_withdraw)

**Verdict: NOT EXPLOITABLE as designed — accepted risk, no code change.**
(Repeat of stage 1 finding 2.)

`_withdraw` already follows checks-effects-interactions: `lock.withdrawn
= true`, totals updated, event emitted — all before the external `call`.
The report's own recommendation ("updating state before the external
call") is already satisfied by the code. Cross-lock reentrancy cannot
steal: `_locks` is per `msg.sender`, each lock pays at most once, and a
reentrant call could only withdraw the attacker's own other locks to
themselves. Live evidence: standard withdraw of lock 1 (block 10151381)
and proof withdrawals of locks 3 (block 10151383) and 4 (block 10335795)
each settled exactly once — lock 4's record shows contract balance
0.85 → 0.75 QOR and totalWithdrawn 1.15 → 1.25 QOR, exactly the lock
amount. A reentrancy guard would require redeploying the contract, which
would orphan the live locks (including the 0.5 QOR Q-Day Drill lock,
unlocks 18 Dec 2026) — not justified for an attack path the code already
blocks.

## Finding 3 — MEDIUM — Signature Verification Dependency on Precompile

**Verdict: ACCEPTED — platform dependency, no contract-level fix.**

ML-DSA verification on QoreChain is exposed only through the pqcVerify
precompile (0x0A01); key status only through pqcKeyStatus (0x0A02).
There is no feasible pure-Solidity ML-DSA-87 verifier (enormous gas,
itself unaudited). If the precompiles were compromised, the chain's own
hybrid-signed window gating (layer 1) would fail too — this is a
systemic, chain-level risk, not a contract-specific one. Mitigations in
place: the verified key is read from the chain per call (never
caller-supplied), possession-proven is required, and the signed digest
is domain-separated per chain, contract, owner, lock and amount. No code
change is possible inside the contract.

## Finding 4 — LOW — No Emergency Withdrawal Mechanism (design)

**Verdict: ACCEPTED BY DESIGN — no code change.**
(Repeat of stage 1 finding 4, raised INFO → LOW.)

No owner, no admin, no pause, no upgrade path is the vault's core
design, documented in the README ("Honest limitations") and the contract
NatSpec. Any recovery mechanism would be a privileged backdoor. A lost
ML-DSA key means unrecoverable funds — disclosed, not hidden.

## Finding 5 — INFO — Missing Input Validation for Signature Data

**Verdict: ACCEPTED — low value, no code change.**

A malformed or wrong-length signature passed to `pqcVerify` simply
returns false and the call reverts with `InvalidProof()` — before any
state change. The only cost is the caller's own gas on a doomed call;
there is no state corruption or gas-exhaustion vector against anyone
else. A 4,627-byte length check would be defense-in-depth only, and
adding it requires a redeploy that orphans live locks — not justified.
Live proof withdrawals used exactly 4,627-byte ML-DSA-87 signatures
(lock 4 record: `signatureBytes: 4627`). Candidate for a future v2 if
the contract is ever redeployed for other reasons.

## Summary

| # | Severity | Verdict |
|---|----------|---------|
| 1 | HIGH | Not applicable (no data to encrypt) |
| 2 | MEDIUM | Not exploitable (checks-effects-interactions); accepted risk |
| 3 | MEDIUM | Accepted (chain-level precompile dependency) |
| 4 | LOW | Accepted by design |
| 5 | INFO | Accepted (invalid input reverts harmlessly) |

No finding requires a code change. No redeploy. Contract unchanged
since stage 1; live state verified from repo records (locks 1/3/4
withdrawn exactly once; drill lock 0.5 QOR locked until 18 Dec 2026).
