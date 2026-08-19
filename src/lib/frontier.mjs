// The cost/unlinkability frontier.
//
// Splitting a position into several tranches reduces how distinctive each public
// leg is. It also costs a flat pool fee per *pool transaction*, and the protocol
// allows at most one external invoke per transaction — so a schedule of N legs
// is at least N transactions, and usually more than N.
//
// Two things this module refuses to fudge:
//
//   1. The fee is charged per `apply_actions` call, not per tranche. Getting a
//      tranche into a venue takes two pool transactions if you want the deposit
//      unlinked from the venue action, and unwinding it takes two more. Pricing
//      a schedule at one fee per leg understates it by 2-4x.
//   2. A leg is scored on its weaker end. Cover on the way in is not cover on
//      the way out, and mainnet cover is wildly asymmetric.
//
// At the fee measured on mainnet (6 STRK per pool transaction) that cost is not
// marginal. For small positions the honest recommendation is one tranche.

import { coveredBothSides, roundTripCohort } from "./cohorts.mjs";

/**
 * Pool transactions per tranche.
 *
 * The fee is per transaction, so this is the multiplier that turns a leg count
 * into a bill. `bundled` is the cheap option and Rhizome does not recommend it:
 * putting the deposit and the venue invoke in one transaction publishes "this
 * address deposited X" in the same transaction as the venue action it paid for,
 * which is the correlation the schedule exists to break.
 */
export const FEE_MODELS = {
  bundled: {
    txPerLeg: 1,
    label: "deposit + invoke in one transaction",
    note: "Cheapest, and it links your public deposit to the venue action. Priced for comparison, not recommended.",
  },
  enter: {
    txPerLeg: 2,
    label: "shield, then invoke separately",
    note: "Shielding as its own earlier transaction leaves the venue action with no public leg to correlate against.",
  },
  roundTrip: {
    txPerLeg: 4,
    label: "shield, invoke, unwind, unshield",
    note: "The full cost of holding and then exiting the position — the number that decides whether splitting was worth it.",
  },
};

export const DEFAULT_FEE_MODEL = "enter";

/** Accept either `{ entry, exit }` or a bare entry histogram. */
function normalizeHistograms(hist) {
  if (hist instanceof Map) return { entry: hist, exit: null };
  return { entry: hist.entry, exit: hist.exit ?? null };
}

/**
 * Build a schedule out of amounts that already have public cover on both legs.
 *
 * Three earlier versions of this were wrong in instructive ways.
 *
 * The first split the position evenly and let a final tranche absorb the
 * remainder. That remainder is almost always a one-of-a-kind amount, and since
 * an attacker correlates on the most identifiable leg, it poisoned every
 * schedule.
 *
 * The second covered the position greedily largest-first. That minimises the
 * number of legs, which is the wrong objective — for 50,000 STRK it produced
 * 30,000 + 20,000 with cohorts of 5 and 4, when 16 x 3,000 + 2,000 was available
 * with far better cover for an extra 90 STRK in fees on a 50,000 position.
 *
 * The third ranked on deposit cohorts alone, which put 4.1 STRK among the ten
 * best-covered denominations in the pool on the strength of 149 deposits — an
 * amount that has never once been withdrawn. Every leg of such a schedule would
 * have had to leave the pool as a unique amount.
 *
 * So: try each well-covered amount as a repeating unit, cover any remainder from
 * other covered amounts, and keep whichever schedule maximises the *weakest
 * cohort on the weaker side* within the leg budget.
 */
export function buildSchedule(position, maxTranches, hist, { minCohort = 3, minTranche = 0n } = {}) {
  const { entry, exit } = normalizeHistograms(hist);

  const candidates = coveredBothSides(entry, exit, 500, { minCohort })
    .filter((c) => c.amount >= minTranche && c.amount > 0n);

  if (candidates.length === 0) return null;
  const bySizeDesc = [...candidates].sort((a, b) => (a.amount > b.amount ? -1 : 1));

  const leg = (amount) => {
    const scored = roundTripCohort(entry, exit, amount);
    return { ...scored, covered: scored.cohort >= minCohort };
  };

  /** Cover `amount` exactly from covered denominations, largest first. */
  const coverRemainder = (amount, budget) => {
    const legs = [];
    let left = amount;
    while (left > 0n && legs.length < budget) {
      const pick = bySizeDesc.find((c) => c.amount <= left);
      if (!pick) break;
      legs.push(leg(pick.amount));
      left -= pick.amount;
    }
    return left === 0n ? legs : null;
  };

  let best = null;
  const consider = (legs) => {
    if (!legs || legs.length === 0 || legs.length > maxTranches) return;
    const weakest = Math.min(...legs.map((l) => l.cohort));
    const covered = legs.every((l) => l.covered);
    if (
      best === null ||
      (covered && !best.covered) ||
      (covered === best.covered &&
        (weakest > best.weakest || (weakest === best.weakest && legs.length < best.legs.length)))
    ) {
      best = { legs, weakest, covered };
    }
  };

  // Baseline: shield the whole position in one leg, whatever its cover.
  consider([leg(position)]);

  for (const c of candidates) {
    if (c.amount > position) continue;
    const repeats = position / c.amount;
    if (repeats === 0n || repeats > BigInt(maxTranches)) continue;

    const remainder = position % c.amount;
    const legs = Array.from({ length: Number(repeats) }, () => leg(c.amount));

    if (remainder === 0n) {
      consider(legs);
      continue;
    }
    const tail = coverRemainder(remainder, maxTranches - legs.length);
    if (tail) consider([...legs, ...tail]);
  }

  return best ? best.legs : null;
}

/**
 * Score every tranche budget from 1..maxTranches.
 *
 * `worstDistinctiveness` is the weakest link twice over: the most identifiable
 * tranche, scored on its more exposed leg. An attacker only needs one end of one
 * tranche, so a schedule is only as good as its worst leg. Averaging would
 * flatter the result and mislead.
 */
export function computeFrontier({
  position,
  feeAmount,
  hist,
  maxTranches = 24,
  minTranche = 0n,
  feeModel = DEFAULT_FEE_MODEL,
}) {
  const model = FEE_MODELS[feeModel];
  if (!model) throw new Error(`unknown fee model "${feeModel}"`);

  const rows = [];
  const seen = new Set();

  for (let n = 1; n <= maxTranches; n++) {
    const tranches = buildSchedule(position, n, hist, { minTranche });
    if (!tranches) continue;

    // A larger budget often yields the same schedule; report each once.
    const key = tranches.map((t) => t.amount.toString()).join(",");
    if (seen.has(key)) continue;
    seen.add(key);

    const actual = tranches.length;
    const poolTransactions = actual * model.txPerLeg;
    const feeCost = feeAmount * BigInt(poolTransactions);
    if (feeCost >= position) continue; // fees would eat the position

    const roundTripFeeCost = feeAmount * BigInt(actual * FEE_MODELS.roundTrip.txPerLeg);
    const exitKnown = tranches.every((t) => t.exitKnown);

    rows.push({
      tranches: actual,
      poolTransactions,
      feeCost,
      feeCostRatio: Number(feeCost) / Number(position),
      roundTripFeeCost,
      roundTripFeeCostRatio: Number(roundTripFeeCost) / Number(position),
      worstDistinctiveness: Math.max(...tranches.map((t) => t.distinctiveness)),
      minCohort: Math.min(...tranches.map((t) => t.cohort)),
      minEntryCohort: Math.min(...tranches.map((t) => t.entryCohort)),
      minExitCohort: exitKnown ? Math.min(...tranches.map((t) => t.exitCohort)) : null,
      exitKnown,
      allCovered: tranches.every((t) => t.covered),
      schedule: tranches,
      feeModel,
    });
  }

  return rows;
}

/**
 * Choose a tranche count.
 *
 * Two hard constraints, because ranking improvements alone produces absurd
 * answers — an early version of this happily spent 60% of a position in fees to
 * move distinctiveness from 0.013 to 0.008:
 *
 *   1. `maxFeeRatio` — never spend more than this share of the position on fees.
 *   2. `targetDistinctiveness` — "good enough" cover; past this, more tranches
 *      buy nothing worth paying for.
 *
 * Among schedules that clear both, take the cheapest. If a single tranche
 * already clears them, that is the answer — and for small positions it usually
 * is.
 */
export function recommend(rows, { maxFeeRatio = 0.1, targetDistinctiveness = 0.05 } = {}) {
  if (rows.length === 0) return null;

  const affordable = rows.filter((r) => r.feeCostRatio <= maxFeeRatio);
  if (affordable.length === 0) {
    // Even one operation costs more than the budget allows.
    return { ...rows[0], isSplitWorthwhile: false, verdict: "position-too-small" };
  }

  const meeting = affordable.filter((r) => r.worstDistinctiveness <= targetDistinctiveness);
  if (meeting.length > 0) {
    const best = meeting.reduce((a, b) => (a.tranches <= b.tranches ? a : b));
    return {
      ...best,
      isSplitWorthwhile: best.tranches > 1,
      verdict: best.tranches === 1 ? "already-covered" : "split-earns-its-fee",
    };
  }

  // Nothing affordable reaches the target: take the best cover we can afford.
  const best = affordable.reduce((a, b) =>
    a.worstDistinctiveness <= b.worstDistinctiveness ? a : b,
  );
  return {
    ...best,
    isSplitWorthwhile: best.tranches > 1,
    verdict: "best-affordable",
  };
}
