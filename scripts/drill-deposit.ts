/**
 * drill-deposit.ts - the Quantum Vault Q-Day Drill transaction (18 Nov 2026).
 *
 * DO NOT RUN BEFORE THE DRILL. The drill window is 18 Nov 2026 00:00-23:59
 * UTC; this script refuses to run before 2026-11-18T00:00:00Z unless
 * QORE_DRILL_FORCE=1 is set. It also refuses to run twice: once
 * deployments/drill-deposit.json exists with a recorded transaction, it
 * exits without sending anything (same override applies).
 *
 * What it does: deposits 0.5 QOR from the drill account into the vault
 * with a 30-day lock (unlockTime = now + 30 days). The lock is time-locked
 * far past the drill, so the attacker bot — which holds the drill
 * account's leaked ECDSA key — cannot withdraw it during the drill: any
 * withdraw() call reverts while the lock is active. The deposit itself is
 * the drill-day "normal transaction" whose hash is submitted on the
 * project page to prove the project still works.
 *
 * Requires a live EVM window for the drill account: the drill-day cron
 * opens it first (`npx tsx --env-file=../.env.drill scripts/window.ts
 * open`), exactly like the Quantum Flip drill-flip flow.
 *
 * Run (from the repo root, on drill day only):
 *   npx tsx --env-file=../.env.drill scripts/drill-deposit.ts
 *
 * Safety: refuses to run on any chain other than the testnet (chain id 9800).
 */
import {
  createEvmClient,
  evmAccountFromPrivateKey,
  readContract,
  writeContract,
} from "@qorechain/evm";
import { parseEther, type Address, type Hex } from "viem";
import fs from "node:fs";
import path from "node:path";
import { cosmosHashForEvmTx } from "./cosmos-hash.js";

const TESTNET_CHAIN_ID = 9800;
const DRILL_START = Date.parse("2026-11-18T00:00:00Z") / 1000;
const LOCK_DAYS = 30;
const DEPOSIT_AMOUNT = parseEther("0.5");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  const force = process.env.QORE_DRILL_FORCE === "1";
  const now = Math.floor(Date.now() / 1000);
  if (!force && now < DRILL_START) {
    throw new Error(
      "Refusing: the Q-Day Drill has not started yet (window opens 2026-11-18T00:00:00Z). " +
        "Set QORE_DRILL_FORCE=1 to override.",
    );
  }

  const evmRpc = process.env.QORE_EVM_RPC_URL ?? "http://localhost:8545";
  const privateKey = requireEnv("QORE_EVM_PRIVATE_KEY") as Hex;

  const root = process.cwd();
  const artifactPath = path.resolve(
    root,
    "artifacts",
    "contracts",
    "QuantumVault.sol",
    "QuantumVault.json",
  );
  const deploymentPath = path.resolve(root, "deployments", "testnet.json");
  const evidencePath = path.resolve(root, "deployments", "drill-deposit.json");
  if (!fs.existsSync(artifactPath) || !fs.existsSync(deploymentPath)) {
    throw new Error("Run `npm run compile` and `npm run deploy` first.");
  }
  if (!force && fs.existsSync(evidencePath)) {
    const prior = JSON.parse(fs.readFileSync(evidencePath, "utf8")) as {
      evmTx?: string;
    };
    if (prior.evmTx) {
      console.log(
        `Drill deposit already recorded (${prior.evmTx}); refusing to deposit again. ` +
          "Set QORE_DRILL_FORCE=1 to override.",
      );
      return;
    }
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as {
    abi: unknown;
  };
  const abi = artifact.abi as never;
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8")) as {
    contract: Address;
  };
  const contract = deployment.contract;

  const client = await createEvmClient({ endpoints: { evmRpc } });
  const chainId = await client.getChainId();
  if (chainId !== TESTNET_CHAIN_ID) {
    throw new Error(`Refusing: chain id is ${chainId}, expected testnet ${TESTNET_CHAIN_ID}.`);
  }
  const account = evmAccountFromPrivateKey(privateKey);
  const wallet = client.getWalletClient(account);
  console.log(`network:  QoreChain EVM testnet (chain id ${chainId})`);
  console.log(`contract: ${contract}`);
  console.log(`account:  ${account.address} (drill account)`);

  const existingLocks = Number(
    (await readContract(client.publicClient, {
      address: contract,
      abi,
      functionName: "lockCountOf",
      args: [account.address],
    })) as bigint,
  );
  console.log(`existing locks for this account: ${existingLocks}`);

  const unlockTime = now + LOCK_DAYS * 24 * 60 * 60;
  console.log(
    `\nDepositing 0.5 QOR with a ${LOCK_DAYS}-day lock (unlocks ${new Date(unlockTime * 1000).toISOString()})…`,
  );
  const hash = await writeContract(wallet, {
    address: contract,
    abi,
    functionName: "deposit",
    args: [BigInt(unlockTime)] as never,
    value: DEPOSIT_AMOUNT,
    account: wallet.account ?? null,
    chain: wallet.chain,
  } as never);
  await client.publicClient.waitForTransactionReceipt({ hash });
  const cosmos = await cosmosHashForEvmTx(client.publicClient, hash);
  console.log(`  tx: ${hash}`);
  console.log(`  cosmos: ${cosmos.cosmosHash} (block ${cosmos.block})`);

  // Verify the lock on chain.
  const lock = (await readContract(client.publicClient, {
    address: contract,
    abi,
    functionName: "getLock",
    args: [account.address, BigInt(existingLocks)],
  })) as { amount: bigint; unlockTime: bigint; withdrawn: boolean };
  if (lock.amount !== DEPOSIT_AMOUNT || lock.unlockTime !== BigInt(unlockTime) || lock.withdrawn) {
    throw new Error(
      `Lock verification failed: amount=${lock.amount} unlockTime=${lock.unlockTime} withdrawn=${lock.withdrawn}`,
    );
  }
  console.log(
    `Verified on chain: lock ${existingLocks}, 0.5 QOR, unlocks ${new Date(Number(lock.unlockTime) * 1000).toISOString()}, withdrawn=false.`,
  );

  const evidence = {
    network: "qorechain-diana",
    chainId: 9800,
    contract,
    account: account.address,
    action: "drill-deposit",
    amount: DEPOSIT_AMOUNT.toString(),
    amountQor: "0.5",
    lockId: existingLocks,
    unlockTime,
    lockDays: LOCK_DAYS,
    evmTx: hash,
    cosmosTx: cosmos.cosmosHash,
    block: cosmos.block,
    ranAt: new Date().toISOString(),
  };
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`\nEvidence written to deployments/drill-deposit.json.`);
  console.log(`Submit this hash on the project page drill section: ${hash}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
