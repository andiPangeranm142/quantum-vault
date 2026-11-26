# QCAI audit — stage 3 triage (26 Nov 2026)

- Audit: QoreChain dashboard QCAI, Blockchain = QoreChain, source
  `flattened/QuantumVault.flattened.sol` (identical source to stages 1 and 2,
  no test code), run 26 Nov 2026 16:16 WIB (fresh browser session, no re-login
  needed — session still active; no "No wallet found", no silent failure).
- Result: **score 85/100, risk MEDIUM, quantum readiness QUANTUM-SAFE,
  5 findings.** Report: `docs/QCAI-audit-stage3.pdf`. Score, risk and
  readiness are IDENTICAL to stage 1 (19 Nov) and stage 2 (20 Nov) —
  **85/100 x3**.
- Cost: 150 QOR testnet + 0.045 gas (fee tx
  E3BC40253DA3EA0B51B89C88F0488D13FDC2DE59B98977D140C54F46DFA4B5A5, block
  #10780158, memo "AI Contract Audit Fee (testnet)", to fee address
  qor1wv0fvt5qzx7gllk9ckzv3u6ypceaqq8evuny0h). Dashboard wallet
  qor14pwajnz3pn6uzxkchjv856q8639m6uve6hwmc4 topped up +150 QOR from the
  deployer first (tx B2FF0A60F88FE0FC2D033CB6A779E003A9B9F36753DF1E991AF766AA49658E1D),
  balance after: 8.605 QOR (on-chain verified).
- Context: 85/100 is the effective ceiling of this tool for our design —
  Quantum Vault ties Fenestella's 85/100 (x2), the best known QCAI score
  fest-wide. Three identical runs on identical source confirm stability.

## Stage 3 vs stage 2

| # | Stage 3 finding | Stage 2 equivalent | Change |
|---|---|---|---|
| 1 | HIGH — Missing Quantum-Resistant Key Verification in Deposit Function | Finding 1 (HIGH "Missing ML-KEM", same underlying theme) | Retitled; same misunderstanding, now aimed at deposit() instead of the contract generally |
| 2 | MEDIUM — Reentrancy Risk in Withdrawal Process | Finding 2 (MEDIUM reentrancy, same) | Identical, third run in a row |
| 3 | LOW — Signature Verification Dependency on Precompile Availability | Finding 3 (MEDIUM precompile dependency) | Downgraded MEDIUM → LOW; same theme |
| 4 | INFO — Lock ID Management | — | NEW (cosmetic) |
| 5 | INFO — Error Message Clarity | — | NEW (cosmetic) |

Gone since stage 2: the LOW "no emergency withdrawal" flag — the stage-3
auditor no longer flags the absence of an emergency withdrawal, corroborating
the stage-2 verdict that it is a deliberate design choice (no owner, no admin,
no privileged function), not a gap.

## Triage (0 findings need a code change)

1. **HIGH — deposit() has no quantum-resistant key verification: NOT
   APPLICABLE, by design.** Deposits deliberately need no PQC key: only
   withdrawals are sensitive, and anyone may lock funds in for themselves.
   Requiring an ML-DSA key at deposit would block legitimate deposits and
   add nothing — funds can only leave via a withdrawal by the lock's owner,
   after its unlock time, gated by the registered-key check plus (optionally)
   an on-chain-verified ML-DSA signature. The auditor's own executive
   summary concedes the contract "maintains a clear separation of concerns
   between deposit and withdrawal operations". No change.
2. **MEDIUM — reentrancy in _withdraw(): FALSE POSITIVE, third run in a
   row.** `_withdraw` is checks-effects-interactions: every state change
   (`withdrawn = true`, `totalLocked`/`totalWithdrawn` updates, `Withdrawn`
   event) happens BEFORE the single external call. The auditor's own
   recommendation — "ensure that all state changes occur before external
   calls" — is exactly what the code already does. A reentrancy guard would
   be redundant. No change.
3. **LOW — signature verification depends on precompile availability: BY
   DESIGN.** The precompiles (0x0A01 pqcVerify, 0x0A02 pqcKeyStatus) are
   chain-level, always available on Diana. A "fallback mechanism" that let
   withdrawals proceed without the PQC check would bypass the security gate
   itself — strictly worse. No change.
4. **INFO — Lock ID Management: COSMETIC.** Lock IDs are per-owner,
   sequential from 0 in deposit order — deterministic, unambiguous, no
   collision possible. A "more sophisticated ID generation mechanism" adds
   complexity for zero benefit. No change.
5. **INFO — Error Message Clarity: COSMETIC.** Custom errors already carry
   parameters (owner, lockId, amounts, unlock times). No change.

## Conclusion

Three independent QCAI runs on identical source (19, 20, 26 Nov 2026) all
score 85/100 MEDIUM QUANTUM-SAFE. Every finding across all three runs is
either a false positive, not applicable by design, or cosmetic. **No code
change, no redeploy.** The contract is final as deployed
(0x0abdb86be55eb51cb090fd736651dff56d57715a).
