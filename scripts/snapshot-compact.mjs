// Derive the compact file from an existing full snapshot — no RPC.
// Used when the full scan already exists locally and you just want to refresh
// pool-state.*.json without re-scanning 13M blocks.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCompactPayload } from "../src/lib/pool-compact.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const networks = process.argv[2] ? [process.argv[2]] : ["mainnet"];

for (const network of networks) {
  const rawPath = join(__dirname, `../public/pool-snapshot.${network}.json`);
  let payload;
  try {
    payload = JSON.parse(readFileSync(rawPath, "utf8"));
  } catch {
    console.error(`no ${rawPath} — run scripts/snapshot.mjs first`);
    process.exit(1);
  }
  const deposits = payload.deposits.map((d) => ({ ...d, amount: BigInt(d.amount) }));
  const withdrawals = payload.withdrawals.map((w) => ({ ...w, amount: BigInt(w.amount) }));
  const feeHistory = (payload.feeHistory ?? []).map((h) => ({ feeAmount: BigInt(h.feeAmount), blockNumber: h.blockNumber, txHash: h.txHash }));
  const fee = payload.fee ? BigInt(payload.fee) : 0n;

  const compact = buildCompactPayload({
    network,
    block: payload.block,
    pool: payload.pool,
    token: payload.token,
    fee,
    feeHistory,
    deposits,
    withdrawals,
    generatedAt: payload.generatedAt,
  });
  const out = join(__dirname, `../public/pool-state.${network}.json`);
  writeFileSync(out, JSON.stringify(compact));
  console.log(`${network} compact: ${deposits.length} deposits -> ${out} ${(JSON.stringify(compact).length / 1024).toFixed(1)} kB via pool-compact.mjs`);
}
