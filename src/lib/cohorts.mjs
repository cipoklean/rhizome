// Cohort analysis over public deposit amounts.
//
// The pool hides who paid whom inside it, but the public legs — shield deposits
// and withdrawals — expose exact amounts. An amount nobody else has ever used
// is a fingerprint: it survives the pool and reappears on the way out. An amount
// hundreds of people have used is cover.
//
// "Cohort" here means: how many other deposits of this token carry this same
// amount. Bigger cohort, weaker fingerprint.

/** Counts of each exact amount, as a Map<bigint, number>. */
export function amountHistogram(deposits) {
  const hist = new Map();
  for (const d of deposits) {
    hist.set(d.amount, (hist.get(d.amount) ?? 0) + 1);
  }
  return hist;
}

/** How many deposits share this exact amount. */
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
