// Wallet layer — the Starknet Wallet API route.
//
// The dapp describes actions; the wallet holds the viewing key, discovers notes,
// generates the proof and submits. Rhizome never sees a key.
//
// Verified against starknet@10.4.0 and get-starknet 6.0.3:
//   createStore                      @starknet-io/get-starknet-discovery (root export)
//   WalletAccountV6.connect          starknet
//   walletV6.supportedWalletApi      capability detection
//   strk20Balances / strk20PrepareInvoke / strk20InvokeTransaction

import { CallData, WalletAccountV6, constants, walletV6 } from "starknet";

/** LendingOperation variants, in Cairo declaration order. */
export const OPERATION = { Deposit: "0x0", Withdraw: "0x1" };

/** Wallets currently injected into the page. */
export async function listWallets() {
  const { createStore } = await import("@starknet-io/get-starknet-discovery");
  return createStore().getWallets();
}

/**
 * Is this wallet STRK20-capable?
 *
 * Detect with a version query, never a data call. Probing `strk20Balances([])`
 * would make the wallet prompt the user to disclose balances the app does not
 * need. The wallet-standard feature version (`1.0.0`) says nothing about STRK20
 * support — only the Wallet API version does.
 */
export const MIN_STRK20_WALLET_API = "0.10.3";

/** Private DeFi was added in Wallet API 0.10.3, not the 0.10 line generally. */
export function supportsStrk20PrivateDefiVersion(version) {
  const parts = String(version).split(".");
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) {
    return false;
  }
  const [major, minor, patch = "0"] = parts.map(Number);
  if (major > 0) return true;
  if (major !== 0) return false;
  if (minor > 10) return true;
  return minor === 10 && patch >= 3;
}

export async function checkStrk20Support(wallet) {
  try {
    const versions = await walletV6.supportedWalletApi(wallet);
    const list = Array.isArray(versions) ? versions : [versions];
    const supported = list.some(supportsStrk20PrivateDefiVersion);
    let canQueryTxs = false;
    try {
      canQueryTxs = typeof wallet.strk20QueryTransactions === "function";
    } catch {}
    return {
      supported,
      versions: list,
      minimumVersion: MIN_STRK20_WALLET_API,
      canQueryTxs,
    };
  } catch (e) {
    return {
      supported: false,
      versions: [],
      minimumVersion: MIN_STRK20_WALLET_API,
      error: e.message,
    };
  }
}

export async function connectWallet(wallet, nodeUrl, { silent = false } = {}) {
  const provider = { nodeUrl };
  return silent
    ? WalletAccountV6.connectSilent(provider, wallet)
    : WalletAccountV6.connect(provider, wallet);
}

/**
 * Resolve config's readable chain aliases to the felt chain id the Wallet API
 * requires. Accepting the felt too keeps this helper usable outside config.
 */
export function resolveChainId(chainId) {
  const resolved = constants.StarknetChainId[chainId] ?? chainId;
  if (typeof resolved !== "string" || !/^0x[0-9a-f]+$/i.test(resolved)) {
    throw new Error(`unknown Starknet chain id "${chainId}"`);
  }
  return "0x" + BigInt(resolved).toString(16);
}

/** Chain ids are felts: zero-padding and letter case are not identity. */
export function sameChain(a, b) {
  try {
    return BigInt(resolveChainId(a)) === BigInt(resolveChainId(b));
  } catch {
    return false;
  }
}

/** The wallet's write chain — not the RPC chain the dapp uses for reads. */
export async function walletChainId(wallet, api = walletV6) {
  return api.requestChainId(wallet);
}

/**
 * Put the wallet on the selected network, or fail closed.
 *
 * A WalletAccount has two networks: its provider handles reads and the injected
 * wallet handles writes. Merely constructing it with a Sepolia RPC does not move
 * Ready off mainnet; without this check the UI reads testnet, signs mainnet and
 * fails in ways that look like bad STRK20 calldata.
 *
 * The Wallet API can request a switch even when Ready does not expose a manual
 * network picker, but only after WalletAccountV6.connect has authorized the
 * dapp. Verify after the request — a truthy response is not evidence that the
 * wallet actually moved, and submitting across a mismatch is worse than
 * refusing to submit.
 */
export async function ensureWalletChain(wallet, targetChainId, api = walletV6) {
  const expected = resolveChainId(targetChainId);
  const before = await walletChainId(wallet, api);
  if (sameChain(before, expected)) {
    return { chainId: expected, previousChainId: resolveChainId(before), switched: false };
  }

  let accepted;
  try {
    accepted = await api.switchStarknetChain(wallet, expected);
  } catch (e) {
    throw new Error(
      `wallet network switch to ${targetChainId} failed or was rejected: ${e.message}`,
    );
  }
  if (accepted === false) {
    throw new Error(`wallet refused to switch to ${targetChainId}`);
  }

  const after = await walletChainId(wallet, api);
  if (!sameChain(after, expected)) {
    throw new Error(
      `wallet is still on ${after}; selected network is ${targetChainId}. No transaction was sent.`,
    );
  }

  return { chainId: expected, previousChainId: resolveChainId(before), switched: true };
}

/** Shielded balances, read through the wallet — no viewing key in the app. */
export async function shieldedBalances(account, tokens) {
  return account.strk20Balances(tokens.map((token, i) => canonicalFelt(token, `balance token ${i}`)));
}

/**
 * VISIBLE (public) ERC-20 balance via RPC. The paymaster funds every pool
 * transaction from the user's VISIBLE STRK (6 STRK fee-leg transfer + gas
 * bounds); when that balance is empty the paymaster fails pre-flight with
 * the generic 156/TRANSACTION_EXECUTION_ERROR and NOTHING is broadcast.
 * This read lets the UI refuse early with a plain reason instead.
 * Returns null when no RPC answers (check skipped, never blocks).
 */
export async function visibleBalance({ rpcUrls, owner, token }) {
  const viaProxy =
    typeof window !== "undefined" && typeof window.fetch === "function" && window.location?.protocol?.startsWith("http");
  const send = async (target, body) =>
    (await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })).json();
  for (const url of rpcUrls ?? []) {
    try {
      const j = viaProxy
        ? await send("/api/simulate", { rpcUrl: url, method: "starknet_call", params: { contract_address: token, entry_point: "balance_of", calldata: [owner], block_id: "latest" }, id: 1 })
        : await send(url, { jsonrpc: "2.0", method: "starknet_call", params: { contract_address: token, entry_point: "balance_of", calldata: [owner], block_id: "latest" }, id: 1 });
      if (j?.error) continue;
      const arr = j?.result;
      if (Array.isArray(arr) && arr.length >= 1) return BigInt(arr[0]);
      if (typeof arr === "string") return BigInt(arr);
    } catch {
      continue;
    }
  }
  return null;
}

const FELT_PATTERN = /^0x(?:0|[a-f1-9][a-f0-9]{0,62})$/i;
const CALLDATA_PLACEHOLDER_PATTERN = /^\$\{(?:openNoteIds\[([0-9]+)\]|poolAddress)\}$/;

/** Wallet API FELTs are minimal hex: at most 63 digits and no leading zeroes. */
export function canonicalFelt(value, label = "felt") {
  let numeric;
  try {
    if (typeof value === "bigint") {
      numeric = value;
    } else if (typeof value === "string" && /^0x[a-f0-9]+$/i.test(value)) {
      numeric = BigInt(value);
    } else {
      throw new Error("must be a hexadecimal string or bigint");
    }
  } catch (e) {
    throw new Error(`${label} is not a Wallet API FELT: ${e.message}`);
  }
  if (numeric < 0n) throw new Error(`${label} is not a Wallet API FELT: negative value`);
  const canonical = `0x${numeric.toString(16)}`;
  if (!FELT_PATTERN.test(canonical)) {
    throw new Error(`${label} is not a Wallet API FELT: exceeds 63 hex digits`);
  }
  return canonical;
}

/** Return field-level errors using the Wallet API 0.10.3 STRK20 schema. */
export function validateStrk20Actions(actions) {
  if (!Array.isArray(actions) || actions.length === 0) return ["actions must be a non-empty array"];
  const errors = [];
  const openNotes = actions.filter((a) => a?.type === "transfer" && a.amount === "OPEN").length;
  const felt = (path, value) => {
    if (typeof value !== "string" || !FELT_PATTERN.test(value)) {
      errors.push(`${path} must be a canonical Wallet API FELT`);
    }
  };
  const address = felt;

  actions.forEach((action, index) => {
    const path = `actions[${index}]`;
    if (!action || typeof action !== "object") {
      errors.push(`${path} must be an action object`);
      return;
    }
    if (action.type === "deposit") {
      address(`${path}.token`, action.token);
      felt(`${path}.amount`, action.amount);
    } else if (action.type === "withdraw") {
      address(`${path}.token`, action.token);
      felt(`${path}.amount`, action.amount);
      address(`${path}.recipient`, action.recipient);
    } else if (action.type === "transfer") {
      address(`${path}.token`, action.token);
      if (action.amount !== "OPEN") felt(`${path}.amount`, action.amount);
      address(`${path}.recipient`, action.recipient);
    } else if (action.type === "invoke") {
      address(`${path}.contract`, action.contract);
      if (!Array.isArray(action.calldata)) {
        errors.push(`${path}.calldata must be an array`);
      } else {
        action.calldata.forEach((item, calldataIndex) => {
          const itemPath = `${path}.calldata[${calldataIndex}]`;
          const placeholder =
            typeof item === "string" ? item.match(CALLDATA_PLACEHOLDER_PATTERN) : null;
          if (placeholder) {
            if (placeholder[1] !== undefined && Number(placeholder[1]) >= openNotes) {
              errors.push(`${itemPath} references a missing open note`);
            }
          } else {
            felt(itemPath, item);
          }
        });
      }
    } else {
      errors.push(`${path}.type is not a supported STRK20 action`);
    }
  });
  return errors;
}

function assertValidStrk20Actions(actions) {
  const errors = validateStrk20Actions(actions);
  if (errors.length) throw new Error(`invalid STRK20 action payload: ${errors.join("; ")}`);
  return actions;
}

const toHex = (value, label) => canonicalFelt(value, label);

/** u256 splits into (low, high) felts. */
function u256Felts(value) {
  const v = BigInt(value);
  const MASK = (1n << 128n) - 1n;
  return [toHex(v & MASK), toHex(v >> 128n)];
}

/**
 * One tranche into the Vesu vault, as STRK20 actions.
 *
 * The documented shape for private DeFi is exactly two actions in one pool
 * transaction — an open note for the output, then the invoke:
 * https://strk20-by-example.org/starknet-wallet-api/private-defi
 *
 * The open note receives the vToken shares the helper produces; its amount is
 * only known once the vault has run, which is why it is created with "OPEN" and
 * filled in the same transaction. Open-note amounts are public by design.
 *
 * Helper calldata follows the fixed convention: the last felt is always the id
 * of the open note to fill. Our `privacy_invoke(operation, in_token, out_token,
 * assets: u256, note_id)` matches — with u256 occupying two felts.
 *
 * The accepted wallet shape is intentionally fixed. A Sepolia dry run proved
 * `transfer OPEN + invoke`; adding an explicit withdraw is both unnecessary and
 * a different, unproven request.
 */
export function buildTrancheActions({
  anonymizer,
  inToken,
  outToken,
  amount,
  recipient,
  operation = OPERATION.Deposit,
}) {
  const inAddress = canonicalFelt(inToken, "input token");
  const outAddress = canonicalFelt(outToken, "output token");
  const anonymizerAddress = canonicalFelt(anonymizer, "anonymizer");
  const recipientAddress = canonicalFelt(recipient, "recipient");
  const openNote = {
    type: "transfer",
    token: outAddress,
    amount: "OPEN",
    recipient: recipientAddress,
  };
  const invoke = {
    type: "invoke",
    contract: anonymizerAddress,
    calldata: [
      canonicalFelt(operation, "operation"),
      inAddress,
      outAddress,
      ...u256Felts(amount),
      "${openNoteIds[0]}",
    ],
  };

  return assertValidStrk20Actions([openNote, invoke]);
}

/**
 * A plain deposit — shield public tokens into the pool.
 *
 * This is the leg whose amount the cohort analysis actually chose: it emits the
 * public `Deposit` event that an observer sees. It costs one pool fee of its own,
 * and the wallet prompts **twice** — the ERC-20 `approve` has to be on-chain
 * before the private deposit can be proven, so a single "shield" is two wallet
 * signatures. Name both in the UI or users read the second as a bug.
 */
export function buildShieldActions({ token, amount }) {
  return assertValidStrk20Actions([
    {
      type: "deposit",
      token: canonicalFelt(token, "shield token"),
      amount: toHex(amount, "shield amount"),
    },
  ]);
}

/** Exact Wallet API envelope that starknet.js sends for a free STRK20 dry run. */
export function buildPrepareInvokeRequest(actions, simulate = true) {
  return {
    type: "wallet_strk20PrepareInvoke",
    params: { actions, simulate },
  };
}

/**
 * Build and prove without submitting. The cheapest way to find a calldata-shape
 * mistake, and free — no fee, no transaction.
 */
export async function dryRun(account, actions) {
  return account.strk20PrepareInvoke(assertValidStrk20Actions(actions), true);
}

/**
 * Submit through the wallet, but never wait forever.
 *
 * A wallet that accepted a transaction can still drop its response — the tab
 * was backgrounded, the RPC bridge stalled. An unbounded await here strands
 * `busy` and locks every other leg of the schedule. Time out and throw a
 * distinguishable error; the caller keeps the submission attempt checkable
 * rather than declaring the leg failed (the wallet may still relay it).
 */
export function execute(account, actions, { timeoutMs = 120000 } = {}) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          Object.assign(
            new Error("wallet did not answer in time — if you approved, use Check once it lands"),
            { code: "EXECUTE_TIMEOUT" },
          ),
        ),
      timeoutMs,
    );
  });
  return Promise.race([
    account.strk20InvokeTransaction(assertValidStrk20Actions(actions)),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

/**
 * Wait for a transaction, but never forever.
 *
 * Private transactions are relayed, so they can take a while to become visible
 * to whichever RPC this dapp happens to be on. An unbounded await strands the UI
 * in a pending state with no feedback, so time out and report "submitted" —
 * which is true, and checkable on an explorer.
 */
export async function confirm(provider, transactionHash, { timeoutMs = 90000 } = {}) {
  let timer;
  try {
    const receipt = await Promise.race([
      provider.waitForTransaction(transactionHash),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
    return receipt === "timeout" ? { confirmed: false, timedOut: true } : { confirmed: true, receipt };
  } catch (e) {
    return { confirmed: false, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Deep Simulate via the raw RPC, bypassing every SDK account factory.
 *
 * Why this exists: the SDK's account.simulateTransaction adds wallet-era
 * steps (getEstimateTip — which cartridge mainnet does not implement — plus
 * its own invocation factory) between us and the node. Those steps crash
 * client-side on shape drift before the contract ever runs. This helper
 * hand-builds the BROADCASTED INVOKE transaction exactly as the sequencer
 * expects it, so the only thing that can fail is the chain itself — and a
 * chain-side revert carries the REAL reason (maturity, balance, proof).
 *
 * The signature is empty because the caller always sets skipValidate; the
 * dummy resource bounds are fine because simulation does not submit.
 */
// ── shared proxy RPC plumbing ──────────────────────────────────────────────
// Route browser POSTs through the Vercel proxy (api/simulate.js): public
// Starknet RPCs block direct browser POSTs via CORS, so the app talks to
// /api/simulate and the proxy relays server-side. In Node (tests/scripts)
// there is no CORS, so we call the RPC directly.
export const rpcViaProxy = () =>
  typeof window !== "undefined" &&
  typeof window.fetch === "function" &&
  String(window.location?.protocol ?? "").startsWith("http");

/** JSON-RPC POST that transparently uses the Vercel proxy in the browser. */
export async function rpcFetch(url, method, params) {
  const send = async (target, body) => {
    const res = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  };
  if (!rpcViaProxy()) {
    return send(url, { jsonrpc: "2.0", method, params, id: 1 });
  }
  const j = await send("/api/simulate", { rpcUrl: url, method, params, id: 1 });
  if (j?.proxyError) throw new Error(String(j.error ?? "proxy failure"));
  return j;
}

/** Numeric felt comparison — on-chain addresses drop leading zeros. */
const sameAddr = (a, b) => {
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return false;
  }
};

/**
 * 4K BUG B primitive: find pool transactions a given owner sent recently.
 *
 * Scans the pool's events over a recent block window, groups by tx hash, and
 * returns the owner's transactions with their receipt status. This is what
 * reconciles a wallet-reported "failure" with what actually landed.
 */
export async function recentPoolTxs({ rpcUrls, owner, pool, sinceBlock } = {}) {
  if (!rpcUrls?.length || !owner || !pool) return [];
  let lastError = null;
  for (const url of rpcUrls) {
    try {
      const block = (await rpcFetch(url, "starknet_blockNumber", [])).result;
      if (typeof block !== "number") throw new Error("blockNumber unavailable");
      const fromBlock = Number.isFinite(sinceBlock)
        ? Math.max(0, block - sinceBlock)
        : Math.max(0, block - 600); // ~2.5h of mainnet blocks — enough to catch a slow tx
      const scan = async (continuation) =>
        rpcFetch(url, "starknet_getEvents", {
          filter: {
            from_block: { block_number: fromBlock },
            to_block: "latest",
            address: pool,
            chunk_size: 100,
            ...(continuation ? { continuation_token: continuation } : {}),
          },
        });
      // Paginate via the filter's continuation_token (verified live: the
      // token goes inside the filter object; a top-level param is "Invalid
      // params"). Cap at 5 chunks so a busy pool can't turn the reconcile
      // into an unbounded crawl.
      const events = [];
      let continuation = null;
      for (let chunk = 0; chunk < 5; chunk++) {
        const page = await scan(continuation);
        if (page?.error) throw new Error(String(page.error?.message ?? "getEvents failed"));
        events.push(...(page?.result?.events ?? []));
        continuation = page?.result?.continuation_token ?? null;
        if (!continuation) break;
      }
      const seen = new Set();
      const out = [];
      for (const e of events) {
        const h = e.transaction_hash;
        if (!h || seen.has(h)) continue;
        seen.add(h);
        const rc = await rpcFetch(url, "starknet_getTransactionReceipt", { transaction_hash: h });
        const rec = rc?.result ?? {};
        // Owner match: paymaster-funded txs are SENT by the relayer account,
        // but the owner's account contract still emits its own event inside
        // the tx (observed in the live hide receipt: the user's account emits
        // alongside the relayer). A receipt event from the owner's address is
        // the honest "the user did this" marker.
        const ownerEvent = (rec.events ?? []).some((ev) => sameAddr(ev.from_address, owner));
        if (!ownerEvent) continue;
        const tx = await rpcFetch(url, "starknet_getTransactionByHash", { transaction_hash: h });
        out.push({
          hash: h,
          block: rec.block_number ?? e.block_number ?? null,
          status: rec.execution_status ?? "UNKNOWN",
          sender: tx?.result?.sender_address ?? null,
          receipt: rec,
        });
      }
      return out;
    } catch (e) {
      lastError = e;
    }
  }
  if (lastError) throw lastError;
  return [];
}

/**
 * Pure decision core of 4K BUG B: given the chain-scan results and the
 * current block, pick the SUCCEEDED tx that the wallet's "failure" hid.
 * Exported for unit tests — no network, deterministic.
 */
export function pickLandedPoolTx(txs, currentBlock, window = 120) {
  if (!Array.isArray(txs) || txs.length === 0) return null;
  const floor = Number.isFinite(currentBlock) ? currentBlock - window : -Infinity;
  const landed = txs.filter(
    (t) =>
      t?.status === "SUCCEEDED" &&
      t?.block != null &&
      Number(t.block) >= floor,
  );
  if (landed.length === 0) return null;
  // newest first
  landed.sort((a, b) => Number(b.block) - Number(a.block));
  return landed[0];
}

export async function rawSimulateInvoke({
  rpcUrls,
  senderAddress,
  call,
  chargeFee = true,
} = {}) {
  const hexCalldata = (Array.isArray(call.calldata) ? call.calldata : [call.calldata]).map((v) =>
    typeof v === "bigint" ? "0x" + v.toString(16) : String(v),
  );
  // cairo1 multi-call envelope. The wallet's real invokes bundle a fee-router
  // STRK transfer ahead of the pool call (observed in the live hide tx:
  // calldata[0]=2 calls, first = transfer to feeRouter, second = apply_actions).
  // Mirror that structure: the pool's apply_actions reads the fee transfer.
  const compiled = CallData.compile({
    orderCalls: [
      { contractAddress: call.contractAddress, entrypoint: call.entrypoint, calldata: hexCalldata },
    ],
  }).map((v) => {
    // CallData.compile emits decimal strings; the RPC JSON schema demands hex.
    const n = BigInt(typeof v === "bigint" ? v : String(v));
    return "0x" + n.toString(16);
  });
  const flags = chargeFee ? ["SKIP_VALIDATE"] : ["SKIP_VALIDATE", "SKIP_FEE_CHARGE"];

  let lastError = null;
  for (const url of rpcUrls ?? []) {
    try {
      const block = (await rpcFetch(url, "starknet_blockNumber", []))?.result;
      if (typeof block !== "number") throw new Error("blockNumber unavailable");
      // Real nonce — the node rejects simulated invokes with a stale nonce
      // exactly like real ones ("Invalid transaction nonce ... got: 0x0").
      // Response gives a hex string ("0x4").
      const nonceResp = await rpcFetch(url, "starknet_getNonce", {
        contract_address: senderAddress,
        block_id: "latest",
      });
      const nonce = nonceResp?.result;
      if (typeof nonce !== "string" || !nonce.startsWith("0x")) throw new Error("nonce unavailable");
      const tx = {
        type: "INVOKE",
        version: "0x100000000000000000000000000000003",
        sender_address: senderAddress,
        calldata: ["0x1", ...compiled],
        signature: [],
        nonce,
        resource_bounds: {
          l2_gas: { max_amount: "0x20000000", max_price_per_unit: "0x1" },
          l1_gas: { max_amount: "0x0", max_price_per_unit: "0x1" },
          l1_data_gas: { max_amount: "0x200", max_price_per_unit: "0x1" },
        },
        tip: "0x0",
        paymaster_data: [],
        account_deployment_data: [],
        nonce_data_availability_mode: "L1",
        fee_data_availability_mode: "L1",
      };
      // Positional params (proven live): [blockIdentifier, [tx], flags].
      // Named form demands a `block_id` key — cartridge rejects block_number.
      const j = await rpcFetch(url, "starknet_simulateTransactions", [
        { block_number: block },
        [tx],
        flags,
      ]);
      if (j.error) {
        // The node's execution errors carry the REAL revert text under
        // data.execution_error — surface it verbatim, not just the message.
        const exec = j.error?.data?.execution_error;
        lastError = new Error(
          exec ? String(exec) : `RPC: ${j.error.message}${j.error.data?.reason ? ` — ${j.error.data.reason}` : ""}`,
        );
        continue;
      }
      const t = Array.isArray(j.result) ? j.result[0] : j.result;
      const trace = t?.transaction_trace ?? {};
      const revertRaw =
        trace.revert_reason
        ?? trace.execute_invocation_state
        ?? t?.revert_error
        ?? null;
      const reverted =
        String(trace.execute_invocation_state ?? "").toUpperCase().includes("REVERT")
        || Boolean(trace.revert_reason);
      return {
        ok: !reverted,
        reason: reverted
          ? String(revertRaw ?? "reverted in simulation")
          : "simulation passed" + (chargeFee ? " with the real fee charged" : ""),
      };
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError ?? new Error("no reachable RPC for raw simulate");
}
