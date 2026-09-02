import { useCallback, useEffect, useMemo, useState } from "react";
import {
  acceptedReceiptBlock,
  buildFeeReservePlan,
  executionProgressKey,
  noteMaturityGate,
  readExecutionProgress,
  reconcileInFlightLegs,
  visibleRequirement,
  writeExecutionProgress,
} from "./lib/execution.mjs";
import { connect } from "./lib/pool.mjs";
import { NOTE_MATURITY_BLOCKS, formatDelay } from "./lib/timing.mjs";
import { formatUnits, parseUnits } from "./lib/units.mjs";
import {
  OPERATION,
  buildPrepareInvokeRequest,
  buildShieldActions,
  buildTrancheActions,
  checkStrk20Support,
  confirm,
  connectWallet,
  dryRun,
  ensureWalletChain,
  execute,
  executeSelfPay,
  listWallets,
  pickLandedPoolTx,
  rawSimulateInvoke,
  recentPoolTxs,
  shieldedBalances,
  visibleBalance,
} from "./lib/wallet.mjs";

/** Map a raw contract/pool revert string to plain English for the user. */
function humanizeRevert(raw) {
  const s = String(raw || "").toLowerCase();
  // PaymasterV2 wraps the real revert in a generic TRANSACTION_EXECUTION_ERROR
  // (error 156). The note-spend maturity failure lands inside it, so surface
  // the maturity explanation rather than the opaque paymaster text.
  if (/paymaster.*156|transaction_execution_error/i.test(s)) {
    return "The vault move was rejected by the pool. If your note was hidden fewer than 10 blocks ago, wait for it to mature, then press Check and retry. If the wait already passed, run the free vault test again before entering.";
  }
  if (/reserve|insufficient|balance|short|fee|collect_fee|enough strk|not enough/i.test(s)) {
    return "Hidden reserve too low to pay the pool fee — add more hidden STRK (Step 2 shows the exact amount), then retry.";
  }
  if (/maturity|not spendable|too early|note not ready|10 block/i.test(s)) {
    return "The hidden funds are not spendable yet (maturity). Wait a few blocks, then retry.";
  }
  if (/note|open note|unknown note|invalid note/i.test(s)) {
    return "The private note could not be found or was already spent. Use Check, or re-run the free test.";
  }
  if (/argent|braavos|validate|signature/i.test(s)) {
    return "The wallet rejected the transaction signature. Try again, or reconnect the wallet.";
  }
  // Fall back to the raw reason so nothing is hidden.
  return String(raw || "transaction reverted");
}

/** True when the wallet error means the user declined (not a chain failure). */
function isUserRejection(e) {
  const code = e?.code ?? e?.cause?.code ?? e?.originalError?.code;
  if (code === 4001) return true;
  const msg = (e?.message ?? e?.cause?.message ?? e?.originalError?.message ?? "").toLowerCase();
  return /reject|denied|user cancelled|cancelled by user|user abort/i.test(msg);
}

// 4B/4H diagnostics, hoisted to module scope so EVERY catch (invest, dry-run,
// deep-simulate) can use them — a helper defined in one catch was unreachable
// from the others (ReferenceError masked the real wallet error).
function serializeWalletError(err, depth = 0, seen = new Set()) {
  if (!err || typeof err !== "object" || seen.has(err) || depth > 6) return "[depth limit]";
  seen.add(err);
  return {
    name: err.constructor?.name,
    message: err.message,
    code: err.code,
    data: err.data,
    ownPropertyNames: Object.getOwnPropertyNames(err),
    cause: err.cause ? serializeWalletError(err.cause, depth + 1, seen) : undefined,
    originalError: err.originalError ? serializeWalletError(err.originalError, depth + 1, seen) : undefined,
    error: err.error ? serializeWalletError(err.error, depth + 1, seen) : undefined,
  };
}

function extractDetailedErrors(node, depth = 0, seen = new Set(), out = []) {
  if (!node || typeof node !== "object" || seen.has(node) || depth > 6) return out;
  seen.add(node);
  for (const key of ["errorMessages", "error_messages", "errors"]) {
    const v = node[key];
    if (Array.isArray(v)) {
      for (const item of v) {
        const s = typeof item === "string" ? item : item?.message ?? item?.reason ?? JSON.stringify(item);
        if (s && typeof s === "string") out.push(s);
      }
    } else if (typeof v === "string" && v.length > 0) {
      out.push(v);
    }
  }
  for (const key of ["cause", "originalError", "error", "context"]) {
    extractDetailedErrors(node[key], depth + 1, seen, out);
  }
  return out;
}

export default function ExecutePanel({
  net,
  network,
  schedule,
  scheduleSource,
  paidSubmissionAllowed,
  paidSubmissionReason,
  analysisError,
  token,
  fee,
  delay,
  secondsPerBlock,
}) {
  const [wallets, setWallets] = useState(null);
  const [selectedWallet, setSelectedWallet] = useState(null);
  const [account, setAccount] = useState(null);
  const [walletObj, setWalletObj] = useState(null);
  const [support, setSupport] = useState(null);
  const [balances, setBalances] = useState(null);
  const [directVaultAmount, setDirectVaultAmount] = useState("1");
  const [directVaultPassed, setDirectVaultPassed] = useState(false);
  const [directVaultAttempt, setDirectVaultAttempt] = useState(null);
  const [busy, setBusy] = useState(null);
  const [log, setLog] = useState([]);
  const [shieldDryRun, setShieldDryRun] = useState(false);
  const [dryRunPassTick, setDryRunPassTick] = useState(0);
  const [gatewayError, setGatewayError] = useState(null);
  const [block, setBlock] = useState(null);
  const [delayMode, setDelayMode] = useState(network === "sepolia" ? "rehearsal" : "measured");
  // User-chosen wait between hide and vault, in blocks. The pool will not spend
  // a note younger than NOTE_MATURITY_BLOCKS, so the shortest offered wait is
  // that floor — anything lower would show "ready" while the contract reverts.
  const [waitBlocks, setWaitBlocks] = useState(NOTE_MATURITY_BLOCKS);
  const WAIT_OPTIONS = [NOTE_MATURITY_BLOCKS, 15, 20, 25, 30];
  const [legs, setLegs] = useState({});
  const [hydratedProgressKey, setHydratedProgressKey] = useState(null);
  // Landing block of the most recent hide seen by this app (any leg). The fee
  // router draws the vault fee from the newest shielded STRK, so this bounds
  // the fee note's age. Null = hidden outside the app / before tracking.
  const [reserveShieldedAt, setReserveShieldedAt] = useState(null);
  // Persistent (not transient) vault failure card — paymaster 156 etc.
  const [vaultMaturityCard, setVaultMaturityCard] = useState(null);
  // Persistent (not transient) vault failure card — paymaster 156 etc.
  const [vaultErrorCard, setVaultErrorCard] = useState(null);
  // 4L: self-pay toggle — broadcast the vault move WITHOUT the wallet's
  // paymaster, paying gas from the visible balance. Default: paymaster.
  const [selfPay, setSelfPay] = useState(false);
  const [deepSimResult, setDeepSimResult] = useState(null);
  const [deepSimBusy, setDeepSimBusy] = useState(false);
  // Recovery lane for submissions whose hash never reached us (wallet answered
  // too slowly): the user pastes the explorer/wallet hash, we link the leg.
  const [hashPrompt, setHashPrompt] = useState(null);
  const [hashInput, setHashInput] = useState("");

  const anonymizer = net.anonymizer;
  const vToken = net.vesu?.vTokens?.STRK ?? null;
  // net.tokens is absent on sepolia (only mainnet carries the STRK contract);
  // fall back to the token prop App already resolves for the current network.
  const strkToken = net.tokens?.STRK ?? token;
  const measuredDelayBlocks = Math.max(NOTE_MATURITY_BLOCKS, delay?.window ?? NOTE_MATURITY_BLOCKS);
  const isRehearsal = network === "sepolia" && delayMode === "rehearsal";
  // The wait the user actually gets: their chosen blocks, floored at the pool's
  // spendability maturity (younger notes revert) and capped at 30. The timing
  // model's suggestion is a hint only — it must never force an unusable wait.
  const delayBlocks = isRehearsal
    ? NOTE_MATURITY_BLOCKS
    : Math.min(30, Math.max(NOTE_MATURITY_BLOCKS, waitBlocks));
  // 4J-REV: visible STRK alongside shielded, read through the 4G proxy.
  // Fails open — unknown balance renders "· Visible: ?" and never blocks.
  const visibleReqWei = visibleRequirement(net.observed?.feeAmountWei);
  const [visibleStrk, setVisibleStrk] = useState(null);
  useEffect(() => {
    let cancelled = false;
    if (!account) {
      setVisibleStrk(null);
      return;
    }
    (async () => {
      try {
        const v = await visibleBalance({ rpcUrls: net.rpc, owner: account.address, token: strkToken });
        if (!cancelled) setVisibleStrk(v);
      } catch {
        if (!cancelled) setVisibleStrk(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account, net.rpc, strkToken]);
  const shieldedStrkBalance = useMemo(() => {
    if (!Array.isArray(balances)) return null;
    try {
      const target = BigInt(token);
      const entry = balances.find((b) => {
        try {
          return BigInt(b?.token ?? b?.[0]) === target;
        } catch {
          return false;
        }
      });
      return entry ? BigInt(entry.balance ?? entry[1] ?? 0) : 0n;
    } catch {
      return null;
    }
  }, [balances, token]);

  const feePlan = useMemo(() => {
    if (!schedule?.length || fee == null) return null;
    return buildFeeReservePlan({ schedule, feeAmount: fee, shieldedStrkBalance });
  }, [schedule, fee, shieldedStrkBalance]);

  const paidGateOpen = Boolean(paidSubmissionAllowed && feePlan?.paidSubmissionAllowed);
  const progressKey = useMemo(
    () =>
      executionProgressKey({
        chainId: net.chainId,
        account: account?.address,
        anonymizer,
        schedule,
      }),
    [net.chainId, account?.address, anonymizer, schedule],
  );

  const say = (line, kind = "info") =>
    setLog((l) => [{ line, kind, at: new Date().toLocaleTimeString() }, ...l].slice(0, 14));

  useEffect(() => {
    if (!progressKey) {
      setHydratedProgressKey(null);
      return;
    }
    const saved = readExecutionProgress(window.localStorage, progressKey, schedule.length);
    // 4I Task 2: an in-flight "entering vault" from a previous session with
    // no broadcast (no hash) can only be a wallet/paymaster pre-flight
    // refusal. Reconcile it to ready so the row never renders a dead
    // "entering vault…" after refresh; a stored hash stays in-flight and
    // keeps its Check.
    const { progress, resetLegs } = reconcileInFlightLegs(saved, schedule.length);
    setLegs(progress);
    if (resetLegs.length > 0) {
      say(
        `A previous vault attempt never broadcast — state reset for ${resetLegs.map((i) => `piece ${i + 1}`).join(", ")}. You can retry.`,
        "info",
      );
    }
    setHydratedProgressKey(progressKey);
  }, [progressKey, schedule.length]);

  // A passed dry run is only valid for the exact plan it was tested against.
  // When the amount (and therefore the schedule) changes, drop the stale pass
  // so the user must re-test before Hide unlocks. Key on content, not just
  // length, so a different amount with the same tranche count still resets.
  const scheduleKey = (schedule ?? []).map((s) => s.amount?.toString() ?? String(s)).join(",");
  useEffect(() => {
    setShieldDryRun(false);
    setDryRunPassTick(0);
  }, [scheduleKey]);

  useEffect(() => {
    if (!progressKey || hydratedProgressKey !== progressKey) return;
    writeExecutionProgress(window.localStorage, progressKey, legs, schedule.length);
  }, [progressKey, hydratedProgressKey, legs, schedule.length]);

  useEffect(() => {
    let cancelled = false;
    let provider;
    const tick = async () => {
      try {
        provider = provider ?? (await connect(net.rpc));
        const b = await provider.getBlockNumber();
        if (!cancelled) setBlock(b);
      } catch {}
    };
    tick();
    const id = setInterval(tick, 12000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [net.rpc]);

  // Restore the newest known hide block for this account+network. Hides made
  // before this tracking existed (or outside the app) leave it null — the
  // maturity UI then warns instead of guessing.
  useEffect(() => {
    if (!account?.address) {
      setReserveShieldedAt(null);
      return;
    }
    try {
      const raw = window.localStorage.getItem(
        `rhizome:lasthide:v1:${net.chainId}:${account.address}`,
      );
      const n = raw === null ? null : Number(raw);
      setReserveShieldedAt(Number.isSafeInteger(n) && n >= 0 ? n : null);
    } catch {
      setReserveShieldedAt(null);
    }
  }, [account?.address, net.chainId]);

  async function discover() {
    setBusy("discover");
    try {
      const list = await listWallets();
      setWallets(list);
      if (list.length === 0) say("No Starknet wallet found. Install Ready.", "err");
      else say(`${list.length} wallet(s) found.`);
    } catch (e) {
      say(`Could not find wallets: ${e.message}`, "err");
    } finally {
      setBusy(null);
    }
  }

  async function pick(wallet) {
    setBusy("connect");
    setShieldDryRun(false);
    setGatewayError(null);
    setSelectedWallet(null);
    setAccount(null);
    setBalances(null);
    let phase = "capability check";
    try {
      const cap = await checkStrk20Support(wallet);
      setSupport(cap);
      if (!cap.supported) {
        say(`${wallet.name} needs Wallet API ${cap.minimumVersion} or newer; it reports ${cap.versions.join(", ") || "unknown"}.`, "err");
        return;
      }
      phase = "authorization";
      say(`Opening ${wallet.name}, approve Rhizome…`);
      let acc = await connectWallet(wallet, net.rpc[0]);
      say(`${wallet.name} approved.`, "ok");
      phase = "network switch";
      say(`Checking network…`);
      const chain = await ensureWalletChain(wallet, net.chainId);
      if (chain.switched) {
        say(`Switched ${wallet.name} to ${net.chainId}.`, "ok");
        phase = "account refresh";
        acc = await connectWallet(wallet, net.rpc[0], { silent: true });
      } else {
        say(`${wallet.name} is already on ${net.chainId}.`);
      }
      setSelectedWallet(wallet);
      setAccount(acc);
      setWalletObj(wallet);
      setGatewayError(null);
      say(`Connected · ${acc.address.slice(0, 10)}… · ${net.chainId}`, "ok");
      phase = "balance consent";
      const tokens = [token, vToken].filter(Boolean);
      try {
        await ensureWalletChain(wallet, net.chainId);
        const b = await shieldedBalances(acc, tokens);
        setBalances(b);
        say("Wallet shared your hidden balances.");
      } catch (e) {
        say(`Wallet did not share hidden balances: ${e.message}. You can still test for free; real moves stay locked.`, "info");
      }
    } catch (e) {
      const labels = {
        "capability check": "Wallet check failed",
        authorization: "Wallet approval failed",
        "network switch": `Switch to ${net.chainId} failed`,
        "account refresh": "Wallet refresh failed after switching",
      };
      // Plain-English mapping so the persistent error area is human-readable.
      const code = e?.code ?? e?.cause?.code;
      let gatewayMessage;
      if (code === 4001 || /reject|denied|user cancelled/i.test(e.message || "")) {
        gatewayMessage = "You rejected the request in your wallet.";
      } else if (phase === "network switch") {
        gatewayMessage = `Your wallet doesn't recognize this Starknet chain (${net.chainId}). Add it manually or use a Starknet-native wallet.`;
      } else if (/rpc|network|connect|timeout|fetch failed|ENOTFOUND/i.test(e.message || "")) {
        gatewayMessage = "Wallet can't reach the RPC. Try again, or switch network.";
      } else {
        gatewayMessage = `${labels[phase] ?? "Could not connect"}: ${e.message}`;
      }
      setGatewayError(gatewayMessage);
      say(`${labels[phase] ?? "Could not connect"}: ${e.message}`, "err");
    } finally {
      setBusy(null);
    }
  }

  const shieldActionsFor = (leg) => buildShieldActions({ token, amount: leg.amount });
  const investActionsFor = (leg) =>
    buildTrancheActions({
      anonymizer,
      inToken: token,
      outToken: vToken,
      amount: leg.amount,
      recipient: account?.address ?? "0x0",
      operation: OPERATION.Deposit,
    });
  const patch = (i, fields) => setLegs((l) => ({ ...l, [i]: { ...(l[i] ?? {}), ...fields } }));

  async function requireSelectedChain() {
    if (!selectedWallet) throw new Error("wallet is not connected");
    return ensureWalletChain(selectedWallet, net.chainId);
  }

  // Re-read the wallet's shielded balances. The fee-reserve gate depends on
  // this number; without a refresh after a hide/deposit the gate would keep
  // reporting a stale shortfall and loop forever. On failure we drop to null
  // (shows "balance not shared") rather than keeping a stale value that makes
  // the gate report a wrong shortfall when the RPC is down.
  const refreshBalances = useCallback(async () => {
    if (!account || !walletObj) return;
    const tokens = [token, vToken].filter(Boolean);
    setBusy("balances");
    try {
      const b = await shieldedBalances(account, tokens);
      setBalances(b);
      say("Wallet shared your hidden balances.", "ok");
    } catch (e) {
      setBalances(null);
      say(
        isUserRejection(e)
          ? "Balance share was rejected in the wallet — the fee-reserve check needs it. Press 'share balances' again and approve."
          : `Wallet did not share hidden balances: ${e.message}. Press 'share balances' to retry.`,
        "err",
      );
    } finally {
      setBusy(null);
    }
  }, [account, walletObj, token, vToken]);

  async function dryRunShield() {
    if (!account || !schedule?.length) return;
    setBusy("dryrun-shield");
    try {
      await requireSelectedChain();
      await dryRun(account, shieldActionsFor(schedule[0]));
      setShieldDryRun(true);
      setDryRunPassTick((t) => t + 1);
      say("Free test passed: your wallet can hide this amount. Real move unlocked.", "ok");
    } catch (e) {
      setShieldDryRun(false);
      // 4H extraction on the dry-run path too: the wallet hides the real
      // reason (errorMessages/context) behind UNKNOWN_ERROR 163.
      const details = extractDetailedErrors(e);
      if (typeof console !== "undefined") {
        if (details.length > 0) console.log("Hide test paymaster errors:", details);
        console.log("hide-test error shape:", serializeWalletError(e));
      }
      say(
        details.length > 0
          ? `Free test failed: ${details[0]}`
          : `Free test failed: ${humanizeRevert(e?.message ?? String(e))}`,
        "err",
      );
    } finally {
      setBusy(null);
    }
  }

  async function dryRunExistingVault() {
    if (!account || !deployed) return;
    setBusy("dryrun-existing-vault");
    setDirectVaultPassed(false);
    try {
      const amount = parseUnits(directVaultAmount, 18);
      if (amount <= 0n) throw new Error("enter an amount above zero");
      const actions = investActionsFor({ amount });
      setDirectVaultAttempt({ request: buildPrepareInvokeRequest(actions) });
      await requireSelectedChain();
      await dryRun(account, actions);
      setDirectVaultPassed(true);
      say(`Free vault test passed for ${strk(amount)} STRK: no fee, no transaction sent.`, "ok");
    } catch (e) {
      setDirectVaultPassed(false);
      say(`Vault test failed: ${e.message}`, "err");
    } finally {
      setBusy(null);
    }
  }

  function acceptShieldReceipt(i, receipt) {
    const at = acceptedReceiptBlock(receipt);
    if (at === null) return false;
    patch(i, { stage: "shielded", shieldedAt: at });
    // Every accepted hide mints a note the pool may later draw fees from; the
    // most recent landing block bounds the youngest spendable note.
    setReserveShieldedAt((prev) => {
      const next = prev == null || at > prev ? at : prev;
      try {
        window.localStorage.setItem(
          `rhizome:lasthide:v1:${net.chainId}:${account?.address ?? "unknown"}`,
          String(next),
        );
      } catch {}
      return next;
    });
    say(`Piece ${i + 1} hidden at block ${at}. Enter the vault in ${delayBlocks} blocks (${formatDelay(delayBlocks, secondsPerBlock)}).`, "ok");
    return true;
  }

  // Retry a receipt fetch a few times across every configured RPC endpoint.
  // Private / relayed STRK20 transactions may not be visible to the first
  // reachable provider, so we fan out across all endpoints from the config.
  async function retryReceipt(tx, attempts = 3, gapMs = 2000) {
    let last = null;
    for (const nodeUrl of net.rpc) {
      let provider;
      try {
        provider = await connect([nodeUrl]);
      } catch {
        continue;
      }
      for (let n = 0; n < attempts; n++) {
        try {
          const r = await provider.getTransactionReceipt(tx);
          if (r) return r;
        } catch (e) {
          last = e;
        }
        if (n < attempts - 1) await new Promise((r) => setTimeout(r, gapMs));
      }
    }
    throw last ?? new Error("receipt unavailable across all RPC endpoints");
  }

  // Wallet APIs return amounts as plain decimal strings (e.g. "500000000000000000");
  // buildShieldActions / buildTrancheActions emit canonical hex felts (e.g. "0x56bc7...").
  // Normalise either form to a decimal string so the matcher can compare them.
  function normalizeAmount(a) {
    if (typeof a === "bigint") return a.toString();
    if (typeof a === "number") return BigInt(a).toString();
    if (typeof a === "string") {
      if (/^0x[0-9a-f]+$/i.test(a)) return BigInt(a).toString();
      if (/^-?\d+$/.test(a)) return a;
      const n = BigInt(a);
      return n.toString();
    }
    return String(a ?? "");
  }

  // Compare two action arrays for practical equality, tolerant of extra fields
  // and formatting differences the wallet may add.
  function actionsMatch(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((av, i) => {
      const bv = b[i];
      if (!bv || typeof av !== typeof bv) return false;
      if (av.type !== bv.type) return false;
      if (av.token !== bv.token) return false;
      if (av.type === "deposit" || av.type === "withdraw") {
        return normalizeAmount(av.amount) === normalizeAmount(bv.amount);
      }
      if (av.type === "transfer") {
        return normalizeAmount(av.amount) === normalizeAmount(bv.amount) && av.recipient === bv.recipient;
      }
      if (av.type === "invoke") {
        return (
          av.contract === bv.contract &&
          Array.isArray(av.calldata) &&
          Array.isArray(bv.calldata) &&
          av.calldata.length === bv.calldata.length
        );
      }
      return false;
    });
  }

  // First condition blocking paid moves, phrased for the person clicking.
  // Used by both the click handlers (so a click always explains itself) and
  // nowhere else — buttons stay clickable so dead clicks are impossible.
  const gateBlocker = () => {
    if (!account) return "connect your wallet in Step 1";
    if (!shieldDryRun) return "run the free test in Step 3 first";
    if (!paidSubmissionAllowed) return paidSubmissionReason ?? "paid moves are not available for this plan";
    if (!feePlan) return "the live fee is not known yet";
    if (!feePlan.balanceKnown)
      return "your wallet has not shared hidden balances, so the fee reserve cannot be verified. Reconnect in Step 1 and approve the balance prompt";
    if (feePlan.reserveShortfall > 0n)
      return `the hidden fee reserve is short by ${strk(feePlan.reserveShortfall)} STRK. Hide ${strk(feePlan.bootstrapDeposit)} STRK extra first (Step 2 explains why)`;
    return null;
  };

  function shieldClick(i) {
    const blocker = gateBlocker();
    if (blocker) {
      say(`Hide is locked for piece ${i + 1}: ${blocker}.`, "err");
      return;
    }
    shield(i);
  }

  // Pre-flight: every note the vault tx will spend (position legs + the fee
  // note) must be mature. Known ages block hard; unknown ages warn softly.
  const maturityGate = useMemo(
    () =>
      noteMaturityGate({
        knownBlocks: [
          ...(schedule ?? []).map((_, i) => legs[i]?.shieldedAt ?? null),
          reserveShieldedAt,
        ],
        currentBlock: block,
        maturity: NOTE_MATURITY_BLOCKS,
      }),
    [schedule, legs, reserveShieldedAt, block],
  );
  const vaultMaturity = () => maturityGate;

  function investClick(i) {
    const blocker = gateBlocker();
    if (blocker) {
      say(`Vault move is locked for piece ${i + 1}: ${blocker}.`, "err");
      return;
    }
    if (!legs[i]?.investDryRun) {
      say(`Piece ${i + 1}: run "test vault" before entering.`, "err");
      return;
    }
    const gate = vaultMaturity();
    if (gate.blocked) {
      // DO NOT submit: the pool would revert while drawing the privacy fee.
      setVaultMaturityCard({
        piece: i + 1,
        blocksRemaining: gate.blocksRemaining,
      });
      say(
        `Piece ${i + 1}: a shielded note is too young to spend — waiting ${gate.blocksRemaining} blocks.`,
        "err",
      );
      return;
    }
    setVaultMaturityCard(null);
    invest(i);
  }

  // 4K BUG B: a wallet-reported failure is not final. The two "failed" 15-STRK
  // hides both SUCCEEDED on-chain — the wallet errored after submission and
  // the UI declared failure, so the user re-sent and duplicated notes.
  // Reconciliation: after a wallet error, scan the chain for the account's
  // recent pool transactions; a SUCCEEDED tx that appeared after the submit
  // timestamp is the truth — accept it, update state, and say so.
  const reconcileAfterWalletError = useCallback(
    async (i, kind) => {
      if (!account) return false;
      const submittedAt = Date.now();
      // Give the node a moment to index the tx if it genuinely landed just now.
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const txs = await recentPoolTxs({
          rpcUrls: net.rpc,
          owner: account.address,
          pool: net.strk20Pool,
          sinceBlock: 120, // ~10 min of mainnet blocks around the attempt
        });
        const t = pickLandedPoolTx(txs, block ?? undefined, 120);
        if (!t) return false;
        const at = acceptedReceiptBlock(t.receipt);
        if (kind === "hide") {
          if (at !== null) {
            patch(i, { stage: "shielded", shieldedAt: at, shieldTx: t.hash });
            say(
              `Piece ${i + 1}: your wallet reported an error, but the hide SUCCEEDED on-chain (block ${at}). State updated — do NOT hide again.`,
              "ok",
            );
          }
        } else {
          if (at !== null) {
            patch(i, { stage: "invested", investTx: t.hash, investedAt: at });
            say(
              `Piece ${i + 1}: your wallet reported an error, but the vault move SUCCEEDED on-chain (block ${at}). State updated.`,
              "ok",
            );
          }
        }
        await refreshBalances();
        return at !== null;
      } catch {
        // Chain scan failed (RPC down) — fail open: do not claim success, but
        // also do NOT double-down on failure; the failure card is shown.
        return false;
      }
    },
    [account, net, block, say, patch, refreshBalances],
  );

  async function shield(i) {
    if (!account || !shieldDryRun || !paidGateOpen) return;
    setBusy(`shield-${i}`);
    patch(i, { stage: "shielding" });
    try {
      await requireSelectedChain();
      say(`Piece ${i + 1}: hiding ${strk(schedule[i].amount)} STRK, approve in wallet (2 prompts).`);
      const { transaction_hash } = await execute(account, shieldActionsFor(schedule[i]));
      // The wallet accepted the submission — from here on this leg is checkable,
      // never "failed", no matter what happens while waiting for the receipt.
      patch(i, { stage: "shield-pending", shieldTx: transaction_hash });
      say(`Piece ${i + 1} hide sent: ${transaction_hash}`, "ok");
      const provider = await connect(net.rpc);
      const result = await confirm(provider, transaction_hash);
      if (!result.confirmed || !acceptShieldReceipt(i, result.receipt)) {
        say(`Piece ${i + 1} sent but not yet on-chain. Clock hasn't started; use Check.`, "info");
      }
      // Re-read shielded balance so the fee-reserve gate reflects the new
      // hidden balance instead of the stale pre-hide value.
      await refreshBalances();
    } catch (e) {
      if (e?.code === "EXECUTE_TIMEOUT") {
        // Submission state unknown. Leave any prior hash intact and keep the
        // button as Check — resubmitting blind could double-spend the leg.
        patch(i, { stage: "shield-pending" });
        say(
          `Piece ${i + 1}: wallet did not answer in time. If you approved, wait for it to land, then press Check. Do NOT approve a second hide for this piece.`,
          "err",
        );
      } else if (isUserRejection(e)) {
        // The user declined in the wallet. Reset to the interactive state so the
        // button returns to "hide" and never stays stuck on "sending...".
        patch(i, { stage: null, shieldTx: null });
        setGatewayError("You rejected the request in your wallet.");
        say(`Piece ${i + 1}: you rejected the request in your wallet.`, "err");
      } else {
        // 4K BUG B: the wallet SAYS failure, but the chain may have accepted
        // the submission anyway (this exact case duplicated the user's notes).
        // Reconcile before declaring failure.
        const reconciled = await reconcileAfterWalletError(i, "hide");
        if (reconciled) {
          setGatewayError(null);
        } else {
          patch(i, { stage: "failed" });
          let reason = e?.message ?? String(e);
        try {
          if (e?.data) {
            if (typeof e.data === "string") reason = e.data;
            else if (e.data.error) reason = e.data.error;
            else if (e.data.contract_address) {
              const sel = e.data?.selector
                ? `selector ${e.data.selector.slice(0, 14)}…`
                : "unknown entry point";
              reason = `contract ${e.data?.contract_address?.slice(0, 10) ?? "?"}… reverted at ${sel}: ${e.data?.error ?? "no reason given"}`;
            }
          }
          // Paymaster rejections nest the real error under .cause / .originalError
          // (starknet.js PaymasterError / wallet wrappers). Walk the chain to find
          // the deepest message — e.g. "Paymaster error 156: TRANSACTION_EXECUTION_ERROR".
          let probe = e;
          for (let i = 0; i < 6 && probe; i++) {
            if (probe.cause && typeof probe.cause === "object" && probe.cause !== e) {
              const m = probe.cause.message;
              if (typeof m === "string" && m.length > 0) reason = m;
              if (probe.cause.data && typeof probe.cause.data === "string") {
                if (reason === e?.message) reason = probe.cause.data;
              }
              probe = probe.cause;
            } else if (probe.originalError && typeof probe.originalError === "object" && probe.originalError !== e) {
              const m = probe.originalError.message;
              if (typeof m === "string" && m.length > 0) reason = m;
              probe = probe.originalError;
            } else if (probe.error && typeof probe.error === "object" && probe.error !== e) {
              const m = probe.error.message;
              if (typeof m === "string" && m.length > 0) reason = m;
              probe = probe.error;
            } else {
              probe = null;
            }
          }
          if (reason === e?.message && typeof e?.code === "number") {
            reason = `${e.constructor?.name || "Error"} code ${e.code}: ${reason}`;
          }
          // Debug dump so the next failure reveals the full error shape.
          if (typeof console !== "undefined") {
            console.error("vault-fail error shape:", {
              name: e?.constructor?.name,
              message: e?.message,
              code: e?.code,
              data: e?.data,
              causePresent: typeof e?.cause === "object" && e?.cause !== null,
            });
          }
        } catch {}
          say(`Piece ${i + 1} hide failed: ${humanizeRevert(reason)}`, "err");
        }
      }
    } finally {
      setBusy(null);
    }
  }

  async function checkShield(i) {
    const tx = legs[i]?.shieldTx;
    setBusy(`check-shield-${i}`);
    try {
      if (tx) {
        const receipt = await retryReceipt(tx);
        if (!acceptShieldReceipt(i, receipt)) say(`Piece ${i + 1} still pending, no block yet.`, "info");
      } else {
        // No hash on record (e.g. a timed-out submission). Recover by asking
        // the wallet for its recent invokes and matching this schedule's
        // actions loosely (action count + token + amount), then try to link
        // the resulting hash. Fall back to asking the user for the explorer hash.
        let found = null;
        try {
          const h = walletObj && walletObj.strk20QueryTransactions
            ? await walletObj.strk20QueryTransactions({
                since: Date.now() - 24 * 60 * 60 * 1000,
              })
            : null;
          const want = shieldActionsFor(schedule[i]);
          found = (h ?? []).find((t) => {
            const actions = Array.isArray(t.actions) ? t.actions : [];
            if (actions.length !== want.length) return false;
            return actions.every((a, idx) => {
              const w = want[idx];
              if (!a || typeof a !== typeof w) return false;
              if (a.type !== w.type) return false;
              if (a.token !== w.token) return false;
              if (w.type === "deposit" || w.type === "withdraw") {
                return normalizeAmount(a.amount) === normalizeAmount(w.amount);
              }
              if (w.type === "transfer") {
                return normalizeAmount(a.amount) === normalizeAmount(w.amount) && a.recipient === w.recipient;
              }
              if (w.type === "invoke") {
                return (
                  a.contract === w.contract &&
                  Array.isArray(a.calldata) &&
                  Array.isArray(w.calldata) &&
                  a.calldata.length === w.calldata.length
                );
              }
              return false;
            });
          })?.transaction_hash ?? null;
        } catch {}
        if (found) {
          patch(i, { shieldTx: found });
          const receipt = await retryReceipt(found);
          if (!acceptShieldReceipt(i, receipt)) say(`Piece ${i + 1} still pending, no block yet.`, "info");
        } else {
          say(
            `Could not auto-recover piece ${i + 1}'s hash from your wallet. If the wallet confirmed it, paste the hash into the box below to link it; otherwise resubmit from the Hide button.`,
            "info",
          );
          setHashPrompt({ kind: "shield", index: i });
        }
      }
    } catch (e) {
      if (/revert/i.test(e.message)) {
        patch(i, { stage: "failed" });
        say(`Piece ${i + 1} reverted: ${e.message}`, "err");
      } else say(`Receipt not visible yet: ${e.message}`, "info");
    } finally {
      setBusy(null);
    }
  }

  async function dryRunInvest(i) {
    if (!account) return;
    setBusy(`dryrun-invest-${i}`);
    try {
      await requireSelectedChain();
      await dryRun(account, investActionsFor(schedule[i]));
      patch(i, { investDryRun: true });
      say(`Piece ${i + 1} vault test passed.`, "ok");
    } catch (e) {
      patch(i, { investDryRun: false });
      // 4H extraction on the dry-run path too: the wallet hides the real
      // reason (errorMessages/context) behind UNKNOWN_ERROR 163.
      const details = extractDetailedErrors(e);
      if (typeof console !== "undefined") {
        if (details.length > 0) console.log("Vault test paymaster errors:", details);
        console.log("vault-test error shape:", serializeWalletError(e));
      }
      say(
        details.length > 0
          ? `Piece ${i + 1} vault test failed: ${details[0]}`
          : `Piece ${i + 1} vault test failed: ${humanizeRevert(e?.message ?? String(e))}`,
        "err",
      );
    } finally {
      setBusy(null);
    }
  }

  function acceptInvestReceipt(i, receipt) {
    const at = acceptedReceiptBlock(receipt);
    if (at === null) return false;
    patch(i, { stage: "invested", investedAt: at });
    say(`Piece ${i + 1} is in the vault at block ${at}.`, "ok");
    setVaultErrorCard(null);
    setDeepSimResult(null);
    return true;
  }

  // Link a pasted explorer/wallet hash to a leg whose submission answer never
  // reached us, so its receipt can be fetched like any other.
  function linkHash(event) {
    event?.preventDefault?.();
    const target = hashPrompt;
    const value = hashInput.trim();
    if (!target || !/^0x[0-9a-fA-F]{60,70}$/.test(value)) {
      say("That does not look like a transaction hash (expected 0x…).", "err");
      return;
    }
    const field = target.kind === "shield" ? "shieldTx" : "investTx";
    patch(target.index, { [field]: value });
    if (target.kind === "shield" && !legs[target.index]?.shieldedAt) {
      patch(target.index, { stage: "shield-pending" });
    }
    setHashPrompt(null);
    setHashInput("");
    say(`Piece ${target.index + 1} linked to ${value}; press Check.`, "ok");
  }

  async function invest(i) {
    if (!account || !legs[i]?.investDryRun || !paidGateOpen) return;
    const leg = legs[i];
    // The contract rejects spends of newly-shielded funds for ~10 blocks.
    // Surface that as a clear message instead of letting the wallet surface
    // a generic UNKNOWN_ERROR.
    if (leg.shieldedAt != null && block != null) {
      const maturityBlock = BigInt(leg.shieldedAt) + BigInt(NOTE_MATURITY_BLOCKS);
      if (BigInt(block) < maturityBlock) {
        say(
          `Piece ${i + 1}: shielded funds are not spendable yet. Wait until block ${maturityBlock.toLocaleString()} (about ${formatDelay(Number(maturityBlock - BigInt(block)), secondsPerBlock)} from now).`,
          "err",
        );
        return;
      }
    }
    setBusy(`invest-${i}`);
    // Pre-flight: the fee leg (6 STRK visible transfer to the fee router)
    // plus gas (~3 STRK on mainnet, measured from real pool txs) is paid from
    // the VISIBLE balance. Below the true minimum the paymaster refuses
    // pre-flight with the generic 156 and nothing is broadcast — refuse
    // early, plainly, with real numbers instead of padded ones.
    try {
      const visible = await visibleBalance({ rpcUrls: net.rpc, owner: account.address, token: strkToken });
      // Same source as the Step-5 readout (4J-REV): 6 STRK fee leg + ~3.2 gas.
      const MIN_VISIBLE = visibleRequirement(net.observed?.feeAmountWei);
      if (visible != null && visible < MIN_VISIBLE) {
        const have = Number(visible) / 1e18;
        setBusy(null);
        setVaultErrorCard({
          piece: i + 1,
          reason: `Wallet has only ${have.toFixed(2)} visible STRK. A pool transaction needs ~9 visible STRK minimum: the 6 STRK fee leg plus ~3 STRK gas. Shielded funds cannot pay for the move that spends them. Add visible STRK to ${account.address.slice(0, 10)}… and retry.`,
          feePattern: false,
        });
        say(
          `Vault move blocked: only ${have.toFixed(2)} visible STRK — a pool transaction needs ~9 visible STRK (6 fee + ~3 gas).`,
          "err",
        );
        return;
      }
    } catch {
      // Balance read failed (RPC down) — never block the move on it.
    }
    try {
      await requireSelectedChain();
      // 4L: two broadcast paths for the same vault actions.
      // - Paymaster (default): wallet relays via its PaymasterV2.
      // - Self-pay: real proofs + classic wallet_addInvokeTransaction —
      //   the user's visible STRK pays gas, no paymaster pre-flight.
      const { transaction_hash } = selfPay
        ? await executeSelfPay(account, investActionsFor(schedule[i]))
        : await execute(account, investActionsFor(schedule[i]));
      patch(i, { stage: "invest-pending", investTx: transaction_hash });
      say(`Piece ${i + 1} vault move sent: ${transaction_hash}`, "ok");
      const provider = await connect(net.rpc);
      const result = await confirm(provider, transaction_hash);
      if (!result.confirmed || !acceptInvestReceipt(i, result.receipt)) say(`Piece ${i + 1} sent but not yet on-chain.`, "info");
    } catch (e) {
      if (e?.code === "EXECUTE_TIMEOUT") {
        patch(i, { stage: "invest-pending" });
        say(
          `Piece ${i + 1}: wallet did not answer in time. If you approved the vault move, wait for it to land, then press Check. Do NOT approve a second one.`,
          "err",
        );
      } else if (isUserRejection(e)) {
        // The user declined in the wallet. Reset so the button returns to
        // "enter vault" and never stays stuck on "sending...".
        patch(i, { stage: null, investTx: null });
        setGatewayError("You rejected the request in your wallet.");
        say(`Piece ${i + 1}: you rejected the request in your wallet.`, "err");
      } else {
        // 4K BUG B: the wallet says failure; the chain may have accepted it
        // anyway. Reconcile before declaring the vault move failed.
        const reconciled = await reconcileAfterWalletError(i, "vault");
        if (reconciled) {
          setVaultErrorCard(null);
          setDeepSimResult(null);
        } else if (legs[i]?.investTx) {
          // 4L: self-pay broadcasts, so failures now carry a real hash. The
          // receipt's execution_error is the on-chain truth — print it
          // verbatim instead of the wallet's wrapper text.
          try {
            const provider = await connect(net.rpc);
            const receipt = await provider.getTransactionReceipt(legs[i].investTx);
            const execErr = receipt?.execution_status === "REVERTED" ? receipt?.revert_reason ?? "(reverted with no reason string)" : null;
            if (execErr) {
              setVaultErrorCard({
                piece: i + 1,
                reason: execErr,
                feePattern: false,
                txHash: legs[i].investTx,
              });
              say(`Piece ${i + 1} vault move reverted on-chain — reason printed on the card.`, "err");
              return;
            }
          } catch {}
        } else {
          patch(i, { stage: "vault_failed" });
          let reason = e?.message ?? String(e);
        try {
          if (e?.data) {
            if (typeof e.data === "string") reason = e.data;
            else if (e.data.error) reason = e.data.error;
            else if (e.data.contract_address) {
              const sel = e.data?.selector
                ? `selector ${e.data.selector.slice(0, 14)}…`
                : "unknown entry point";
              reason = `contract ${e.data?.contract_address?.slice(0, 10) ?? "?"}… reverted at ${sel}: ${e.data?.error ?? "no reason given"}`;
            }
          }
          // Paymaster rejections nest the real error under .cause / .originalError
          // (starknet.js PaymasterError / wallet wrappers). Walk the chain to find
          // the deepest message — e.g. "Paymaster error 156: TRANSACTION_EXECUTION_ERROR".
          let probe = e;
          for (let i = 0; i < 6 && probe; i++) {
            if (probe.cause && typeof probe.cause === "object" && probe.cause !== e) {
              const m = probe.cause.message;
              if (typeof m === "string" && m.length > 0) reason = m;
              if (probe.cause.data && typeof probe.cause.data === "string") {
                if (reason === e?.message) reason = probe.cause.data;
              }
              probe = probe.cause;
            } else if (probe.originalError && typeof probe.originalError === "object" && probe.originalError !== e) {
              const m = probe.originalError.message;
              if (typeof m === "string" && m.length > 0) reason = m;
              probe = probe.originalError;
            } else if (probe.error && typeof probe.error === "object" && probe.error !== e) {
              const m = probe.error.message;
              if (typeof m === "string" && m.length > 0) reason = m;
              probe = probe.error;
            } else {
              probe = null;
            }
          }
          if (reason === e?.message && typeof e?.code === "number") {
            reason = `${e.constructor?.name || "Error"} code ${e.code}: ${reason}`;
          }
          // Debug dump so the next failure reveals the full error shape.
          // Wallet SDKs (paymaster wrappers especially) hide the reason under
          // .cause or non-enumerable fields; serialize the whole chain.
          if (typeof console !== "undefined") {
            console.error("vault-fail error shape:", serializeWalletError(e));
          }
        } catch {}
        // 4H: the paymaster hides its exact rejection reasons in non-standard
        // array/object fields (errorMessages, context) that the serializer
        // above never reads. Extract them so the user sees WHY the paymaster
        // refused, not just the generic 156/163 wrapper.
        let paymasterErrors = [];
        try {
          paymasterErrors = extractDetailedErrors(e);
        } catch {}
        if (typeof console !== "undefined") {
          if (paymasterErrors.length > 0) {
            console.log("Paymaster detailed errors:", paymasterErrors);
          } else {
            // 4H fallback: no errorMessages anywhere — dump context + cause
            // raw; the paymaster may have nested the reasons there.
            console.log("Paymaster detailed errors: none — full context:", e?.context, "| cause:", e?.cause);
          }
        }
        // 4F: the on-chain receipt of the failed invoke is the remaining
        // truth. Wallets often return the hash even when they report an
        // error — walk the same cause chain and capture any tx hash so the
        // receipt can be pulled and the REAL revert read.
        const TX_HASH_PATTERN = /^0x[0-9a-f]{40,80}$/i;
        const findTxHash = (node, depth = 0, seen = new Set()) => {
          if (!node || depth > 6) return null;
          if (typeof node === "string") return TX_HASH_PATTERN.test(node) ? node : null;
          if (typeof node !== "object" || seen.has(node)) return null;
          seen.add(node);
          for (const key of ["transaction_hash", "transactionHash", "txHash", "tx_hash"]) {
            const v = node[key];
            if (typeof v === "string" && TX_HASH_PATTERN.test(v)) return v;
          }
          // data.transaction_hash / nested wrappers
          for (const key of ["data", "cause", "originalError", "error", "response"]) {
            const found = findTxHash(node[key], depth + 1, seen);
            if (found) return found;
          }
          // last resort: any own property value that is a tx-hash-shaped string
          for (const v of Object.values(node)) {
            if (typeof v === "string" && TX_HASH_PATTERN.test(v)) return v;
          }
          return null;
        };
        const failedTxHash = findTxHash(e);
        if (typeof console !== "undefined") {
          if (failedTxHash) console.log("vault-fail tx hash:", failedTxHash);
          else console.log("vault-fail tx hash: none found in error chain");
        }
        // ANY vault failure shows the persistent card + Deep Simulate. The
        // fee-maturity pattern keeps its specific copy; everything else gets
        // the generic wrapper copy with the code and message inline.
        const feePattern = /paymaster.*156|transaction_execution_error|insufficient_balance/i.test(String(reason));
        setVaultErrorCard({
          piece: i + 1,
          reason: String(reason),
          feePattern,
          txHash: failedTxHash,
          paymasterErrors,
        });
        say(`Piece ${i + 1} vault move failed: ${humanizeRevert(reason)}`, "err");
        }
      }
    } finally {
      setBusy(null);
    }
  }

  // Deep Simulate: raw-RPC simulation of the exact vault call. Bypasses the
  // SDK's account factory entirely — that factory is where the felt(undefined)
  // crashes lived (getEstimateTip is not implemented on cartridge, plus its
  // own invocation-shape handling). The raw path hand-builds the broadcasted
  // INVOKE, so the only failures left are chain-side and carry real text.
  async function deepSimulate(i) {
    if (!account || !schedule?.length) return;
    setDeepSimBusy(true);
    setDeepSimResult(null);
    try {
      // Step 1: the wallet assembles the STRK20 call (free, simulate mode).
      let prepared;
      try {
        prepared = await dryRun(account, investActionsFor(schedule[i]));
      } catch (e) {
        setDeepSimResult({
          ok: false,
          reason: `wallet refused to prepare the simulation: ${String(e?.message ?? e)}`,
        });
        return;
      }
      const call = prepared?.call ?? prepared;
      // Step 1.5 — casing map: the wallet speaks SNIP-36 snake_case
      // (contract_address, entry_point); normalize to a clean camelCase Call.
      const normalizeCall = (c) => {
        if (Array.isArray(c)) return c.map(normalizeCall);
        if (!c || typeof c !== "object") return c;
        return {
          contractAddress: c.contractAddress ?? c.contract_address,
          entrypoint: c.entrypoint ?? c.entry_point,
          calldata: c.calldata,
        };
      };
      const cleanCall = normalizeCall(call);
      if (typeof console !== "undefined") {
        console.log(
          "Deep Simulate payload:",
          JSON.stringify(cleanCall, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2),
        );
      }
      // Step 2: raw-RPC simulate. chargeFee:false skips only the SEQUENCER
      // gas charge; the pool's internal 6-STRK fee flow still runs, so a
      // young fee note still reverts here exactly like live.
      try {
        const r = await rawSimulateInvoke({
          rpcUrls: net.rpc,
          senderAddress: account.address,
          call: cleanCall,
          chargeFee: false,
        });
        // The wallet's simulate-mode call carries EMPTY PROOFS by design
        // (proofs are generated only at real invoke time). If the pool
        // rejects the proofs, that is a limitation of this diagnostic —
        // not the live failure. Say so honestly.
        if (!r.ok && /deserialize param|proof/i.test(r.reason)) {
          setDeepSimResult({
            ok: false,
            reason:
              `Simulation reached the pool but reverted at the proof check: ${r.reason}\n\n` +
              "The free wallet preparation returns EMPTY proofs by design — real proofs are only generated at send time. " +
              "This diagnostic cannot replay the live vault failure end-to-end; it verifies everything up to the proofs.",
          });
          return;
        }
        setDeepSimResult({
          ok: r.ok,
          reason: r.ok
            ? "simulation passed — the call, fee flow and action shape are valid up to the (empty) proofs"
            : r.reason,
        });
      } catch (e) {
        // The raw simulate itself threw (RPC refused, no endpoint reachable).
        // Print the raw error verbatim — honest failure.
        const detail = e?.cause?.message ? `${e.message} (cause: ${e.cause.message})` : String(e?.message ?? e);
        setDeepSimResult({ ok: false, reason: `simulation call failed: ${detail}` });
      }
    } finally {
      setDeepSimBusy(false);
    }
  }

  async function checkInvest(i) {
    const tx = legs[i]?.investTx;
    if (!tx) {
      // 4I Task 3: never a silent no-op. A vault attempt that never
      // broadcast has nothing to check — say so and point at retry.
      say(`Piece ${i + 1}: nothing to check — no vault transaction was broadcast. Press "try again" to retry the move.`, "info");
      return;
    }
    setBusy(`check-invest-${i}`);
    try {
      const receipt = await retryReceipt(tx);
      if (!acceptInvestReceipt(i, receipt)) say(`Piece ${i + 1} vault receipt still pending.`, "info");
    } catch (e) {
      if (/revert/i.test(e.message)) {
        patch(i, { stage: "vault_failed" });
        say(`Piece ${i + 1} vault move reverted: ${e.message}`, "err");
      } else say(`Vault receipt not visible yet: ${e.message}`, "info");
    } finally {
      setBusy(null);
    }
  }

  const strk = (v) => formatUnits(v, 18, { maxFractionDigits: 4 });
  // Starkscan is the standard Starknet explorer and honours ?chain= so the
  // same link resolves on mainnet or Sepolia.
  const explorerChain = net.chainId === "SN_MAIN" ? "mainnet" : net.chainId === "SN_SEPOLIA" ? "sepolia" : "mainnet";
  const explorerTx = (hash) => `https://starkscan.co/tx/${hash}?chain=${explorerChain}`;

  const scheduledAmount = feePlan?.legAmounts.reduce((s, a) => s + a, 0n) ?? 0n;
  const paidGateReason = !paidSubmissionAllowed
    ? paidSubmissionReason ?? "Not available for this plan."
    : !feePlan
      ? "Live fee not known; can't check reserve."
      : !feePlan.balanceKnown
        ? "Connect your wallet and let it share hidden balances to check the fee reserve."
        : feePlan.reserveShortfall > 0n
          ? `You need ${strk(feePlan.reserveShortfall)} more hidden STRK. Add ${strk(feePlan.bootstrapDeposit)} (includes 1 fee).`
          : null;

  const ready = Boolean(account && support?.supported);
  const deployed = Boolean(anonymizer && vToken);

  const blocksLeft = (i) => {
    const leg = legs[i];
    if (!leg?.shieldedAt || block == null) return null;
    const maturityBlock = BigInt(leg.shieldedAt) + BigInt(delayBlocks);
    if (BigInt(block) >= maturityBlock) return 0;
    return maturityBlock - BigInt(block);
  };

  const legStatus = (i) => {
    const leg = legs[i] ?? {};
    if (leg.stage === "invested") return { label: "in vault ✓", done: true };
    if (leg.stage === "invest-pending") return { label: "entering vault…", done: false };
    // A failed vault attempt is never a dead end: nothing was broadcast, so
    // the row offers retry alongside Check. Anything left over from an older
    // session that never broadcast is reconciled to ready at hydration.
    if (leg.stage === "vault_failed") return { label: "vault failed — retryable", done: false, vaultFailed: true };
    // A submitted-but-unconfirmed hide is checkable, never a dead end —
    // with or without a stored hash (wallets can drop the answer entirely).
    if (!leg.shieldedAt && (leg.shieldTx || leg.stage === "shield-pending")) {
      return {
        label: leg.shieldTx ? "hiding… check receipt" : "sent, proof missing: check or link hash",
        done: false,
        pendingShield: true,
      };
    }
    if (leg.stage === "failed") return { label: "failed", done: false, retryable: true };
    if (!leg.shieldedAt) {
      return { label: leg.stage === "shielding" ? "hiding…" : "not hidden yet", done: false };
    }
    const left = blocksLeft(i);
    if (left == null) return { label: "hidden", done: false };
    if (left > 0) return { label: `wait ${left} blocks (${formatDelay(left, secondsPerBlock)})`, done: false, waiting: true };
    return { label: leg.investDryRun ? "ready for vault" : "test vault first", done: false, ready: true };
  };

  // wizard progress
  const step1Done = ready;
  const step2Done = feePlan ? feePlan.reserveVerified : false;
  const step3Done = shieldDryRun;
  const allLegsDone = schedule?.length > 0 && schedule.every((_, i) => legs[i]?.stage === "invested");

  return (
    <section className="band">
      <p className="eyebrow">
        <b>◢</b> EXECUTE · 4 STEPS
      </p>
      <h2>From visible to private.</h2>
      <p className="lede">
        Each piece takes two moves: <b>hide it</b>, wait a little so no one can pair the timing, then{" "}
        <b>enter the vault</b>. Rhizome only describes the moves; your wallet holds the keys and does
        the proving.
        {feePlan && <> This plan is {feePlan.legCount} piece{feePlan.legCount === 1 ? "" : "s"} · fee {strk(feePlan.executionFees)} STRK to hide.</>}
        {delay && !isRehearsal && <> Wait {formatDelay(delayBlocks, secondsPerBlock)} between hide and vault.</>}
      </p>

            {ready && (
              <div className="persistent-error" style={{ marginTop: 12, direction: "ltr" }}>
                {gatewayError != null && (
                  <p className="err-title" style={{ color: "var(--error)" }}>
                    {gatewayError}
                  </p>
                )}
              </div>
            )}

            {!deployed && (
        <p className="err" style={{ marginTop: 18 }}>
          Vault not set up on {network}: hiding still works, entering the vault needs the helper.
        </p>
      )}

      {/* ---- wizard ---- */}
      <div className="wizard">
        {/* STEP 1 */}
      <div className={`wizard-step ${wallets ? (ready ? "done" : "active") : wallets == null ? "active" : ""}`}>
        <div className="badge">{ready ? "✓" : "1"}</div>
        <div>
          <h4>Connect wallet</h4>
          <p>We never see your keys. Your wallet does the hiding.</p>
            <div className="controls" style={{ marginTop: 0 }}>
              <label className="field">
                Wait before vault
                <select value={String(waitBlocks)} onChange={(e) => setWaitBlocks(Number(e.target.value))}>
                  {WAIT_OPTIONS.map((b) => (
                    <option key={b} value={String(b)}>
                      {b} blocks (~{formatDelay(b, secondsPerBlock)})
                    </option>
                  ))}
                </select>
              </label>
              <label
                className="field"
                title="The wallet's paymaster sponsors the vault move by default. When its pre-flight keeps rejecting the move (error 156 with an empty reason), self-pay broadcasts the same transaction yourself: gas comes from your visible STRK, no paymaster involved."
              >
                Sponsor my own gas (skip paymaster)
                <input
                  type="checkbox"
                  checked={selfPay}
                  onChange={(e) => setSelfPay(e.target.checked)}
                  style={{ marginTop: 6 }}
                />
              </label>
              {selfPay && (
                <p className="status" style={{ marginTop: 6, maxWidth: 340 }}>
                  Self-pay: needs ~3-4 visible STRK for gas. You have{" "}
                  {visibleStrk != null ? `${(Number(visibleStrk) / 1e18).toFixed(2)}` : "?"}. The vault
                  fee leg (6 STRK) still applies on top.
                </p>
              )}
              {delay && !isRehearsal && (
                <p className="status" style={{ marginTop: 6, maxWidth: 320 }}>
                  Timing model suggests {measuredDelayBlocks.toLocaleString()} blocks for cover; you chose {waitBlocks}. Shorter waits mean thinner cover — your call.
                </p>
              )}
              {!wallets && (
                <button type="button" className="chip" onClick={discover} disabled={busy === "discover"}>
                  {busy === "discover" ? "looking…" : "Find wallets →"}
                </button>
              )}
              {wallets?.map((w) => (
                <button
                  key={w.name}
                  type="button"
                  className="chip"
                  aria-pressed={ready}
                  onClick={() => pick(w)}
                  disabled={busy === "connect"}
                >
                  {busy === "connect" ? "connecting…" : ready ? `${w.name} ✓` : `Connect ${w.name}`}
                </button>
              ))}
            </div>
            {support && (
              <div className="facts" style={{ marginTop: 12 }}>
                <span className={`tag ${support.supported ? "hot" : ""}`}>wallet {support.versions.join(" / ") || "unknown"}</span>
                <span className="tag">{support.supported ? "ready for private moves" : `needs API ${support.minimumVersion}`}</span>
                {support.canQueryTxs != null && (
                  <span className={`tag ${support.canQueryTxs ? "hot" : ""}`}>
                    {support.canQueryTxs ? "can recover hashes" : "can't auto-recover txs"}
                  </span>
                )}
                {account && <span className="tag">{account.address.slice(0, 10)}…</span>}
              </div>
            )}
            {wallets && !ready && <p className="status" style={{ marginTop: 8 }}>Approve Rhizome in your wallet to continue.</p>}
            {block != null && <p className="status" style={{ marginTop: 6 }}>Current block {block.toLocaleString()} · wait {delayBlocks} blocks = {formatDelay(delayBlocks, secondsPerBlock)}</p>}
            {isRehearsal && <p className="status" style={{ marginTop: 6, color: "var(--orange)" }}>Quick test skips the real wait; don&apos;t use it on mainnet.</p>}
          </div>
        </div>

        {/* STEP 2 */}
        <div className={`wizard-step ${!ready ? "" : step2Done ? "done" : "active"}`}>
          <div className="badge">{step2Done ? "✓" : "2"}</div>
          <div>
            <h4>Fee check</h4>
            {!feePlan ? (
              <p>Pick an amount above to see the fee.</p>
            ) : (
              <>
                <p>
                  Each piece needs <strong>2 × {strk(feePlan.feePerTransaction)} STRK</strong> hidden separately to pay fees without changing your amounts.
                  Total hidden reserve needed: <strong>{strk(feePlan.requiredReserve)} STRK</strong> for {feePlan.executionTransactions} moves.
                </p>
                <div className="facts">
                  <span className="tag">you hide · {strk(scheduledAmount)} STRK</span>
                  <span className="tag">vault gets · {strk(scheduledAmount)} STRK</span>
                  <span className={`tag ${feePlan.reserveVerified ? "hot" : ""}`}>
                    {feePlan.balanceKnown ? `${strk(feePlan.existingReserve)} hidden balance` : "hidden balance not shared"}
                  </span>
                </div>
                {!feePlan.balanceKnown && ready ? (
                  <p className="status" style={{ marginTop: 8 }}>Let your wallet share hidden balances (Step 1) to verify this.</p>
                ) : feePlan.reserveShortfall > 0n ? (
                  <p className="err" style={{ marginTop: 8 }}>
                    Need {strk(feePlan.reserveShortfall)} more hidden STRK. Add {strk(feePlan.bootstrapDeposit)} (shortfall + 1 fee). Without it amounts would shrink to{" "}
                    {feePlan.withoutReserveVaultAmounts.map((a) => strk(a)).join(" / ")}, breaking your cover.
                  </p>
                ) : feePlan.balanceKnown ? (
                  <p className="status" style={{ marginTop: 8, color: "var(--text)" }}>✓ Reserve verified: real moves unlocked.</p>
                ) : null}
                {!ready && <p className="status" style={{ marginTop: 8 }}>Connect wallet first.</p>}
                {paidGateReason && !paidGateOpen && <p className="err" style={{ marginTop: 8 }}>{paidGateReason}</p>}
                {paidGateOpen && <p className="status" style={{ marginTop: 8, color: "var(--text)" }}>✓ Ready to send real transactions.</p>}
              </>
            )}
          </div>
        </div>

        {/* STEP 3 */}
        <div className={`wizard-step ${!ready || !schedule?.length ? "" : step3Done ? "done" : "active"}`}>
          <div className="badge">{step3Done ? "✓" : "3"}</div>
          <div>
            <h4>Free test: no fee, no transaction</h4>
            <p>Prove your wallet can do the moves before spending anything.</p>
            {!ready || !schedule?.length ? (
              <p className="status">{!ready ? "Connect wallet first." : analysisError ? `No plan: ${analysisError}` : "Pick an amount above."}</p>
            ) : (
              <>
                <button type="button" className="chip" onClick={dryRunShield} disabled={busy === "dryrun-shield"} aria-pressed={shieldDryRun}>
                  {busy === "dryrun-shield" ? "testing…" : shieldDryRun ? "hide test passed ✓" : "Test hide (free) →"}
                </button>
                {shieldDryRun && (
                  <span
                    key={dryRunPassTick}
                    className="dry-run-chip"
                    aria-hidden="true"
                    style={{
                      marginLeft: 8,
                      fontSize: 12,
                      color: "var(--text)",
                      display: "inline-block",
                      animation: "dryRunPass 1.5s ease-out forwards",
                    }}
                  >
                    ✓ passed
                  </span>
                )}
                {shieldDryRun && (
                  <span style={{ marginLeft: 8, fontSize: 11, color: "var(--ghost)" }}>
                    simulation — charges no real fee
                  </span>
                )}
                {scheduleSource === "sepolia-rehearsal" && <p className="status" style={{ marginTop: 8 }}>Practice amount {strk(schedule[0].amount)}, not a real recommendation.</p>}
                {!shieldDryRun && <p className="status" style={{ marginTop: 8 }}>You must pass this before Hide unlocks.</p>}
              </>
            )}
          </div>
        </div>

        {/* STEP 4 */}
        <div className={`wizard-step ${!ready || !step3Done ? "" : allLegsDone ? "done" : "active"}`}>
          <div className="badge">{allLegsDone ? "✓" : "4"}</div>
          <div>
            <h4>Hide → wait → vault</h4>
            {schedule?.length > 0 ? (
              <p>
                {schedule.length} piece{schedule.length === 1 ? "" : "s"}; each hidden amount stays exactly as shown so it keeps its cover. Wait{" "}
                {formatDelay(delayBlocks, secondsPerBlock)} between hide and vault.
              </p>
            ) : (
              <p className="status">No pieces yet, pick an amount.</p>
            )}
            {schedule?.length > 0 && (
              <p
                className="status"
                style={{
                  color: "var(--warn, #b8860b)",
                  fontSize: 12,
                  margin: "6px 0 0",
                  lineHeight: 1.5,
                }}
              >
                Visible STRK pays the bills: each hide burns ~3-4 STRK gas; the
                vault move needs ≥ ~9.2 visible (6 STRK fee + ~3.2 gas).
                Shielded STRK cannot pay for either.
              </p>
            )}

            {account && schedule?.length > 0 && (
              <p
                className="status"
                aria-label="Shielded and visible STRK balances"
                style={{
                  fontSize: 12,
                  margin: "4px 0 0",
                  lineHeight: 1.5,
                  color:
                    visibleStrk != null && visibleStrk < visibleReqWei
                      ? "var(--warn, #b8860b)"
                      : "var(--ghost, inherit)",
                }}
              >
                Shielded: {shieldedStrkBalance != null ? `${(Number(shieldedStrkBalance) / 1e18).toFixed(2)} STRK` : "?"}{" "}
                · Visible: {visibleStrk != null ? `${(Number(visibleStrk) / 1e18).toFixed(2)} STRK` : "?"}{" "}
                (vault needs ≥ {(Number(visibleReqWei) / 1e18).toFixed(1)})
                {visibleStrk != null && visibleStrk < visibleReqWei && (
                  <strong> — add visible STRK before entering the vault</strong>
                )}
              </p>
            )}

            {account && balances == null && (
              <div style={{ marginTop: 8 }}>
                <button
                  type="button"
                  className="chip"
                  onClick={() => refreshBalances()}
                  disabled={busy === "balances"}
                  title="Ask the wallet to share your hidden (shielded) balances. Argent shows a prompt — approve it to unlock the fee-reserve check."
                >
                  share balances
                </button>
                <span style={{ fontSize: 11, color: "var(--ghost)", marginLeft: 8 }}>
                  no shielded balance shared yet — the fee-reserve gate needs it
                </span>
              </div>
            )}

            {ready && schedule?.length > 0 && (
              <div className="table-wrap" style={{ marginTop: 12 }}>
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Amount</th>
                      <th>Hides among</th>
                      <th>Status</th>
                      <th>Hide</th>
                      <th>Vault</th>
                    </tr>
                  </thead>
                  <tbody>
                    {schedule.map((leg, i) => {
                      const status = legStatus(i);
                      const state = legs[i] ?? {};
                      return (
                        <tr key={i} className={status.ready ? "chosen" : ""}>
                          <td>{i + 1}</td>
                          <td>{strk(leg.amount)} STRK</td>
                          <td>
                            {leg.entryCohort ?? leg.cohort} / {leg.exitKnown ? leg.exitCohort : "?"}
                            {!leg.covered && <span className="pill">rare</span>}
                          </td>
                          <td>{status.label}</td>
                          <td>
                            <button
                              type="button"
                              className="chip"
                              onClick={() =>
                                !state.shieldedAt && (state.shieldTx || state.stage === "shield-pending")
                                  ? checkShield(i)
                                  : shieldClick(i)
                              }
                              disabled={busy != null || Boolean(state.shieldedAt)}
                            >
                              {busy === `shield-${i}` ? "sending…" : busy === `check-shield-${i}` ? "checking…" : state.shieldedAt ? `block ${state.shieldedAt}` : state.shieldTx || state.stage === "shield-pending" ? "check" : status.retryable ? "retry" : "hide"}
                            </button>
                            {state.shieldTx && (
                              <a
                                className="tx-link"
                                href={explorerTx(state.shieldTx)}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{ display: "block", marginTop: 6, fontSize: 11 }}
                              >
                                view tx ↗
                              </a>
                            )}
                            {!state.shieldedAt && !state.shieldTx && (
                              <span
                                style={{
                                  display: "block",
                                  marginTop: 4,
                                  fontSize: 10,
                                  color: "var(--warn, #b8860b)",
                                  lineHeight: 1.4,
                                }}
                                title="Visible STRK pays the bills: each hide burns ~3-4 STRK gas; the vault move needs ≥ ~9.2 visible (6 STRK fee + ~3.2 gas). Shielded STRK cannot pay for either."
                              >
                                hides burn ~3-4 visible STRK gas
                              </span>
                            )}
                          </td>
                          <td>
                            {!state.shieldedAt ? (
                              <span style={{ color: "var(--ghost)" }}></span>
                            ) : state.stage === "invest-pending" ? (
                              <button type="button" className="chip" onClick={() => checkInvest(i)} disabled={busy != null} title="Check the on-chain receipt of the submitted vault transaction">
                                {busy === `check-invest-${i}` ? "checking…" : "check"}
                              </button>
                            ) : state.stage === "vault_failed" ? (
                              <>
                                {!state.investDryRun && (
                                  <button
                                    type="button"
                                    className="chip"
                                    onClick={() => (deployed ? dryRunInvest(i) : say("Vault helper is not deployed on this network; hiding still works.", "err"))}
                                    disabled={busy != null}
                                    title="The free vault test is session-only — a refresh clears it. Run it once, then press try again."
                                  >
                                    {busy === `dryrun-invest-${i}` ? "testing…" : "test vault"}
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="chip"
                                  onClick={() => investClick(i)}
                                  disabled={busy != null}
                                  title="A previous attempt never broadcast. Retry the vault move."
                                  style={{ marginLeft: state.investDryRun ? 0 : 6 }}
                                >
                                  {busy === `invest-${i}` ? "sending…" : "try again"}
                                </button>
                                {state.investTx && (
                                  <button type="button" className="chip" onClick={() => checkInvest(i)} disabled={busy != null} style={{ marginLeft: 6 }} title="Check the receipt of the last submitted attempt">
                                    check
                                  </button>
                                )}
                              </>
                            ) : !status.ready ? (
                              <span style={{ color: "var(--faint)" }}>wait</span>
                            ) : !state.investDryRun ? (
                              <button type="button" className="chip" onClick={() => (deployed ? dryRunInvest(i) : say("Vault helper is not deployed on this network; hiding still works.", "err"))} disabled={busy != null}>
                                {busy === `dryrun-invest-${i}` ? "testing…" : "test vault"}
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="chip"
                                onClick={() => (state.stage === "invested" ? undefined : investClick(i))}
                                disabled={busy != null}
                              >
                                {busy === `invest-${i}` ? "sending…" : state.stage === "invested" ? "done ✓" : "enter vault"}
                              </button>
                            )}
                            {state.investTx && state.stage !== "invested" && (
                              <a
                                className="tx-link"
                                href={explorerTx(state.investTx)}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{ display: "block", marginTop: 6, fontSize: 11 }}
                              >
                                view tx ↗
                              </a>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* TASK 1 — amber pre-flight maturity card with a live countdown.
          Auto-clears when the countdown reaches zero (the 12s block poll
          re-renders this); "Retry when mature" re-runs investClick. */}
      {vaultMaturityCard && ready && (
        <div
          className="card maturity-card"
          role="alert"
          style={{
            marginTop: 16,
            padding: "14px 16px",
            border: "1px solid var(--amber, #c9a227)",
            borderRadius: 10,
            direction: "ltr",
          }}
        >
          <p style={{ margin: 0, color: "var(--amber, #c9a227)", fontWeight: 600 }}>
            A shielded note is too young to spend.
          </p>
          <p style={{ margin: "8px 0 10px", fontSize: 13 }}>
            It matures in ~{maturityGate.blocked ? maturityGate.blocksRemaining : 0} blocks (~
            {formatDelay(maturityGate.blocked ? maturityGate.blocksRemaining : 0, secondsPerBlock)}).
            The dry run can&apos;t detect this — simulation charges no real fee.
          </p>
          <button
            type="button"
            className="chip"
            disabled={vaultMaturity().blocked}
            onClick={() => {
              setVaultMaturityCard(null);
              investClick(vaultMaturityCard.piece - 1);
            }}
          >
            Retry when mature
          </button>
        </div>
      )}

      {/* TASK 2 — persistent vault failure card (paymaster 156 / fee drawing) */}
      {vaultErrorCard && ready && (
        <div
          className="card vault-error-card"
          role="alert"
          style={{
            marginTop: 16,
            padding: "14px 16px",
            border: "1px solid var(--error)",
            borderRadius: 10,
            direction: "ltr",
          }}
        >
          {vaultErrorCard.feePattern ? (
            <>
              <p style={{ margin: 0, color: "var(--error)", fontWeight: 600 }}>
                Piece {vaultErrorCard.piece}: the vault transaction reverted while drawing the privacy fee.
              </p>
              <p style={{ margin: "8px 0 10px", fontSize: 13 }}>
                Most common cause: a fee note younger than 10 blocks. Wait ~1 minute and retry. If it
                persists, run Deep Simulate.
              </p>
            </>
          ) : (
            <>
              <p style={{ margin: 0, color: "var(--error)", fontWeight: 600 }}>
                Piece {vaultErrorCard.piece}: the vault transaction failed.
              </p>
              <p style={{ margin: "8px 0 10px", fontSize: 13, fontFamily: "var(--mono)", wordBreak: "break-word" }}>
                {vaultErrorCard.reason}
              </p>
              <p style={{ margin: "8px 0 10px", fontSize: 13 }}>
                The wrapper hides the reason — run Deep Simulate to read the exact on-chain revert.
              </p>
            </>
          )}
          {vaultErrorCard.paymasterErrors?.length > 0 && (
            <div
              style={{
                marginTop: 10,
                padding: "8px 10px",
                border: "1px solid var(--error)",
                borderRadius: 6,
                fontFamily: "var(--mono)",
                fontSize: 12,
                color: "var(--error)",
                direction: "ltr",
              }}
            >
              Paymaster rejection reasons:
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                {vaultErrorCard.paymasterErrors.map((s, idx) => (
                  <li key={idx} style={{ wordBreak: "break-word" }}>
                    {s}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <button
            type="button"
            className="chip"
            onClick={() => deepSimulate(vaultErrorCard.piece - 1)}
            disabled={deepSimBusy}
          >
            {deepSimBusy ? "simulating…" : "Deep Simulate"}
          </button>
          {vaultErrorCard.txHash && (
            <button
              type="button"
              className="chip"
              title={vaultErrorCard.txHash}
              onClick={() => {
                if (typeof navigator !== "undefined" && navigator.clipboard) {
                  navigator.clipboard.writeText(vaultErrorCard.txHash).catch(() => {});
                }
                // Also surface it in the console — clipboard can silently fail.
                if (typeof console !== "undefined") console.log("vault-fail tx hash:", vaultErrorCard.txHash);
                say(`Copied tx hash: ${vaultErrorCard.txHash.slice(0, 18)}…`, "ok");
              }}
              style={{ marginLeft: 8 }}
            >
              Copy tx hash
            </button>
          )}
          {vaultErrorCard.txHash && (
            <a
              className="tx-link"
              href={explorerTx(vaultErrorCard.txHash)}
              target="_blank"
              rel="noopener noreferrer"
              style={{ display: "inline-block", marginLeft: 8, fontSize: 11, verticalAlign: "middle" }}
            >
              view tx ↗
            </a>
          )}
          {deepSimResult && (
            <p
              className="deep-sim-result"
              style={{
                marginTop: 10,
                marginBottom: 0,
                fontFamily: "var(--mono)",
                fontSize: 12,
                whiteSpace: "pre-wrap",
                color: deepSimResult.ok ? "var(--ok, #2e9e5b)" : "var(--error)",
                direction: "ltr",
              }}
            >
              {deepSimResult.ok ? "✓ " : "✗ "}
              {deepSimResult.reason}
            </p>
          )}
        </div>
      )}

      {/* Unknown note ages: honest, non-blocking warning */}
      {(() => {
        const gate = vaultMaturity();
        if (!gate.blocked && gate.unknownAges.length > 0 && feePlan?.reserveVerified && ready) {
          return (
            <p className="status" style={{ marginTop: 10, fontSize: 12 }}>
              Note: the age of {gate.unknownAges.length === 1 ? "one shielded note is" : `${gate.unknownAges.length} shielded notes are`} unknown
              (hidden outside this app or before tracking). If the vault move reverts, wait ~1 minute and retry.
            </p>
          );
        }
        return null;
      })()}

      {/* advanced / debug */}
      {ready && deployed && network === "sepolia" && (
        <details className="advanced">
          <summary>Sepolia vault test: already-hidden funds</summary>
          <p style={{ marginTop: 10, color: "var(--dim)", fontSize: 13 }}>
            Try the vault step alone with funds you already hid. Free, no transaction sent.
          </p>
          <div className="controls" style={{ marginTop: 12 }}>
            <label className="field">
              Amount to test (STRK)
              <input
                type="text"
                inputMode="decimal"
                value={directVaultAmount}
                onChange={(e) => {
                  setDirectVaultAmount(e.target.value);
                  setDirectVaultPassed(false);
                  setDirectVaultAttempt(null);
                }}
                aria-label="Amount to test"
              />
            </label>
            <button type="button" className="chip" onClick={dryRunExistingVault} disabled={busy != null} aria-pressed={directVaultPassed}>
              {busy === "dryrun-existing-vault" ? "testing…" : directVaultPassed ? "test passed ✓" : "Test vault (free) →"}
            </button>
          </div>
          {directVaultAttempt && (
            <details open style={{ marginTop: 12 }}>
              <summary className="status" style={{ cursor: "pointer" }}>Exact request sent to wallet</summary>
              <pre className="mono" style={{ marginTop: 10, padding: 12, border: "1px solid var(--line)", background: "#0a0a0a", fontSize: 11, overflowX: "auto", color: "var(--dim)" }}>
                {JSON.stringify(directVaultAttempt.request, null, 2)}
              </pre>
            </details>
          )}
        </details>
      )}

      {balances && (
        <details className="advanced">
          <summary>Hidden balances</summary>
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table>
              <thead>
                <tr><th>Token</th><th>Amount</th></tr>
              </thead>
              <tbody>
                {(Array.isArray(balances) ? balances : []).map((b, i) => (
                  <tr key={i}>
                    <td>{String(b.token ?? b[0] ?? "…").slice(0, 14)}…</td>
                    <td>{strk(BigInt(b.balance ?? b[1] ?? 0))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {ready && schedule?.length > 0 && (
        <details className="advanced">
          <summary>What the wallet actually receives</summary>
          <pre className="mono" style={{ marginTop: 12, padding: 14, border: "1px solid var(--line)", background: "#0a0a0a", fontSize: 11, overflowX: "auto", color: "var(--dim)" }}>
            {JSON.stringify({ hide: shieldActionsFor(schedule[0]), "enter vault": deployed ? investActionsFor(schedule[0]) : "needs helper" }, null, 2)}
          </pre>
        </details>
      )}

      {hashPrompt && (
        <form className="controls" style={{ marginTop: 14 }} onSubmit={linkHash}>
          <label className="field" style={{ flex: 1 }}>
            Paste the transaction hash for piece {hashPrompt.index + 1} ({hashPrompt.kind === "shield" ? "hide" : "vault"})
            <input
              type="text"
              value={hashInput}
              onChange={(e) => setHashInput(e.target.value)}
              placeholder="0x…"
              aria-label="Transaction hash"
            />
          </label>
          <button type="submit" className="chip">
            link
          </button>
          <button
            type="button"
            className="chip"
            onClick={() => {
              setHashPrompt(null);
              setHashInput("");
            }}
          >
            dismiss
          </button>
        </form>
      )}

      {log.length > 0 && (
        <div style={{ marginTop: 22 }}>
          {log.map((l, i) => (
            <div
              key={i}
              className="mono"
              style={{
                fontSize: 11,
                color: l.kind === "err" ? "var(--orange)" : l.kind === "ok" ? "var(--text)" : "var(--faint)",
                borderBottom: "1px solid var(--line-subtle)",
                padding: "6px 0",
                wordBreak: "break-all",
              }}
            >
              <span style={{ color: "var(--ghost)", marginRight: 8 }}>{l.at}</span>
              {l.line}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
