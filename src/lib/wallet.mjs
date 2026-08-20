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
export async function checkStrk20Support(wallet) {
  try {
    const versions = await walletV6.supportedWalletApi(wallet);
    const list = Array.isArray(versions) ? versions : [versions];
    const supported = list.some((v) => {
      const [major, minor] = String(v).split(".").map(Number);
      return major === 0 ? minor >= 10 : major > 0;
    });
    return { supported, versions: list };
  } catch (e) {
    return { supported: false, versions: [], error: e.message };
  }
}

export async function connectWallet(wallet, nodeUrl) {
  return WalletAccountV6.connect({ nodeUrl }, wallet);
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
 * network picker. Verify after the request — a truthy response is not evidence
 * that the wallet actually moved, and submitting across a mismatch is worse than
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
  return account.strk20Balances(tokens);
}

const toHex = (v) => (typeof v === "bigint" ? "0x" + v.toString(16) : v);

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
  const openNote = { type: "transfer", token: outToken, amount: "OPEN", recipient };
  const invoke = {
    type: "invoke",
    contract: anonymizer,
    calldata: [
      operation,
      inToken,
      outToken,
      ...u256Felts(amount),
      "${openNoteIds[0]}",
    ],
  };

  if (shape === "explicit-withdraw") {
    // Phase order matters and may never go backwards:
    // create note (5) -> withdraw (6) -> invoke (7).
    return [openNote, { type: "withdraw", token: inToken, amount: toHex(amount), recipient: anonymizer }, invoke];
  }
  return [openNote, invoke];
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
  return [{ type: "deposit", token, amount: toHex(amount) }];
}

/**
 * Build and prove without submitting. The cheapest way to find a calldata-shape
 * mistake, and free — no fee, no transaction.
 */
export async function dryRun(account, actions) {
  return account.strk20PrepareInvoke(actions, true);
}

export async function execute(account, actions) {
  return account.strk20InvokeTransaction(actions);
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
