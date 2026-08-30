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