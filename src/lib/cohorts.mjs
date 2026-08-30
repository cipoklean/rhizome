// Cohort analysis over public deposit and withdrawal amounts.
//
// The pool hides who paid whom inside it, but both public legs — the shield
// deposit on the way in and the withdrawal on the way out — expose exact amounts.
// An amount nobody else has ever used is a fingerprint: it survives the pool and
// reappears on the way out. An amount hundreds of people have used is cover.
//
// "Cohort" here means: how many other legs of this token carry this same amount.
// Bigger cohort, weaker fingerprint.
//
// Cover is not symmetric, and that is the whole reason this module reads both
// sides. Measured on mainnet: 4 STRK has 787 deposits behind it and 20
// withdrawals; 3,000 STRK has 395 and 31; and 4.1 STRK has 149 deposits and has
// never once been withdrawn. A schedule tuned on entry cover alone walks into an
// exit leg nobody else has ever made.