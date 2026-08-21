// Compact derived snapshot — what the frontend actually renders.
// Same block/fee as pool-snapshot.mainnet.json but only histograms + timing,
// so the download is ~20 kB not ~1.3 M (gz). Fresh visitors never wait for RPC.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyWithdrawals } from "../src/lib/pool.mjs";
import { amountHistogram } from "../src/lib/cohorts.mjs";
import { poolTransactionBlocks } from "../src/lib/timing.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const networks = process.argv[2] ? [process.argv[2]] : ["mainnet"];

for (const network of networks) {
  const rawPath = join(__dirname, `../public/pool-snapshot.${network}.json`);
  let payload;
  try {
    payload = JSON.parse(readFileSync(rawPath, "utf8"));
  } catch (e) {
    console.error(`no ${rawPath} — run snapshot.mjs first`);
    process.exit(1);
  }
  const deposits = payload.deposits.map((d) => ({ ...d, amount: BigInt(d.amount) }));
  const withdrawals = payload.withdrawals.map((w) => ({ ...w, amount: BigInt(w.amount) }));
  const feeHistory = (payload.feeHistory ?? []).map((h) => ({ feeAmount: BigInt(h.feeAmount), blockNumber: h.blockNumber, txHash: h.txHash }));

  const { positions: exits, feeLegs, routers, routerStats, feeAmounts } = classifyWithdrawals(withdrawals, feeHistory);
  const entryHist = amountHistogram(deposits);
  const exitHist = exits.length ? amountHistogram(exits) : new Map();
  const txBlocks = poolTransactionBlocks(feeLegs);

  const compact = {
    network,
    block: payload.block,
    pool: payload.pool,
    token: payload.token,
    fee: payload.fee,
    feeHistory: payload.feeHistory,
    // histograms as string-keyed objects (amount wei string -> count)
    entryHist: Object.fromEntries([...entryHist.entries()].map(([k, v]) => [k.toString(), v])),
    exitHist: Object.fromEntries([...exitHist.entries()].map(([k, v]) => [k.toString(), v])),
    txBlocks,
    deposits: deposits.length,
    withdrawals: withdrawals.length,
    exits: exits.length,
    feeLegs: feeLegs.length,
    routers,
    routerStats,
    feeAmounts: feeAmounts.map((a) => a.toString()),
    generatedAt: payload.generatedAt,
  };
  const out = join(__dirname, `../public/pool-state.${network}.json`);
  writeFileSync(out, JSON.stringify(compact));
  writeFileSync(join(__dirname, `../public/pool-state.${network}.pretty.json`), JSON.stringify(compact, null, 2));
  const rawBytes = JSON.stringify(compact).length;
  console.log(`${network} compact: ${deposits.length} deposits ${exits.length} exits ${feeLegs.length} feeLegs -> ${out} ${(rawBytes/1024).toFixed(1)} kB`);
}
