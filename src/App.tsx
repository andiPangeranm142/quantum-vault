import { ConnectButton } from "@rainbow-me/rainbowkit";
import {
  QORECHAIN_REST_ENDPOINTS,
  classifyEvmWindowRejection,
  qorechainTestnet,
  evmWindowStatus,
  type EvmWindowRejection,
} from "@qorechain/evm";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { formatEther, parseEther } from "viem";
import {
  useAccount,
  useReadContract,
  useReadContracts,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";

import { quantumVaultAbi } from "./contract.js";
import {
  CONTRACT_DEPLOYED,
  EXPLORER_URL,
  QUANTUM_VAULT_ADDRESS,
  TESTNET_CHAIN_ID,
} from "./config.js";

const REMEDY: Record<EvmWindowRejection, string> = {
  "no-pqc-key":
    "This account has no registered ML-DSA-87 key. Register one on the native lane first.",
  "no-window": "No EVM authorisation window is open. Open one from QoreX, then retry.",
  exhausted: "The window has run out of blocks, transactions or value. Open a new one.",
  invalid: "The chain refused the window parameters.",
};

/**
 * The REST API of each chain, through the dev server's proxy (vite.config.ts):
 * the public REST endpoints send no CORS headers. Same chains as
 * QORECHAIN_REST_ENDPOINTS.
 */
const REST_PROXY: Record<number, string | undefined> = Object.fromEntries(
  Object.keys(QORECHAIN_REST_ENDPOINTS).map((id) => [
    Number(id),
    Number(id) === qorechainTestnet.id ? "/lcd-testnet" : "/lcd-mainnet",
  ]),
);

const LOCK_DURATIONS = [
  { label: "5 minutes (demo)", seconds: 5 * 60 },
  { label: "1 day", seconds: 24 * 60 * 60 },
  { label: "7 days", seconds: 7 * 24 * 60 * 60 },
  { label: "30 days", seconds: 30 * 24 * 60 * 60 },
] as const;

function shorten(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatQor(wei: bigint): string {
  const s = formatEther(wei);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** Current time, ticking once a second, for lock countdowns. */
function useNow(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function countdown(unlockTime: bigint, now: number): string {
  const remaining = Number(unlockTime) - now;
  if (remaining <= 0) return "Unlocked";
  const d = Math.floor(remaining / 86400);
  const h = Math.floor((remaining % 86400) / 3600);
  const m = Math.floor((remaining % 3600) / 60);
  const s = remaining % 60;
  if (d > 0) return `Unlocks in ${d}d ${h}h`;
  if (h > 0) return `Unlocks in ${h}h ${m}m`;
  if (m > 0) return `Unlocks in ${m}m ${s}s`;
  return `Unlocks in ${s}s`;
}

/** The account's EVM authorisation window, read over the native-lane REST API. */
function WindowStatus({ address, chainId }: { address: `0x${string}`; chainId: number }) {
  const rest = REST_PROXY[chainId];
  const { data, error, isLoading } = useQuery({
    queryKey: ["evm-window", chainId, address],
    queryFn: () => evmWindowStatus({ rest: rest!, address }),
    enabled: rest !== undefined,
    refetchInterval: 10_000,
  });
  if (!rest) return <p>Unknown network.</p>;
  if (isLoading) return <p>Reading the EVM window...</p>;
  // The window status comes from the native-lane REST API, which sends no
  // CORS headers — it is only readable when the app runs behind the /lcd
  // proxy (local dev/preview). On a plain static host this read fails, but
  // deposits and withdrawals still work when the wallet already has a live
  // window open.
  if (error)
    return (
      <p>
        Could not read the EVM window status from here. If you already opened a
        window from QoreX, you can still use the vault; otherwise open one from
        QoreX first.
      </p>
    );
  if (!data?.found) {
    return (
      <p>
        EVM window: none. Transactions are refused until one is open — open an
        EVM window from QoreX, then retry.
      </p>
    );
  }
  return (
    <p>
      EVM window: {data.live ? "live" : "not usable"} ({data.remainingBlocks.toString()} blocks,{" "}
      {data.remainingTxs.toString()} transactions, {data.remainingValue.toString()} uqor left)
      {data.nativeOnly
        ? " — this window admits native transfers only, so a vault transaction (a contract call) would be refused; open a window that covers contract calls."
        : ""}
      {!data.live ? " Open a new EVM window from QoreX, then retry." : ""}
    </p>
  );
}

/** The account's ML-DSA key status, read from the contract (0x0A02 precompile). */
function PqcKeyStatus({ address }: { address: `0x${string}` }) {
  const { data, error, isLoading } = useReadContract({
    address: QUANTUM_VAULT_ADDRESS as `0x${string}`,
    abi: quantumVaultAbi,
    functionName: "hasPqcKey",
    args: [address],
  });
  if (isLoading) return <p>Reading your post-quantum key status...</p>;
  if (error) return <p>Could not read your post-quantum key status: {error.message}</p>;
  if (!data) return null;
  const [registered, possessionProven] = data;
  return (
    <p>
      Post-quantum key:{" "}
      {registered
        ? possessionProven
          ? "registered, possession proven — withdrawals are authorised"
          : "registered, but possession was never proven — withdrawals will be refused"
        : "not registered — withdrawals will be refused until you register an ML-DSA-87 key"}
    </p>
  );
}

function VaultTotals() {
  const contract = QUANTUM_VAULT_ADDRESS as `0x${string}`;
  const query = useReadContracts({
    contracts: (["totalLocked", "totalDeposited", "totalWithdrawn", "lockCount"] as const).map(
      (fn) => ({ address: contract, abi: quantumVaultAbi, functionName: fn }),
    ),
    query: { refetchInterval: 10_000 },
  });
  const [locked, deposited, withdrawn, count] = (query.data ?? []).map((r) =>
    r.status === "success" ? (r.result as bigint) : undefined,
  );
  return (
    <section>
      <h2>The vault</h2>
      <ul>
        <li>Total locked: {locked === undefined ? "..." : `${formatQor(locked)} QOR`}</li>
        <li>Total deposited: {deposited === undefined ? "..." : `${formatQor(deposited)} QOR`}</li>
        <li>Total withdrawn: {withdrawn === undefined ? "..." : `${formatQor(withdrawn)} QOR`}</li>
        <li>Locks created: {count === undefined ? "..." : count.toString()}</li>
      </ul>
      {query.error && <p>Could not read vault totals: {query.error.message}</p>}
      <p>
        Contract:{" "}
        <a
          href={`${EXPLORER_URL}/address/${QUANTUM_VAULT_ADDRESS}`}
          target="_blank"
          rel="noreferrer"
        >
          <code>{shorten(QUANTUM_VAULT_ADDRESS)}</code>
        </a>
      </p>
    </section>
  );
}

function DepositForm({ onReceipt }: { onReceipt: () => void }) {
  const [amount, setAmount] = useState("0.1");
  const [duration, setDuration] = useState<number>(LOCK_DURATIONS[0].seconds);
  const write = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash: write.data });
  const now = useNow();
  const unlockTime = now + duration;

  useEffect(() => {
    if (receipt.data) onReceipt();
    // onReceipt is stable (invalidates queries); only the receipt re-triggers this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt.data]);

  const rejection = write.error ? classifyEvmWindowRejection(write.error) : undefined;
  const busy = write.isPending || receipt.isLoading;
  const reverted = receipt.data?.status === "reverted";

  const deposit = () => {
    let value: bigint;
    try {
      value = parseEther(amount);
    } catch {
      return;
    }
    if (value <= 0n) return;
    write.writeContract({
      address: QUANTUM_VAULT_ADDRESS as `0x${string}`,
      abi: quantumVaultAbi,
      functionName: "deposit",
      args: [BigInt(unlockTime)],
      value,
    });
  };

  return (
    <section>
      <h2>Deposit</h2>
      <p>
        <label>
          Amount (QOR){" "}
          <input
            type="number"
            min="0.001"
            step="0.001"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            style={{ width: "8rem" }}
          />
        </label>{" "}
        <label>
          Lock duration{" "}
          <select
            aria-label="Lock duration"
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value))}
          >
            {LOCK_DURATIONS.map((d) => (
              <option key={d.seconds} value={d.seconds}>
                {d.label}
              </option>
            ))}
          </select>
        </label>{" "}
        <button type="button" disabled={busy} onClick={deposit}>
          Deposit
        </button>
      </p>
      <p>
        Unlocks at {new Date(unlockTime * 1000).toLocaleString()} (minimum deposit 0.001 QOR,
        maximum lock 730 days).
      </p>
      {write.isPending && <p>Waiting for your wallet to sign...</p>}
      {receipt.isLoading && <p>Confirming on-chain...</p>}
      {write.data && (
        <p>
          Transaction: <code>{shorten(write.data)}</code>
        </p>
      )}
      {reverted && <p>The transaction was reverted on-chain — no deposit happened.</p>}
      {receipt.data && receipt.data.status === "success" && <p>Deposit confirmed.</p>}
      {write.error && <p>Deposit refused: {rejection ? REMEDY[rejection] : write.error.message}</p>}
      {receipt.error && <p>Could not confirm the transaction: {receipt.error.message}</p>}
    </section>
  );
}

interface LockRow {
  id: number;
  amount: bigint;
  unlockTime: bigint;
  withdrawn: boolean;
}

function MyLocks({ address, onReceipt }: { address: `0x${string}`; onReceipt: () => void }) {
  const contract = QUANTUM_VAULT_ADDRESS as `0x${string}`;
  const now = useNow();
  const { data: count, error: countError } = useReadContract({
    address: contract,
    abi: quantumVaultAbi,
    functionName: "lockCountOf",
    args: [address],
    query: { refetchInterval: 10_000 },
  });
  const shown = count === undefined ? 0 : Number(count);
  const locksQuery = useReadContracts({
    contracts: Array.from({ length: shown }, (_, i) => ({
      address: contract,
      abi: quantumVaultAbi,
      functionName: "getLock" as const,
      args: [address, BigInt(i)] as const,
    })),
    query: { refetchInterval: 10_000 },
  });
  const write = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash: write.data });
  const [withdrawingId, setWithdrawingId] = useState<number | null>(null);

  useEffect(() => {
    if (receipt.data) {
      onReceipt();
      setWithdrawingId(null);
    }
    // onReceipt is stable (invalidates queries); only the receipt re-triggers this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt.data]);

  const rows: LockRow[] = (locksQuery.data ?? [])
    .map((r, i) => {
      if (r.status !== "success" || !r.result) return null;
      return {
        id: i,
        amount: r.result.amount,
        unlockTime: r.result.unlockTime,
        withdrawn: r.result.withdrawn,
      };
    })
    .filter((r): r is LockRow => r !== null);

  const rejection = write.error ? classifyEvmWindowRejection(write.error) : undefined;
  const busy = write.isPending || receipt.isLoading;
  const reverted = receipt.data?.status === "reverted";

  const withdraw = (id: number) => {
    setWithdrawingId(id);
    write.writeContract({
      address: contract,
      abi: quantumVaultAbi,
      functionName: "withdraw",
      args: [BigInt(id)],
    });
  };

  return (
    <section>
      <h2>Your locks</h2>
      {countError && <p>Could not read your locks: {countError.message}</p>}
      {count === undefined && !countError && <p>Loading...</p>}
      {count === 0n && <p>No locks yet — deposit to create your first one.</p>}
      {rows.length > 0 && (
        <ul>
          {rows.map((row) => {
            const unlocked = now >= Number(row.unlockTime);
            return (
              <li key={row.id}>
                Lock {row.id}: {formatQor(row.amount)} QOR —{" "}
                {row.withdrawn
                  ? "withdrawn"
                  : unlocked
                    ? "unlocked"
                    : countdown(row.unlockTime, now)}{" "}
                (unlocks {new Date(Number(row.unlockTime) * 1000).toLocaleString()}){" "}
                {!row.withdrawn && unlocked && (
                  <button
                    type="button"
                    aria-label={`Withdraw lock ${row.id}`}
                    disabled={busy}
                    onClick={() => withdraw(row.id)}
                  >
                    Withdraw
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {write.isPending && <p>Waiting for your wallet to sign...</p>}
      {receipt.isLoading && <p>Confirming on-chain...</p>}
      {write.data && (
        <p>
          Transaction: <code>{shorten(write.data)}</code>
        </p>
      )}
      {reverted && <p>The transaction was reverted on-chain — no withdrawal happened.</p>}
      {receipt.data && receipt.data.status === "success" && withdrawingId === null && (
        <p>Withdrawal confirmed.</p>
      )}
      {write.error && (
        <p>Withdrawal refused: {rejection ? REMEDY[rejection] : write.error.message}</p>
      )}
      {receipt.error && <p>Could not confirm the transaction: {receipt.error.message}</p>}
    </section>
  );
}

export function App() {
  const { address, chainId, isConnected } = useAccount();
  const { switchChain } = useSwitchChain();
  const queryClient = useQueryClient();
  const onReceipt = () => {
    void queryClient.invalidateQueries();
  };

  const onTestnet = chainId === TESTNET_CHAIN_ID;

  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        maxWidth: 720,
        margin: "2rem auto",
        padding: "0 1rem",
      }}
    >
      <h1>Quantum Vault</h1>
      <p>
        A time-locked savings vault on the QoreChain testnet. Deposit QOR locked until a time you
        choose; withdrawals are protected on three post-quantum layers — a hybrid-signed EVM
        authorisation window, an on-chain check that you hold a registered ML-DSA-87 key, and an
        optional ML-DSA-87 signature over the exact withdrawal, verified on chain.
      </p>
      <ConnectButton />

      {!CONTRACT_DEPLOYED && <p>Contract not deployed yet — check back after deployment.</p>}

      {CONTRACT_DEPLOYED && <VaultTotals />}

      {!isConnected && <p>Connect a wallet to use the vault. QoreX is recommended.</p>}

      {isConnected && address && chainId && !onTestnet && (
        <section>
          <p>
            You are connected on chain {chainId}. Quantum Vault lives on the QoreChain Testnet
            (chain {TESTNET_CHAIN_ID}) — please switch networks to use it.
          </p>
          <button type="button" onClick={() => switchChain({ chainId: TESTNET_CHAIN_ID })}>
            Switch to QoreChain Testnet
          </button>
        </section>
      )}

      {isConnected && address && onTestnet && (
        <section>
          <p>
            Account <code>{address}</code> on the QoreChain Testnet
          </p>
          <WindowStatus address={address} chainId={chainId} />

          {CONTRACT_DEPLOYED && (
            <>
              <PqcKeyStatus address={address} />
              <DepositForm onReceipt={onReceipt} />
              <MyLocks address={address} onReceipt={onReceipt} />
            </>
          )}
        </section>
      )}

      <footer>
        <hr />
        <p>
          Honest notes: the timelock is enforced by block.timestamp, which a block proposer can
          shift by a few seconds — locks are for savings horizons, not second-exact deadlines. The
          EVM window is enforced by the chain, not by this contract (native window state is not
          observable from the EVM). If you lose your ML-DSA key, the funds in your locks cannot be
          withdrawn by anyone — there is no owner, no admin and no recovery backdoor. Testnet only:
          nothing here has real value.
        </p>
      </footer>
    </main>
  );
}
