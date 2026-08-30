// Durable, receipt-driven state for the two-stage execution runner.
//
// A shield-to-vault delay can last hours. React state is not a safe place to
// remember which transaction paid a pool fee, and the current block is not a
// substitute for the block a timed-out transaction eventually landed in.
//
// const DURABLE_STAGES = new Set([
//   "shield-pending",
//   "shielded",
//   "invest-pending",
//   "invested",
//   "failed",
// ]);