// Cohort analysis over public deposit and withdrawal amounts.
//
// The pool hides who paid whom inside it, but both public legs — the shield
// deposit on the way in and the withdrawal on the way out — expose exact
// amounts. An amount nobody else has ever used is a fingerprint: it survives the
// pool and reappears on the way out. An amount hundreds of people have used is
// cover.
//
// "Cohort" here means: how many other legs of this token carry this same amount.
// Bigger cohort, weaker fingerprint.
//
// Cover is not symmetric, and that is the whole reason this module reads both
// sides. Measured on mainnet: 4 STRK has 787 deposits behind it and 20
// withdrawals; 3,000 STRK has 395 and 31; and 4.1 STRK has 149 deposits and has
// never once been withdrawn. A schedule tuned on entry cover alone walks into an
// exit leg nobody else has ever made.

/** Counts of each exact amount, as a Map<bigint, number>. */
export function amountHistogram(legs) {
  const hist = new Map();
  for (const l of legs) {
    hist.set(l.amount, (hist.get(l.amount) ?? 0) + 1);
  }
  return hist;
}

/** How many legs share this exact amount. */
export function cohortSize(hist, amount) {
  return hist.get(amount) ?? 0;
}

/**
 * The most-used amounts, largest cohort first. These are the amounts that blend
 * in — the natural "denominations" the pool has grown organically.
 */
export function popularAmounts(hist, limit = 20, { minCohort = 2 } = {}) {
  return [...hist.entries()]
    .filter(([, count]) => count >= minCohort)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([amount, count]) => ({ amount, cohort: count }));
}

/**
 * Nearest well-populated amount at or below `target`.
 *
 * Rounding *down* matters: a tranche must be affordable from the position, and
 * rounding up could overrun the remaining balance.
 */
export function snapToCohort(hist, target, { minCohort = 3, tolerance = 0.25 } = {}) {
  const floor = target - BigInt(Math.floor(Number(target) * tolerance));
  let best = null;

  for (const [amount, count] of hist) {
    if (count < minCohort) continue;
    if (amount > target || amount < floor) continue;
    if (best === null || amount > best.amount) best = { amount, cohort: count };
  }
  return best;
}

/**
 * Distinctiveness of an amount, 0 (perfect cover) to 1 (unique fingerprint).
 * Deliberately crude and monotonic in cohort size — the point is to be honest
 * about ordering, not to invent false precision.
 */
export function distinctiveness(hist, amount) {
  const cohort = cohortSize(hist, amount);
  if (cohort === 0) return 1;
  return 1 / (1 + cohort);
}

/**
 * Score one amount across the whole round trip.
 *
 * The reported cohort is the *weaker* of the two sides, and the reported
 * distinctiveness the *worse* of the two. A leg is only as unlinkable as its
 * more exposed end: an attacker who cannot place your deposit will happily place
 * your withdrawal instead, and only needs one of them.
 *
 * `exitHist` may be null when exit data is unavailable (a token with no
 * withdrawals yet, say). The result then carries `exitKnown: false` and scores
 * on the entry side alone rather than pretending the exit is safe.
 */
export function roundTripCohort(entryHist, exitHist, amount) {
  const entryCohort = cohortSize(entryHist, amount);
  const entryDistinctiveness = distinctiveness(entryHist, amount);

  if (!exitHist) {
    return {
      amount,
      entryCohort,
      exitCohort: null,
      entryDistinctiveness,
      exitDistinctiveness: null,
      cohort: entryCohort,
      distinctiveness: entryDistinctiveness,
      exitKnown: false,
    };
  }

  const exitCohort = cohortSize(exitHist, amount);
  const exitDistinctiveness = distinctiveness(exitHist, amount);
  return {
    amount,
    entryCohort,
    exitCohort,
    entryDistinctiveness,
    exitDistinctiveness,
    cohort: Math.min(entryCohort, exitCohort),
    distinctiveness: Math.max(entryDistinctiveness, exitDistinctiveness),
    exitKnown: true,
  };
}

/**
 * Amounts that carry cover on both legs, weakest side first.
 *
 * Ranking on the weaker side is what stops the analysis recommending 4 STRK —
 * an amount with 787 deposits behind it and zero withdrawals, which looks like
 * the safest denomination in the pool right up to the moment you try to leave.
 */
export function coveredBothSides(entryHist, exitHist, limit = 500, { minCohort = 3 } = {}) {
  const amounts = new Set(entryHist.keys());
  const out = [];

  for (const amount of amounts) {
    const scored = roundTripCohort(entryHist, exitHist, amount);
    if (scored.cohort >= minCohort) out.push(scored);
  }

  return out
    .sort((a, b) => b.cohort - a.cohort || (a.amount < b.amount ? -1 : 1))
    .slice(0, limit);
}
