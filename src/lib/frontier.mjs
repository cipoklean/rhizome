// The cost/unlinkability frontier.
//
// Splitting a position into several tranches reduces how distinctive each public
// leg is. It also costs a flat pool fee per tranche, because the protocol allows
// at most one external invoke per pool transaction — so N tranches is N
// transactions is N fees.
//
// At the fee measured on mainnet (6 STRK, deducted from the deposit) that cost
// is not marginal. This module refuses to pretend otherwise: for small positions
// the honest recommendation is one tranche.

import { cohortSize, distinctiveness, popularAmounts } from "./cohorts.mjs";

/**
 * Build a schedule out of amounts that already have public cover.
 *
 * Two earlier versions of this were wrong in instructive ways.
 *
 * The first split the position evenly and let a final tranche absorb the
 * remainder. That remainder is almost always a one-of-a-kind amount, and since
 * an attacker correlates on the most identifiable leg, it poisoned every
 * schedule.
 *
 * The second covered the position greedily largest-first. That minimises the
 * number of legs, which is the wrong objective — for 50,000 STRK it produced
 * 30,000 + 20,000 with cohorts of 5 and 4, when 16 x 3,000 + 2,000 was available
 * with cohorts of 395 and 229 for an extra 90 STRK in fees on a 50,000 position.
 *
 * So: try each well-covered amount as a repeating unit, cover any remainder from
 * other covered amounts, and keep whichever schedule maximises the *weakest*
 * cohort within the leg budget.
 */
export function buildSchedule(position, maxTranches, hist, { minCohort = 3, minTranche = 0n } = {}) {
  const candidates = popularAmounts(hist, 500, { minCohort })
    .filter((c) => c.amount >= minTranche && c.amount > 0n)
    .sort((a, b) => b.cohort - a.cohort);

  if (candidates.length === 0) return null;
  const bySizeDesc = [...candidates].sort((a, b) => (a.amount > b.amount ? -1 : 1));

  const leg = (amount) => ({
    amount,
    cohort: cohortSize(hist, amount),
    distinctiveness: distinctiveness(hist, amount),
    covered: cohortSize(hist, amount) >= minCohort,
  });

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
 * `worstDistinctiveness` is the weakest link: an attacker correlates on the most
 * identifiable tranche, so a schedule is only as good as its worst leg.
 * Averaging would flatter the result and mislead.
 */
export function computeFrontier({
  position,
  feeAmount,
  hist,
  maxTranches = 24,
  minTranche = 0n,
}) {
  const rows = [];
  let seen = new Set();

  for (let n = 1; n <= maxTranches; n++) {
    const tranches = buildSchedule(position, n, hist, { minTranche });
    if (!tranches) continue;

    // A larger budget often yields the same schedule; report each once.
    const key = tranches.map((t) => t.amount.toString()).join(",");
    if (seen.has(key)) continue;
    seen.add(key);

    const actual = tranches.length;
    const feeCost = feeAmount * BigInt(actual);
    if (feeCost >= position) continue; // fees would eat the position

    const worst = Math.max(...tranches.map((t) => t.distinctiveness));
    const minCohort = Math.min(...tranches.map((t) => t.cohort));

    rows.push({
      tranches: actual,
      feeCost,
      feeCostRatio: Number(feeCost) / Number(position),
      worstDistinctiveness: worst,
      minCohort,
      allCovered: tranches.every((t) => t.covered),
      schedule: tranches,
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
