// The cost/unlinkability frontier.
//
// Splitting a position into several tranches reduces how distinctive each public
// leg is. It also costs a flat pool fee per *pool transaction*, and the protocol
// allows at most one external invoke per transaction — so a schedule of N legs
// is at least N transactions, and usually more than N.
//
// Two things this module refuses to fudge:
//
//   1. The fee is charged per `apply_actions` call, not per tranche. Getting a
//      tranche into a venue takes two pool transactions if you want the deposit
//      unlinked from the venue action, and unwinding it takes two more. Pricing
//      a schedule at one fee per leg understates it by 2-4x.
//
//   2. A leg is scored on its weaker end. Cover on the way in is not cover on
//      the way out, and mainnet cover is wildly asymmetric.
//
// At the fee measured on mainnet (6 STRK per pool transaction) that cost is not
// marginal. For small positions the honest recommendation is one tranche.