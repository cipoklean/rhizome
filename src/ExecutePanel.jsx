import { useEffect, useState } from "react";
import { connect } from "./lib/pool.mjs";
import { FEE_MODELS } from "./lib/frontier.mjs";
import { NOTE_MATURITY_BLOCKS, formatDelay } from "./lib/timing.mjs";
import { formatUnits } from "./lib/units.mjs";
import {
  OPERATION,
  buildShieldActions,
  buildTrancheActions,
  checkStrk20Support,
  confirm,
  connectWallet,
  dryRun,
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
  token,
  fee,
  feeModel,
  delay,
  secondsPerBlock,
}) {
  const [wallets, setWallets] = useState(null);
  const [account, setAccount] = useState(null);
  const [support, setSupport] = useState(null);
  const [balances, setBalances] = useState(null);
  const [shape, setShape] = useState("implicit");
  const [busy, setBusy] = useState(null);
  const [log, setLog] = useState([]);
  const [shieldDryRun, setShieldDryRun] = useState(false);
  const [block, setBlock] = useState(null);
  // Per-leg progress: { [index]: { stage, shieldTx, shieldedAt, investDryRun, investTx } }
  const [legs, setLegs] = useState({});

  const anonymizer = net.anonymizer;
  const vToken = net.vesu?.vTokens?.STRK ?? null;
  const txPerLeg = FEE_MODELS[feeModel]?.txPerLeg ?? 1;
  const delayBlocks = Math.max(NOTE_MATURITY_BLOCKS, delay?.window ?? NOTE_MATURITY_BLOCKS);

  const say = (line, kind = "info") =>
    setLog((l) => [{ line, kind, at: new Date().toLocaleTimeString() }, ...l].slice(0, 14));

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
      const acc = await connectWallet(wallet, net.rpc[0]);
      setAccount(acc);
      say(`Connected ${wallet.name} · ${acc.address.slice(0, 10)}…`);

      const tokens = [token, vToken].filter(Boolean);
      const b = await shieldedBalances(acc, tokens);
      setBalances(b);
      say("Read shielded balances through the wallet.");
    } catch (e) {
      say(`Connect failed: ${e.message}`, "err");
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
      shape,
    });

  const patch = (i, fields) => setLegs((l) => ({ ...l, [i]: { ...(l[i] ?? {}), ...fields } }));

  /** Stage 0: prove the shield shape once, for free, before spending a fee on it. */
  async function dryRunShield() {
    if (!account || !schedule?.length) return;
    setBusy("dryrun-shield");
    try {
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

  /** Stage 1: the public deposit leg — the amount the analysis chose. */
  async function shield(i) {
    if (!account || !shieldDryRun) return;
    setBusy(`shield-${i}`);
    patch(i, { stage: "shielding" });
    try {
      say(`Leg ${i + 1}: shielding ${strk(schedule[i].amount)} STRK — expect two prompts (approve, then deposit).`);
      const { transaction_hash } = await execute(account, shieldActionsFor(schedule[i]));
      patch(i, { shieldTx: transaction_hash });
      say(`Leg ${i + 1} shield submitted: ${transaction_hash}`, "ok");

      const provider = await connect(net.rpc);
      const result = await confirm(provider, transaction_hash);
      const at = await provider.getBlockNumber();
      patch(i, { stage: "shielded", shieldedAt: at });
      say(
        result.confirmed
          ? `Leg ${i + 1} shielded at block ${at}. Vault action unlocks in ${delayBlocks} blocks (${formatDelay(delayBlocks, secondsPerBlock)}).`
          : `Leg ${i + 1} shield still pending; treating block ${at} as the start of the wait.`,
        result.confirmed ? "ok" : "info",
      );
    } catch (e) {
      patch(i, { stage: "failed" });
      say(`Leg ${i + 1} shield failed: ${e.message}`, "err");
    } finally {
      setBusy(null);
    }
  }

  /** Stage 2 gate: prove the invoke shape now that there is a note to spend. */
  async function dryRunInvest(i) {
    if (!account) return;
    setBusy(`dryrun-invest-${i}`);
    try {
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
  async function invest(i) {
    if (!account || !legs[i]?.investDryRun) return;
    setBusy(`invest-${i}`);
    try {
      const { transaction_hash } = await execute(account, investActionsFor(schedule[i]));
      patch(i, { stage: "invested", investTx: transaction_hash });
      say(`Leg ${i + 1} vault action submitted: ${transaction_hash}`, "ok");
    } catch (e) {
      say(`Leg ${i + 1} vault action failed: ${e.message}`, "err");
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
    if (leg.stage === "failed") return { label: "failed", done: false };
    if (!leg.shieldedAt) {
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
        <div className="facts" style={{ marginTop: 22 }}>
          <span className={`tag ${delay.verdict === "delay-earns-it" ? "hot" : ""}`}>
            wait {delayBlocks} blocks · {formatDelay(delayBlocks, secondsPerBlock)}
          </span>
          <span className="tag">median {delay.medianCohort} other pool tx in that window</span>
          <span className="tag">alone {(delay.aloneShare * 100).toFixed(0)}% of the time</span>
          {block !== null && <span className="tag">block {block.toLocaleString()}</span>}
        </div>
      )}

      {!deployed && (
        <p className="err" style={{ marginTop: 24 }}>
          No anonymizer{vToken ? "" : " or Vesu vault"} configured for {network}. Stage 1 (shielding)
          would still work; stage 2 needs the helper deployed here.
        </p>
      )}

      <div className="controls">
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
            Vault action shape
            <select
              value={shape}
              onChange={(e) => {
                setShape(e.target.value);
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
                          onClick={() => shield(i)}
                          disabled={!shieldDryRun || busy !== null || Boolean(state.shieldedAt)}
                        >
                          {busy === `shield-${i}`
                            ? "submitting…"
                            : state.shieldedAt
                              ? `block ${state.shieldedAt}`
                              : "shield"}
                        </button>
                      </td>
                      <td>
                        {!state.shieldedAt ? (
                          <span style={{ color: "var(--ghost)" }}>—</span>
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
