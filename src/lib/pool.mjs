// Reading public STRK20 pool state.
//
// Everything here is public on-chain data. No viewing key, no private state —
// Rhizome deliberately never touches either.

import { RpcProvider, hash } from "starknet";

export const DEPOSIT_SELECTOR = hash.getSelectorFromName("Deposit");

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
 * This is deducted from the deposited amount rather than charged on top: to end
 * up with N shielded you deposit N + fee. It is admin-settable via
 * `set_fee_amount` and has changed during this project's lifetime, which is why
 * nothing here hardcodes it.
 */
export async function getFeeAmount(provider, poolAddress) {
  const [raw] = await provider.callContract({
    contractAddress: poolAddress,
    entrypoint: "get_fee_amount",
    calldata: [],
  });
  return BigInt(raw);
}

/**
 * Public `Deposit` events: who shielded, which token, how much.
 *
 * Event shape (from the pool ABI):
 *   keys = [selector, user_addr, token]
 *   data = [amount]  (u128, single felt)
 */
export async function fetchDeposits(
  provider,
  poolAddress,
  { fromBlock = 0, toBlock = "latest", token = null, maxEvents = 20000, chunkSize = 1000 } = {},
) {
  const keys = token ? [[DEPOSIT_SELECTOR], [], [token]] : [[DEPOSIT_SELECTOR]];
  const deposits = [];
  let continuationToken;

  do {
    const page = await provider.getEvents({
      address: poolAddress,
      from_block: fromBlock === 0 ? { block_number: 0 } : { block_number: fromBlock },
      to_block: toBlock === "latest" ? "latest" : { block_number: toBlock },
      keys,
      chunk_size: chunkSize,
      continuation_token: continuationToken,
    });

    for (const e of page.events ?? []) {
      // keys[0] is the selector.
      deposits.push({
        user: e.keys[1],
        token: e.keys[2],
        amount: BigInt(e.data[0]),
        blockNumber: e.block_number,
        txHash: e.transaction_hash,
      });
    }

    continuationToken = page.continuation_token;
  } while (continuationToken && deposits.length < maxEvents);

  return deposits;
}
