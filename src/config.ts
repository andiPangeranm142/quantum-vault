import { isAddress } from "viem";

/** EVM chain id of the QoreChain testnet (`qorechain-diana`). */
export const TESTNET_CHAIN_ID = 9800;

/** QoreChain block explorer (covers the testnet). */
export const EXPLORER_URL = "https://explore.qore.network";

/**
 * The deployed QuantumVault contract address, read from the build-time
 * environment. Empty string means the contract has not been deployed yet —
 * the UI must not show deposit/withdraw buttons in that case.
 *
 * A malformed value is treated the same as unset: never trust a bad address.
 */
const raw = (import.meta.env.VITE_QUANTUM_VAULT_ADDRESS ?? "").trim();

export const QUANTUM_VAULT_ADDRESS: `0x${string}` | "" = isAddress(raw)
  ? (raw as `0x${string}`)
  : "";

export const CONTRACT_DEPLOYED = QUANTUM_VAULT_ADDRESS !== "";
