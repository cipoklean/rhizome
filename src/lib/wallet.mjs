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

import { WalletAccountV6, constants, walletV6 } from "starknet";

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
    return { supported, versions: list, minimumVersion: MIN_STRK20_WALLET_API };
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
 * `shape` stays configurable despite the documentation, because the pool's own
 * balance accounting requires the input tokens to reach the helper somehow, and
 * the documented example does not show that leg. Which shape the pool accepts is
 * settled by dry-running against a real wallet, not by reading either source
 * harder.
 */
export function buildTrancheActions({
  anonymizer,
  inToken,
  outToken,
  amount,
  recipient,
  operation = OPERATION.Deposit,
  shape = "implicit",
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

  if (shape === "explicit-withdraw") {
    // Phase order matters and may never go backwards:
    // create note (5) -> withdraw (6) -> invoke (7).
    return assertValidStrk20Actions([
      openNote,
      {
        type: "withdraw",
        token: inAddress,
        amount: toHex(amount, "withdraw amount"),
        recipient: anonymizerAddress,
      },
      invoke,
    ]);
  }
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

export async function execute(account, actions) {
  return account.strk20InvokeTransaction(assertValidStrk20Actions(actions));
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
