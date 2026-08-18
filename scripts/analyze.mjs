// Rhizome's analysis, run headlessly against live public data.
//
//   node scripts/analyze.mjs                  # mainnet, 100 STRK position
//   node scripts/analyze.mjs mainnet 50000    # 50,000 STRK position
//
// Reads only public pool state: the live fee and public Deposit amounts. No
// viewing key, no private state.

import { readFileSync } from "node:fs";
import { amountHistogram, popularAmounts } from "../src/lib/cohorts.mjs";
import { computeFrontier, recommend } from "../src/lib/frontier.mjs";
import { connect, fetchDeposits, getFeeAmount } from "../src/lib/pool.mjs";
import { formatUnits, parseUnits } from "../src/lib/units.mjs";

const cfg = JSON.parse(readFileSync(new URL("../config/addresses.json", import.meta.url)));

const network = process.argv[2] ?? "mainnet";
const positionArg = process.argv[3] ?? "100";
const net = cfg[network];
if (!net) {
  console.error(`unknown network "${network}"`);
  process.exit(1);
}

const fmt = (wei) => formatUnits(wei, 18, { maxFractionDigits: 4 });

const provider = await connect(net.rpc);
console.log(`network  ${network} @ block ${await provider.getBlockNumber()}`);

const fee = await getFeeAmount(provider, net.strk20Pool);
console.log(`pool fee ${fmt(fee)} STRK per private operation, deducted from the deposit\n`);

const token = net.tokens?.STRK ?? cfg.mainnet.tokens.STRK;
process.stdout.write("fetching public Deposit events... ");
const deposits = await fetchDeposits(provider, net.strk20Pool, { token });
console.log(`${deposits.length} found`);

if (deposits.length === 0) {
  console.log("\nNo deposits for this token yet — no cohort data to work with.");
  process.exit(0);
}

const hist = amountHistogram(deposits);
const uniqueAmounts = [...hist.values()].filter((c) => c === 1).length;
console.log(`distinct depositors    ${new Set(deposits.map((d) => d.user)).size}`);
console.log(`distinct amounts       ${hist.size}`);
console.log(
  `one-of-a-kind amounts  ${uniqueAmounts} (${((uniqueAmounts / hist.size) * 100).toFixed(1)}% of amounts are fingerprints)\n`,
);

console.log("amounts with the most public cover:");
for (const { amount, cohort } of popularAmounts(hist, 10)) {
  console.log(`  ${fmt(amount).padStart(12)} STRK   cohort ${cohort}`);
}

const position = parseUnits(positionArg, 18);
console.log(`\n=== frontier for ${fmt(position)} STRK ===`);
const rows = computeFrontier({ position, feeAmount: fee, hist });

if (rows.length === 0) {
  console.log("fees exceed the position at every tranche count — too small to shield sensibly.");
  process.exit(0);
}

console.log("legs    fee cost   fee %   worst distinctiveness   smallest cohort   fully covered");
for (const r of rows) {
  console.log(
    `${String(r.tranches).padStart(4)}   ${fmt(r.feeCost).padStart(9)}   ${(r.feeCostRatio * 100).toFixed(2).padStart(5)}%   ` +
      `${r.worstDistinctiveness.toFixed(4).padStart(21)}   ${String(r.minCohort).padStart(15)}   ${r.allCovered ? "yes" : "no"}`,
  );
}

const rec = recommend(rows);
console.log(
  `\nrecommendation: ${rec.tranches} leg${rec.tranches === 1 ? "" : "s"}, fee cost ${fmt(rec.feeCost)} STRK ` +
    `(${(rec.feeCostRatio * 100).toFixed(2)}% of position) — ${rec.verdict}`,
);

switch (rec.verdict) {
  case "position-too-small":
    console.log(
      "The pool fee is a large share of this position. Shielding still works, but the fee\n" +
        "dominates — consider a larger position or accept the cost knowingly.",
    );
    break;
  case "already-covered":
    console.log(
      "This amount already blends into existing public deposits. Splitting it would cost\n" +
        "fees and buy nothing. One leg is the honest answer.",
    );
    break;
  case "split-earns-its-fee":
    console.log("schedule:");
    for (const [i, t] of rec.schedule.entries()) {
      console.log(
        `  ${String(i + 1).padStart(2)}. ${fmt(t.amount).padStart(12)} STRK   cohort ${String(t.cohort).padStart(4)}${t.covered ? "" : "   <- no public cover"}`,
      );
    }
    break;
  default:
    console.log(
      "No affordable schedule reaches good cover. Best available shown; the flagged legs\n" +
        "below still carry a distinctive amount.",
    );
    for (const [i, t] of rec.schedule.entries()) {
      console.log(
        `  ${String(i + 1).padStart(2)}. ${fmt(t.amount).padStart(12)} STRK   cohort ${String(t.cohort).padStart(4)}${t.covered ? "" : "   <- no public cover"}`,
      );
    }
}
