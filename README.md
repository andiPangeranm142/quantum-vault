# Quantum Vault

A time-locked savings vault on the QoreChain testnet — built for the
[QoreChain Developer Fest](https://build.qorechain.io) ("Build Before Q-Day"),
**Post-Quantum dApp** category.

Deposit QOR locked until a time you choose. Withdrawals are the sensitive
action, and they receive post-quantum protection on three independent layers:

1. **Chain-gated window.** Every EVM transaction on QoreChain is admitted
   only inside a post-quantum authorisation window opened by a hybrid-signed
   (secp256k1 + ML-DSA-87) native message. A leaked ECDSA key alone cannot
   send any transaction at all — including a withdrawal — because it cannot
   open a window.
2. **Contract-verified key.** Before releasing funds, the contract calls the
   `pqcKeyStatus` precompile (0x0A02) for the withdrawer and requires a
   registered ML-DSA key whose possession was proven at registration.
3. **Proof withdrawal (optional, stronger).** `withdrawWithProof` additionally
   requires an ML-DSA-87 signature over the exact withdrawal intent — chain,
   contract, withdrawer, lock id and amount — verified on chain via the
   `pqcVerify` precompile (0x0A01) against the *registered* public key (never
   a caller-supplied one). A stolen window cannot be abused for a withdrawal
   the key owner never signed, because the signature commits to the exact
   withdrawal.

The contract holds deposited funds and has no owner, no admin and no
privileged function: nobody — not even the deployer — can move funds except
through a withdrawal by the lock's owner after its unlock time. There is no
emergency withdrawal, no pause and no upgrade path, by design.

- **Live demo:** https://andipangeranm142.github.io/quantum-vault/
- **Contract (Diana testnet):** `0x0abdb86be55eb51cb090fd736651dff56d57715a`
  ([explorer](https://explore.qore.network/address/0x0abdb86be55eb51cb090fd736651dff56d57715a) — switch to Testnet)
- **Demo video:** [`docs/demo.mp4`](docs/demo.mp4) — a real screen recording
  of the live demo being used (deposit + withdrawal + explorer proof).
- **Fest project page:** https://build.qorechain.io/p/quantum-vault

## Live usage (Diana testnet)

All of it is real on-chain usage by the deployer account, recorded in
[`deployments/usage.json`](deployments/usage.json) (EVM + Cosmos hashes):

| Step | Amount | Result |
| --- | --- | --- |
| Deposit, 90s lock (first usage run) | 0.5 QOR | lock 0 |
| Deposit, 90s lock | 0.5 QOR | lock 1 |
| Deposit, 7-day lock | 0.25 QOR | lock 2 (withdrawn 23 Nov 2026) |
| Deposit, 90s lock | 0.15 QOR | lock 3 |
| Withdraw lock 1 (standard) | 0.5 QOR | `0xd88353bf…2bdf74` |
| Withdraw lock 3 (with ML-DSA-87 proof) | 0.15 QOR | `0xbb908fc5…50a2a` |
| Withdraw lock 0 (standard, live in the demo video) | 0.5 QOR | `0x63a7e34a…e1738` |
| Deposit, 5-min lock (live in the demo video) | 0.1 QOR | lock 4 |
| Deposit, 30-day lock (Q-Day Drill proof, drill account) | 0.5 QOR | drill-account lock 0, unlocks 2026-12-18 |
| Withdraw lock 4 (with ML-DSA-87 proof) | 0.1 QOR | `0xfb7f4f1c…f183ec` |
| Withdraw lock 2 (with ML-DSA-87 proof) | 0.25 QOR | `0x60fb99e6…571dd` |

Totals after the lock-2 withdrawal (23 Nov 2026): 2.0 QOR deposited, 1.5 QOR
withdrawn, 0.5 QOR locked across 6 locks — the only remaining lock is the
drill lock (0.5 QOR, 30-day, unlocks 2026-12-18). Lock 2 (0.25 QOR, 7-day lock)
was withdrawn 23 Nov 2026 via `withdrawWithProof` (4,627-byte ML-DSA-87 proof,
tx `0x60fb99e6…571dd`, block 10582783, recorded in
[`deployments/withdraw-lock2.json`](deployments/withdraw-lock2.json)); lock 4
(0.1 QOR, 5-minute lock) was withdrawn 19 Nov 2026 via `withdrawWithProof`
(4,627-byte ML-DSA-87 proof, tx `0xfb7f4f1c…f183ec`, block 10335795, recorded in
[`deployments/withdraw-lock4.json`](deployments/withdraw-lock4.json)); the
drill lock (0.5 QOR, 30-day) unlocks 2026-12-18T00:59:57Z (drill proof tx
`0xb8d33f02…d63d5`, block 10286542, recorded in
[`deployments/drill-deposit.json`](deployments/drill-deposit.json)).

## Security audit (QCAI)

The contract source prepared for the QCAI two-stage audit (the dApp
category's main requirement) is in [`flattened/`](flattened/) — the real
contract only, no test mocks. See
[`flattened/README.md`](flattened/README.md) for the audit steps. The audit
itself is run from the QoreChain dashboard, not from this repo.

## How it works

### Deposits

`deposit(uint256 unlockTime)` is payable. The unlock time must be in the
future and at most 730 days ahead; the minimum deposit is 0.001 QOR (a dust
guard). Each deposit creates a new lock — lock ids are per-owner, sequential
from 0 — so one account can hold several locks with different unlock times.
Deposits need no PQC key: only withdrawals are sensitive, and anyone may lock
funds in for themselves.

### Withdrawals

`withdraw(uint256 lockId)` releases a lock's funds to its owner once
`block.timestamp >= unlockTime`, and only when the `pqcKeyStatus` precompile
reports a registered ML-DSA key with proven possession for the caller.

`withdrawWithProof(uint256 lockId, bytes signature)` does the same, plus an
on-chain ML-DSA verification: the signature must be valid (via the
`pqcVerify` precompile) for the *registered* pubkey over the digest returned
by `withdrawalDigest(owner, lockId, amount)` — `keccak256("QuantumVault.withdraw"
‖ chainId ‖ contract ‖ owner ‖ lockId ‖ amount)`. The digest is
domain-separated per chain, contract, owner, lock and amount, and single-use
by construction (a withdrawn lock cannot be withdrawn again), so a proof
cannot be replayed anywhere else.

### The precompile interfaces (verified live, not from the SDK docs)

The `pqcKeyStatus` precompile returns **four** values since chain v3.2.4 —
`(bool registered, uint8 algorithmId, bytes pubkey, bool possessionProven)`.
The `@qorechain/evm` 0.14.0 type definitions still describe only three.
Both interfaces used here were verified against the live Diana precompiles
with raw `eth_call`s before the contract was written:

- `pqcKeyStatus` on a registered account returns 2,752 bytes decoding to
  `(true, 1, 2592-byte pubkey, true)`; on an unregistered account it returns
  `(false, 0, empty, false)`.
- `pqcVerify` over a signature produced by the SDK's `pqcSign` returns true
  for the signed message and false for a different message.

## Honest limitations

- **Timelock granularity.** The lock is enforced by `block.timestamp`, which
  a block proposer can shift by a few seconds. Locks are for savings
  horizons, not second-exact deadlines.
- **The window is enforced by the chain, not the contract.** Native window
  state is not observable from the EVM, so the contract cannot check whether
  a window is open — it relies on the chain refusing transactions outside
  one. That is a property of QoreChain, not of this code.
- **A lost ML-DSA key means unrecoverable funds.** If the key owner loses
  their ML-DSA key, the funds in that account's locks cannot be withdrawn by
  anyone. There is no recovery backdoor, by design — but it is a real risk
  for a real vault, and a production version would need a key-rotation or
  social-recovery story.
- **Testnet only.** Nothing here has real value. Assurance comes from the
  test suite (25 Hardhat tests, including mocked-precompile tests of every
  revert path, plus a Foundry suite: 3 handler-based invariants over 256
  runs / 25,600 calls, 5 fuzz tests at 256 runs each, 2 unit tests), the
  QCAI stage 1 audit (85/100, MEDIUM, QUANTUM-SAFE — see
  [docs/QCAI-stage1-triage.md](docs/QCAI-stage1-triage.md)), and the live
  verification described above.

## Development

Prerequisites: Node 20+ and npm. The deployer account needs testnet QOR and
a registered ML-DSA-87 key; registration must be the account's very first
transaction.

```bash
npm install
npm test            # 25 Hardhat tests (local network, mocked precompiles)
npm run test:forge  # Foundry suite: invariants + fuzz + unit (needs Foundry)
npm run typecheck   # both tsconfigs (Hardhat side + Vite app side)
```

Secrets live **outside** this repo, in `../.env` (mode 600) — see
`.env.example`. Never commit a real mnemonic or private key.

```bash
npm run window status    # check the PQC key and the EVM window
npm run window register  # register the ML-DSA-87 key (once, first tx)
npm run window open      # open a 1200-block / 10-tx authorisation window
npm run compile          # compile the contracts (Hardhat)
npm run deploy           # deploy to Diana testnet
npm run usage            # real on-chain usage: deposits + both withdrawals
npm run check-state      # read-only on-chain state check (no keys, no tx)
```

### Frontend

```bash
VITE_QUANTUM_VAULT_ADDRESS=0x0abdb86be55eb51cb090fd736651dff56d57715a npm run dev
```

The demo is a Vite + React app (wagmi + RainbowKit, QoreX recommended).
`vite.config.ts` sets `base: "/quantum-vault/"` — without it, a plain build
emits root-absolute asset URLs that 404 on GitHub Pages. The EVM window
status is read over the native-lane REST API through the dev server's proxy;
on a plain static host that read fails gracefully while deposits and
withdrawals still work with an already-open window.

## Layout

```
contracts/QuantumVault.sol        the vault + the two precompile interfaces
contracts/mocks/                  MockPqcKeyStatus + MockPqcVerify (tests only)
flattened/QuantumVault.flattened.sol  flattened contract source for the QCAI audit
flattened/README.md               QCAI audit steps (run from the dashboard)
test/QuantumVault.test.ts         25 Hardhat tests (mocked precompiles via hardhat_setCode)
test/foundry/                     Foundry suite: handler invariants, fuzz tests, reentrancy test
scripts/window.ts                 PQC key registration + EVM window management
scripts/deploy.ts                 deploy to Diana testnet
scripts/usage.ts                  real on-chain usage (deposits + both withdrawals)
scripts/withdraw-lock4.ts         withdraw lock 4 with an ML-DSA-87 proof (19 Nov)
scripts/drill-deposit.ts          Q-Day Drill deposit (0.5 QOR, 30-day lock)
scripts/check-state.ts            read-only on-chain state check
scripts/cosmos-hash.ts            EVM tx hash -> Cosmos tx hash (explorer links)
scripts/gen-abi.ts                generate src/contract.ts from the Hardhat artifact
src/                              Vite + React demo app
docs/demo.mp4                     demo video (real screen recording)
docs/featured.png                 featured image
deployments/testnet.json          deployment record (contract, tx hashes)
deployments/usage.json            on-chain usage evidence (tx hashes, totals)
deployments/drill-deposit.json    Q-Day Drill deposit record
deployments/withdraw-lock4.json   lock-4 proof-withdrawal record (19 Nov)
```

## License

Apache-2.0. See [LICENSE](LICENSE).
