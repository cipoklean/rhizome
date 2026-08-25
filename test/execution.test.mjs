import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptedReceiptBlock,
  buildFeeReservePlan,
  buildRehearsalFallback,
  executionProgressKey,
  readExecutionProgress,
  sanitizeExecutionProgress,
  writeExecutionProgress,
} from "../src/lib/execution.mjs";

test("a shield delay starts from the receipt block, never the current block", () => {
  assert.equal(
    acceptedReceiptBlock({ execution_status: "SUCCEEDED", block_number: 12345 }),
    12345,
  );
  assert.equal(
    acceptedReceiptBlock({ value: { execution_status: "SUCCEEDED", block_number: 54321 } }),
    54321,
  );
  assert.equal(acceptedReceiptBlock({ finality_status: "RECEIVED" }), null);
  assert.equal(acceptedReceiptBlock(null), null);
});

test("a reverted receipt can never advance a leg", () => {
  assert.throws(
    () =>
      acceptedReceiptBlock({
        execution_status: "REVERTED",
        block_number: 100,
        revert_reason: "bad proof",
      }),
    /bad proof/,
  );
});

test("a 'failed' label never buries a submitted transaction", () => {
  // Error struck after the wallet accepted the submission: the hash must
  // survive so the leg stays checkable instead of reading as a dead end.
  assert.deepEqual(sanitizeExecutionProgress({ 0: { stage: "failed", shieldTx: "0xabc" } }, 1), {
    0: { shieldTx: "0xabc", investDryRun: false },
  });
  // A landing block outranks a false failure verdict.
  assert.deepEqual(
    sanitizeExecutionProgress({ 0: { stage: "failed", shieldTx: "0xabc", shieldedAt: 42 } }, 1),
    {
      0: { stage: "shielded", shieldTx: "0xabc", shieldedAt: 42, investDryRun: false },
    },
  );
  // A failure before anything was submitted stays a visible, retryable error.
  assert.deepEqual(sanitizeExecutionProgress({ 0: { stage: "failed" } }, 1), {
    0: { stage: "failed", investDryRun: false },
  });
});

test("execution progress keys separate accounts, networks, venues and schedules", () => {
  const base = {
    chainId: "0x1",
    account: "0x02",
    anonymizer: "0x3",
    schedule: [{ amount: 100n }, { amount: 200n }],
  };
  const key = executionProgressKey(base);
  assert.match(key, /^rhizome:execution:v1:/);
  assert.notEqual(key, executionProgressKey({ ...base, chainId: "0x2" }));
  assert.notEqual(key, executionProgressKey({ ...base, account: "0x3" }));
  assert.notEqual(key, executionProgressKey({ ...base, anonymizer: "0x4" }));
  assert.notEqual(key, executionProgressKey({ ...base, schedule: [{ amount: 300n }] }));
  assert.equal(executionProgressKey({ ...base, account: null }), null);
});

test("only non-secret durable progress survives serialization", () => {
  const clean = sanitizeExecutionProgress(
    {
      0: {
        stage: "shielded",
        shieldTx: "0xabc",
        shieldedAt: 123,
        investDryRun: true,
        proof: "SECRET_PROOF",
        viewingKey: "SECRET_KEY",
      },
      1: { stage: "shield-pending", shieldTx: "0xdef" },
      2: { stage: "shielding" },
      99: { stage: "invested", investTx: "0x999" },
    },
    3,
  );

  assert.deepEqual(clean, {
    0: {
      stage: "shielded",
      shieldTx: "0xabc",
      shieldedAt: 123,
      investDryRun: false,
    },
    1: { stage: "shield-pending", shieldTx: "0xdef", investDryRun: false },
  });
  assert.equal(JSON.stringify(clean).includes("SECRET"), false);
});

test("a stale pending label with a landing block becomes shielded", () => {
  assert.deepEqual(
    sanitizeExecutionProgress(
      { 0: { stage: "shield-pending", shieldTx: "0xabc", shieldedAt: 100 } },
      1,
    ),
    {
      0: {
        stage: "shielded",
        shieldTx: "0xabc",
        shieldedAt: 100,
        investDryRun: false,
      },
    },
  );
});

test("invalid storage never breaks execution", () => {
  const broken = {
    getItem() {
      return "not json";
    },
    setItem() {
      throw new Error("storage disabled");
    },
  };
  assert.deepEqual(readExecutionProgress(broken, "k", 1), {});
  assert.doesNotThrow(() => writeExecutionProgress(broken, "k", { 0: {} }, 1));
});

test("progress round-trips through storage and resets dry-run gates", () => {
  const map = new Map();
  const storage = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, v),
  };
  const progress = {
    0: { stage: "shielded", shieldTx: "0xabc", shieldedAt: 123, investDryRun: true },
  };
  writeExecutionProgress(storage, "k", progress, 1);
  assert.deepEqual(readExecutionProgress(storage, "k", 1), {
    0: { stage: "shielded", shieldTx: "0xabc", shieldedAt: 123, investDryRun: false },
  });
});


test("a Sepolia rehearsal fallback exists above the two-operation fee floor", () => {
  const score = { entryCohort: 95, exitCohort: 27, exitKnown: true };
  assert.deepEqual(buildRehearsalFallback({ amount: 10n, feeAmount: 2n, score }), [
    {
      ...score,
      amount: 10n,
      covered: false,
      rehearsal: true,
    },
  ]);
});

test("a rehearsal fallback refuses amounts consumed by two pool fees", () => {
  assert.deepEqual(buildRehearsalFallback({ amount: 4n, feeAmount: 2n }), []);
  assert.deepEqual(buildRehearsalFallback({ amount: 3n, feeAmount: 2n }), []);
});


test("one fresh leg reserves both execution fees and bootstraps net of its own fee", () => {
  const plan = buildFeeReservePlan({ schedule: [{ amount: 10n }], feeAmount: 2n });
  assert.deepEqual(
    {
      legCount: plan.legCount,
      executionTransactions: plan.executionTransactions,
      requiredReserve: plan.requiredReserve,
      reserveShortfall: plan.reserveShortfall,
      bootstrapFee: plan.bootstrapFee,
      bootstrapDeposit: plan.bootstrapDeposit,
      totalFeesWithBootstrap: plan.totalFeesWithBootstrap,
      vaultAmounts: plan.vaultAmounts,
      withoutReserveVaultAmounts: plan.withoutReserveVaultAmounts,
      reserveVerified: plan.reserveVerified,
      paidSubmissionAllowed: plan.paidSubmissionAllowed,
    },
    {
      legCount: 1,
      executionTransactions: 2,
      requiredReserve: 4n,
      reserveShortfall: 4n,
      bootstrapFee: 2n,
      bootstrapDeposit: 6n,
      totalFeesWithBootstrap: 6n,
      vaultAmounts: [10n],
      withoutReserveVaultAmounts: [6n],
      reserveVerified: false,
      paidSubmissionAllowed: false,
    },
  );
});

test("multiple legs preserve every cohort amount with a shared reserve", () => {
  const schedule = [{ amount: 4000n }, { amount: 4000n }, { amount: 2000n }];
  const plan = buildFeeReservePlan({ schedule, feeAmount: 6n, shieldedStrkBalance: 36n });
  assert.equal(plan.transactionsPerLeg, 2);
  assert.equal(plan.executionTransactions, 6);
  assert.equal(plan.requiredReserve, 36n);
  assert.equal(plan.bootstrapDeposit, 0n);
  assert.deepEqual(plan.vaultAmounts, [4000n, 4000n, 2000n]);
  assert.equal(plan.preservesCohorts, true);
  assert.equal(plan.reserveVerified, true);
  assert.equal(plan.paidSubmissionAllowed, true);
});

test("a partial reserve top-up deposits the shortfall plus one bootstrap fee", () => {
  const plan = buildFeeReservePlan({
    schedule: [{ amount: 100n }, { amount: 100n }],
    feeAmount: 6n,
    shieldedStrkBalance: 10n,
  });
  assert.equal(plan.requiredReserve, 24n);
  assert.equal(plan.reserveShortfall, 14n);
  assert.equal(plan.bootstrapFee, 6n);
  assert.equal(plan.bootstrapDeposit, 20n);
  assert.equal(plan.freshBootstrapFee, 6n);
  assert.equal(plan.freshBootstrapDeposit, 30n);
  assert.equal(plan.totalFeesWithBootstrap, 30n);
  assert.equal(plan.reserveVerified, false);
});

test("zero-fee execution needs no reserve even when balance sharing is unavailable", () => {
  const plan = buildFeeReservePlan({ schedule: [{ amount: 1n }], feeAmount: 0n });
  assert.equal(plan.requiredReserve, 0n);
  assert.equal(plan.bootstrapDeposit, 0n);
  assert.equal(plan.reserveVerified, true);
  assert.equal(plan.paidSubmissionAllowed, true);
});

test("fee planning fails closed on invalid inputs and unknown or insufficient balances", () => {
  assert.throws(() => buildFeeReservePlan({ schedule: [], feeAmount: 1n }), /at least one/);
  assert.throws(
    () => buildFeeReservePlan({ schedule: [{ amount: 1n }], feeAmount: -1n }),
    /cannot be negative/,
  );
  assert.throws(
    () => buildFeeReservePlan({ schedule: [{ amount: 0n }], feeAmount: 1n }),
    /positive integer amount/,
  );
  assert.throws(
    () =>
      buildFeeReservePlan({
        schedule: [{ amount: 1n }],
        feeAmount: 1n,
        shieldedStrkBalance: "not-an-integer",
      }),
    /balance must be an integer/,
  );

  const unknown = buildFeeReservePlan({ schedule: [{ amount: 100n }], feeAmount: 6n });
  assert.equal(unknown.balanceKnown, false);
  assert.equal(unknown.paidSubmissionAllowed, false);

  const insufficient = buildFeeReservePlan({
    schedule: [{ amount: 100n }],
    feeAmount: 6n,
    shieldedStrkBalance: 11n,
  });
  assert.equal(insufficient.reserveShortfall, 1n);
  assert.equal(insufficient.paidSubmissionAllowed, false);
});
