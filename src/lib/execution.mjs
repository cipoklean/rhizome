// Durable, receipt-driven state for the two-stage execution runner.
//
// A shield-to-vault delay can last hours. React state is not a safe place to
// remember which transaction paid a pool fee, and the current block is not a
// substitute for the block a timed-out transaction eventually landed in.

const DURABLE_STAGES = new Set([
  "shield-pending",
  "shielded",
  "invest-pending",
  "invested",
  "failed",
]);

const txHash = (v) => (typeof v === "string" && /^0x[0-9a-f]+$/i.test(v) ? v : null);
const blockNumber = (v) => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};
const felt = (v) => {
  try {
    return "0x" + BigInt(v).toString(16);
  } catch {
    return String(v ?? "unknown").toLowerCase();
  }
};

/**
 * Accepted receipt block, or null while the transaction is not in a block.
 * Throws on a reverted transaction so the caller never advances the runner.
 *
 * starknet.js receipts are exposed both directly and through a `.value`
 * wrapper depending on the provider path, so support both shapes explicitly.
 */
export function acceptedReceiptBlock(receipt) {
  const r = receipt?.value ?? receipt;
  if (!r) return null;

  const execution = String(r.execution_status ?? r.executionStatus ?? "").toUpperCase();
  if (execution.includes("REVERT")) {
    const reason = r.revert_reason ?? r.revertReason ?? "transaction reverted";
    throw new Error(reason);
  }

  return blockNumber(r.block_number ?? r.blockNumber);
}

/**
 * Storage key scoped to exactly one account, network, venue and schedule.
 * Changing the analyzed position cannot accidentally inherit another
 * schedule's paid legs.
 */
export function executionProgressKey({ chainId, account, anonymizer, schedule }) {
  if (!chainId || !account || !Array.isArray(schedule) || schedule.length === 0) return null;
  const amounts = schedule.map((l) => BigInt(l.amount).toString()).join(".");
  return `rhizome:execution:v1:${felt(chainId)}:${felt(account)}:${felt(anonymizer)}:${amounts}`;
}

/**
 * Keep only durable, non-secret progress.
 *
 * No notes, proofs, balances, viewing material or action payloads are stored.
 * `investDryRun` is deliberately reset: a dry run is a gate for the current
 * session, not a durable authorization, and its proof may expire while the page
 * is closed.
 */
export function sanitizeExecutionProgress(value, scheduleLength) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};

  for (const [key, leg] of Object.entries(value)) {
    const i = Number(key);
    if (!Number.isInteger(i) || i < 0 || i >= scheduleLength || !leg || typeof leg !== "object") {
      continue;
    }

    const shieldTx = txHash(leg.shieldTx);
    const investTx = txHash(leg.investTx);
    const shieldedAt = blockNumber(leg.shieldedAt);
    let stage = DURABLE_STAGES.has(leg.stage) ? leg.stage : undefined;

    // A landing block is stronger evidence than any stale stage label.
    if (shieldedAt !== null && (stage === "shield-pending" || stage === "failed")) {
      stage = "shielded";
    }
    // Conversely, a pending shield without a hash cannot be checked and must not
    // disable a safe resubmission forever.
    if (stage === "shield-pending" && !shieldTx) stage = undefined;
    // A "failed" verdict next to a submitted hash is not trustworthy — the
    // error may have struck after the wallet accepted the transaction. Demote
    // to a plain checkable leg and let the receipt decide.
    if (stage === "failed" && shieldTx) stage = undefined;

    const clean = { investDryRun: false };
    if (stage) clean.stage = stage;
    if (shieldTx) clean.shieldTx = shieldTx;
    if (shieldedAt !== null) clean.shieldedAt = shieldedAt;
    if (investTx) clean.investTx = investTx;

    if (Object.keys(clean).length > 1 || clean.investDryRun) out[i] = clean;
  }
  return out;
}

export function readExecutionProgress(storage, key, scheduleLength) {
  if (!storage || !key) return {};
  try {
    const raw = storage.getItem(key);
    return raw ? sanitizeExecutionProgress(JSON.parse(raw), scheduleLength) : {};
  } catch {
    return {};
  }
}

export function writeExecutionProgress(storage, key, progress, scheduleLength) {
  if (!storage || !key) return;
  const clean = sanitizeExecutionProgress(progress, scheduleLength);
  try {
    storage.setItem(key, JSON.stringify(clean));
  } catch {
    // Storage can be disabled or full. Execution remains usable in-memory; the
    // UI should not turn a browser policy into a transaction failure.
  }
}


/**
 * One synthetic Sepolia leg for proving action shapes when analytics cannot
 * produce a schedule. It is intentionally not a privacy recommendation.
 *
 * Keep it above two pool fees because the real entry path is shield + invoke;
 * accepting a smaller amount would present a rehearsal that cannot possibly
 * become a paid two-stage leg.
 */
export function buildRehearsalFallback({ amount, feeAmount, score = {} }) {
  const value = BigInt(amount);
  const fee = BigInt(feeAmount);
  if (value <= fee * 2n) return [];
  return [{ ...score, amount: value, covered: false, rehearsal: true }];
}


/**
 * Derive the STRK reserve required to keep every analyzed public amount intact.
 *
 * Upstream `privacy.cairo` runs `collect_fee()` before `_apply_actions()`: the
 * fee router fronts each fee and is reimbursed by a fee-sized pool withdrawal.
 * Client action phases put Deposit before Withdrawal, so a dedicated bootstrap
 * deposit can reimburse its own fee. Depositing `shortfall + fee` therefore
 * leaves exactly `shortfall` additional shielded STRK.
 *
 * Without a separate reserve, one fresh isolated entry leg can move only
 * `amount - 2 * fee` into the vault. That changes the public withdrawal amount
 * the cohort analysis scored, so Rhizome must fail closed rather than silently
 * haircut it.
 */
export function buildFeeReservePlan({ schedule, feeAmount, shieldedStrkBalance } = {}) {
  if (!Array.isArray(schedule) || schedule.length === 0) {
    throw new Error("fee planning requires at least one schedule leg");
  }

  let fee;
  try {
    fee = BigInt(feeAmount);
  } catch {
    throw new Error("fee amount must be an integer");
  }
  if (fee < 0n) throw new Error("fee amount cannot be negative");

  const legAmounts = schedule.map((leg, index) => {
    try {
      const amount = BigInt(leg?.amount);
      if (amount <= 0n) throw new Error();
      return amount;
    } catch {
      throw new Error(`schedule leg ${index + 1} must have a positive integer amount`);
    }
  });

  const transactionsPerLeg = 2;
  const legCount = legAmounts.length;
  const executionTransactions = legCount * transactionsPerLeg;
  const requiredReserve = fee * BigInt(executionTransactions);
  const balanceKnown = shieldedStrkBalance !== undefined && shieldedStrkBalance !== null;
  let existingReserve = 0n;
  if (balanceKnown) {
    try {
      existingReserve = BigInt(shieldedStrkBalance);
    } catch {
      throw new Error("shielded STRK balance must be an integer");
    }
    if (existingReserve < 0n) throw new Error("shielded STRK balance cannot be negative");
  }

  const reserveShortfall =
    existingReserve >= requiredReserve ? 0n : requiredReserve - existingReserve;
  const bootstrapFee = reserveShortfall > 0n ? fee : 0n;
  const bootstrapDeposit = reserveShortfall > 0n ? reserveShortfall + bootstrapFee : 0n;
  const freshBootstrapFee = requiredReserve > 0n ? fee : 0n;
  const freshBootstrapDeposit = requiredReserve + freshBootstrapFee;
  const reserveVerified = requiredReserve === 0n || (balanceKnown && reserveShortfall === 0n);

  return {
    legCount,
    feePerTransaction: fee,
    transactionsPerLeg,
    executionTransactions,
    executionFees: requiredReserve,
    requiredReserve,
    balanceKnown,
    existingReserve,
    reserveShortfall,
    bootstrapFee,
    bootstrapDeposit,
    freshBootstrapFee,
    freshBootstrapDeposit,
    totalFeesWithBootstrap: requiredReserve + bootstrapFee,
    legAmounts,
    vaultAmounts: [...legAmounts],
    withoutReserveVaultAmounts: legAmounts.map((amount) => {
      const net = amount - fee * BigInt(transactionsPerLeg);
      return net > 0n ? net : 0n;
    }),
    preservesCohorts: true,
    reserveVerified,
    paidSubmissionAllowed: reserveVerified,
  };
}
