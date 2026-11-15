/**
 * deploy.ts - deploy the QuantumVault contract to the QoreChain EVM Engine
 * (testnet qorechain-diana, chain id 9800).
 *
 * Uses @qorechain/evm (createEvmClient / deployContract / readContract) and
 * the Hardhat artifact at artifacts/contracts/QuantumVault.sol/QuantumVault.json
 * (run `npm run compile` first).
 *
 * Prerequisites (see README):
 *   - QORE_EVM_RPC_URL pointing at the testnet EVM JSON-RPC endpoint.
 *   - QORE_EVM_PRIVATE_KEY for a funded testnet EVM account (0x-prefixed,
 *     32 bytes). It must be the SAME account as QORE_MNEMONIC (used by
 *     scripts/window.ts), derived at m/44'/60'/0'/0/0.
 *   - A registered ML-DSA-87 key and a live EVM authorisation window for
 *     that account: run `npm run window register` once, then
 *     `npm run window open`, and wait ~10 seconds before deploying.
 *
 * Safety: this script REFUSES to run on any chain other than the testnet
 * (chain id 9800). Quantum Vault is a testnet-only project.
 *
 * On success it writes deployments/testnet.json with the contract address
 * and the transaction hashes, so the frontend and the README can point at
 * the live deployment.
 */
import {
  createEvmClient,
  deployContract,
  evmAccountFromPrivateKey,
  readContract,
} from "@qorechain/evm";
import { type Address, type Hex } from "viem";
import fs from "node:fs";
import path from "node:path";

/** QoreChain testnet (qorechain-diana) EVM chain id. Nothing else is allowed. */
const TESTNET_CHAIN_ID = 9800;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

import { cosmosHashForEvmTx } from "./cosmos-hash.js";

async function main(): Promise<void> {
  const evmRpc = process.env.QORE_EVM_RPC_URL ?? "http://localhost:8545";
  const privateKey = requireEnv("QORE_EVM_PRIVATE_KEY") as Hex;

  // npm scripts run with the working directory at the package root.
  const root = process.cwd();
  const artifactPath = path.resolve(
    root,
    "artifacts",
    "contracts",
    "QuantumVault.sol",
    "QuantumVault.json",
  );
  if (!fs.existsSync(artifactPath)) {
    throw new Error(
      `Hardhat artifact not found at ${artifactPath}. Run \`npm run compile\` first.`,
    );
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as {
    abi: unknown;
    bytecode: Hex;
    deployedBytecode: string;
  };

  const client = await createEvmClient({ endpoints: { evmRpc } });
  const chainId = await client.getChainId();
  if (chainId !== TESTNET_CHAIN_ID) {
    throw new Error(
      `Refusing to deploy: chain id is ${chainId}, expected testnet ${TESTNET_CHAIN_ID}. ` +
        `Check QORE_EVM_RPC_URL (testnet: https://evm-testnet.qore.host).`,
    );
  }
  const account = evmAccountFromPrivateKey(privateKey);
  const wallet = client.getWalletClient(account);

  console.log(`network:  QoreChain EVM testnet (chain id ${chainId})`);
  console.log(`deployer: ${account.address}`);

  console.log(`\nDeploying QuantumVault…`);
  const deployHash = await deployContract(wallet, {
    abi: artifact.abi as never,
    bytecode: artifact.bytecode,
    args: [],
  });
  const receipt = await client.publicClient.waitForTransactionReceipt({
    hash: deployHash,
  });
  const contract = receipt.contractAddress;
  if (!contract) {
    throw new Error("Deployment receipt did not include a contract address.");
  }
  console.log(`deployed: ${contract}`);
  console.log(`deploy tx: ${deployHash}`);
  const deployCosmos = await cosmosHashForEvmTx(client.publicClient, deployHash);
  console.log(`explorer: https://explore.qore.network/tx/${deployCosmos.cosmosHash} (switch the explorer to Testnet)`);

  // Sanity reads: constants and zero totals.
  const minDeposit = await readContract(client.publicClient, {
    address: contract as Address,
    abi: artifact.abi as never,
    functionName: "MIN_DEPOSIT",
  });
  const totalLocked = await readContract(client.publicClient, {
    address: contract as Address,
    abi: artifact.abi as never,
    functionName: "totalLocked",
  });
  console.log(`\nMIN_DEPOSIT: ${minDeposit}`);
  console.log(`totalLocked: ${totalLocked}`);

  const deployedBytecodeSize = (artifact.deployedBytecode.length - 2) / 2;
  console.log(`bytecode size: ${deployedBytecodeSize} bytes`);

  const outDir = path.resolve(root, "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const deployment = {
    network: "qorechain-diana",
    chainId: 9800,
    contract: contract as Address,
    deployer: account.address,
    deployTx: deployHash,
    deployTxCosmos: deployCosmos.cosmosHash,
    deployBlock: deployCosmos.block,
    bytecodeSize: deployedBytecodeSize,
    explorerContract: `https://explore.qore.network/address/${contract}`,
    explorerDeployTx: `https://explore.qore.network/tx/${deployCosmos.cosmosHash}`,
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(outDir, "testnet.json"),
    JSON.stringify(deployment, null, 2) + "\n",
  );
  console.log("\nWrote deployments/testnet.json");
  console.log("Done.");
}

main().catch((err: unknown) => {
  console.error("\nDeploy failed.");
  console.error(
    "Check QORE_EVM_RPC_URL is reachable, QORE_EVM_PRIVATE_KEY funds an account, " +
      "and a live EVM authorisation window is open (`npm run window status`).",
  );
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
