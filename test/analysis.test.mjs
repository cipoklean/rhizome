import assert from "node:assert/strict";
import { test } from "node:test";
import { amountHistogram } from "../src/lib/cohorts.mjs";
import { buildSchedule, computeFrontier, recommend } from "../src/lib/frontier.mjs";
import { formatUnits, parseUnits } from "../src/lib/units.mjs";

const STRK = (n) => parseUnits(String(n), 18);

test("parseUnits is exact where floats are not", () => {
  assert.equal(parseUnits("50000"), 50000n * 10n ** 18n);
  assert.equal(parseUnits("0.1"), 10n ** 17n);
  assert.equal(parseUnits("1.5", 6), 1_500_000n);
  assert.equal(parseUnits("0"), 0n);
});

test("the float path really is wrong (regression guard)", () => {
  // This is the bug that made cohort matching silently fail: an amount a few
  // thousand wei off matches no cohort at all.
  const viaFloat = BigInt(Math.round(50000 * 1e18));
  assert.notEqual(viaFloat, parseUnits("50000"));
});

test("parseUnits rejects excess precision rather than truncating", () => {
  assert.throws(() => parseUnits("1.1234567", 6));
  assert.throws(() => parseUnits("abc"));
});

test("formatUnits round-trips", () => {
  for (const v of ["0", "1", "1.5", "50000", "1234.6789"]) {
    assert.equal(formatUnits(parseUnits(v)).replace(/,/g, ""), v === "0" ? "0" : v);
  }
});

/** A pool with cover at 5,000 / 1,000 / 10 and a lone 7,777. */
function fixtureHistogram() {
  const deposits = [];
  const push = (amount, times) => {
    for (let i = 0; i < times; i++) deposits.push({ amount, user: `0x${i}`, token: "0x1" });
  };
  push(STRK(5000), 30);
  push(STRK(1000), 12);
  push(STRK(10), 100);
  push(STRK(7777), 1);
  return amountHistogram(deposits);
}

test("a schedule sums to the position exactly", () => {
  const hist = fixtureHistogram();
  for (const size of ["10", "1000", "5000", "20000", "7777"]) {
    const position = parseUnits(size);
    const legs = buildSchedule(position, 24, hist);
    assert.ok(legs, `no schedule for ${size}`);
    const total = legs.reduce((sum, l) => sum + l.amount, 0n);
    assert.equal(total, position, `schedule for ${size} must sum exactly`);
    assert.ok(
      legs.every((l) => l.amount > 0n),
      "no zero-value legs",
    );
  }
});

test("prefers well-covered denominations over the fewest legs", () => {
  const hist = fixtureHistogram();
  // 20,000 could be 4 x 5,000 (cohort 30). It must not be left as one bare leg.
  const legs = buildSchedule(parseUnits("20000"), 24, hist);
  assert.equal(legs.length, 4);
  assert.ok(legs.every((l) => l.cohort === 30));
});

test("an amount that already has cover is not split", () => {
  const hist = fixtureHistogram();
  const rows = computeFrontier({ position: STRK(5000), feeAmount: STRK(6), hist });
  const rec = recommend(rows);
  assert.equal(rec.tranches, 1);
  assert.equal(rec.isSplitWorthwhile, false);
  assert.equal(rec.verdict, "already-covered");
});

test("recommendation respects the fee budget", () => {
  const hist = fixtureHistogram();
  const position = STRK(100);
  const rows = computeFrontier({ position, feeAmount: STRK(6), hist });
  const rec = recommend(rows, { maxFeeRatio: 0.1 });
  // 6 STRK on 100 is 6%; a second leg would be 12% and must be rejected.
  assert.ok(rec.feeCostRatio <= 0.1 || rec.verdict === "position-too-small");
});

test("a distinctive position gets split into covered legs", () => {
  const hist = fixtureHistogram();
  // 15,000 = 3 x 5,000, all with cohort 30.
  const rows = computeFrontier({ position: STRK(15000), feeAmount: STRK(6), hist });
  const rec = recommend(rows);
  assert.ok(rec.tranches > 1, "should split");
  assert.ok(rec.minCohort >= 12, "legs should have real cover");
  assert.ok(rec.schedule.every((l) => l.covered));
});

test("fees never exceed the position", () => {
  const hist = fixtureHistogram();
  const rows = computeFrontier({ position: STRK(10), feeAmount: STRK(6), hist });
  assert.ok(rows.every((r) => r.feeCost < STRK(10)));
});
