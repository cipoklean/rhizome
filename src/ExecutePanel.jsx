import { useEffect, useMemo, useState } from "react";
import {
  acceptedReceiptBlock,
  executionProgressKey,
  readExecutionProgress,
  writeExecutionProgress,
} from "./lib/execution.mjs";
import { connect } from "./lib/pool.mjs";
import { FEE_MODELS } from "./lib/frontier.mjs";
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

/**
 * Execution panel.
 *
 * A tranche is two pool transactions, not one, and the gap between them is the
 * point. Stage 1 shields the chosen amount — that is the public `Deposit` leg the
 * cohort analysis picked. Stage 2 puts it into the vault through the anonymizer.
 * If stage 2 follows stage 1 immediately, the observer does not need the amounts:
 * on this pool, a transaction is alone in a ten-block window 98% of the time, so
 * the two legs are trivially paired and the extra fee bought nothing.
 *
 * So the panel refuses to run stage 2 early. Notes need ~10 blocks to mature
 * anyway; the recommended delay is longer, measured from real traffic, and the
 * only unlinkability on offer here that costs nothing.
 *
 * Deliberately gated: nothing submits until a dry run of that exact action shape
 * has passed. The pool charges its fee whether or not the calldata was right.
 */
export default function ExecutePanel({
  net,
  network,
  schedule,
  scheduleSource,
  paidSubmissionAllowed,
  analysisError,
  token,
  fee,
  feeModel,
  delay,
  secondsPerBlock,
}) {
  const [wallets, setWallets] = useState(null);
  const [selectedWallet, setSelectedWallet] = useState(null);
  const [account, setAccount] = useState(null);
  const [support, setSupport] = useState(null);
  const [balances, setBalances] = useState(null);
  const [shape, setShape] = useState("implicit");
  const [directVaultAmount, setDirectVaultAmount] = useState("1");
  const [directVaultPassed, setDirectVaultPassed] = useState(null);
  const [directVaultAttempt, setDirectVaultAttempt] = useState(null);
  const [busy, setBusy] = useState(null);
  const [log, setLog] = useState([]);
  const [shieldDryRun, setShieldDryRun] = useState(false);
  const [block, setBlock] = useState(null);
  const [delayMode, setDelayMode] = useState(network === "sepolia" ? "rehearsal" : "measured");
  // Per-leg progress: { [index]: { stage, shieldTx, shieldedAt, investDryRun, investTx } }
  const [legs, setLegs] = useState({});
  const [hydratedProgressKey, setHydratedProgressKey] = useState(null);

  const anonymizer = net.anonymizer;
  const vToken = net.vesu?.vTokens?.STRK ?? null;
  const txPerLeg = FEE_MODELS[feeModel]?.txPerLeg ?? 1;
  const measuredDelayBlocks = Math.max(
    NOTE_MATURITY_BLOCKS,
    delay?.window ?? NOTE_MATURITY_BLOCKS,
  );
  // Mainnet never exposes the shortcut. On Sepolia it is a rehearsal of the
  // action path, not a claim of timing cover.
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

  // A measured delay lasts hours. Restore only transaction hashes, landing
  // blocks and durable stages — never notes, proofs, balances or viewing data.
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

  // Readiness is measured in blocks, so the panel needs to know what block it is.
  useEffect(() => {
    let cancelled = false;
    let provider;
    const tick = async () => {
      try {
        provider = provider ?? (await connect(net.rpc));
        const b = await provider.getBlockNumber();
        if (!cancelled) setBlock(b);
      } catch {
        /* a missed poll is not worth reporting */
      }
    };
    tick();
    const id = setInterval(tick, 12000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [net]);

  async function discover() {
    setBusy("discover");
    try {
      const list = await listWallets();
      setWallets(list);
      if (list.length === 0) say("No Starknet wallet detected. Install Ready.", "err");
      else say(`${list.length} wallet(s) detected.`);
    } catch (e) {
      say(`Discovery failed: ${e.message}`, "err");
    } finally {
      setBusy(null);
    }
  }

  async function pick(wallet) {
    setBusy("connect");
    setShieldDryRun(false);
    setSelectedWallet(null);
    setAccount(null);
    setBalances(null);
    let phase = "capability check";

    try {
      const cap = await checkStrk20Support(wallet);
      setSupport(cap);
      if (!cap.supported) {
        say(
          `${wallet.name} reports Wallet API ${cap.versions.join(", ") || "unknown"} — STRK20 needs 0.10 or higher.`,
          "err",
        );
        return;
      }

      // Authorization has to come first. Wallet-side calls such as
      // requestChainId and switchStarknetChain are scoped to an authorized dapp;
      // asking before WalletAccountV6.connect produces Ready's correct but
      // unhelpful "Not preauthorized" error.
      phase = "authorization";
      say(`Authorize Rhizome in ${wallet.name}…`);
      let acc = await connectWallet(wallet, net.rpc[0]);
      say(`${wallet.name} authorized Rhizome.`, "ok");

      phase = "network switch";
      say(`Checking ${wallet.name}'s write network…`);
      const chain = await ensureWalletChain(wallet, net.chainId);
      if (chain.switched) {
        say(`${wallet.name} switched to ${net.chainId}.`, "ok");

        // starknet.js explicitly recommends a new WalletAccount after a network
        // change. Reconstruct silently from the account the user just allowed;
        // do not turn one Connect click into a second authorization prompt.
        phase = "account refresh";
        acc = await connectWallet(wallet, net.rpc[0], { silent: true });
      } else {
        say(`${wallet.name} is already on ${net.chainId}.`);
      }

      setSelectedWallet(wallet);
      setAccount(acc);
      say(`Ready · ${acc.address.slice(0, 10)}… · ${net.chainId}`, "ok");

      // Balance access is separate consent, not connection. Rejecting it must
      // not discard an otherwise usable account or report "Connect failed".
      phase = "balance consent";
      const tokens = [token, vToken].filter(Boolean);
      try {
        await ensureWalletChain(wallet, net.chainId);
        const b = await shieldedBalances(acc, tokens);
        setBalances(b);
        say("Read shielded balances through the wallet.");
      } catch (e) {
        say(`Shielded balances not shared: ${e.message}. Execution is still available.`, "info");
      }
    } catch (e) {
      const labels = {
        "capability check": "Wallet capability check failed",
        authorization: "Ready authorization failed",
        "network switch": `Switch to ${net.chainId} failed`,
        "account refresh": "Wallet account refresh failed after switching networks",
      };
      say(`${labels[phase] ?? "Wallet connection failed"}: ${e.message}`, "err");
    } finally {
      setBusy(null);
    }
  }

  const shieldActionsFor = (leg) => buildShieldActions({ token, amount: leg.amount });

  const investActionsFor = (leg, selectedShape = shape) =>
    buildTrancheActions({
      anonymizer,
      inToken: token,
      outToken: vToken,
      amount: leg.amount,
      recipient: account?.address ?? "0x0",
      operation: OPERATION.Deposit,
      shape: selectedShape,
    });

  const patch = (i, fields) => setLegs((l) => ({ ...l, [i]: { ...(l[i] ?? {}), ...fields } }));

  /**
   * The user can switch Ready after connecting. Re-check before every proof or
   * submission so reads from Sepolia can never be paired with writes to mainnet.
   */
  async function requireSelectedChain() {
    if (!selectedWallet) throw new Error("wallet is not connected");
    return ensureWalletChain(selectedWallet, net.chainId);
  }

  /** Stage 0: prove the shield shape once, for free, before spending a fee on it. */
  async function dryRunShield() {
    if (!account || !schedule?.length) return;
    setBusy("dryrun-shield");
    try {
      await requireSelectedChain();
      await dryRun(account, shieldActionsFor(schedule[0]));
      setShieldDryRun(true);
      say("Shield dry run passed. Stage 1 unlocked.", "ok");
    } catch (e) {
      setShieldDryRun(false);
      say(`Shield dry run rejected: ${e.message}`, "err");
    } finally {
      setBusy(null);
    }
  }

  /**
   * Prove the vault leg directly against funds already shielded in Ready.
   *
   * This is the missing diagnostic between a successful shield dry run and a
   * paid two-stage execution. It spends nothing, creates no transaction and
   * does not pretend stage 1 happened; it only settles which helper action
   * shape the wallet/pool accepts. The pool fee still participates in balance
   * conservation during proving, so the account needs the requested amount plus
   * enough shielded STRK for the fee.
   */
  async function dryRunExistingVault(selectedShape) {
    if (!account || !deployed) return;
    setShape(selectedShape);
    setBusy(`dryrun-existing-vault-${selectedShape}`);
    setDirectVaultPassed(null);
    try {
      const amount = parseUnits(directVaultAmount, 18);
      if (amount <= 0n) throw new Error("enter a vault amount above zero");
      const actions = investActionsFor({ amount }, selectedShape);
      setDirectVaultAttempt({
        shape: selectedShape,
        request: buildPrepareInvokeRequest(actions),
      });
      await requireSelectedChain();
      await dryRun(account, actions);
      setDirectVaultPassed(selectedShape);
      say(
        `Direct vault dry run passed (${selectedShape}, ${strk(amount)} STRK from existing shielded funds). No transaction sent.`,
        "ok",
      );
    } catch (e) {
      setDirectVaultPassed(null);
      say(`Direct vault dry run rejected (${selectedShape}): ${e.message}`, "err");
    } finally {
      setBusy(null);
    }
  }

  /** Record a shield only when a receipt proves the block it landed in. */
  function acceptShieldReceipt(i, receipt) {
    const at = acceptedReceiptBlock(receipt);
    if (at === null) return false;
    patch(i, { stage: "shielded", shieldedAt: at });
    say(
      `Leg ${i + 1} shielded at block ${at}. Vault action unlocks in ${delayBlocks} blocks (${formatDelay(delayBlocks, secondsPerBlock)}).`,
      "ok",
    );
    return true;
  }

  /** Stage 1: the public deposit leg — the amount the analysis chose. */
  async function shield(i) {
    if (!account || !shieldDryRun || !paidSubmissionAllowed) return;
    setBusy(`shield-${i}`);
    patch(i, { stage: "shielding" });
    try {
      await requireSelectedChain();
      say(`Leg ${i + 1}: shielding ${strk(schedule[i].amount)} STRK — expect two prompts (approve, then deposit).`);
      const { transaction_hash } = await execute(account, shieldActionsFor(schedule[i]));
      patch(i, { stage: "shield-pending", shieldTx: transaction_hash });
      say(`Leg ${i + 1} shield submitted: ${transaction_hash}`, "ok");

      const provider = await connect(net.rpc);
      const result = await confirm(provider, transaction_hash);
      if (!result.confirmed || !acceptShieldReceipt(i, result.receipt)) {
        say(
          `Leg ${i + 1} shield is submitted but not yet in a block. The delay clock has not started; use Check receipt.`,
          "info",
        );
      }
    } catch (e) {
      patch(i, { stage: "failed" });
      say(`Leg ${i + 1} shield failed: ${e.message}`, "err");
    } finally {
      setBusy(null);
    }
  }

  /** Recheck a submitted shield after RPC visibility or confirmation timed out. */
  async function checkShield(i) {
    const tx = legs[i]?.shieldTx;
    if (!tx) return;
    setBusy(`check-shield-${i}`);
    try {
      const provider = await connect(net.rpc);
      const receipt = await provider.getTransactionReceipt(tx);
      if (!acceptShieldReceipt(i, receipt)) {
        say(`Leg ${i + 1} shield is still pending. No delay block recorded.`, "info");
      }
    } catch (e) {
      // RPCs commonly report "transaction not found" while a relayed tx is
      // propagating. That is pending, not failed; a receipt marked REVERTED is
      // surfaced by acceptShieldReceipt instead.
      if (/revert/i.test(e.message)) {
        patch(i, { stage: "failed" });
        say(`Leg ${i + 1} shield reverted: ${e.message}`, "err");
      } else {
        say(`Leg ${i + 1} receipt not visible yet: ${e.message}`, "info");
      }
    } finally {
      setBusy(null);
    }
  }

  /** Stage 2 gate: prove the invoke shape now that there is a note to spend. */
  async function dryRunInvest(i) {
    if (!account) return;
    setBusy(`dryrun-invest-${i}`);
    try {
      await requireSelectedChain();
      await dryRun(account, investActionsFor(schedule[i]));
      patch(i, { investDryRun: true });
      say(`Leg ${i + 1} vault dry run passed (${shape}).`, "ok");
    } catch (e) {
      patch(i, { investDryRun: false });
      say(`Leg ${i + 1} vault dry run rejected (${shape}): ${e.message}`, "err");
    } finally {
      setBusy(null);
    }
  }

  /** Stage 2: into the vault through the anonymizer. */
  function acceptInvestReceipt(i, receipt) {
    const at = acceptedReceiptBlock(receipt);
    if (at === null) return false;
    patch(i, { stage: "invested", investedAt: at });
    say(`Leg ${i + 1} is in the vault at block ${at}.`, "ok");
    return true;
  }

  async function invest(i) {
    if (!account || !legs[i]?.investDryRun) return;
    setBusy(`invest-${i}`);
    try {
      await requireSelectedChain();
      const { transaction_hash } = await execute(account, investActionsFor(schedule[i]));
      patch(i, { stage: "invest-pending", investTx: transaction_hash });
      say(`Leg ${i + 1} vault action submitted: ${transaction_hash}`, "ok");

      const provider = await connect(net.rpc);
      const result = await confirm(provider, transaction_hash);
      if (!result.confirmed || !acceptInvestReceipt(i, result.receipt)) {
        say(`Leg ${i + 1} vault action is submitted but not yet in a block.`, "info");
      }
    } catch (e) {
      patch(i, { stage: "failed" });
      say(`Leg ${i + 1} vault action failed: ${e.message}`, "err");
    } finally {
      setBusy(null);
    }
  }

  async function checkInvest(i) {
    const tx = legs[i]?.investTx;
    if (!tx) return;
    setBusy(`check-invest-${i}`);
    try {
      const provider = await connect(net.rpc);
      const receipt = await provider.getTransactionReceipt(tx);
      if (!acceptInvestReceipt(i, receipt)) {
        say(`Leg ${i + 1} vault receipt is still pending.`, "info");
      }
    } catch (e) {
      if (/revert/i.test(e.message)) {
        patch(i, { stage: "failed" });
        say(`Leg ${i + 1} vault action reverted: ${e.message}`, "err");
      } else {
        say(`Leg ${i + 1} vault receipt not visible yet: ${e.message}`, "info");
      }
    } finally {
      setBusy(null);
    }
  }

  const strk = (v) => formatUnits(v, 18, { maxFractionDigits: 4 });
  const ready = Boolean(account && support?.supported);
  const deployed = Boolean(anonymizer && vToken);

  /** Blocks still to wait before a leg's vault action should be sent. */
  const blocksLeft = (i) => {
    const leg = legs[i];
    if (!leg?.shieldedAt || block === null) return null;
    return Math.max(0, leg.shieldedAt + delayBlocks - block);
  };

  const legStatus = (i) => {
    const leg = legs[i] ?? {};
    if (leg.stage === "invested") return { label: "in the vault", done: true };
    if (leg.stage === "invest-pending") return { label: "vault tx pending", done: false };
    if (leg.stage === "failed") return { label: "failed", done: false };
    if (!leg.shieldedAt) {
      if (leg.shieldTx) return { label: "shield tx pending", done: false, pendingShield: true };
      return { label: leg.stage === "shielding" ? "shielding…" : "not shielded", done: false };
    }
    const left = blocksLeft(i);
    if (left === null) return { label: "shielded", done: false };
    if (left > 0) {
      return {
        label: `waiting ${left} blocks (${formatDelay(left, secondsPerBlock)})`,
        done: false,
        waiting: true,
      };
    }
    return { label: leg.investDryRun ? "ready" : "dry run needed", done: false, ready: true };
  };

  return (
    <section className="band">
      <p className="eyebrow">
        <b>◢</b> EXECUTE
      </p>
      <h2>Run the schedule.</h2>
      <p className="lede">
        The wallet holds the viewing key, discovers the notes, proves the transaction and submits it.
        Rhizome only describes the actions. Each leg is two pool transactions —{" "}
        <b>shield the chosen amount</b>, wait, then <b>move it into the vault</b> — because the pool
        fee is charged per <span className="mono">apply_actions</span> call and the gap between the
        two is what stops an observer pairing them.
        {fee && schedule?.length > 0 && (
          <>
            {" "}
            This schedule is {schedule.length} leg{schedule.length === 1 ? "" : "s"} × {txPerLeg}{" "}
            transaction{txPerLeg === 1 ? "" : "s"} ={" "}
            {strk(fee * BigInt(schedule.length * txPerLeg))} STRK in pool fees.
          </>
        )}
      </p>

      {delay && (
        <>
          <div className="facts" style={{ marginTop: 22 }}>
            <span className={`tag ${!isRehearsal && delay.verdict === "delay-earns-it" ? "hot" : ""}`}>
              wait {delayBlocks} blocks · {formatDelay(delayBlocks, secondsPerBlock)}
            </span>
            {isRehearsal ? (
              <span className="tag hot">Sepolia rehearsal · no timing-cover claim</span>
            ) : (
              <>
                <span className="tag">median {delay.medianCohort} other pool tx in that window</span>
                <span className="tag">alone {(delay.aloneShare * 100).toFixed(0)}% of the time</span>
              </>
            )}
            {block !== null && <span className="tag">block {block.toLocaleString()}</span>}
          </div>
          {isRehearsal && (
            <p className="status" style={{ marginTop: 12, color: "var(--orange)" }}>
              Rehearsal mode waits only for note maturity so you can test the action path. It does
              not buy timing privacy. Mainnet never exposes this shortcut.
            </p>
          )}
        </>
      )}

      {!deployed && (
        <p className="err" style={{ marginTop: 24 }}>
          No anonymizer{vToken ? "" : " or Vesu vault"} configured for {network}. Stage 1 (shielding)
          would still work; stage 2 needs the helper deployed here.
        </p>
      )}

      <div className="controls">
        {network === "sepolia" && (
          <label className="field">
            Delay mode
            <select value={delayMode} onChange={(e) => setDelayMode(e.target.value)}>
              <option value="rehearsal">rehearsal · {NOTE_MATURITY_BLOCKS} blocks</option>
              <option value="measured">
                measured cover · {measuredDelayBlocks.toLocaleString()} blocks
              </option>
            </select>
          </label>
        )}
        {!wallets && (
          <button type="button" className="chip" onClick={discover} disabled={busy === "discover"}>
            {busy === "discover" ? "detecting…" : "Detect wallets →"}
          </button>
        )}
        {wallets?.map((w) => (
          <button
            key={w.name}
            type="button"
            className="chip"
            aria-pressed={account && support?.supported}
            onClick={() => pick(w)}
            disabled={busy === "connect"}
          >
            {busy === "connect" ? "connecting…" : `Connect ${w.name}`}
          </button>
        ))}
        {deployed && (
          <label className="field">
            Staged execution shape
            <select
              value={shape}
              onChange={(e) => {
                setShape(e.target.value);
                setDirectVaultPassed(null);
                setLegs((l) =>
                  Object.fromEntries(
                    Object.entries(l).map(([k, v]) => [k, { ...v, investDryRun: false }]),
                  ),
                );
              }}
            >
              <option value="implicit">transfer + invoke</option>
              <option value="explicit-withdraw">transfer + withdraw + invoke</option>
            </select>
          </label>
        )}
      </div>

      {support && (
        <div className="facts" style={{ marginTop: 22 }}>
          <span className={`tag ${support.supported ? "hot" : ""}`}>
            wallet api {support.versions.join(" / ") || "unknown"}
          </span>
          <span className="tag">{support.supported ? "strk20 capable" : "not strk20 capable"}</span>
          {account && <span className="tag">{account.address.slice(0, 12)}…</span>}
          {ready && (
            <span className={`tag ${schedule?.length > 0 ? "hot" : ""}`}>
              {schedule?.length > 0
                ? scheduleSource === "sepolia-rehearsal"
                  ? "1 free dry-run rehearsal leg"
                  : `${schedule.length} executable leg${schedule.length === 1 ? "" : "s"}`
                : "no executable schedule"}
            </span>
          )}
        </div>
      )}

      {wallets && !ready && (
        <p className="status" style={{ marginTop: 18 }}>
          Execution controls are locked until a STRK20-capable wallet is authorized on{" "}
          {net.chainId}.
        </p>
      )}

      {ready && (!schedule || schedule.length === 0) && (
        <p className="err" style={{ marginTop: 18 }}>
          Execution controls are locked because there is no valid rehearsal amount.
          {analysisError ? ` Frontier: ${analysisError}` : ""} Enter 10 STRK on Sepolia.
        </p>
      )}

      {ready && schedule?.length > 0 && (
        <p className="status" style={{ marginTop: 18 }}>
          {scheduleSource === "sepolia-rehearsal" ? (
            <>
              Free rehearsal ready: prove one {strk(schedule[0].amount)} STRK shield action below.
              This fallback is not a cohort recommendation, and paid submission stays locked until
              fee-net amount handling is verified.
            </>
          ) : (
            <>
              Execution ready: {schedule.length} leg{schedule.length === 1 ? "" : "s"}. The free
              shield dry run is directly below the balance section.
            </>
          )}
        </p>
      )}

      {ready && deployed && network === "sepolia" && (
        <div className="verdict" style={{ marginTop: 22 }}>
          <h3>Test stage 2 with funds already shielded.</h3>
          <p>
            Choose either exact action shape below. Each button constructs and submits the shape
            printed on that button, updates the staged-execution selector, spends no pool fee and
            sends no transaction. Start with 1 STRK; proving also needs enough shielded STRK to
            account for the 2 STRK Sepolia pool fee.
          </p>
          <div className="controls" style={{ marginTop: 18 }}>
            <label className="field">
              Vault dry-run amount (STRK)
              <input
                type="text"
                inputMode="decimal"
                value={directVaultAmount}
                onChange={(e) => {
                  setDirectVaultAmount(e.target.value);
                  setDirectVaultPassed(null);
                  setDirectVaultAttempt(null);
                }}
                aria-label="Direct vault dry-run amount in STRK"
              />
            </label>
            {["implicit", "explicit-withdraw"].map((testShape) => (
              <button
                key={testShape}
                type="button"
                className="chip"
                onClick={() => dryRunExistingVault(testShape)}
                disabled={busy !== null}
                aria-pressed={directVaultPassed === testShape}
              >
                {busy === `dryrun-existing-vault-${testShape}`
                  ? `proving ${testShape}…`
                  : directVaultPassed === testShape
                    ? `${testShape} passed ✓`
                    : `Test ${testShape} (free) →`}
              </button>
            ))}
          </div>
          {directVaultAttempt && (
            <details open style={{ marginTop: 18 }}>
              <summary className="status" style={{ cursor: "pointer" }}>
                Latest click submitted: {directVaultAttempt.shape}
              </summary>
              <pre
                className="mono"
                style={{
                  marginTop: 12,
                  padding: 14,
                  border: "1px solid var(--line)",
                  background: "#0a0a0a",
                  fontSize: 12,
                  overflowX: "auto",
                  color: "var(--dim)",
                }}
              >
                {JSON.stringify(directVaultAttempt.request, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}

      {balances && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Shielded balance</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {(Array.isArray(balances) ? balances : []).map((b, i) => (
                <tr key={i}>
                  <td>{String(b.token ?? b[0] ?? "—").slice(0, 14)}…</td>
                  <td>{strk(BigInt(b.balance ?? b[1] ?? 0))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {ready && schedule?.length > 0 && (
        <>
          <div className="controls">
            <button
              type="button"
              className="chip"
              onClick={dryRunShield}
              disabled={busy === "dryrun-shield"}
              aria-pressed={shieldDryRun}
            >
              {busy === "dryrun-shield"
                ? "proving…"
                : shieldDryRun
                  ? "shield dry run passed ✓"
                  : "Dry run the shield leg (free) →"}
            </button>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Leg</th>
                  <th>Amount</th>
                  <th>Entry / exit cohort</th>
                  <th>Status</th>
                  <th>1 · shield</th>
                  <th>2 · vault</th>
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
                        {!leg.covered && <span className="pill">no cover</span>}
                      </td>
                      <td>{status.label}</td>
                      <td>
                        <button
                          type="button"
                          className="chip"
                          onClick={() => (state.shieldTx && !state.shieldedAt ? checkShield(i) : shield(i))}
                          disabled={
                            busy !== null ||
                            Boolean(state.shieldedAt) ||
                            !paidSubmissionAllowed ||
                            (!state.shieldTx && !shieldDryRun)
                          }
                        >
                          {!paidSubmissionAllowed
                            ? "paid submit locked"
                            : busy === `shield-${i}`
                            ? "submitting…"
                            : busy === `check-shield-${i}`
                              ? "checking…"
                              : state.shieldedAt
                                ? `block ${state.shieldedAt}`
                                : state.shieldTx
                                  ? "check receipt"
                                  : "shield"}
                        </button>
                      </td>
                      <td>
                        {!state.shieldedAt ? (
                          <span style={{ color: "var(--ghost)" }}>—</span>
                        ) : state.stage === "invest-pending" ? (
                          <button
                            type="button"
                            className="chip"
                            onClick={() => checkInvest(i)}
                            disabled={busy !== null}
                          >
                            {busy === `check-invest-${i}` ? "checking…" : "check receipt"}
                          </button>
                        ) : !status.ready ? (
                          <span style={{ color: "var(--faint)" }}>maturing</span>
                        ) : !state.investDryRun ? (
                          <button
                            type="button"
                            className="chip"
                            onClick={() => dryRunInvest(i)}
                            disabled={!deployed || busy !== null}
                          >
                            {busy === `dryrun-invest-${i}` ? "proving…" : "dry run"}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="chip"
                            onClick={() => invest(i)}
                            disabled={busy !== null || state.stage === "invested"}
                          >
                            {busy === `invest-${i}`
                              ? "submitting…"
                              : state.stage === "invested"
                                ? "done ✓"
                                : "invest"}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <details style={{ marginTop: 22 }}>
            <summary className="status" style={{ cursor: "pointer" }}>
              inspect the actions sent to the wallet
            </summary>
            <pre
              className="mono"
              style={{
                marginTop: 14,
                padding: 16,
                border: "1px solid var(--line)",
                background: "#0a0a0a",
                fontSize: 12,
                overflowX: "auto",
                color: "var(--dim)",
              }}
            >
              {JSON.stringify(
                {
                  "stage 1 — shield": shieldActionsFor(schedule[0]),
                  "stage 2 — vault": deployed ? investActionsFor(schedule[0]) : "needs an anonymizer",
                },
                null,
                2,
              )}
            </pre>
          </details>
        </>
      )}

      {log.length > 0 && (
        <div style={{ marginTop: 26 }}>
          {log.map((l, i) => (
            <div
              key={i}
              className="mono"
              style={{
                fontSize: 12,
                color:
                  l.kind === "err" ? "var(--orange)" : l.kind === "ok" ? "var(--text)" : "var(--faint)",
                borderBottom: "1px solid var(--line-subtle)",
                padding: "7px 0",
                wordBreak: "break-all",
              }}
            >
              <span style={{ color: "var(--ghost)", marginRight: 10 }}>{l.at}</span>
              {l.line}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
