import { useEffect, useMemo, useState } from "react";
import {
  acceptedReceiptBlock,
  buildFeeReservePlan,
  executionProgressKey,
  readExecutionProgress,
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
  listWallets,
  shieldedBalances,
} from "./lib/wallet.mjs";

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
  const [legs, setLegs] = useState({});
  const [hydratedProgressKey, setHydratedProgressKey] = useState(null);
  // Recovery lane for submissions whose hash never reached us (wallet answered
  // too slowly): the user pastes the explorer/wallet hash, we link the leg.
  const [hashPrompt, setHashPrompt] = useState(null);
  const [hashInput, setHashInput] = useState("");

  const anonymizer = net.anonymizer;
  const vToken = net.vesu?.vTokens?.STRK ?? null;
  const measuredDelayBlocks = Math.max(NOTE_MATURITY_BLOCKS, delay?.window ?? NOTE_MATURITY_BLOCKS);
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
  const isRehearsal = network === "sepolia" && delayMode === "rehearsal";
  const delayBlocks = isRehearsal ? NOTE_MATURITY_BLOCKS : measuredDelayBlocks;

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
    setLegs(saved);
    setHydratedProgressKey(progressKey);
  }, [progressKey, schedule.length]);

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
      say(`Free test failed: ${e.message}`, "err");
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
    invest(i);
  }

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
    } catch (e) {
      if (e?.code === "EXECUTE_TIMEOUT") {
        // Submission state unknown. Leave any prior hash intact and keep the
        // button as Check — resubmitting blind could double-spend the leg.
        patch(i, { stage: "shield-pending" });
        say(
          `Piece ${i + 1}: wallet did not answer in time. If you approved, wait for it to land, then press Check. Do NOT approve a second hide for this piece.`,
          "err",
        );
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
        say(`Piece ${i + 1} hide failed: ${reason}`, "err");
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
      say(`Piece ${i + 1} vault test failed: ${e.message}`, "err");
    } finally {
      setBusy(null);
    }
  }

  function acceptInvestReceipt(i, receipt) {
    const at = acceptedReceiptBlock(receipt);
    if (at === null) return false;
    patch(i, { stage: "invested", investedAt: at });
    say(`Piece ${i + 1} is in the vault at block ${at}.`, "ok");
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
    try {
      await requireSelectedChain();
      const { transaction_hash } = await execute(account, investActionsFor(schedule[i]));
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
        say(`Piece ${i + 1} vault move failed: ${reason}`, "err");
      }
    } finally {
      setBusy(null);
    }
  }

  async function checkInvest(i) {
    const tx = legs[i]?.investTx;
    if (!tx) return;
    setBusy(`check-invest-${i}`);
    try {
      const receipt = await retryReceipt(tx);
      if (!acceptInvestReceipt(i, receipt)) say(`Piece ${i + 1} vault receipt still pending.`, "info");
    } catch (e) {
      if (/revert/i.test(e.message)) {
        patch(i, { stage: "failed" });
        say(`Piece ${i + 1} vault move reverted: ${e.message}`, "err");
      } else say(`Vault receipt not visible yet: ${e.message}`, "info");
    } finally {
      setBusy(null);
    }
  }

  const strk = (v) => formatUnits(v, 18, { maxFractionDigits: 4 });
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
              {network === "sepolia" && (
                <label className="field">
                  Wait time
                  <select value={delayMode} onChange={(e) => setDelayMode(e.target.value)}>
                    <option value="rehearsal">quick test · {NOTE_MATURITY_BLOCKS} blocks</option>
                    <option value="measured">real wait · {measuredDelayBlocks.toLocaleString()} blocks</option>
                  </select>
                </label>
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
                          </td>
                          <td>
                            {!state.shieldedAt ? (
                              <span style={{ color: "var(--ghost)" }}></span>
                            ) : state.stage === "invest-pending" ? (
                              <button type="button" className="chip" onClick={() => checkInvest(i)} disabled={busy != null}>
                                {busy === `check-invest-${i}` ? "checking…" : "check"}
                              </button>
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
