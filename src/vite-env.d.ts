/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
  /** Deployed QuantumFlip contract address on the QoreChain testnet. Empty when not yet deployed. */
  readonly VITE_QUANTUM_FLIP_ADDRESS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
