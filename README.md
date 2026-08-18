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
over time. The obvious fix is also expensive: the pool charges a **flat fee per private
operation**, and the protocol permits **at most one external invoke per pool transaction**, so
every tranche is a separate transaction and a separate fee.

Measured on mainnet at block 13494196:

```
get_fee_amount => 6000000000000000000   (6 STRK)
```

Ten tranches on a 100 STRK position costs 60 STRK in fees. Splitting is not free, and for small
positions it is irrational.

## What Rhizome does

Rhizome treats unlinkability as something with a price, and computes it.

1. **Reads the live fee** from the pool rather than assuming it.
2. **Reads public cohort data** — the pool's own `Deposit` events and venue deposit amounts are
   public — to find amounts that blend in rather than stand out.
3. **Computes the frontier**: for a given position size, what tranche count buys meaningful
   unlinkability, and what it costs in fees. Sometimes the honest answer is "one tranche".
4. **Executes the chosen schedule** through its own anonymizer contract, each tranche landing in
   its own note.

Externally: several indistinguishable deposits with no shared fingerprint. Internally: one
position, one dashboard.

Existing privacy-preflight tools tell a user they leaked. Rhizome prices the fix and executes it.

## Hidden vs. visible

Being precise about this matters more than the pitch.

| Public | Private |
| --- | --- |
| Shield deposits: your address, token, amount | Note-to-note transfers: amounts and parties |
| Withdrawal destination and amount | Which deposit a withdrawal came from |
| Each tranche's amount and timing at the venue | Which tranches belong to the same position |
| Open-note amounts (measured at execution time) | The owner of an open note |
| That an address interacts with the pool | |

Rhizome claims **identity privacy and reduced correlatability**. It does **not** claim amount
privacy for the DeFi leg — that is not something the pool provides, and no scheduling strategy
can create it.

## Status

Early. This section will carry the integration log, deployed addresses, and verified mainnet
transactions as they land.

## Stack

- Starknet Wallet API via `starknet.js` `WalletAccountV6` — the dapp never touches a viewing key
- `@starknet-io/get-starknet-discovery` / `-wallet-standard` 6.0.3, `@starknet-io/types-js` 0.10.3
- A Cairo `privacy_invoke` anonymizer contract (owned and reviewed here, not audited)

## License

MIT — see [LICENSE](./LICENSE).
