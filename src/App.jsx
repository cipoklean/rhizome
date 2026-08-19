import { useEffect, useMemo, useState } from "react";
import cfg from "../config/addresses.json";
import ExecutePanel from "./ExecutePanel.jsx";
import FrontierChart from "./FrontierChart.jsx";
import { amountHistogram, popularAmounts } from "./lib/cohorts.mjs";
import { computeFrontier, recommend } from "./lib/frontier.mjs";
import { connect, fetchDeposits, getFeeAmount } from "./lib/pool.mjs";
import { formatUnits, parseUnits } from "./lib/units.mjs";

const VERDICTS = {
  "already-covered": {
    title: "Don't split this.",
    body: "This amount already disappears into existing public deposits. Splitting it would cost fees and buy nothing measurable.",
  },
  "split-earns-its-fee": {
    title: "Splitting earns its fee.",
    body: "Every leg below lands in a populated cohort, and the fees stay a small share of the position.",
  },
  "position-too-small": {
    title: "The fee dominates this position.",
    body: "Shielding still works, but the flat pool fee is a large share of what you are moving. Move more, or accept the cost knowingly.",
  },
  "best-affordable": {
    title: "No affordable schedule reaches good cover.",
    body: "This is the best available inside the fee budget. Legs flagged below still carry a distinctive amount.",
  },
};

const PRESETS = ["100", "1000", "5000", "50000"];

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
      popular: popularAmounts(hist, 8),
    };
  }, [state]);

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
      return { error: "The pool fee exceeds this position at every leg count." };
    }
    return { rows, rec: recommend(rows), position };
  }, [state, positionText]);

  const strk = (v) => formatUnits(v, 18, { maxFractionDigits: 4 });
  const maxCohort = stats?.popular?.[0]?.cohort ?? 1;

  return (
    <div className="wrap">
      <header className="hero">
        <p className="eyebrow">
          <b>◢</b> STRK20 PRIVATE SPRINT · RHIZOME
        </p>
        <h1>Privacy has a price. Rhizome measures it.</h1>
        <p className="sub">
          The STRK20 pool hides who paid whom. It does not hide the amounts on the public legs — and
          on mainnet, most of those amounts are unique enough to identify you. Rhizome reads the live
          fee and every public deposit, prices what unlinkability actually costs, and refuses to
          recommend it when it isn&apos;t worth paying for.
        </p>

        {state.status === "loading" && (
          <p className="status" style={{ marginTop: 34 }}>
            <span className="dot" />
            reading pool state…
          </p>
        )}
        {state.status === "error" && (
          <p className="err" style={{ marginTop: 34 }}>
            could not reach the pool — {state.message}
          </p>
        )}

        {state.status === "ready" && (
          <div className="strip">
            <div className="cell">
              <div className="k">Pool fee / operation</div>
              <div className="v">
                {strk(state.fee)}
                <small>STRK</small>
              </div>
              <div className="note">deducted from the deposit, not added on top</div>
            </div>
            <div className="cell">
              <div className="k">Public deposits read</div>
              <div className="v">{stats ? stats.deposits.toLocaleString() : "—"}</div>
              <div className="note">
                {network} · block {state.block.toLocaleString()}
              </div>
            </div>
            <div className="cell">
              <div className="k">Amounts that are fingerprints</div>
              <div className="v">
                {stats ? stats.uniquePct.toFixed(1) : "—"}
                <small>%</small>
              </div>
              <div className="note">
                {stats ? `${stats.unique.toLocaleString()} of ${stats.amounts.toLocaleString()} used once` : ""}
              </div>
            </div>
          </div>
        )}
      </header>

      <section className="band">
        <p className="eyebrow">
          <b>◢</b> THE LEAK
        </p>
        <h2>The pool hides who. Not how much.</h2>
        <p className="lede">
          Shielding and withdrawing are public ERC-20 legs: address, token, amount. Movement inside
          the pool is private, but an amount nobody else has ever used survives that and reappears on
          the way out. Rhizome only ever reads this public side — it never touches a viewing key.
        </p>

        <div className="cards">
          <div className="card">
            <div className="num">01</div>
            <h3>Your amount is the leak</h3>
            <p>
              Deposits publish the depositor, the token and the exact amount. Pick a number nobody
              else has used and the pool cannot help you.
            </p>
          </div>
          <div className="card">
            <div className="num">02</div>
            <h3>Splitting costs real money</h3>
            <p>
              The protocol permits at most one external invoke per pool transaction, so every leg is
              another transaction and another flat fee.
            </p>
          </div>
          <div className="card">
            <div className="num">03</div>
            <h3>So the answer is often no</h3>
            <p>
              Below a certain size the fee outruns the benefit. Rhizome will tell you to leave it
              alone rather than sell you a schedule.
            </p>
          </div>
        </div>
      </section>

      {stats && (
        <section className="band">
          <p className="eyebrow">
            <b>◢</b> COHORTS
          </p>
          <h2>Where the cover actually is.</h2>
          <p className="lede">
            A cohort is how many other deposits carry the exact same amount. These are the
            denominations the pool has grown organically — the only amounts that come with cover
            already attached.
          </p>

          <div className="bars">
            {stats.popular.map((p) => (
              <div className="bar-row" key={p.amount.toString()}>
                <div className="mono" style={{ fontSize: 13, color: "var(--dim)" }}>
                  {strk(p.amount)}
                </div>
                <div className="bar-track">
                  <div
                    className="bar-fill"
                    style={{ width: `${Math.max(2, (p.cohort / maxCohort) * 100)}%` }}
                  />
                </div>
                <div className="mono" style={{ fontSize: 13, textAlign: "right" }}>
                  {p.cohort}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="band">
        <p className="eyebrow">
          <b>◢</b> THE FRONTIER
        </p>
        <h2>What cover costs, priced.</h2>
        <p className="lede">
          Enter a position. Rhizome builds schedules out of amounts that already have cover, prices
          each one at the live fee, and marks the schedule it would actually run.
        </p>

        <div className="controls">
          <label className="field">
            Position (STRK)
            <input
              type="text"
              inputMode="decimal"
              value={positionText}
              onChange={(e) => setPositionText(e.target.value)}
              aria-label="Position in STRK"
            />
          </label>
          <label className="field">
            Network
            <select value={network} onChange={(e) => setNetwork(e.target.value)}>
              <option value="mainnet">mainnet</option>
              <option value="sepolia">sepolia</option>
            </select>
          </label>
          <div className="chips">
            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                className="chip"
                aria-pressed={positionText === p}
                onClick={() => setPositionText(p)}
              >
                {Number(p).toLocaleString()}
              </button>
            ))}
          </div>
        </div>

        {!analysis && state.status === "ready" && <p className="status">no deposits for this token yet.</p>}
        {analysis?.error && <p className="err">{analysis.error}</p>}

        {analysis?.rows && (
          <>
            <div className={`verdict ${analysis.rec.verdict}`}>
              <h3>{VERDICTS[analysis.rec.verdict]?.title ?? analysis.rec.verdict}</h3>
              <p>{VERDICTS[analysis.rec.verdict]?.body}</p>
              <div className="facts">
                <span className="tag hot">
                  {analysis.rec.tranches} leg{analysis.rec.tranches === 1 ? "" : "s"}
                </span>
                <span className="tag">{strk(analysis.rec.feeCost)} STRK in fees</span>
                <span className="tag">
                  {(analysis.rec.feeCostRatio * 100).toFixed(2)}% of position
                </span>
                <span className="tag">weakest cohort {analysis.rec.minCohort}</span>
              </div>
            </div>

            <FrontierChart rows={analysis.rows} chosen={analysis.rec.tranches} />

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Legs</th>
                    <th>Fee cost</th>
                    <th>% of position</th>
                    <th>Weakest cohort</th>
                    <th>Fully covered</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.rows.map((r) => (
                    <tr
                      key={r.tranches}
                      className={r.tranches === analysis.rec.tranches ? "chosen" : ""}
                    >
                      <td>{r.tranches}</td>
                      <td>{strk(r.feeCost)}</td>
                      <td>{(r.feeCostRatio * 100).toFixed(2)}%</td>
                      <td>{r.minCohort}</td>
                      <td>{r.allCovered ? "yes" : "no"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {analysis.rec.tranches > 1 && (
              <div className="table-wrap">
                <table>
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
                        <td>{i + 1}</td>
                        <td>{strk(leg.amount)} STRK</td>
                        <td>
                          {leg.cohort}
                          {!leg.covered && <span className="pill">no cover</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>

      <ExecutePanel
        net={cfg[network]}
        network={network}
        token={cfg[network].tokens?.STRK ?? cfg.mainnet.tokens.STRK}
        schedule={analysis?.rec?.schedule ?? []}
      />

      <footer>
        <div className="meta">
          Honest accounting · reads public state only · no viewing key
        </div>
        Deposits, withdrawals, timing and open-note amounts are public by design. Rhizome claims
        reduced correlatability on the public legs — not amount privacy, which the pool does not
        provide and no scheduling strategy can create.{" "}
        <a href="https://github.com/cipoklean/rhizome">Source</a> ·{" "}
        <a href="https://strk20.starknet.io/hackathon">STRK20 Private Sprint</a>
      </footer>
    </div>
  );
}
