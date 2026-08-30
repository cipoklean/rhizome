// One reusable loader for public pool state — every network, every visit.
//
// Guarantees:
//  - cold visitor (no cache): snapshot (66k gz) -> paint <200ms -> tail since snapshot block
//  - warm visitor: freshest of (shipped snapshot, compact cache) by block, no rewind
//  - tip: no event fetch at all when snapshot/cache is at head
//  - offline / RPC down: still paints from snapshot
//
// The shape returned is exactly what the frontend renders, so App.jsx stays thin:
//   { block, fee, feeHistory, entryHist: Map<BigInt,count>, exitHist: Map| null, txBlocks: number[], counts, source, stale? }
// No React, no component branching, fully testable.

import { amountHistogram } from "./cohorts.mjs";
import {
  classifyWithdrawals,
  connect,
  fetchDeposits,
  fetchFeeHistory,
  fetchWithdrawals,
  getFeeAmount,
} from "./pool.mjs";
import { poolTransactionBlocks } from "./timing.mjs";

const CACHE_PREFIX = "rhizome:pool:v2:compact:";

function compactCacheKey(network, token) {
  return `${CACHE_PREFIX}${network}:${String(token).toLowerCase()}`;
}

function readCompactCache(network, token) {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(compactCacheKey(network, token));
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (!j || typeof j.block !== "number" || !j.entryHist || !j.exitHist || !Array.isArray(j.txBlocks)) return null;
    return {
      block: j.block,
      fee: j.fee ? BigInt(j.fee) : null,
      feeHistory: (j.feeHistory ?? []).map((h) => ({ feeAmount: BigInt(h.feeAmount), blockNumber: h.blockNumber, txHash: h.txHash })),
      entryHist: new Map(Object.entries(j.entryHist).map(([k, v]) => [BigInt(k), v])),
      exitHist: new Map(Object.entries(j.exitHist).map(([k, v]) => [BigInt(k), v])),
      txBlocks: j.txBlocks,
      depositsCount: j.depositsCount ?? 0,
      withdrawalsCount: j.withdrawalsCount ?? 0,
      exitsCount: j.exitsCount ?? 0,
      feeLegsCount: j.feeLegsCount ?? 0,
      compact: true,
      source: "cache",
      fetchedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

function writeCompactCache(network, token, state) {
  try {
    if (typeof window === "undefined") return;
    const payload = {
      block: state.block,
      fee: state.fee != null ? state.fee.toString() : null,
      feeHistory: (state.feeHistory ?? []).map((h) => ({ feeAmount: h.feeAmount.toString(), blockNumber: h.blockNumber, txHash: h.txHash })),
      entryHist: Object.fromEntries([...state.entryHist.entries()].map(([k, v]) => [k.toString(), v])),
      exitHist: Object.fromEntries([...(state.exitHist ?? new Map()).entries()].map(([k, v]) => [k.toString(), v])),
      txBlocks: state.txBlocks ?? [],
      depositsCount: state.depositsCount ?? 0,
      withdrawalsCount: state.withdrawalsCount ?? 0,
      exitsCount: state.exitsCount ?? 0,
      feeLegsCount: state.feeLegsCount ?? 0,
      savedAt: Date.now(),
    };
    window.localStorage.setItem(compactCacheKey(network, token), JSON.stringify(payload));
  } catch {}
}

async function loadShippedSnapshot(network) {
  const base = import.meta.env?.BASE_URL ?? "/";
  const urls = [
    `${base.replace(/\/$/, "/")}pool-state.${network}.json`,
    `${base.replace(/\/$/, "/")}pool-snapshot.${network}.json`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) continue;
      const j = await res.json();
      if (j.entryHist && j.exitHist && Array.isArray(j.txBlocks)) {
        return {
          block: j.block ?? 0,
          fee: j.fee ? BigInt(j.fee) : null,
          feeHistory: (j.feeHistory ?? []).map((h) => ({ feeAmount: BigInt(h.feeAmount), blockNumber: h.blockNumber, txHash: h.txHash })),
          entryHist: new Map(Object.entries(j.entryHist).map(([k, v]) => [BigInt(k), v])),
          exitHist: new Map(Object.entries(j.exitHist).map(([k, v]) => [BigInt(k), v])),
          txBlocks: j.txBlocks ?? [],
          depositsCount: typeof j.deposits === "number" ? j.deposits : null,
          withdrawalsCount: typeof j.withdrawals === "number" ? j.withdrawals : null,
          exitsCount: typeof j.exits === "number" ? j.exits : null,
          feeLegsCount: typeof j.feeLegs === "number" ? j.feeLegs : null,
          compact: true,
          source: "snapshot",
          fetchedAt: Date.now(),
        };
      }
      if (Array.isArray(j.deposits) && Array.isArray(j.withdrawals)) {
        // Legacy full snapshot (7M) — derive histograms here so caller never sees the difference
        const deposits = j.deposits.map((d) => ({ ...d, amount: BigInt(d.amount) }));
        const withdrawals = j.withdrawals.map((w) => ({ ...w, amount: BigInt(w.amount) }));
        const feeHistory = (j.feeHistory ?? []).map((h) => ({ feeAmount: BigInt(h.feeAmount), blockNumber: h.blockNumber, txHash: h.txHash }));
        const { positions: exits, feeLegs } = classifyWithdrawals(withdrawals, feeHistory);
        return {
          block: j.block ?? 0,
          fee: j.fee ? BigInt(j.fee) : null,
          feeHistory,
          entryHist: amountHistogram(deposits),
          exitHist: exits.length ? amountHistogram(exits) : new Map(),
          txBlocks: poolTransactionBlocks(feeLegs),
          depositsCount: deposits.length,
          withdrawalsCount: withdrawals.length,
          exitsCount: exits.length,
          feeLegsCount: feeLegs.length,
          compact: true,
          source: "snapshot",
          fetchedAt: Date.now(),
        };
      }
    } catch {}
  }
  return null;
}

function pickFreshest(snapshot, cached) {
  if (!snapshot) return cached;
  if (!cached) return snapshot;
  return cached.block > snapshot.block ? cached : snapshot;
}

/
 * Load public pool state for `network` with incremental tail fetch.
 *
 * @param {string} network    "mainnet" | "sepolia"
 * @param {object} cfg        parsed config/addresses.json
 * @param {object} opts
 * @param {(state)=>void} opts.onStale  called immediately with snapshot/cache if available, before live refresh
 * @returns {Promise<{block,fee,feeHistory,entryHist,exitHist,txBlocks,depositsCount,withdrawalsCount,exitsCount,feeLegsCount,source}>}
 */
export async function loadPoolState(network, cfg, { onStale } = {}) {
  const net = cfg[network];
  if (!net) throw new Error(`unknown network "${network}"`);
  const token = net.tokens?.STRK ?? cfg.mainnet.tokens.STRK;

  const [snapshot, cached] = await Promise.all([loadShippedSnapshot(network), Promise.resolve(readCompactCache(network, token))]);
  const base = pickFreshest(snapshot, cached);

  if (base && base.entryHist?.size && typeof onStale === "function") {
    onStale({ ...base, stale: true, staleSource: base.source });
  }

  // Live refresh: only tail since freshest block (fast). Fee + block are always checked live.
  let provider;
  try {
    provider = await connect(net.rpc);
  } catch (e) {\n    if (base) return { ...base, source: "snapshot", stale: true, fetchedAt: Date.now() };\n    throw e;\n  }

  const fromBlock = base ? Math.max(0, base.block + 1) : 0;
  const [block, fee, liveFeeHistory] = await Promise.all([
    provider.getBlockNumber(),
    getFeeAmount(provider, net.strk20Pool),
    fromBlock <= Number.MAX_SAFE_INTEGER
      ? fetchFeeHistory(provider, net.strk20Pool, { fromBlock }).catch(() => [])
      : Promise.resolve([]),
  ]);

  let mergedFeeHistory = base ? [...(base.feeHistory ?? []), ...liveFeeHistory].sort((a, b) => a.blockNumber - b.blockNumber) : liveFeeHistory;

  // At tip — no event fetch
  if (fromBlock > block || (base && base.block >= block && liveFeeHistory.length === 0)) {
    const live = {
      block,
      fee,
      feeHistory: mergedFeeHistory,
      entryHist: base ? new Map(base.entryHist) : new Map(),
      exitHist: base?.exitHist ? new Map(base.exitHist) : null,
      txBlocks: base?.txBlocks ? [...base.txBlocks] : [],
      depositsCount: base?.depositsCount ?? 0,
      withdrawalsCount: base?.withdrawalsCount ?? 0,
      exitsCount: base?.exitsCount ?? 0,
      feeLegsCount: base?.feeLegsCount ?? 0,
      source: base?.source ?? "live",
      stale: false,
    };
    return live;
  }

  let freshDeposits = [];
  let freshWithdrawals = [];
  try {
    [freshDeposits, freshWithdrawals] = await Promise.all([
      fetchDeposits(provider, net.strk20Pool, { token, fromBlock }),
      fetchWithdrawals(provider, net.strk20Pool, { token, fromBlock }),
    ]);
  } catch (e) {
    // RPC tail failed — return cache source with stale=true\n    if (base) return { ...base, source: "cache", stale: true, fetchedAt: Date.now() };
    throw e;
  }

  const mergedEntryHist = base ? new Map(base.entryHist) : new Map();
  for (const d of freshDeposits) mergedEntryHist.set(d.amount, (mergedEntryHist.get(d.amount) ?? 0) + 1);

  // Classify tail withdrawals to separate fee legs from exits before merging
  const tailClass = classifyWithdrawals(freshWithdrawals, mergedFeeHistory);
  const mergedExitHist = base?.exitHist ? new Map(base.exitHist) : new Map();
  for (const w of tailClass.positions) mergedExitHist.set(w.amount, (mergedExitHist.get(w.amount) ?? 0) + 1);

  const mergedTxBlocks = [...(base?.txBlocks ?? []), ...poolTransactionBlocks(tailClass.feeLegs)].sort((a, b) => a - b);
  // Dedup + sort (re-fetch after reorg could overlap by one block on some RPCs)
  const dedupedTxBlocks = [...new Set(mergedTxBlocks)].sort((a, b) => a - b);

  const live = {
    block,
    fee,
    feeHistory: mergedFeeHistory,
    entryHist: mergedEntryHist,
    exitHist: mergedExitHist.size > 0 ? mergedExitHist : null,
    txBlocks: dedupedTxBlocks,
    depositsCount: (base?.depositsCount ?? 0) + freshDeposits.length,
    withdrawalsCount: (base?.withdrawalsCount ?? 0) + freshWithdrawals.length,
    exitsCount: (base?.exitsCount ?? 0) + tailClass.positions.length,
    feeLegsCount: (base?.feeLegsCount ?? 0) + tailClass.feeLegs.length,
    source: "live",
    stale: false,
    fetchedAt: Date.now(),
  };

  writeCompactCache(network, token, live);
  return live;
}
