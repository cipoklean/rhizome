import { useEffect, useMemo, useState } from "react";
import cfg from "../config/addresses.json";
import { amountHistogram, popularAmounts } from "./lib/cohorts.mjs";
import { computeFrontier, recommend } from "./lib/frontier.mjs";
import { connect, fetchDeposits, getFeeAmount } from "./lib/pool.mjs";
import { formatUnits, parseUnits } from "./lib/units.mjs";

const VERDICTS = {
  "already-covered": {
    title: "Don't split this.",
    body: "This amount already blends into existing public deposits. Splitting it would cost fees and buy nothing.",
  },
  "split-earns-its-fee": {
    title: "Splitting is worth it here.",
    body: "Each leg below sits in a populated cohort, and the fees are a small share of the position.",
  },
  "position-too-small": {
    title: "The fee dominates this position.",
    body: "Shielding still works, but the flat pool fee is a large share of what you're moving. Consider a larger position, or accept the cost knowingly.",
  },
  "best-affordable": {
    title: "No affordable schedule reaches good cover.",
    body: "This is the best available within the fee budget. Legs marked below still carry a distinctive amount.",
  },
};

export default function App() {
  const [network, setNetwork] = useState("mainnet");
  const [state, setState] = useState({ status: "loading" });
  const [positionText, setPositionText] = useState("50000");

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

    (async () => {
      try {
        const net = cfg[network];
        const provider = await connect(net.rpc);
        const [block, fee] = await Promise.all([
          provider.getBlockNumber(),
          getFeeAmount(provider, net.strk20Pool),
        ]);
        const token = net.tokens?.STRK ?? cfg.mainnet.tokens.STRK;
        const deposits = await fetchDeposits(provider, net.strk20Pool, { token });
        if (cancelled) return;
        setState({ status: "ready", block, fee, deposits, hist: amountHistogram(deposits) });
      } catch (e) {
        if (!cancelled) setState({ status: "error", message: e.message });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [network]);

  const analysis = useMemo(() => {
    if (state.status !== "ready" || state.deposits.length === 0) return null;
    let position;
    try {
      position = parseUnits(positionText || "0", 18);
    } catch {
      return { error: "Not a valid amount." };
    }
    if (position <= 0n) return { error: "Enter an amount above zero." };

    const rows = computeFrontier({ position, feeAmount: state.fee, hist: state.hist });
    if (rows.length === 0) {
      return { error: "The pool fee exceeds this position at every tranche count." };
    }
    return { rows, rec: recommend(rows), position };
  }, [state, positionText]);

  const stats = useMemo(() => {
    if (state.status !== "ready" || state.deposits.length === 0) return null;
    const hist = state.hist;
    const unique = [...hist.values()].filter((c) => c === 1).length;
    return {
      deposits: state.deposits.length,
      depositors: new Set(state.deposits.map((d) => d.user)).size,
      amounts: hist.size,
      unique,
      uniquePct: (unique / hist.size) * 100,
      popular: popularAmounts(hist, 6),
    };
  }, [state]);

  const strk = (v) => formatUnits(v, 18, { maxFractionDigits: 4 });

  return (
    <div className="wrap">
      <header className="top">
        <h1>Rhizome</h1>
        <p className="tag">
          What unlinkability costs on the STRK20 privacy pool — measured, not assumed.
        </p>
      </header>

      <section className="panel">
        <h2>The pool, right now</h2>
        <p className="lede">
          Read live from the pool contract. Nothing here is hardcoded — the fee is
          admin-settable and has already changed once during this project.
        </p>

        {state.status === "loading" && <p className="dim">Reading pool state…</p>}
        {state.status === "error" && <p className="err">Could not reach the pool: {state.message}</p>}

        {state.status === "ready" && (
          <>
            <div className="stats">
              <div className="stat">
                <div className="k">Network</div>
                <div className="v">
                  <select value={network} onChange={(e) => setNetwork(e.target.value)}>
                    <option value="mainnet">mainnet</option>
                    <option value="sepolia">sepolia</option>
                  </select>
                </div>
              </div>
              <div className="stat">
                <div className="k">Block</div>
                <div className="v mono">{state.block.toLocaleString()}</div>
              </div>
              <div className="stat">
                <div className="k">Fee per operation</div>
                <div className="v mono">{strk(state.fee)} STRK</div>
              </div>
              <div className="stat">
                <div className="k">Public STRK deposits</div>
                <div className="v mono">{stats ? stats.deposits.toLocaleString() : "—"}</div>
              </div>
            </div>
            <p className="lede" style={{ marginTop: 14, marginBottom: 0 }}>
              The fee is <strong>deducted from the deposited amount</strong>, not charged on top: to
              end up with N shielded you deposit N + {strk(state.fee)}.
            </p>
          </>
        )}
      </section>

      {stats && (
        <section className="panel">
          <h2>Are you a fingerprint?</h2>
          <p className="lede">
            The pool hides who paid whom inside it. It does not hide the amounts on the public legs.
            An amount nobody else has used survives the pool and reappears on the way out.
          </p>
          <div className="stats">
            <div className="stat">
              <div className="k">Distinct depositors</div>
              <div className="v mono">{stats.depositors.toLocaleString()}</div>
            </div>
            <div className="stat">
              <div className="k">Distinct amounts</div>
              <div className="v mono">{stats.amounts.toLocaleString()}</div>
            </div>
            <div className="stat">
              <div className="k">One-of-a-kind amounts</div>
              <div className="v mono">
                {stats.unique.toLocaleString()}{" "}
                <span className="dim" style={{ fontSize: 14 }}>
                  ({stats.uniquePct.toFixed(1)}%)
                </span>
              </div>
            </div>
          </div>

          <p className="lede" style={{ marginTop: 18, marginBottom: 8 }}>
            Amounts with the most public cover:
          </p>
          <table>
            <thead>
              <tr>
                <th>Amount</th>
                <th>Deposits sharing it</th>
              </tr>
            </thead>
            <tbody>
              {stats.popular.map((p) => (
                <tr key={p.amount.toString()}>
                  <td className="mono">{strk(p.amount)} STRK</td>
                  <td className="mono">{p.cohort}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="panel">
        <h2>The frontier</h2>
        <p className="lede">
          Splitting a position into legs reduces how distinctive each public leg is. The protocol
          allows at most one external invoke per pool transaction, so every leg is another
          transaction and another flat fee. This is that trade, priced.
        </p>

        <label className="field">
          Position (STRK)
          <input
            type="text"
            inputMode="decimal"
            value={positionText}
            onChange={(e) => setPositionText(e.target.value)}
          />
        </label>

        {!analysis && <p className="dim">Waiting on pool data…</p>}
        {analysis?.error && <p className="err">{analysis.error}</p>}

        {analysis?.rows && (
          <>
            <table style={{ marginTop: 14 }}>
              <thead>
                <tr>
                  <th>Legs</th>
                  <th>Fee cost</th>
                  <th>Fee % of position</th>
                  <th>Weakest leg cohort</th>
                  <th>Fully covered</th>
                </tr>
              </thead>
              <tbody>
                {analysis.rows.map((r) => (
                  <tr
                    key={r.tranches}
                    className={r.tranches === analysis.rec.tranches ? "chosen" : ""}
                  >
                    <td className="mono">{r.tranches}</td>
                    <td className="mono">{strk(r.feeCost)} STRK</td>
                    <td className="mono">{(r.feeCostRatio * 100).toFixed(2)}%</td>
                    <td className="mono">{r.minCohort}</td>
                    <td>{r.allCovered ? "yes" : <span className="pill no-cover">no</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className={`verdict ${analysis.rec.verdict}`}>
              <strong>{VERDICTS[analysis.rec.verdict]?.title ?? analysis.rec.verdict}</strong>
              {VERDICTS[analysis.rec.verdict]?.body}
              <div style={{ marginTop: 8 }} className="mono">
                {analysis.rec.tranches} leg{analysis.rec.tranches === 1 ? "" : "s"} ·{" "}
                {strk(analysis.rec.feeCost)} STRK in fees ·{" "}
                {(analysis.rec.feeCostRatio * 100).toFixed(2)}% of position
              </div>
            </div>

            {analysis.rec.tranches > 1 && (
              <table style={{ marginTop: 16 }}>
                <thead>
                  <tr>
                    <th>Leg</th>
                    <th>Amount</th>
                    <th>Cohort</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.rec.schedule.map((leg, i) => (
                    <tr key={i}>
                      <td className="mono">{i + 1}</td>
                      <td className="mono">{strk(leg.amount)} STRK</td>
                      <td className="mono">
                        {leg.cohort}{" "}
                        {!leg.covered && <span className="pill no-cover">no cover</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </section>

      <footer>
        Rhizome reads only public pool state — the live fee and public <code>Deposit</code> amounts.
        It never sees a viewing key. Deposits, withdrawals, timing and open-note amounts are public
        by design; Rhizome claims reduced correlatability, not amount privacy.{" "}
        <a href="https://github.com/cipoklean/rhizome">Source</a>
      </footer>
    </div>
  );
}
