// Rhizome's analysis, run headlessly against live public data.
//
//   node scripts/analyze.mjs                            # mainnet, 100 STRK
//   node scripts/analyze.mjs mainnet 50000              # 50,000 STRK position
//   node scripts/analyze.mjs mainnet 50000 roundTrip    # price the full exit too
//
// Reads only public pool state: the live fee, the fee history, and the public
// Deposit and Withdrawal amounts. No viewing key, no private state.

import { readFileSync } from "node:fs";
import { amountHistogram, popularAmounts, roundTripCohort } from "../src/lib/cohorts.mjs";
import { DEFAULT_FEE_MODEL, FEE_MODELS, computeFrontier, recommend } from "../src/lib/frontier.mjs";
import {
  classifyWithdrawals,
  connect,
  fetchDeposits,
  fetchFeeHistory,
  fetchWithdrawals,
  getFeeAmount,
  getFeeCollector,
} from "../src/lib/pool.mjs";
import { formatUnits, parseUnits } from "../src/lib/units.mjs";

const cfg = JSON.parse(readFileSync(new URL("../config/addresses.json", import.meta.url)));

const network = process.argv[2] ?? "mainnet";
const positionArg = process.argv[3] ?? "100";
const feeModel = process.argv[4] ?? DEFAULT_FEE_MODEL;
const net = cfg[network];
if (!net) {
  console.error(`unknown network "${network}"`);
  process.exit(1);
}
if (!FEE_MODELS[feeModel]) {
  console.error(`unknown fee model "${feeModel}" — one of ${Object.keys(FEE_MODELS).join(", ")}`);
  process.exit(1);
}

const fmt = (wei) => formatUnits(wei, 18, { maxFractionDigits: 4 });

const provider = await connect(net.rpc);
console.log(`network  ${network} @ block ${await provider.getBlockNumber()}`);

const [fee, collector, feeHistory] = await Promise.all([
  getFeeAmount(provider, net.strk20Pool),
  getFeeCollector(provider, net.strk20Pool),
  fetchFeeHistory(provider, net.strk20Pool),
]);

console.log(`\n=== the fee ===`);
console.log(`${fmt(fee)} STRK per pool transaction (per apply_actions call), paid in STRK`);
console.log(`collector ${collector}`);
console.log("history:");
console.log(`  from genesis          0 STRK   (fee unset; collect_fee is a no-op at zero)`);
for (const h of feeHistory) {
  console.log(`  from block ${String(h.blockNumber).padEnd(10)} ${fmt(h.feeAmount).padStart(2)} STRK`);
}
console.log(
  `\nmodel: ${feeModel} — ${FEE_MODELS[feeModel].label}, ${FEE_MODELS[feeModel].txPerLeg} pool transaction(s) per leg`,
);
console.log(`  ${FEE_MODELS[feeModel].note}`);

const token = net.tokens?.STRK ?? cfg.mainnet.tokens.STRK;
process.stdout.write("\nfetching public Deposit and Withdrawal events... ");
const [deposits, allWithdrawals] = await Promise.all([
  fetchDeposits(provider, net.strk20Pool, { token }),
  fetchWithdrawals(provider, net.strk20Pool, { token }),
]);
console.log(`${deposits.length} deposits, ${allWithdrawals.length} withdrawals`);

if (deposits.length === 0) {
  console.log("\nNo deposits for this token yet — no cohort data to work with.");
  process.exit(0);
}

// The fee is settled by an extra withdraw leg back to the fee router, so most
// public withdrawals are fee reimbursement rather than anybody's position.
const { positions: exits, feeLegs, routers } = classifyWithdrawals(allWithdrawals, feeHistory);
const feeShare = allWithdrawals.length === 0 ? 0 : (feeLegs.length / allWithdrawals.length) * 100;
console.log(
  `  of those withdrawals, ${feeLegs.length} (${feeShare.toFixed(1)}%) are fee reimbursement to ${routers.length} router(s) — excluded`,
);
console.log(`  ${exits.length} are position exits`);

const entryHist = amountHistogram(deposits);
const exitHist = exits.length > 0 ? amountHistogram(exits) : null;
const hist = { entry: entryHist, exit: exitHist };

const uniqueShare = (h) => {
  const unique = [...h.values()].filter((c) => c === 1).length;
  return { unique, pct: (unique / h.size) * 100 };
};

console.log(`\n=== the public legs ===`);
const e = uniqueShare(entryHist);
console.log(`entry   ${deposits.length} deposits from ${new Set(deposits.map((d) => d.user)).size} depositors`);
console.log(
  `        ${entryHist.size} distinct amounts, ${e.unique} one-of-a-kind (${e.pct.toFixed(1)}% are fingerprints)`,
);
if (exitHist) {
  const x = uniqueShare(exitHist);
  console.log(`exit    ${exits.length} withdrawals to ${new Set(exits.map((w) => w.to)).size} destinations`);
  console.log(
    `        ${exitHist.size} distinct amounts, ${x.unique} one-of-a-kind (${x.pct.toFixed(1)}% are fingerprints)`,
  );
} else {
  console.log("exit    no position withdrawals for this token yet — exit cover is unknown, not safe");
}

console.log(`\namounts with the most public cover, both legs:`);
console.log("       amount        entry    exit   weaker side");
for (const { amount } of popularAmounts(entryHist, 12)) {
  const s = roundTripCohort(entryHist, exitHist, amount);
  const flag = s.exitKnown && s.exitCohort === 0 ? "   <- never withdrawn" : "";
  console.log(
    `  ${fmt(amount).padStart(12)}   ${String(s.entryCohort).padStart(6)}  ${String(s.exitCohort ?? "?").padStart(6)}   ${String(s.cohort).padStart(6)}${flag}`,
  );
}

const position = parseUnits(positionArg, 18);
console.log(`\n=== frontier for ${fmt(position)} STRK ===`);
const rows = computeFrontier({ position, feeAmount: fee, hist, feeModel });

if (rows.length === 0) {
  console.log("fees exceed the position at every leg count — too small to shield sensibly.");
  process.exit(0);
}

console.log("legs   pool tx   fee cost   fee %   worst dist.   entry   exit   weaker   covered");
for (const r of rows) {
  console.log(
    `${String(r.tranches).padStart(4)}   ${String(r.poolTransactions).padStart(7)}   ${fmt(r.feeCost).padStart(8)}   ` +
      `${(r.feeCostRatio * 100).toFixed(2).padStart(5)}%   ${r.worstDistinctiveness.toFixed(4).padStart(11)}   ` +
      `${String(r.minEntryCohort).padStart(5)}   ${String(r.minExitCohort ?? "?").padStart(4)}   ${String(r.minCohort).padStart(6)}   ${r.allCovered ? "yes" : "no"}`,
  );
}

const rec = recommend(rows);
console.log(
  `\nrecommendation: ${rec.tranches} leg${rec.tranches === 1 ? "" : "s"} — ${rec.poolTransactions} pool transactions, ` +
    `${fmt(rec.feeCost)} STRK in fees (${(rec.feeCostRatio * 100).toFixed(2)}% of position) — ${rec.verdict}`,
);
if (feeModel !== "roundTrip") {
  console.log(
    `entering and later exiting the whole position: ${fmt(rec.roundTripFeeCost)} STRK ` +
      `(${(rec.roundTripFeeCostRatio * 100).toFixed(2)}% of position)`,
  );
}

const printSchedule = () => {
  for (const [i, t] of rec.schedule.entries()) {
    console.log(
      `  ${String(i + 1).padStart(2)}. ${fmt(t.amount).padStart(12)} STRK   entry ${String(t.entryCohort).padStart(4)}   ` +
        `exit ${String(t.exitCohort ?? "?").padStart(4)}${t.covered ? "" : "   <- no public cover"}`,
    );
  }
};

switch (rec.verdict) {
  case "position-too-small":
    console.log(
      "\nThe pool fee is a large share of this position. Shielding still works, but the fee\n" +
        "dominates — consider a larger position or accept the cost knowingly.",
    );
    break;
  case "already-covered":
    console.log(
      "\nThis amount already blends into existing public legs on both sides. Splitting it\n" +
        "would cost fees and buy nothing. One leg is the honest answer.",
    );
    break;
  case "split-earns-its-fee":
    console.log("\nschedule:");
    printSchedule();
    break;
  default:
    console.log(
      "\nNo affordable schedule reaches good cover. Best available shown; the flagged legs\n" +
        "below still carry a distinctive amount on at least one side.",
    );
    printSchedule();
}
