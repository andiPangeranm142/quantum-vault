# Flattened contract for the QCAI audit

`QuantumVault.flattened.sol` is the deployed contract's source, flattened
with `npx hardhat flatten contracts/QuantumVault.sol` — the real contract
only, plus its (zero) dependencies. The contract has no imports, so the
flattened file is the single source file with a Hardhat header.

**No test mocks are included.** `contracts/mocks/` (`MockPqcKeyStatus`,
`MockPqcVerify`) exists only for the Hardhat test suite and is deliberately
excluded: the audit must assess exactly what is deployed at
`0x0abdb86be55eb51cb090fd736651dff56d57715a` on Diana testnet (chain id 9800).

Regenerate after any contract change (and redeploy + re-verify first — the
flattened file must always match the deployed bytecode):

```bash
npx hardhat flatten contracts/QuantumVault.sol > flattened/QuantumVault.flattened.sol
```

## Running the QCAI audit (two-stage, the dApp category's main requirement)

The audit is run from the QoreChain dashboard — **not** from this repo, and
not by an automated script. Steps:

1. Open https://dashboard.qorechain.io/audit and sign in with the project
   account.
2. Start a new audit for the Quantum Vault project and upload
   `flattened/QuantumVault.flattened.sol` as the contract source.
3. Set **Blockchain = QoreChain** so the quantum-readiness assessment runs
   against QoreChain's post-quantum surface (the `pqcKeyStatus` / `pqcVerify`
   precompiles this contract relies on). Without it, the audit cannot judge
   the quantum layer.
4. Run the audit's two stages (automated scan, then the deeper review) and
   wait for both to complete.
5. **Export the audit PDF** and keep it with the project records
   (`docs/` in this repo, or the fest project page attachments).
6. **Triage every finding:**
   - Confirm whether each finding applies to the deployed contract or is a
     false positive (e.g. findings about the precompile interfaces, which
     were verified against the live Diana precompiles — see the README's
     "The precompile interfaces" section).
   - Fix real findings in `contracts/QuantumVault.sol`, re-run the full
     test suite (`npm test`, 25 tests), redeploy, re-flatten, and re-run
     the audit on the new source.
   - Record the triage outcome (fixed / false positive with reason /
     accepted risk with reason) alongside the PDF.

## Known context for the auditor

- The contract has no owner, no admin, no pause and no upgrade path, by
  design. There is no emergency withdrawal.
- Withdrawals require (1) a chain-gated EVM authorisation window, (2) a
  registered ML-DSA key with proven possession (`pqcKeyStatus` precompile,
  0x0A02), and (3) for `withdrawWithProof`, an ML-DSA-87 signature over the
  exact withdrawal digest verified via the `pqcVerify` precompile (0x0A01)
  against the *registered* public key — never a caller-supplied one.
- The `pqcKeyStatus` precompile returns **four** values since chain v3.2.4
  `(registered, algorithmId, pubkey, possessionProven)`; the
  `@qorechain/evm` 0.14.0 type definitions still describe only three. The
  four-value interface in this contract was verified against the live Diana
  precompile with raw `eth_call`s before the contract was written.
- Lock timing is enforced by `block.timestamp` (proposer-shiftable by a few
  seconds); locks are for savings horizons, not second-exact deadlines.
- A lost ML-DSA key means unrecoverable funds — there is no recovery
  backdoor, by design. This is documented in the README's "Honest
  limitations" section.
