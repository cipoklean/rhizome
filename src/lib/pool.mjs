// Reading public STRK20 pool state.
//
// Everything here is public on-chain data. No viewing key, no private state —
// Rhizome deliberately never touches either.
//
// This file is pure RPC + classification. No fetch(), no localStorage, no
// JSON snapshot shape. Those live in pool-state.mjs so every network reuses
// the same incremental path.

import { RpcProvider, hash } from "starknet";

export const DEPOSIT_SELECTOR = hash.getSelectorFromName("Deposit");
export const WITHDRAWAL_SELECTOR = hash.getSelectorFromName("Withdrawal");
export const FEE_AMOUNT_SET_SELECTOR = hash.getSelectorFromName("FeeAmountSet");

/** First responsive RPC from a list. */
export async function connect(urls) {
  let lastError;
  for (const nodeUrl of urls) {
    try {
      const provider = new RpcProvider({ nodeUrl });
      await provider.getBlockNumber();
      return provider;
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`no reachable RPC (${lastError?.message ?? "unknown"})`);
}

/**
 * The flat pool fee, read live.
 *
 * Charged per `apply_actions` call — that is, once per pool transaction,
 * whatever the transaction does — and always denominated in STRK regardless of
 * which token is being shielded. See `feeNote` in config/addresses.json for the
 * measured settlement path.
 *
 * Admin-settable via `set_fee_amount`, and it has changed twice on mainnet,
 * which is why nothing here hardcodes it.
 */
export async function getFeeAmount(provider, poolAddress) {
  const [raw] = await provider.callContract({
    contractAddress: poolAddress,
    entrypoint: "get_fee_amount",
    calldata: [],
  });
  return BigInt(raw);
}

/** The address the pool fee is paid to. */
export async function getFeeCollector(provider, poolAddress) {
  const [raw] = await provider.callContract({
    contractAddress: poolAddress,
    entrypoint: "get_fee_collector",
    calldata: [],
  });
  return raw;
}

/**
 * Page through `getEvents`.
 *
 * A page may be empty and still carry a continuation token — the RPC walks
 * block ranges, not matches. Stopping at the first empty page silently returns a
 * fraction of the data, which is exactly the kind of quiet truncation that makes
 * cohort counts wrong rather than absent.
 *
 * Reading the whole pool is tens of pages, so a single transient failure part
 * way through would otherwise discard the lot. Retry the page, keep the
 * continuation token, and only give up once the retries are exhausted — a short
 * read is worse than an error, because it looks like an answer.
 */
async function* pages(
  provider,
  { address, keys, fromBlock = 0, toBlock = "latest", chunkSize = 1000, retries = 3, retryDelayMs = 600 },
) {
  let continuationToken;
  do {
    let page;
    for (let attempt = 0; ; attempt++) {
      try {
        page = await provider.getEvents({
          address,
          from_block: { block_number: fromBlock },
          to_block: toBlock === "latest" ? "latest" : { block_number: toBlock },
          keys,
          chunk_size: chunkSize,
          continuation_token: continuationToken,
        });
        break;
      } catch (e) {
        if (attempt >= retries) {
          throw new Error(`getEvents failed after ${attempt + 1} attempts: ${e.message}`);
        }
        await new Promise((r) => setTimeout(r, retryDelayMs * (attempt + 1)));
      }
    }
    yield page.events ?? [];
    continuationToken = page.continuation_token;
  } while (continuationToken);
}

/**
 * Public `Deposit` events — the entry leg: who shielded, which token, how much.
 *
 *   keys = [selector, user_addr, token]
 *   data = [amount]   (u128, one felt)
 */
export async function fetchDeposits(
  provider,
  poolAddress,
  { fromBlock = 0, toBlock = "latest", token = null, maxEvents = 100000, chunkSize = 1000 } = {},
) {
  const keys = token ? [[DEPOSIT_SELECTOR], [], [token]] : [[DEPOSIT_SELECTOR]];
  const deposits = [];

  for await (const events of pages(provider, { address: poolAddress, keys, fromBlock, toBlock, chunkSize })) {
    for (const e of events) {
      deposits.push({
        user: e.keys[1],
        token: e.keys[2],
        amount: BigInt(e.data[0]),
        blockNumber: e.block_number,
        txHash: e.transaction_hash,
      });
    }
    if (deposits.length >= maxEvents) break;
  }

  return deposits;
}

/**
 * Public `Withdrawal` events — the exit leg.
 *
 *   keys = [selector, to_addr, token]
 *   data = [auditor_public_key, ephemeral_pubkey, enc_user_addr, amount]
 *
 * The first three data felts are the `EncUserAddr` struct: the withdrawing
 * user's address encrypted to the auditor's key. It is opaque here and stays
 * that way — the amount is the last felt.
 */
export async function fetchWithdrawals(
  provider,
  poolAddress,
  { fromBlock = 0, toBlock = "latest", token = null, maxEvents = 100000, chunkSize = 1000 } = {},
) {
  const keys = token ? [[WITHDRAWAL_SELECTOR], [], [token]] : [[WITHDRAWAL_SELECTOR]];
  const withdrawals = [];

  for await (const events of pages(provider, { address: poolAddress, keys, fromBlock, toBlock, chunkSize })) {
    for (const e of events) {
      // EncUserAddr is three felts, so amount is data[3]. Guard rather than
      // assume: a struct change would otherwise shift the amount silently.
      if (e.data.length !== 4) {
        throw new Error(`unexpected Withdrawal data width ${e.data.length} at block ${e.block_number}`);
      }
      withdrawals.push({
        to: e.keys[1],
        token: e.keys[2],
        amount: BigInt(e.data[3]),
        blockNumber: e.block_number,
        txHash: e.transaction_hash,
      });
    }
    if (withdrawals.length >= maxEvents) break;
  }

  return withdrawals;
}

/**
 * Every fee the pool has ever charged, from `FeeAmountSet`.
 *
 * The fee before the first event is zero — `fee_amount` starts unset and
 * `collect_fee` skips a zero fee entirely. So the pool ran free for its first
 * ~56k blocks, which matters when reading old cohort data: those legs were not
 * priced.
 */
export async function fetchFeeHistory(provider, poolAddress, { fromBlock = 0, toBlock = "latest" } = {}) {
  const history = [];
  for await (const events of pages(provider, {
    address: poolAddress,
    keys: [[FEE_AMOUNT_SET_SELECTOR]],
    fromBlock,
    toBlock,
  })) {
    for (const e of events) {
      history.push({
        feeAmount: BigInt(e.data[0]),
        blockNumber: e.block_number,
        txHash: e.transaction_hash,
      });
    }
  }
  return history.sort((a, b) => a.blockNumber - b.blockNumber);
}

/**
 * Split withdrawals into position legs and fee-reimbursement legs.
 *
 * This filter is not cosmetic. The fee is settled by an extra withdraw action
 * inside the same pool transaction: the fee router fronts STRK to the fee
 * collector and the pool immediately withdraws the identical amount back to the
 * router. Every single priced pool transaction therefore emits a public
 * `Withdrawal` of exactly the fee amount, and on mainnet those legs are ~76% of
 * all STRK withdrawals. Treating them as cover would invent an enormous cohort
 * at 4 and 6 STRK that no user position ever occupies.
 *
 * A leg is fee reimbursement when its amount equals a fee the pool has actually
 * charged *and* its destination looks like a fee router. Both conditions come
 * from chain data, never a hardcoded address.
 *
 * "Looks like a fee router" needs two tests, not one. Volume alone is too loose:
 * on Sepolia the busiest fee-sized destination has only 32% fee-sized traffic,
 * so most of its legs are something else and there is no way to tell which are
 * which — while the real mainnet router is 99% fee-sized, because being
 * reimbursed is the only thing it does. So a router must both receive a
 * meaningful share of all fee-sized legs (`routerShare`) and have almost nothing
 * else in its own traffic (`minRouterPurity`). Where that is ambiguous, Rhizome
 * keeps the legs and lets the cohort be honest rather than inventing a filter.
 */
export function classifyWithdrawals(
  withdrawals,
  feeHistory,
  { routerShare = 0.02, minRouterPurity = 0.8 } = {},
) {
  const feeAmounts = new Set(feeHistory.map((f) => f.feeAmount).filter((f) => f > 0n));

  const totalByDestination = new Map();
  const feeSizedByDestination = new Map();
  let feeSizedTotal = 0;
  for (const w of withdrawals) {
    totalByDestination.set(w.to, (totalByDestination.get(w.to) ?? 0) + 1);
    if (feeAmounts.has(w.amount)) {
      feeSizedByDestination.set(w.to, (feeSizedByDestination.get(w.to) ?? 0) + 1);
      feeSizedTotal += 1;
    }
  }

  const threshold = Math.max(1, Math.floor(feeSizedTotal * routerShare));
  const routerStats = [...feeSizedByDestination.entries()]
    .map(([to, feeSized]) => {
      const total = totalByDestination.get(to) ?? feeSized;
      return { to, feeSized, total, purity: feeSized / total };
    })
    .filter((r) => r.feeSized >= threshold && r.purity >= minRouterPurity)
    .sort((a, b) => b.feeSized - a.feeSized);

  const routers = new Set(routerStats.map((r) => r.to));
  const isFeeLeg = (w) => feeAmounts.has(w.amount) && routers.has(w.to);

  return {
    positions: withdrawals.filter((w) => !isFeeLeg(w)),
    feeLegs: withdrawals.filter(isFeeLeg),
    routers: [...routers],
    routerStats,
    feeAmounts: [...feeAmounts],
  };
}
