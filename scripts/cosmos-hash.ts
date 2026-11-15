/**
 * cosmos-hash.ts - resolve the Cosmos transaction hash wrapping an EVM
 * transaction hash. Pure helpers, NO side effects on import: this module is
 * imported by both deploy.ts and usage.ts, so it must never run anything
 * when loaded.
 */
import { keccak256, type Hex } from "viem";
import { createHash } from "node:crypto";

/** Testnet Cosmos REST (LCD) base URL, for resolving Cosmos transaction hashes. */
const TESTNET_REST = "https://api-testnet.qore.host";

/** Minimal protobuf field reader (for TxRaw -> MsgEthereumTx matching). */
function readVarint(buf: Buffer, off: number): [bigint, number] {
  let v = 0n;
  let s = 0n;
  for (;;) {
    const b = buf[off++] as number;
    v |= BigInt(b & 0x7f) << s;
    if (!(b & 0x80)) break;
    s += 7n;
  }
  return [v, off];
}

function pbFields(buf: Buffer): Array<[number, Buffer]> {
  const out: Array<[number, Buffer]> = [];
  let off = 0;
  while (off < buf.length) {
    const [tag, o1] = readVarint(buf, off);
    off = o1;
    const num = Number(tag >> 3n);
    const wt = Number(tag & 7n);
    if (wt === 2) {
      const [len, o2] = readVarint(buf, off);
      off = o2;
      out.push([num, buf.subarray(off, off + Number(len))]);
      off += Number(len);
    } else if (wt === 0) {
      const [, o2] = readVarint(buf, off);
      off = o2;
    } else if (wt === 5) {
      off += 4;
    } else if (wt === 1) {
      off += 8;
    } else {
      throw new Error(`bad protobuf wire type ${wt}`);
    }
  }
  return out;
}

type ReceiptReader = {
  getTransactionReceipt: (args: { hash: Hex }) => Promise<{ blockNumber: bigint }>;
};

/**
 * The Cosmos transaction hash (uppercase hex, no 0x) wrapping an EVM
 * transaction hash. The explorer's /tx/ route only resolves Cosmos
 * hashes, so EVM hashes must be translated this way before linking:
 * take the receipt's block, then find the MsgEthereumTx whose embedded
 * raw transaction hashes (keccak256) to the EVM hash.
 */
export async function cosmosHashForEvmTx(
  publicClient: ReceiptReader,
  evmHash: Hex,
): Promise<{ cosmosHash: string; block: number }> {
  const receipt = await publicClient.getTransactionReceipt({ hash: evmHash });
  const height = Number(receipt.blockNumber);
  const res = await fetch(`${TESTNET_REST}/cosmos/base/tendermint/v1beta1/blocks/${height}`);
  if (!res.ok) throw new Error(`block ${height} query failed: HTTP ${res.status}`);
  const block = (await res.json()) as { block: { data: { txs: string[] } } };
  for (const txb64 of block.block.data.txs) {
    const raw = Buffer.from(txb64, "base64");
    const body = pbFields(raw).find(([n]) => n === 1)?.[1];
    if (!body) continue;
    for (const [, anyMsg] of pbFields(body).filter(([n]) => n === 1)) {
      const f = pbFields(anyMsg);
      const typeUrl = f.find(([n]) => n === 1)?.[1]?.toString() ?? "";
      if (!typeUrl.endsWith("MsgEthereumTx")) continue;
      const value = f.find(([n]) => n === 2)?.[1];
      if (!value) continue;
      const data = pbFields(value).find(([n]) => n === 6)?.[1];
      if (data && keccak256(data).toLowerCase() === evmHash.toLowerCase()) {
        return {
          cosmosHash: createHash("sha256").update(raw).digest("hex").toUpperCase(),
          block: height,
        };
      }
    }
  }
  throw new Error(`no Cosmos tx found for EVM hash ${evmHash} in block ${height}`);
}
