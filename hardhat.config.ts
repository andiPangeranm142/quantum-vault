import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import fs from "node:fs";
import path from "node:path";

// Secrets live OUTSIDE this repo, in ../.env (mode 600) — never committed.
// Hardhat only needs the deployer key for the Diana network entry below;
// deployment itself goes through scripts/deploy.ts (viem client).
const envPath = path.resolve(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const PRIVATE_KEY = process.env.QORE_EVM_PRIVATE_KEY ?? "";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    hardhat: { chainId: 31337 },
    qorechainTestnet: {
      // QoreChain Diana testnet, EVM lane.
      url: process.env.QORE_EVM_RPC_URL ?? "https://evm-testnet.qore.host",
      chainId: 9800,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
  },
};

export default config;
