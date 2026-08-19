import { useState } from "react";
import {
  OPERATION,
  buildTrancheActions,
  checkStrk20Support,
  connectWallet,
  dryRun,
  execute,
  listWallets,
  shieldedBalances,
} from "./lib/wallet.mjs";
import { formatUnits } from "./lib/units.mjs";

/**
 * Execution panel.
 *
 * Deliberately gated: nothing can be submitted until a dry run has passed. The
 * pool charges a flat fee per operation whether or not the calldata was right,
 * so `strk20PrepareInvoke` — which builds and proves without submitting — is the
 * only sane way to find a mistake.
 */
export default function ExecutePanel({ net, network, schedule, token }) {
  const [wallets, setWallets] = useState(null);
  const [account, setAccount] = useState(null);
  const [support, setSupport] = useState(null);
  const [balances, setBalances] = useState(null);
  const [shape, setShape] = useState("implicit");
  const [busy, setBusy] = useState(null);
  const [log, setLog] = useState([]);
  const [dryRunPassed, setDryRunPassed] = useState(false);

  const anonymizer = net.anonymizer;
  const vToken = net.vesu?.vTokens?.STRK ?? null;
  const say = (line, kind = "info") =>
    setLog((l) => [{ line, kind, at: new Date().toLocaleTimeString() }, ...l].slice(0, 12));

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
    setDryRunPassed(false);
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

  const actionsForLeg = (leg) =>
    buildTrancheActions({
      anonymizer,
      inToken: token,
      outToken: vToken,
      amount: leg.amount,
      recipient: account?.address ?? "0x0",
      operation: OPERATION.Deposit,
      shape,
    });

  async function doDryRun() {
    if (!account || !schedule?.length) return;
    setBusy("dryrun");
    try {
      const actions = actionsForLeg(schedule[0]);
      await dryRun(account, actions);
      setDryRunPassed(true);
      say(`Dry run passed for leg 1 (${shape}). Execution unlocked.`, "ok");
    } catch (e) {
      setDryRunPassed(false);
      say(`Dry run rejected (${shape}): ${e.message}`, "err");
    } finally {
      setBusy(null);
    }
  }

  async function runLeg(i) {
    if (!account || !dryRunPassed) return;
    setBusy(`leg-${i}`);
    try {
      const { transaction_hash } = await execute(account, actionsForLeg(schedule[i]));
      say(`Leg ${i + 1} submitted: ${transaction_hash}`, "ok");
    } catch (e) {
      say(`Leg ${i + 1} failed: ${e.message}`, "err");
    } finally {
      setBusy(null);
    }
  }

  const strk = (v) => formatUnits(v, 18, { maxFractionDigits: 4 });
  const ready = Boolean(account && support?.supported);
  const deployed = Boolean(anonymizer);

  return (
    <section className="band">
      <p className="eyebrow">
        <b>◢</b> EXECUTE
      </p>
      <h2>Run the schedule.</h2>
      <p className="lede">
        The wallet holds the viewing key, discovers the notes, proves the transaction and submits it.
        Rhizome only describes the actions. Every leg is one pool transaction, so every leg costs one
        flat fee — which is why nothing here submits until a dry run has passed.
      </p>

      {!deployed && (
        <p className="err" style={{ marginTop: 24 }}>
          No anonymizer deployed on {network} yet. Deploy it before running a schedule here.
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
            Action shape
            <select value={shape} onChange={(e) => { setShape(e.target.value); setDryRunPassed(false); }}>
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

      {ready && deployed && schedule?.length > 0 && (
        <>
          <div className="controls">
            <button
              type="button"
              className="chip"
              onClick={doDryRun}
              disabled={busy === "dryrun"}
              aria-pressed={dryRunPassed}
            >
              {busy === "dryrun" ? "proving…" : dryRunPassed ? "dry run passed ✓" : "Dry run leg 1 (free) →"}
            </button>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Leg</th>
                  <th>Amount</th>
                  <th>Cohort</th>
                  <th>Run</th>
                </tr>
              </thead>
              <tbody>
                {schedule.map((leg, i) => (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td>{strk(leg.amount)} STRK</td>
                    <td>{leg.cohort}</td>
                    <td>
                      <button
                        type="button"
                        className="chip"
                        onClick={() => runLeg(i)}
                        disabled={!dryRunPassed || busy !== null}
                      >
                        {busy === `leg-${i}` ? "submitting…" : "run"}
                      </button>
                    </td>
                  </tr>
                ))}
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
              {JSON.stringify(actionsForLeg(schedule[0]), null, 2)}
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
                color: l.kind === "err" ? "var(--orange)" : l.kind === "ok" ? "var(--text)" : "var(--faint)",
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
