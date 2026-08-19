# Rhizome

**Private yield on Starknet that prices its own privacy.**

Built for the [STRK20 Private Sprint](https://strk20.starknet.io/hackathon), against the live
STRK20 privacy pool on Starknet mainnet.

## The problem

The STRK20 pool hides *who*. It does not hide *how much* or *when*.

Deposits and withdrawals are public ERC-20 legs — address, token, amount. Private DeFi routes
through shared anonymizer contracts into public venues, so a swap or a lending deposit exposes
its amount and its timing. The protocol documentation is explicit that this is unsolved:

> A distinctive amount executed shortly after a distinctive deposit is correlatable.

The obvious fix is to split one position into several smaller, less distinctive tranches spread
over time. The obvious fix is also expensive, and it is more expensive than it first looks.

## What the fee actually is

The pool charges a flat fee **per `apply_actions` call** — once per pool transaction, whatever
that transaction does — and always in **STRK**, whichever token you are shielding. Verified in
the protocol source and on mainnet receipts:

```cairo
/// Fee amount (in FRI) charged per `apply_actions` call.
fee_amount: u128,

fn collect_fee(ref self: ContractState) { ... }   // privacy.cairo
```

```
get_fee_amount   => 6000000000000000000   (6 STRK)
get_fee_collector => 0xd79041634625e5288296fbc648088788710ba44903a3a49468a66567749e77
```

Three consequences the earlier version of this README got wrong:

1. **It is per transaction, not per tranche.** The protocol permits at most one external invoke
   per pool transaction, and keeping a public deposit unlinked from the venue action it funds
   means shielding in an earlier, separate transaction. So one tranche is **two** pool
   transactions going in, and two more coming back out. A ten-leg schedule is 20 fees to enter
   and 40 across the round trip — not 10.
2. **It is settled by an extra public withdrawal.** A fee router fronts the fee to the collector
   and the pool reimburses it, in the same transaction, with a `Withdrawal` of exactly the fee
   amount. Every priced pool transaction therefore emits a public withdrawal leg that belongs to
   nobody's position. On mainnet those legs are **76.1%** of all public STRK withdrawals — so any
   exit-side analysis that does not filter them is three-quarters noise.
3. **The fee has changed, twice.** It ran at zero until block 9,079,357, then 4 STRK, then 6 STRK
   from block 12,806,094. Nothing in this repo hardcodes it; `npm run verify:facts` re-reads the
   whole history and fails if it drifted.

## What Rhizome does

Rhizome treats unlinkability as something with a price, and computes it — in STRK on one axis and
in patience on the other.

1. **Reads the live fee and its history** from the pool rather than assuming it.
2. **Reads both public legs** — the pool's own `Deposit` *and* `Withdrawal` events — to find
   amounts that blend in rather than stand out, after excluding fee reimbursement.
3. **Scores every amount on its weaker side.** An attacker who cannot place your deposit will
   place your withdrawal instead, and only needs one of them.
4. **Computes the frontier**: for a given position size, what tranche count buys meaningful
   unlinkability, and what it costs in fees — priced per pool transaction, with the full round
   trip shown alongside. Sometimes the honest answer is "one tranche".
5. **Prices the delay too**, from the pool's own traffic — because the extra fee you pay to
   separate a shield from the venue action it funds buys nothing if nothing else happens in
   between.
6. **Executes the chosen schedule** through its own anonymizer contract: shield the chosen amount,
   wait out the measured delay, then move it into the vault, each tranche landing in its own note.

Externally: several indistinguishable deposits with no shared fingerprint. Internally: one
position, one dashboard.

Existing privacy-preflight tools tell a user they leaked. Rhizome prices the fix and executes it.

## The cover that costs nothing, and mostly isn't there

Splitting a position is expensive. Waiting is free — so the free axis should be spent first. Except
you cannot spend what the pool does not have.

Every priced pool transaction emits exactly one fee-reimbursement withdrawal, which makes those
legs a census of pool transactions. Measured over the most recent 500,000 blocks, at the measured
block time of **1.73s** (not the 30s the ecosystem's older docs imply — that changes every
"how long must I wait" answer by an order of magnitude):

| delay | wait | other pool tx (median) | alone |
| ---: | ---: | ---: | ---: |
| 10 blocks | 17s | 0 | **98%** |
| 50 | 87s | 0 | 52% |
| 200 | 6 min | 2 | 25% |
| 1,000 | 29 min | 4 | 13% |
| 5,000 | 2.4 h | 11 | 2% |
| 20,000 | 9.6 h | 33 | 0% |

Freshly shielded notes need about **10 blocks** to mature, so ten blocks is the floor on any
two-transaction schedule. At that floor, **98% of pool transactions have no company at all**. An
observer looking for "the deposit that funded this vault action" has exactly one candidate and does
not need to look at amounts.

That is the sharpest thing in this repo, and it cuts against its own product: the second pool
transaction per leg — 6 STRK, the thing the fee model exists to charge for — is **wasted** unless
you also wait. Rhizome asks for 5,000 blocks, about two and a half hours, which is where the median
transaction picks up 11 others and is alone only 2% of the time. That costs nothing, and no fee
schedule substitutes for it.

The pool is also far quieter than its lifetime totals suggest: 14,565 pool transactions in its
history, but **245 in the last ten days**, because roughly 80% of all activity landed in a single
burst around block 11.0M. Rhizome scores timing on the recent window only. An old burst is not
cover for a transaction sent today.

## What the public data actually says

Measured against the live mainnet pool at block 13,541,710:

| | entry (`Deposit`) | exit (`Withdrawal`) |
| --- | ---: | ---: |
| legs | 8,256 | 4,806 |
| counterparties | 1,648 depositors | 789 destinations |
| distinct amounts | 2,144 | 2,833 |
| one-of-a-kind amounts | 1,617 (**75.4%**) | 2,303 (**81.3%**) |

The exit side is read from 20,082 public STRK withdrawals, 15,276 of which (76.1%) are fee
reimbursement to a single router and are excluded.

**Cover is not symmetric, and that is the finding.** The most-deposited amounts in the pool are
not the amounts people withdraw:

| amount | entry cohort | exit cohort | weaker side |
| ---: | ---: | ---: | ---: |
| 4 STRK | 787 | 20 | 20 |
| 3,000 | 395 | 31 | 31 |
| 2,000 | 229 | 11 | 11 |
| 4.1 | 149 | **0** | **0** |
| 4.15 | 103 | **0** | **0** |

An earlier version of this analysis ranked amounts on deposits alone. It rated 4.1 STRK among the
best-covered denominations in the pool, on the strength of 149 deposits — for an amount that has
never once been withdrawn. Every leg of that schedule would have had to leave the pool as a unique
amount. Scoring the weaker side is the fix.

The frontier for a 50,000 STRK position, computed from that data at the live fee, priced at two
pool transactions per leg:

| legs | pool tx | fee cost | fee % | entry cohort | exit cohort | weaker side |
| ---: | ---: | -------: | ----: | -----------: | ----------: | ----------: |
|    1 |       2 |       12 | 0.02% |            2 |           8 |           2 |
|    8 |      16 |       96 | 0.19% |            5 |           5 |           5 |
|   10 |      20 |      120 | 0.24% |           28 |           8 |           8 |
|   13 |      26 |      156 | 0.31% |           28 |          11 |          11 |

Thirteen legs — twelve of 4,000 and one of 2,000 — costs 156 STRK to enter, 0.31% of the
position, and 312 STRK across the round trip. Nothing affordable reaches the target cover, so
Rhizome says so rather than dressing the best available up as sufficient.

For a 100 STRK position the same analysis says **do not split**: one leg already sits in cohorts
of 78 in and 29 out, and the single pair of transactions needed to enter is already 12% of the
position. Twenty-four percent to enter and exit.

That asymmetry is the product. Run it yourself:

```sh
npm run analyze -- mainnet 50000
npm run analyze -- mainnet 50000 roundTrip
npm run verify:facts
```

## Hidden vs. visible

Being precise about this matters more than the pitch.

| Public | Private |
| --- | --- |
| Shield deposits: your address, token, amount | Note-to-note transfers: amounts and parties |
| Withdrawal destination and amount | Which deposit a withdrawal came from |
| Each tranche's amount and timing at the venue | Which tranches belong to the same position |
| Open-note amounts (measured at execution time) | The owner of an open note |
| That an address interacts with the pool | The withdrawing user (encrypted to the auditor) |
| One fee-sized withdrawal per pool transaction | Which of them was yours |

Rhizome claims **identity privacy and reduced correlatability**. It does **not** claim amount
privacy for the DeFi leg — that is not something the pool provides, and no scheduling strategy
can create it.

## Status

Early. The analysis layer is complete and measured against mainnet. Execution is wired as a
two-stage runner per leg — shield, wait out the measured delay, then invoke the vault — gated on a
dry run of each action shape, and it has not yet been run against a wallet on mainnet.

| | |
| --- | --- |
| Sepolia anonymizer | `0x552d747e90eb70e52e9c5f9d9150b97e46ac9b25989a36e7eee96a2e45c5e20` |
| Sepolia class hash | `0x3c8a10f6d3c5f57a93ce5b132a08e30015282fd158e3dcf6986625bc0c9446a` |
| Mainnet anonymizer | not deployed |

The two-action shape for the vault leg (`transfer` with `amount: "OPEN"`, then `invoke`) is the
documented one, but the pool also has to get the input tokens to the helper, and the documented
example does not show that leg. Both shapes are selectable in the UI and neither can submit until
its dry run passes — `strk20PrepareInvoke` proves without spending a fee, so the wallet settles the
question rather than a guess.

`npm run verify:facts` checks the deployed class hash against the class committed in
`artifacts/`, so the reviewed bytecode and the deployed bytecode are provably the same.

## Stack

- Starknet Wallet API via `starknet.js` `WalletAccountV6` — the dapp never touches a viewing key
- `@starknet-io/get-starknet-discovery` / `-wallet-standard` 6.0.3, `@starknet-io/types-js` 0.10.3
- A Cairo `privacy_invoke` anonymizer contract (owned and reviewed here, not audited)

## License

MIT — see [LICENSE](./LICENSE).
