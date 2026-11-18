/**
 * check-state.ts - read-only on-chain state check for the deployed
 * QuantumVault on Diana. No keys needed, no transaction sent.
 *
 * Prints: chain id, latest block time, contract balance, totalDeposited /
 * totalWithdrawn / totalLocked, lock count, and every lock of the deployer
 * account (from deployments/testnet.json), with unlocked/withdrawn status.
 */
import { createEvmClient, readContract } from "@qorechain/evm";
import { formatEther, type Address } from "viem";
import fs from "node:fs";
import path from "node:path";

async function main(): Promise<void> {
  const evmRpc = process.env.QORE_EVM_RPC_URL ?? "https://evm-testnet.qore.host";
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
  ) as { contract: Address; deployer: Address };
  const { contract, deployer } = deployment;

  const client = await createEvmClient({ endpoints: { evmRpc } });
  const chainId = await client.getChainId();
  const latest = await client.publicClient.getBlock({ blockTag: "latest" });
  const balance = await client.publicClient.getBalance({ address: contract });
  const totalDeposited = (await readContract(client.publicClient, {
    address: contract, abi, functionName: "totalDeposited",
  })) as bigint;
  const totalWithdrawn = (await readContract(client.publicClient, {
    address: contract, abi, functionName: "totalWithdrawn",
  })) as bigint;
  const totalLocked = (await readContract(client.publicClient, {
    address: contract, abi, functionName: "totalLocked",
  })) as bigint;
  const lockCount = (await readContract(client.publicClient, {
    address: contract, abi, functionName: "lockCount",
  })) as bigint;
  const mine = (await readContract(client.publicClient, {
    address: contract, abi, functionName: "lockCountOf", args: [deployer],
  })) as bigint;

  console.log(`chainId:        ${chainId}`);
  console.log(`latest block:   ${latest.number} @ ${new Date(Number(latest.timestamp) * 1000).toISOString()}`);
  console.log(`contract:       ${contract}`);
  console.log(`deployer:       ${deployer}`);
  console.log(`balance:        ${formatEther(balance)} QOR`);
  console.log(`totalDeposited: ${formatEther(totalDeposited)} QOR`);
  console.log(`totalWithdrawn: ${formatEther(totalWithdrawn)} QOR`);
  console.log(`totalLocked:    ${formatEther(totalLocked)} QOR`);
  console.log(`lockCount:      ${lockCount} (deployer: ${mine})`);
  for (let i = 0n; i < mine; i++) {
    const lock = (await readContract(client.publicClient, {
      address: contract, abi, functionName: "getLock", args: [deployer, i],
    })) as { amount: bigint; unlockTime: bigint; withdrawn: boolean };
    const unlocked = latest.timestamp >= lock.unlockTime;
    console.log(
      `lock ${i}: ${formatEther(lock.amount)} QOR, unlock ${new Date(Number(lock.unlockTime) * 1000).toISOString()}, ` +
        `unlocked=${unlocked}, withdrawn=${lock.withdrawn}`,
    );
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
