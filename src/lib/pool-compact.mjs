// One helper that turns a full raw scan into the compact file the frontend paints from.
// Both scripts/snapshot.mjs and scripts/snapshot-compact.mjs use this, so the
// shipped pool-state.*.json can never drift from the build tool.
import { classifyWithdrawals } from "./pool.mjs";
import { amountHistogram } from "./cohorts.mjs";
import { poolTransactionBlocks } from "./timing.mjs";

export function buildCompactPayload({ network, block, pool, token, fee, feeHistory, deposits, withdrawals, generatedAt }) {
  const { positions: exits, feeLegs, routers, routerStats, feeAmounts } = classifyWithdrawals(withdrawals, feeHistory);
  const entryHist = amountHistogram(deposits);
  const exitHist = exits.length ? amountHistogram(exits) : new Map();
  const txBlocks = poolTransactionBlocks(feeLegs);
  return {
    network,
    block,
    pool,
    token,
    fee: fee.toString(),
    feeHistory: feeHistory.map((h) => ({ feeAmount: h.feeAmount.toString(), blockNumber: h.blockNumber, txHash: h.txHash })),
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
    generatedAt: generatedAt ?? new Date().toISOString(),
  };
}
