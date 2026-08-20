import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptedReceiptBlock,
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
