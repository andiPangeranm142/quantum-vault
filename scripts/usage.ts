/**
 * usage.ts - real on-chain usage of the deployed QuantumVault on Diana.
 *
 * Requires: a deployed contract (deployments/testnet.json), a registered
 * ML-DSA-87 key and a live EVM window for the deployer (`npm run window open`
 * first — this script sends 5 transactions: 3 deposits, 2 withdrawals).
 *
 * Flow:
 *   1. Deposit 0.5 QOR locked 90 seconds (standard-withdrawal demo).
 *   2. Deposit 0.25 QOR locked 7 days (a real savings lock; stays locked).
 *   3. Deposit 0.15 QOR locked 90 seconds (proof-withdrawal demo).
 *   4. Wait for the short locks to unlock, then withdraw lock 1 with the
 *      standard path and lock 3 with an ML-DSA-87 signature over the exact
 *      withdrawal digest (signed locally with @qorechain/sdk's pqcSign,
 *      verified on chain by the pqcVerify precompile).
 *   5. Read back the totals and every lock, and write deployments/usage.json
 *      with all transaction hashes (EVM + Cosmos) as evidence.
 *
 * Safety: refuses to run on any chain other than the testnet (chain id 9800).
 */
import {
  createEvmClient,
  evmAccountFromPrivateKey,
  readContract,
  writeContract,
} from "@qorechain/evm";
import { deriveUnifiedAccount, pqcSign } from "@qorechain/sdk";
import { formatEther, parseEther, type Address, type Hex } from "viem";
import fs from "node:fs";
import path from "node:path";
import { cosmosHashForEvmTx } from "./cosmos-hash.js";

const TESTNET_CHAIN_ID = 9800;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const evmRpc = process.env.QORE_EVM_RPC_URL ?? "http://localhost:8545";
  const privateKey = requireEnv("QORE_EVM_PRIVATE_KEY") as Hex;
  const mnemonic = requireEnv("QORE_MNEMONIC");

  // npm scripts run with the working directory at the package root.
  const root = process.cwd();
  const artifactPath = path.resolve(
    root,
    "artifacts",
    "contracts",
    "QuantumVault.sol",
    "QuantumVault.json",
  );
  const deploymentPath = path.resolve(root, "deployments", "testnet.json");
  if (!fs.existsSync(artifactPath) || !fs.existsSync(deploymentPath)) {
    throw new Error("Run `npm run compile` and `npm run deploy` first.");
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
  console.log(`account:  ${account.address}`);
  console.log(`contract: ${contract}`);

  // The contract may already hold locks from an earlier run (or a failed
  // run): new deposits get ids from the current lock count onwards, and the
  // withdrawals below target the locks this run creates.
  const baseLock = Number(
    (await readContract(client.publicClient, {
      address: contract,
      abi,
      functionName: "lockCountOf",
      args: [account.address],
    })) as bigint,
  );
  console.log(`existing locks for this account: ${baseLock}`);

  const now = Math.floor(Date.now() / 1000);
  const shortUnlock = now + 90;
  const weekUnlock = now + 7 * 24 * 60 * 60;

  const evidence: Record<string, unknown> = {
    network: "qorechain-diana",
    chainId: 9800,
    contract,
    account: account.address,
    steps: [],
  };
  const steps = evidence.steps as Array<Record<string, unknown>>;

  async function send(
    label: string,
    functionName: string,
    args: unknown[],
    value: bigint,
  ): Promise<Hex> {
    console.log(`\n${label}…`);
    // The ABI is loaded from JSON at runtime, so the call is cast: the
    // argument shapes are verified by the Hardhat tests and by the live run.
    const hash = await writeContract(wallet, {
      address: contract,
      abi,
      functionName,
      args: args as never,
      value,
      account: wallet.account ?? null,
      chain: wallet.chain,
    } as never);
    await client.publicClient.waitForTransactionReceipt({ hash });
    const cosmos = await cosmosHashForEvmTx(client.publicClient, hash);
    console.log(`  tx: ${hash}`);
    console.log(`  cosmos: ${cosmos.cosmosHash} (block ${cosmos.block})`);
    steps.push({ label, functionName, args: JSON.stringify(args, (_, v) => (typeof v === "bigint" ? v.toString() : v)), value: value.toString(), tx: hash, cosmosTx: cosmos.cosmosHash, block: cosmos.block });
    return hash;
  }

  // 1. Short lock for the standard withdrawal.
  await send("Deposit 1 — 0.5 QOR, 90s lock", "deposit", [BigInt(shortUnlock)], parseEther("0.5"));
  // 2. A real savings lock that stays locked.
  await send("Deposit 2 — 0.25 QOR, 7d lock", "deposit", [BigInt(weekUnlock)], parseEther("0.25"));
  // 3. Short lock for the proof withdrawal.
  await send("Deposit 3 — 0.15 QOR, 90s lock", "deposit", [BigInt(shortUnlock)], parseEther("0.15"));

  // Wait for the short locks to unlock (poll the chain clock via a lock read).
  console.log("\nWaiting for the 90s locks to unlock…");
  for (;;) {
    const lock = (await readContract(client.publicClient, {
      address: contract,
      abi,
      functionName: "getLock",
      args: [account.address, BigInt(baseLock)],
    })) as { unlockTime: bigint };
    const latest = await client.publicClient.getBlock({ blockTag: "latest" });
    if (latest.timestamp >= lock.unlockTime) break;
    await sleep(10_000);
  }
  console.log("Short locks are unlocked.");

  // 4. Standard withdrawal of this run's first short lock.
  await send(`Withdraw lock ${baseLock} (standard)`, "withdraw", [BigInt(baseLock)], 0n);

  // 5. Proof withdrawal of this run's second short lock: sign the exact
  //    digest with ML-DSA-87.
  const proofLock = baseLock + 2;
  const digest = (await readContract(client.publicClient, {
    address: contract,
    abi,
    functionName: "withdrawalDigest",
    args: [account.address, BigInt(proofLock), parseEther("0.15")],
  })) as Hex;
  console.log(`\nWithdrawal digest for lock ${proofLock}: ${digest}`);
  const unified = await deriveUnifiedAccount(mnemonic, 0);
  const signature = pqcSign(
    unified.pqc.secretKey,
    Buffer.from(digest.slice(2), "hex"),
  );
  console.log(`ML-DSA-87 signature: ${signature.length} bytes`);
  await send(
    `Withdraw lock ${proofLock} (with ML-DSA-87 proof)`,
    "withdrawWithProof",
    [BigInt(proofLock), `0x${Buffer.from(signature).toString("hex")}`],
    0n,
  );

  // Final state.
  const totalLocked = (await readContract(client.publicClient, {
    address: contract, abi, functionName: "totalLocked",
  })) as bigint;
  const totalDeposited = (await readContract(client.publicClient, {
    address: contract, abi, functionName: "totalDeposited",
  })) as bigint;
  const totalWithdrawn = (await readContract(client.publicClient, {
    address: contract, abi, functionName: "totalWithdrawn",
  })) as bigint;
  const lockCount = (await readContract(client.publicClient, {
    address: contract, abi, functionName: "lockCount",
  })) as bigint;
  console.log(`\ntotalLocked:    ${formatEther(totalLocked)} QOR`);
  console.log(`totalDeposited: ${formatEther(totalDeposited)} QOR`);
  console.log(`totalWithdrawn: ${formatEther(totalWithdrawn)} QOR`);
  console.log(`lockCount:      ${lockCount}`);

  const locks: Array<Record<string, unknown>> = [];
  const mine = (await readContract(client.publicClient, {
    address: contract, abi, functionName: "lockCountOf", args: [account.address],
  })) as bigint;
  for (let i = 0n; i < mine; i++) {
    const lock = (await readContract(client.publicClient, {
      address: contract, abi, functionName: "getLock", args: [account.address, i],
    })) as { amount: bigint; unlockTime: bigint; withdrawn: boolean };
    locks.push({
      lockId: Number(i),
      amountQor: formatEther(lock.amount),
      unlockTime: Number(lock.unlockTime),
      unlockTimeIso: new Date(Number(lock.unlockTime) * 1000).toISOString(),
      withdrawn: lock.withdrawn,
    });
  }
  evidence.totals = {
    totalLockedQor: formatEther(totalLocked),
    totalDepositedQor: formatEther(totalDeposited),
    totalWithdrawnQor: formatEther(totalWithdrawn),
    lockCount: Number(lockCount),
  };
  evidence.locks = locks;
  evidence.recordedAt = new Date().toISOString();

  fs.writeFileSync(
    path.resolve(root, "deployments", "usage.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log("\nWrote deployments/usage.json");
  console.log("Done.");
}

main().catch((err: unknown) => {
  console.error("\nUsage run failed.");
  console.error(
    "Check a live EVM authorisation window is open (`npm run window status`) " +
      "with enough transactions left, and the account still holds QOR.",
  );
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
