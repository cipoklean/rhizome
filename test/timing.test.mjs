import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NOTE_MATURITY_BLOCKS,
  delayFrontier,
  formatDelay,
  formatWaitLabel,
  poolTransactionBlocks,
  recommendDelay,
  temporalCohort,
} from "../src/lib/timing.mjs";

test("pool transactions are counted once per block, sorted", () => {
  const feeLegs = [
    { blockNumber: 300 },
    { blockNumber: 100 },
    { blockNumber: 300 },
    { blockNumber: 200 },
  ];
  assert.deepEqual(poolTransactionBlocks(feeLegs), [100, 200, 300]);
});

test("a temporal cohort counts company, not yourself", () => {
  const blocks = [100, 105, 110, 500];
  assert.equal(temporalCohort(blocks, 100, 10), 2, "105 and 110 are within 10 blocks");
  assert.equal(temporalCohort(blocks, 100, 4), 0, "nothing else that close");
  assert.equal(temporalCohort(blocks, 500, 10), 0, "alone");
  // A block that is not itself an observation still gets a straight count.
  assert.equal(temporalCohort(blocks, 107, 5), 2);
});

test("temporal cohorts agree with a brute-force scan", () => {
  // The binary-search version exists for speed; it has to give the same answer.
  const blocks = [];
  let b = 1000;
  for (let i = 0; i < 400; i++) {
    b += 1 + ((i * 37) % 90);
    blocks.push(b);
  }
  const brute = (at, w) => blocks.filter((o) => o !== at && Math.abs(o - at) <= w).length;
  for (const w of [1, 10, 100, 1000]) {
    for (const at of [blocks[0], blocks[137], blocks.at(-1), 1234, 99999]) {
      assert.equal(temporalCohort(blocks, at, w), brute(at, w), `at ${at} window ${w}`);
    }
  }
});

/** A pool that is busy early and quiet later — the mainnet shape. */
function burstyBlocks() {
  const blocks = [];
  for (let i = 0; i < 300; i++) blocks.push(10000 + i * 5); // dense burst
  for (let i = 0; i < 20; i++) blocks.push(200000 + i * 9000); // sparse tail
  return blocks.sort((a, b) => a - b);
}

test("the delay frontier reports company and the risk of having none", () => {
  const blocks = burstyBlocks();
  const rows = delayFrontier(blocks, { windows: [10, 100, 10000], secondsPerBlock: 2 });

  assert.equal(rows.length, 3);
  for (const r of rows) {
    assert.ok(r.aloneShare >= 0 && r.aloneShare <= 1);
    assert.ok(r.medianCohort >= 0);
    assert.equal(r.hours, (r.window * 2) / 3600);
  }
  // Wider windows can only find more company.
  assert.ok(rows[0].medianCohort <= rows[1].medianCohort);
  assert.ok(rows[1].medianCohort <= rows[2].medianCohort);
  assert.ok(rows[0].aloneShare >= rows[2].aloneShare);
});

test("restricting the sample to recent history refuses to borrow cover from a past burst", () => {
  const blocks = burstyBlocks();
  const all = delayFrontier(blocks, { windows: [100] })[0];
  const recent = delayFrontier(blocks, { windows: [100], sampleFrom: 200000 })[0];

  assert.ok(all.medianCohort > 0, "the burst has plenty of company");
  assert.equal(recent.medianCohort, 0, "the sparse tail has none");
  assert.equal(recent.aloneShare, 1);
  assert.ok(recent.observations < all.observations);
});

test("the shortest delay that clears both conditions wins", () => {
  const rows = [
    { window: 10, medianCohort: 0, aloneShare: 0.98 },
    { window: 1000, medianCohort: 4, aloneShare: 0.13 },
    { window: 5000, medianCohort: 11, aloneShare: 0.02 },
    { window: 20000, medianCohort: 33, aloneShare: 0 },
  ];
  const rec = recommendDelay(rows, { targetCohort: 3, maxAloneShare: 0.1 });
  assert.equal(rec.window, 5000, "1000 has the median but is alone too often");
  assert.equal(rec.verdict, "delay-earns-it");
});

test("a quiet pool is called quiet rather than dressed up", () => {
  const rows = [
    { window: 10, medianCohort: 0, aloneShare: 0.98 },
    { window: 1000, medianCohort: 0, aloneShare: 0.7 },
    { window: 20000, medianCohort: 1, aloneShare: 0.4 },
  ];
  const rec = recommendDelay(rows, { targetCohort: 3, maxAloneShare: 0.1 });
  assert.equal(rec.verdict, "pool-too-quiet");
  assert.equal(rec.window, 20000, "report the least-bad window available");
});

test("note maturity is the floor on any two-transaction schedule", () => {
  assert.equal(NOTE_MATURITY_BLOCKS, 10);
  const rows = delayFrontier(burstyBlocks(), { windows: [NOTE_MATURITY_BLOCKS] });
  assert.equal(rows[0].window, 10);
});

test("delays are formatted at a sane scale", () => {
  assert.equal(formatDelay(10, 1.73), "17s");
  assert.equal(formatDelay(1000, 1.73), "29 min");
  assert.equal(formatDelay(20000, 1.73), "9.6 h");
  assert.equal(formatDelay(200000, 1.73), "4.0 days");
  assert.equal(formatDelay(1000, null), "1000 blocks");
});

test("wait labels carry a time estimate only when block time is known", () => {
  assert.equal(formatWaitLabel(10, 1.73), "10 blocks (~17s)");
  assert.equal(formatWaitLabel(1000, 1.73), "1,000 blocks (~29 min)");
  // No measured block time: never echo the block count back as an estimate.
  assert.equal(formatWaitLabel(10, null), "10 blocks");
  assert.equal(formatWaitLabel(1000, null), "1,000 blocks");
});

// ── post-hide render crash regression: BigInt block counts ────────────────
test("formatDelay: survives BigInt block counts (Cannot mix BigInt fix)", () => {
  // The exact value that crashed the legs table after a successful hide:
  // maturityBlock - currentBlock arrives as a BigInt (both are BigInts).
  const bigLeft = 7n;
  assert.equal(formatDelay(bigLeft, 2.4), "17s");
  assert.equal(formatDelay(0n, 2.4), "0s");
  assert.equal(formatDelay(10n ** 9n, 2.4), "27777.8 days");
  // Numbers still work unchanged.
  assert.equal(formatDelay(7, 2.4), "17s");
});
