// Build-time pool snapshot — ships as static JSON so mainnet loads instantly.
// Run:  node scripts/snapshot.mjs          -> both networks
//       node scripts/snapshot.mjs mainnet   -> mainnet only
// Writes: public/pool-snapshot.mainnet.json , public/pool-snapshot.sepolia.json
// Each file is the full public Deposit/Withdrawal set at a pinned block — the
// frontend shows it instantly, then fetches only the delta since that block live.
import { mkdirSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCompactPayload } from "../src/lib/pool-compact.mjs";
import {
  connect,
  fetchDeposits,
  fetchFeeHistory,
  fetchWithdrawals,
  getFeeAmount,
} from "../src/lib/pool.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(__dirname, "../config/addresses.json"), "utf8"));

const targets = process.argv[2] ? [process.argv[2]] : ["mainnet", "sepolia"];

for (const network of targets) {
  const net = cfg[network];
  if (!net) {
    console.error(`unknown network "${network}"`);
    process.exit(1);
  }
  const token = net.tokens?.STRK ?? cfg.mainnet.tokens.STRK;
  console.log(`\n[${network}] connecting…`);
  const provider = await connect(net.rpc);
  const block = await provider.getBlockNumber();
  console.log(`[${network}] @ block ${block} — reading pool ${net.strk20Pool} token ${token.slice(0, 10)}…`);

  const t0 = Date.now();
  const [fee, feeHistory, deposits, withdrawals] = await Promise.all([
    getFeeAmount(provider, net.strk20Pool),
    fetchFeeHistory(provider, net.strk20Pool),
    fetchDeposits(provider, net.strk20Pool, { token }),
    fetchWithdrawals(provider, net.strk20Pool, { token }),
  ]);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[${network}] fee ${fee} · ${feeHistory.length} FeeAmountSet · ${deposits.length} deposits · ${withdrawals.length} withdrawals in ${secs}s`);

  const payload = {
    network,
    block,
    pool: net.strk20Pool,
    token,
    fee: fee.toString(),
    feeHistory: feeHistory.map((h) => ({ feeAmount: h.feeAmount.toString(), blockNumber: h.blockNumber, txHash: h.txHash })),
    deposits: deposits.map((d) => ({ user: d.user, token: d.token, amount: d.amount.toString(), blockNumber: d.blockNumber, txHash: d.txHash })),
    withdrawals: withdrawals.map((w) => ({ to: w.to, token: w.token, amount: w.amount.toString(), blockNumber: w.blockNumber, txHash: w.txHash })),
    generatedAt: new Date().toISOString(),
  };

  const dir = join(__dirname, "../public");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `pool-snapshot.${network}.json`);
  writeFileSync(out, JSON.stringify(payload));
  const rawBytes = JSON.stringify(payload).length;
  console.log(`[${network}] wrote ${out}  (${(rawBytes / 1024).toFixed(0)} kB)`);

  // Also emit the compact file via the shared helper — single source of truth
  const compact = buildCompactPayload({ network, block, pool: net.strk20Pool, token, fee, feeHistory, deposits, withdrawals, generatedAt: payload.generatedAt });
  const compactOut = join(dir, `pool-state.${network}.json`);
  writeFileSync(compactOut, JSON.stringify(compact));
  console.log(`[${network}] wrote ${compactOut}  (${(JSON.stringify(compact).length / 1024).toFixed(0)} kB compact via pool-compact.mjs)`);
}
console.log("\ndone — run `git add public/pool-state.<network>.json` before mainnet deploy.");
