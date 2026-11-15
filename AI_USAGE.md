# AI Usage — Quantum Vault

This file documents how AI was used to build Quantum Vault, what the AI
generated, what the human contributed, and how the work was verified. It
exists for the QoreChain Developer Fest's **Best AI-Native Build** award,
and as an honest development record.

## Summary

Quantum Vault was built end-to-end by an AI coding agent (**Muse**, running
as the assistant "forza") from a one-line human decision ("we should enter
the other categories too"), over a single build session on 15–16 November
2026. The human (Aeron) chose the event, approved the multi-project plan
and the vault concept, and owns every step that needs a human identity:
accounts, funding, registration, and submission. No code was copied from
any other fest project: the vault concept (time-locked savings with
post-quantum withdrawal authorization) is original, and it is distinct
from escrow (no counterparty, no release conditions beyond time and the
owner's own key) and from the author's own Quantum Flip (a coin-flip game).

## Workflow

1. **Research first, code second.** The agent studied the author's own
   Quantum Flip repo (window management, deployment, frontend, video
   pipeline) and the fest site's Post-Quantum dApp category requirements
   (scoped EVM window, pqcVerify, Foundry/Hardhat tests) before writing
   anything.
2. **Never trust the SDK docs over the live chain.** Both precompile
   interfaces were verified against the live Diana chain with raw
   `eth_call`s before the contract was written: `pqcKeyStatus` returns
   four values since chain v3.2.4 (the `@qorechain/evm` 0.14.0 type
   definitions still describe three), and `pqcVerify` returns true for a
   signature produced by the SDK's `pqcSign` and false for a different
   message. The contract encodes the verified live behavior, not the
   stale type definitions.
3. **Verify at every step.** Hardhat compile; 25 Hardhat tests on a local
   network with mocked precompiles installed at their real addresses via
   `hardhat_setCode`; `tsc --noEmit` on both tsconfigs; `vite build` for
   the frontend; a Playwright render check of the live demo after every
   deploy. On-chain verification was done the same session: the contract
   deployed at `0x0abdb86be55eb51cb090fd736651dff56d57715a`, and every
   transaction hash in this repo was read back from the chain. Nothing in
   this repo claims an on-chain result that has not happened.
4. **Secrets discipline.** A fresh testnet-only wallet was generated for
   this project (funded with 5 testnet QOR); its mnemonic and private key
   live only in a mode-`600` file outside the repo (`../deployer.json`,
   `../.env`). The repo was checked for secrets before every commit (see
   below). The deployer wallet of Quantum Flip and the Q-Day Drill wallet
   were never touched by this build.

## What the AI generated

- `contracts/QuantumVault.sol` — the vault contract (original design:
  per-owner time-locked deposits; withdrawals gated on the pqcKeyStatus
  precompile; an optional proof withdrawal verified via pqcVerify).
- `contracts/mocks/MockPqcKeyStatus.sol`, `MockPqcVerify.sol` — local
  precompile stand-ins for tests (registry-driven, tests only).
- `test/QuantumVault.test.ts` — 25 Hardhat tests (deposit rules, every
  withdrawal revert path, proof wiring including wrong-pubkey and
  wrong-digest rejection, digest construction, views).
- `scripts/deploy.ts`, `scripts/usage.ts`, `scripts/cosmos-hash.ts`,
  `scripts/gen-abi.ts` — deployment, real on-chain usage, explorer-hash
  resolution, ABI generation.
- `scripts/window.ts` — the PQC key registration + EVM window helper,
  reused from the author's Quantum Flip repo (the author's own code).
- `src/*` — the React frontend (vault totals, deposit form, lock list with
  countdowns, PQC key status, EVM window status), following the Quantum
  Flip frontend pattern.
- `README.md`, this file, `.gitignore`, `.env.example`, `LICENSE`
  (Apache-2.0 text).
- `docs/demo.mp4` — recorded with Playwright in one take (real app, real
  testnet transactions, 1080p, 100.8 s, burned-in captions; the recording
  pipeline — wallet bridge, recorder, render script — lives outside this
  repo next to the project workspace); `docs/featured.png` — generated
  featured image.

## Debugging the AI did (and how)

Four real problems were found and fixed during the build, all by reading
error output and source rather than guessing:

1. **npm install failed with EPERM.** A manifest fetch failed writing to
   the npm cache (an overlay-filesystem quirk on this machine). The cache
   wrote fine on retry; the install succeeded on the second attempt.
2. **Hardhat refused an ESM package.** Hardhat 2 cannot load a `.ts`
   config in a `"type": "module"` package. Fix: remove the `"type"` field
   (Vite and tsx handle ESM syntax regardless) and split the TypeScript
   config in two — CommonJS for the Hardhat side (including
   `typechain-types`, which is what types `getContractFactory`), ESNext /
   Bundler for the Vite app side.
3. **Solidity rejected `@` in doc comments and `""` as bytes.** NatSpec
   parses `@qorechain/...` as a documentation tag; the package names were
   reworded without `@`. The shared internal withdrawal path now takes
   `bytes memory` instead of `bytes calldata` so the no-proof path can
   pass an empty signature.
4. **An import side effect deployed a second contract.** `usage.ts`
   imported a helper from `deploy.ts`, whose top-level `main()` ran on
   import and deployed a second, empty contract — and a `JSON.stringify`
   of a BigInt argument then crashed the usage run mid-way. Fix: the
   helper moved to a side-effect-free module (`scripts/cosmos-hash.ts`),
   BigInt-safe JSON logging, and the usage script made re-runnable
   (it reads the current lock count first). The second contract
   (`0xa786fd2a…1f54`) is empty and unused; the canonical contract is the
   first deployment, `0x0abdb86b…715a`, which holds all the usage. The
   first run's deposit (lock 0, 0.5 QOR) was withdrawn live in the demo
   video instead of by the script.
5. **The video's first take failed its own safety check.** The record
   script checked for the lock list immediately after the "Post-quantum
   key: registered" line appeared — but the locks query resolves a few
   seconds later (separate wagmi query). Fix: wait explicitly for the
   lock list before checking, and fail loudly if lock 0 is not unlocked.
   A second issue in the same take: the app's "EVM window: live" line
   reads the native-lane REST API through the dev server's proxy, and
   vite preview's proxy cannot reach it (it does not use the sandbox
   egress proxy). Fix for the recording only: a small Node server that
   serves the built app and proxies the REST calls through the egress
   proxy via a manual CONNECT tunnel. The deployed Pages demo is
   unaffected — its window line degrades gracefully, as documented in
   the README.

All fixes are covered by the passing test suite (`npm test`: 25/25) and
by the verified on-chain run (`deployments/usage.json`).

## Human contribution

- Chose the event and the multi-category strategy; approved the vault
  concept and the quality bar ("no mistakes, however small; maximise the
  chance of winning").
- Owns the accounts and identity steps the agent cannot do: the GitHub
  account the repo lives under, the Dashboard sign-in for the faucet
  claim that funds the deployer, the fest registration (GitHub OAuth, X,
  QoreX), and the final submission (the project page is created by the
  human's main agent after this build verifies).

## Verification status (16 Nov 2026)

| Check | Result |
| --- | --- |
| Hardhat compile (solc 0.8.24) | Passes |
| `npm test` (contract, local EVM, mocked precompiles) | 25/25 pass |
| `npm run typecheck` (both tsconfigs) | Passes |
| `npm run build` (frontend) | Passes |
| No secrets in repo / git history | Checked (see below) |
| Testnet deploy | **Done 15 Nov 2026** — contract `0x0abdb86b…715a`, deploy tx `0x5821fcc…a1ddf` |
| On-chain usage | **Done** — 5 deposits (1.5 QOR), 3 withdrawals (1.15 QOR): standard `0xd88353bf…`, proof `0xbb908fc5…` (ML-DSA-87 signature verified on chain), standard in demo video `0x63a7e34a…`; 0.35 QOR still locked across 2 locks |
| Demo video (real recording) | Done + verified on-chain |
| Live demo (GitHub Pages) | Done — https://andipangeranm142.github.io/quantum-vault/ |

## Secrets check

Before each commit, the repo is checked for secrets: no `.env` exists
inside the repo (secrets live in `../.env` and `../deployer.json`, both
mode `600` and outside the repo); `.gitignore` covers `.env`, `node_modules`,
`dist`, `artifacts`, `cache` and `typechain-types`; `git log` / `git show`
history is reviewed for accidental additions. The test suite uses only
Hardhat's local signers — no real keys anywhere in the tests.

## Tools

- Agent: Muse ("forza"), single build agent for this project.
- Toolchain: Node 24, TypeScript, Hardhat 2 + solc 0.8.24, ethers v6,
  viem, wagmi, RainbowKit, Playwright (video + render checks),
  QoreChain SDK/EVM 0.14.0.
