/**
 * withdraw-lock2.ts - withdraw the deployer's lock 2 (0.25 QOR, 7-day lock)
 * on Diana testnet only.
 *
 * Reuses the exact withdrawWithProof flow proven in scripts/usage.ts (lock 3):
 * read the on-chain withdrawal digest, sign it locally with the deployer's
 * ML-DSA-87 key (@qorechain/sdk pqcSign), submit withdrawWithProof, and verify
 * the on-chain state afterwards.
 *
 * Safety: refuses to run unless chain id is 9800 AND lock 2 is exactly
 * 0.1 QOR, already unlocked, and not yet withdrawn. Touches no other lock.
 * Requires a live EVM window (`npm run window open` first).
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
const LOCK_ID = 2n;
const EXPECTED_AMOUNT = parseEther("0.25");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  const evmRpc = process.env.QORE_EVM_RPC_URL ?? "http://localhost:8545";
  const privateKey = requireEnv("QORE_EVM_PRIVATE_KEY") as Hex;
  const mnemonic = requireEnv("QORE_MNEMONIC");

  const root = process.cwd();
  const artifact = JSON.parse(
    fs.readFileSync(
      path.resolve(root, "artifacts", "contracts", "QuantumVault.sol", "QuantumVault.json"),
      "utf8",
    ),
  ) as { abi: unknown };
  const abi = artifact.abi as never;
  const deployment = JSON.parse(
    fs.readFileSync(path.resolve(root, "deployments", "testnet.json"), "utf8"),
  ) as { contract: Address };
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

  // --- Pre-flight verification (all on-chain reads) ---
  const latest = await client.publicClient.getBlock({ blockTag: "latest" });
  const lockBefore = (await readContract(client.publicClient, {
    address: contract, abi, functionName: "getLock", args: [account.address, LOCK_ID],
  })) as { amount: bigint; unlockTime: bigint; withdrawn: boolean };
  const balanceBefore = await client.publicClient.getBalance({ address: contract });
  const withdrawnBefore = (await readContract(client.publicClient, {
    address: contract, abi, functionName: "totalWithdrawn",
  })) as bigint;

  console.log(
    `\nlock 2 before: ${formatEther(lockBefore.amount)} QOR, unlock ` +
      `${new Date(Number(lockBefore.unlockTime) * 1000).toISOString()}, withdrawn=${lockBefore.withdrawn}`,
  );
  console.log(`contract balance before: ${formatEther(balanceBefore)} QOR`);
  console.log(`totalWithdrawn before:   ${formatEther(withdrawnBefore)} QOR`);
  if (lockBefore.amount !== EXPECTED_AMOUNT) {
    throw new Error(`Refusing: lock 2 amount is ${formatEther(lockBefore.amount)} QOR, expected 0.25 QOR.`);
  }
  if (latest.timestamp < lockBefore.unlockTime) {
    throw new Error("Refusing: lock 2 is still locked.");
  }
  if (lockBefore.withdrawn) {
    throw new Error("Refusing: lock 2 is already withdrawn.");
  }

  // --- Sign the exact withdrawal digest with ML-DSA-87 ---
  const digest = (await readContract(client.publicClient, {
    address: contract, abi, functionName: "withdrawalDigest",
    args: [account.address, LOCK_ID, EXPECTED_AMOUNT],
  })) as Hex;
  console.log(`\nwithdrawal digest for lock 2: ${digest}`);
  const unified = await deriveUnifiedAccount(mnemonic, 0);
  const signature = pqcSign(unified.pqc.secretKey, Buffer.from(digest.slice(2), "hex"));
  console.log(`ML-DSA-87 signature: ${signature.length} bytes`);

  // --- Withdraw ---
  const hash = await writeContract(wallet, {
    address: contract,
    abi,
    functionName: "withdrawWithProof",
    args: [LOCK_ID, `0x${Buffer.from(signature).toString("hex")}`],
    value: 0n,
    account: wallet.account ?? null,
    chain: wallet.chain,
  } as never);
  const receipt = await client.publicClient.waitForTransactionReceipt({ hash });
  const cosmos = await cosmosHashForEvmTx(client.publicClient, hash);
  console.log(`\ntx:     ${hash}`);
  console.log(`cosmos: ${cosmos.cosmosHash} (block ${cosmos.block})`);
  console.log(`status: ${receipt.status}`);

  // --- Post-withdrawal verification ---
  const lockAfter = (await readContract(client.publicClient, {
    address: contract, abi, functionName: "getLock", args: [account.address, LOCK_ID],
  })) as { amount: bigint; unlockTime: bigint; withdrawn: boolean };
  const balanceAfter = await client.publicClient.getBalance({ address: contract });
  const withdrawnAfter = (await readContract(client.publicClient, {
    address: contract, abi, functionName: "totalWithdrawn",
  })) as bigint;
  const lockedAfter = (await readContract(client.publicClient, {
    address: contract, abi, functionName: "totalLocked",
  })) as bigint;
  console.log(`\nlock 2 after: withdrawn=${lockAfter.withdrawn}`);
  console.log(`contract balance after: ${formatEther(balanceAfter)} QOR`);
  console.log(`totalWithdrawn after:   ${formatEther(withdrawnAfter)} QOR`);
  console.log(`totalLocked after:      ${formatEther(lockedAfter)} QOR`);

  if (!lockAfter.withdrawn) throw new Error("Verification failed: lock 2 still not withdrawn.");
  if (withdrawnAfter !== withdrawnBefore + EXPECTED_AMOUNT) {
    throw new Error("Verification failed: totalWithdrawn did not increase by exactly 0.25 QOR.");
  }
  if (balanceAfter !== balanceBefore - EXPECTED_AMOUNT) {
    throw new Error("Verification failed: contract balance did not decrease by exactly 0.25 QOR.");
  }

  const record = {
    network: "qorechain-diana",
    chainId: 9800,
    contract,
    account: account.address,
    lockId: 4,
    amountQor: "0.25",
    method: "withdrawWithProof",
    proof: "ML-DSA-87 signature over withdrawalDigest(owner, 2, 0.25 QOR), verified on chain via pqcVerify",
    signatureBytes: signature.length,
    tx: hash,
    cosmosTx: cosmos.cosmosHash,
    block: cosmos.block,
    status: receipt.status,
    stateBefore: {
      block: Number(latest.number),
      lockWithdrawn: lockBefore.withdrawn,
      contractBalanceQor: formatEther(balanceBefore),
      totalWithdrawnQor: formatEther(withdrawnBefore),
    },
    stateAfter: {
      lockWithdrawn: lockAfter.withdrawn,
      contractBalanceQor: formatEther(balanceAfter),
      totalWithdrawnQor: formatEther(withdrawnAfter),
      totalLockedQor: formatEther(lockedAfter),
    },
    recordedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.resolve(root, "deployments", "withdraw-lock2.json"),
    JSON.stringify(record, null, 2) + "\n",
  );
  console.log("\nWrote deployments/withdraw-lock2.json");
  console.log("Done.");
}

main().catch((err: unknown) => {
  console.error("\nWithdraw lock 2 failed.");
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
