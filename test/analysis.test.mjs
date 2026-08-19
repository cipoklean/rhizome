import assert from "node:assert/strict";
import { test } from "node:test";
import { amountHistogram, coveredBothSides, roundTripCohort } from "../src/lib/cohorts.mjs";
import { FEE_MODELS, buildSchedule, computeFrontier, recommend } from "../src/lib/frontier.mjs";
import { classifyWithdrawals } from "../src/lib/pool.mjs";
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
  const legs = [];
  const push = (amount, times) => {
    for (let i = 0; i < times; i++) legs.push({ amount, user: `0x${i}`, token: "0x1" });
  };
  push(STRK(5000), 30);
  push(STRK(1000), 12);
  push(STRK(10), 100);
  push(STRK(7777), 1);
  return amountHistogram(legs);
}

/**
 * The mainnet asymmetry, in miniature: the most-deposited denomination here has
 * never once been withdrawn. On mainnet that shape is real — 4.1 STRK has 149
 * deposits and zero exits, and 4 STRK has 787 deposits against 20 exits.
 */
function twoSidedFixture() {
  const build = (spec) => {
    const legs = [];
    for (const [amount, times] of spec) {
      for (let i = 0; i < times; i++) legs.push({ amount });
    }
    return amountHistogram(legs);
  };
  return {
    entry: build([
      [STRK(1000), 787],
      [STRK(3000), 395],
      [STRK(2000), 229],
    ]),
    exit: build([
      [STRK(3000), 31],
      [STRK(2000), 11],
    ]),
  };
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
  // At 2 pool transactions per leg, one leg is already 12% of 100 STRK.
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
  // 10 STRK cannot carry even one leg at 2 x 6 STRK, so there is nothing to offer.
  assert.equal(rows.length, 0);
});

// --- the round trip -------------------------------------------------------

test("a cohort is scored on its weaker side", () => {
  const { entry, exit } = twoSidedFixture();

  const popular = roundTripCohort(entry, exit, STRK(1000));
  assert.equal(popular.entryCohort, 787);
  assert.equal(popular.exitCohort, 0);
  assert.equal(popular.cohort, 0, "the weaker side decides");
  assert.equal(popular.distinctiveness, 1, "an amount never withdrawn is a fingerprint on exit");

  const three = roundTripCohort(entry, exit, STRK(3000));
  assert.equal(three.cohort, 31);
  assert.equal(three.distinctiveness, 1 / 32);
});

test("exit cover is reported as unknown, not as safe, when there is no exit data", () => {
  const { entry } = twoSidedFixture();
  const scored = roundTripCohort(entry, null, STRK(1000));
  assert.equal(scored.exitKnown, false);
  assert.equal(scored.exitCohort, null);
  assert.equal(scored.cohort, 787);
});

test("the most popular deposit amount is rejected when nobody ever withdraws it", () => {
  const hist = twoSidedFixture();
  // 12,000 tiles as 12 x 1,000 (the best-covered deposit amount, never withdrawn)
  // or 4 x 3,000 (cover on both legs). Entry-only ranking picks the 1,000s.
  const legs = buildSchedule(STRK(12000), 24, hist);
  assert.ok(legs, "expected a schedule");
  assert.ok(
    legs.every((l) => l.amount !== STRK(1000)),
    "must not build legs from an amount with zero exit cover",
  );
  assert.equal(legs.length, 4);
  assert.ok(legs.every((l) => l.amount === STRK(3000) && l.exitCohort === 31));
  assert.equal(legs.reduce((s, l) => s + l.amount, 0n), STRK(12000));
});

test("covered-both-sides ranks on the weaker leg and drops one-sided cover", () => {
  const { entry, exit } = twoSidedFixture();
  const covered = coveredBothSides(entry, exit, 10, { minCohort: 3 });
  assert.deepEqual(
    covered.map((c) => c.amount),
    [STRK(3000), STRK(2000)],
  );
  assert.ok(!covered.some((c) => c.amount === STRK(1000)));
});

test("the frontier reports both entry and exit cover", () => {
  const hist = twoSidedFixture();
  const rows = computeFrontier({ position: STRK(9000), feeAmount: STRK(6), hist });
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.equal(r.exitKnown, true);
    assert.ok(r.minEntryCohort >= r.minCohort);
    assert.ok(r.minExitCohort >= r.minCohort);
  }
});

// --- the fee model -------------------------------------------------------

test("fees are priced per pool transaction, not per tranche", () => {
  const hist = fixtureHistogram();
  const position = STRK(20000);
  const fee = STRK(6);

  const of = (feeModel) => {
    const row = computeFrontier({ position, feeAmount: fee, hist, feeModel }).find(
      (r) => r.tranches === 4,
    );
    assert.ok(row, `no 4-leg row for ${feeModel}`);
    return row;
  };

  assert.equal(of("bundled").feeCost, fee * 4n);
  assert.equal(of("enter").feeCost, fee * 8n);
  assert.equal(of("roundTrip").feeCost, fee * 16n);

  assert.equal(of("bundled").poolTransactions, 4);
  assert.equal(of("enter").poolTransactions, 8);
  // Whatever model is priced, the full round-trip cost is always reported.
  assert.equal(of("bundled").roundTripFeeCost, fee * 16n);
  assert.equal(of("enter").roundTripFeeCost, fee * 16n);
});

test("every fee model is a whole number of pool transactions", () => {
  for (const [name, m] of Object.entries(FEE_MODELS)) {
    assert.ok(Number.isInteger(m.txPerLeg) && m.txPerLeg >= 1, `${name} txPerLeg`);
    assert.ok(m.label && m.note, `${name} needs a label and a note`);
  }
  assert.equal(FEE_MODELS.roundTrip.txPerLeg, 2 * FEE_MODELS.enter.txPerLeg);
});

test("an unknown fee model is refused rather than silently mispriced", () => {
  assert.throws(() =>
    computeFrontier({ position: STRK(5000), feeAmount: STRK(6), hist: fixtureHistogram(), feeModel: "free" }),
  );
});

// --- fee-reimbursement legs ---------------------------------------------

test("fee-reimbursement withdrawals are separated from position withdrawals", () => {
  const ROUTER = "0x127021a1";
  const USER = "0xabc";
  const feeHistory = [
    { feeAmount: STRK(4), blockNumber: 9079357 },
    { feeAmount: STRK(6), blockNumber: 12806094 },
  ];

  const withdrawals = [
    ...Array.from({ length: 300 }, () => ({ amount: STRK(6), to: ROUTER })),
    ...Array.from({ length: 200 }, () => ({ amount: STRK(4), to: ROUTER })),
    // A real user withdrawing exactly the fee amount is not a fee leg.
    { amount: STRK(6), to: USER },
    { amount: STRK(3000), to: USER },
  ];

  const { positions, feeLegs, routers } = classifyWithdrawals(withdrawals, feeHistory);
  assert.equal(feeLegs.length, 500);
  assert.equal(positions.length, 2);
  assert.deepEqual(routers, [ROUTER]);
  assert.ok(positions.some((w) => w.amount === STRK(6) && w.to === USER));
});

test("a zero fee is never treated as a fee leg", () => {
  const withdrawals = [{ amount: 0n, to: "0xrouter" }, { amount: STRK(5), to: "0xrouter" }];
  const { positions, feeLegs } = classifyWithdrawals(withdrawals, [{ feeAmount: 0n, blockNumber: 1 }]);
  assert.equal(feeLegs.length, 0);
  assert.equal(positions.length, 2);
});

test("classification survives a pool that has never charged a fee", () => {
  const withdrawals = [{ amount: STRK(6), to: "0xa" }];
  const { positions, feeLegs, routers } = classifyWithdrawals(withdrawals, []);
  assert.equal(feeLegs.length, 0);
  assert.equal(positions.length, 1);
  assert.deepEqual(routers, []);
});
