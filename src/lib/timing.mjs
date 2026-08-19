// Timing cover — the axis that costs patience instead of STRK.
//
// Amount cover is bought with fees: more legs, more pool transactions, more
// STRK. Timing cover is bought by waiting, and waiting is free. Rhizome priced
// the expensive axis first and would have been dishonest to stop there, because
// the measured numbers say the free axis is where this pool actually leaks.
//
// The reasoning: shielding in its own earlier transaction is what stops an
// observer tying your public deposit to the venue action it funds. That only
// works if something else happened in between. If your shield is the only pool
// transaction for an hour either side, the observer does not need amounts at
// all — there is exactly one candidate.
//
// Measured on mainnet over the most recent 500k blocks (~240 hours at the
// measured 1.73s per block): 245 pool transactions, and within +/-10 blocks —
// the note maturity gap you cannot avoid — 98% of them were alone. At +/-1000
// blocks (~half an hour) the median transaction has 4 others for company.
//
// So the 6 STRK you spend separating the shield from the invoke buys nothing
// unless you also wait. That is the finding, and it is free to act on.

/**
 * Documented note maturity: freshly shielded funds are not spendable for about
 * ten blocks. It is the floor on any two-transaction schedule — and at that
 * floor you are almost certainly the only pool transaction in the window.
 */
export const NOTE_MATURITY_BLOCKS = 10;

/**
 * A census of pool transactions, taken from fee-reimbursement legs.
 *
 * Every priced `apply_actions` call emits exactly one fee withdrawal, so the
 * blocks carrying those legs are the blocks carrying pool transactions. This is
 * a better denominator than deposits or withdrawals alone: it counts private
 * transfers and venue invokes too, which is precisely the traffic a timing
 * observer has to rule out.
 *
 * Returns sorted unique block numbers.
 */
export function poolTransactionBlocks(feeLegs) {
  return [...new Set(feeLegs.map((f) => f.blockNumber))].sort((a, b) => a - b);
}

/** Index of the first element >= target, in a sorted array. */
function lowerBound(sorted, target) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * How many *other* pool transactions fall within `window` blocks either side of
 * `at`. The timing analogue of a cohort: company you did not have to pay for.
 *
 * Binary search rather than a scan, because the full history is 15k
 * transactions and the burst around block 11.0M is dense enough that the
 * quadratic version is slow enough to discourage running it.
 */
export function temporalCohort(blocks, at, window) {
  const from = lowerBound(blocks, at - window);
  const to = lowerBound(blocks, at + window + 1);
  let count = to - from;
  // Exclude the reference transaction itself if it is one of the observations.
  for (let i = from; i < to; i++) {
    if (blocks[i] === at) {
      count -= 1;
      break;
    }
  }
  return count;
}

const quantile = (sorted, q) =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];

/**
 * The delay frontier: what each waiting period actually buys.
 *
 * Scored the same way as the cost frontier — on the bad case, not the average.
 * `aloneShare` is the number that matters: the share of pool transactions that
 * had *no* company at all in that window. A median of 4 is worthless if a
 * quarter of the time you are alone, because you do not get to choose which
 * case you are in.
 *
 * `sampleFrom` deliberately restricts the observations to recent history. This
 * pool had a burst around block 11.0M that carried 80% of its lifetime traffic
 * in 2.5% of its life; including it would describe cover that is not there for
 * a transaction sent today.
 */
export function delayFrontier(
  blocks,
  {
    windows = [NOTE_MATURITY_BLOCKS, 50, 200, 1000, 5000, 20000, 60000],
    sampleFrom = 0,
    secondsPerBlock = null,
  } = {},
) {
  const sample = blocks.filter((b) => b >= sampleFrom);

  return windows.map((window) => {
    const counts = sample.map((b) => temporalCohort(blocks, b, window)).sort((a, b) => a - b);
    const alone = counts.filter((c) => c === 0).length;
    return {
      window,
      hours: secondsPerBlock === null ? null : (window * secondsPerBlock) / 3600,
      medianCohort: quantile(counts, 0.5),
      p25Cohort: quantile(counts, 0.25),
      worstQuartileCohort: quantile(counts, 0.1),
      aloneShare: sample.length === 0 ? 1 : alone / sample.length,
      observations: sample.length,
    };
  });
}

/**
 * Choose a delay between the shield and the venue action.
 *
 * Two conditions, and both have to hold, because a median is not a guarantee:
 *
 *   1. `targetCohort` — enough other pool transactions in the window to be
 *      confused with, at the median.
 *   2. `maxAloneShare` — and rarely enough alone that the schedule is not a
 *      coin flip.
 *
 * The shortest window clearing both wins: unlike fees, the cost here is time,
 * so there is no reason to buy more than needed. If nothing clears them the
 * verdict is `pool-too-quiet` — the honest answer for a pool where traffic is
 * this sparse, and one no amount of scheduling can fix.
 */
export function recommendDelay(rows, { targetCohort = 3, maxAloneShare = 0.1 } = {}) {
  if (rows.length === 0) return null;

  const viable = rows.filter(
    (r) => r.medianCohort >= targetCohort && r.aloneShare <= maxAloneShare,
  );
  if (viable.length > 0) {
    const best = viable.reduce((a, b) => (a.window <= b.window ? a : b));
    return { ...best, verdict: "delay-earns-it" };
  }

  // Nothing reaches the target. Report the best available and say so.
  const best = rows.reduce((a, b) => {
    if (a.aloneShare !== b.aloneShare) return a.aloneShare < b.aloneShare ? a : b;
    return a.window <= b.window ? a : b;
  });
  return { ...best, verdict: "pool-too-quiet" };
}

/**
 * Seconds per block, measured rather than assumed.
 *
 * Starknet's block time has changed repeatedly and is not 30 seconds any more;
 * at the time of writing it measures about 1.7s, which changes every "how long
 * must I wait" answer by more than an order of magnitude.
 */
export async function measureBlockTime(provider, { sampleBlocks = 10000 } = {}) {
  const latest = await provider.getBlockNumber();
  const from = Math.max(1, latest - sampleBlocks);
  const [a, b] = await Promise.all([provider.getBlock(from), provider.getBlock(latest)]);
  const span = latest - from;
  if (span <= 0) return null;
  return (b.timestamp - a.timestamp) / span;
}

/** Human-readable delay, given a measured block time. */
export function formatDelay(blocks, secondsPerBlock) {
  if (secondsPerBlock === null || secondsPerBlock === undefined) return `${blocks} blocks`;
  const seconds = blocks * secondsPerBlock;
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  if (seconds < 172800) return `${(seconds / 3600).toFixed(1)} h`;
  return `${(seconds / 86400).toFixed(1)} days`;
}
