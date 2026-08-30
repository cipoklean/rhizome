import { useEffect, useMemo, useState } from "react";
import cfg from "../config/addresses.json";
import { TIMING_SAMPLE_BLOCKS, NOTE_MATURITY_BLOCKS } from "./config/constants.mjs";
import ExecutePanel from "./ExecutePanel.jsx";
import { buildRehearsalFallback } from "./lib/execution.mjs";
import FrontierChart from "./FrontierChart.jsx";
import { popularAmounts, roundTripCohort } from "./lib/cohorts.mjs";
import { DEFAULT_FEE_MODEL, FEE_MODELS, computeFrontier, recommend } from "./lib/frontier.mjs";
import { formatUnits, parseUnits } from "./lib/units.mjs";
import { loadPoolState } from "./lib/pool-state.mjs";
import {
  delayFrontier,
  formatDelay,
  recommendDelay,
} from "./lib/timing.mjs";

/**
 * Timing cover is judged on recent traffic only. This pool put roughly 80% of
 * its lifetime transactions into 2.5% of its life, and averaging that burst in
 * would promise company that will not be there today.
 */

const VERDICTS = {
  "already-covered": {
    title: "Don't split this.",
    body: "This amount already disappears into existing public legs on both sides of the pool. Splitting it would cost fees and buy nothing measurable.",
  },
  "split-earns-its-fee": {
    title: "Splitting earns its fee.",
    body: "Every leg below lands in a populated cohort going in and coming out, and the fees stay a small share of the position.",
  },
  "position-too-small": {
    title: "The fee dominates this position.",
    body: "Shielding still works, but the flat pool fee is a large share of what you are moving. Move more, or accept the cost knowingly.",
  },
  "best-affordable": {
    title: "No affordable schedule reaches good cover.",
    body: "This is the best available inside the fee budget. Legs flagged below still carry a distinctive amount on at least one leg.",
  },
};

const PRESETS = ["100", "1000", "5000", "50000"];

export default function App() {
  const [network, setNetwork] = useState("mainnet");
  const [state, setState] = useState({ status: "loading" });
  const [positionText, setPositionText] = useState("50000");
  const [feeModel, setFeeModel] = useState(DEFAULT_FEE_MODEL);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    loadPoolState(network, cfg, {
      onStale: (stale) => {
        if (!cancelled) setState({ status: "ready", ...stale, secondsPerBlock: null });
      },
    })
      .then((live) => {
        if (!cancelled) setState({ status: "ready", ...live, secondsPerBlock: live.secondsPerBlock ?? null });
      })
      .catch((e) => {
        if (!cancelled) setState((prev) => (prev.status === "ready" ? { ...prev, stale: false } : { status: "error", message: e.message }));
      });
    return () => {
      cancelled = true;
    };
  }, [network]);

  const stats = useMemo(() => {
    if (state.status !== "ready" || (!state.entryHist || state.entryHist.size === 0)) return null;
    const share = (hist) => {
      if (!hist) return null;
      const unique = [...hist.values()].filter((c) => c === 1).length;
      return { amounts: hist.size, unique, pct: (unique / hist.size) * 100 };
    };
    return {
      deposits: state.depositsCount ?? 0,
      exits: state.exitsCount ?? 0,
      withdrawals: state.withdrawalsCount ?? 0,
      feeLegs: state.feeLegsCount ?? 0,
      feeLegShare: state.withdrawalsCount ? (state.feeLegsCount / state.withdrawalsCount) * 100 : 0,
      entry: share(state.entryHist),
      exit: share(state.exitHist),
      popular: popularAmounts(state.entryHist, 8).map((p) =>
        roundTripCohort(state.entryHist, state.exitHist, p.amount),
      ),
    };
  }, [state]);

  const timing = useMemo(() => {
    if (state.status !== "ready" || !state.txBlocks?.length) return null;
    const sampleFrom = Math.max(0, state.block - TIMING_SAMPLE_BLOCKS);
    const rows = delayFrontier(state.txBlocks, {
      sampleFrom,
      secondsPerBlock: state.secondsPerBlock,
    });
    return {
      rows,
      rec: recommendDelay(rows),
      recent: state.txBlocks.filter((b) => b >= sampleFrom).length,
      total: state.txBlocks.length,
      floor: rows.find((r) => r.window === NOTE_MATURITY_BLOCKS) ?? null,
    };
  }, [state]);

  const analysis = useMemo(() => {
    if (state.status !== "ready" || !state.entryHist || state.entryHist.size === 0) return null;
    let position;
    try {
      position = parseUnits(positionText || "0", 18);
    } catch {
      return { error: "Not a valid amount." };
    }
    if (position <= 0n) return { error: "Enter an amount above zero." };

    const rows = computeFrontier({
      position,
      feeAmount: state.fee,
      hist: { entry: state.entryHist, exit: state.exitHist },
      feeModel,
    });
    if (rows.length === 0) {
      return { error: "The pool fee exceeds this position at every leg count." };
    }
    return { rows, rec: recommend(rows), position };
  }, [state, positionText, feeModel]);

  // Keep the verdict area from flashing empty while the frontier recomputes on
  // a heavy input change. The memo runs synchronously, so we flip a flag for
  // the frame(s) the inputs are settling, then clear it.
  const [computing, setComputing] = useState(false);
  useEffect(() => {
    setComputing(true);
    const id = setTimeout(() => setComputing(false), 120);
    return () => clearTimeout(id);
  }, [state, positionText, feeModel]);

  // Keyboard help overlay. "?" opens it; Esc closes. Ignore "?" typed into any
  // form field so it still types a question mark there.
  const [helpOpen, setHelpOpen] = useState(false);
  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") {
        setHelpOpen(false);
        return;
      }
      if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const t = e.target;
        const tag = t?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable) {
          return;
        }
        e.preventDefault();
        setHelpOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const executionPlan = useMemo(() => {
    const recommended = analysis?.rec?.schedule;
    if (recommended?.length) {
      return { schedule: recommended, source: "frontier", paidSubmissionAllowed: true };
    }

    // A free wallet action-shape dry run does not need a cohort frontier. On
    // Sepolia, synthesize one clearly labelled leg from the amount field so
    // Ready can prove the deposit action even if event analysis is loading,
    // unavailable, or cannot produce an affordable recommendation.
    if (network !== "sepolia" || state.status !== "ready" || !state.fee) {
      return { schedule: [], source: "none", paidSubmissionAllowed: false };
    }

    let amount;
    try {
      amount = parseUnits(positionText || "0", 18);
    } catch {
      return { schedule: [], source: "none", paidSubmissionAllowed: false };
    }

    const scored = state.entryHist
      ? roundTripCohort(state.entryHist, state.exitHist, amount)
      : {
          amount,
          entryCohort: 0,
          exitCohort: null,
          cohort: 0,
          distinctiveness: 1,
          exitKnown: false,
        };

    const schedule = buildRehearsalFallback({
      amount,
      feeAmount: state.fee,
      score: scored,
    });
    if (schedule.length === 0) {
      return { schedule: [], source: "none", paidSubmissionAllowed: false };
    }

    return {
      source: "sepolia-rehearsal",
      paidSubmissionAllowed: false,
      schedule,
    };
  }, [analysis, network, state, positionText]);

  const strk = (v) => formatUnits(v, 18, { maxFractionDigits: 4 });
  // Scale both bars by the strongest side of either direction. Exit cohorts can
  // dwarf entry cohorts (an amount common going in may be rare coming out);
  // scaling by entry alone pushes exit bars past 100% and through the border.
  const maxCohort = Math.max(
    1,
    ...(stats?.popular ?? []).map((p) => Math.max(p.entryCohort, p.exitCohort ?? 0)),
    ...(analysis?.rows ?? []).map((r) => r.minCohort),
  );

  return (
    <div className="wrap">
      <header className="hero">
        <p className="eyebrow">
          <b>◢</b> STRK20 PRIVATE SPRINT · RHIZOME
        </p>
        <h1>Private yield without leaving a fingerprint.</h1>
        <p className="sub">
          Rhizome picks STRK amounts that match what hundreds of others already deposited — so your move hides in the crowd.
        </p>
        <div className="how">
          <span className="how-step">
            <b>1</b> · Pick a crowd-sized amount
          </span>
          <span className="how-arrow">→</span>
          <span className="how-step">
            <b>2</b> · Pay the privacy fee
          </span>
          <span className="how-arrow">→</span>
          <span className="how-step">
            <b>3</b> · Wait for timing cover, then vault
          </span>
        </div>



        {state.status === "loading" && (
          <div className="hero-skeleton" aria-label="Loading pool data" role="status">
            <div className="hero-skeleton h1-skel skeleton" />
            <div className="skeleton-line" />
            <div className="skeleton-line" />
          </div>
        )}
        {state.status === "error" && (
                  <div className="error-state" role="alert">
                    <p className="err-title">Unable to reach Starknet RPC at {cfg[network].rpc[0]}.</p>
                    <p className="err-body">Check your connection, Retry, or switch to Sepolia.</p>
                    <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
                      <button className="chip" onClick={() => window.location.reload()} style={{ flex: 1 }}>Retry</button>
                      <button className="chip" style={{ flex: 1 }}>Switch to Sepolia</button>
                    </div>
                  </div>
                )}

        {state.status === "ready" && state.stale && (
                  <p className="status" style={{ marginTop: 18, direction: "ltr" }} role="status">
                    <span className="dot" style={{ opacity: 0.5 }} />
                    {state.source === "snapshot"
                      ? "Live RPC unavailable — showing pool snapshot from " + new Date(state.fetchedAt).toLocaleDateString() + ". Planning still works; execution re-checks live data when you connect."
                      : state.source === "cache"
                        ? "Cached data · fetched " + Math.floor((Date.now() - state.fetchedAt) / 60000) + " min ago — live tail fetch failed."
                        : state.source === "live"
                          ? "Live Starknet data · block " + state.block.toLocaleString()
                          : "from " + state.staleSource + ", updating…"}
                  </p>
                )}

        {state.status === "ready" && !state.stale && state.block > 0 && (
          <p className="status" style={{ marginTop: 8, fontSize: 11 }}>
            live at block {state.block.toLocaleString()} ·{" "}
            <button
              type="button"
              className="chip"
              style={{ padding: "4px 8px", fontSize: 10 }}
              onClick={() => {
                try {
                  // Compact cache keys live in pool-state.mjs; clear both old and compact
                  for (const suffix of ["", ":compact"]) {
                    const k = `rhizome:pool:v2${suffix}:${network}:${String((cfg[network].tokens?.STRK ?? "").toLowerCase())}`;
                    window.localStorage.removeItem(k);
                    // New prefix variant
                    const k2 = `rhizome:pool:v2:compact:${network}:${String((cfg[network].tokens?.STRK ?? "").toLowerCase())}`;
                    window.localStorage.removeItem(k2);
                  }
                } catch {}
                window.location.reload();
              }}
            >
              refresh pool data
            </button>
          </p>
        )}

        {state.status === "ready" && (
          <div className="strip">
            <div className="cell">
              <div className="k">Fee per step</div>
              <div className="v">
                {strk(state.fee)}
                <small>STRK</small>
              </div>
              <div className="note">flat, same no matter the size</div>
            </div>
            <div className="cell">
              <div className="k">Past moves checked</div>
              <div className="v">
                {stats ? (stats.deposits + stats.exits).toLocaleString() : "…"}
              </div>
              <div className="note">
                {stats ? `${stats.deposits.toLocaleString()} in · ${stats.exits.toLocaleString()} out` : ""} ·
                block {state.block.toLocaleString()}
              </div>
            </div>
            <div className="cell">
              <div className="k">Amounts used only once</div>
              <div className="v">
                {stats?.entry ? stats.entry.pct.toFixed(1) : "…"}
                <small>%</small>
              </div>
              <div className="note">
                {stats?.entry
                  ? `${stats.entry.unique.toLocaleString()} of ${stats.entry.amounts.toLocaleString()} amounts are unique, easy to trace`
                  : ""}
              </div>
            </div>
            <div className="cell">
              <div className="k">On the way out too</div>
              <div className="v">
                {stats?.exit ? stats.exit.pct.toFixed(1) : "…"}
                <small>%</small>
              </div>
              <div className="note">
                {stats?.exit
                  ? `${stats.exit.unique.toLocaleString()} of ${stats.exit.amounts.toLocaleString()} exit amounts are unique`
                  : "no exit data for this token"}
              </div>
            </div>
          </div>
        )}
        <button
          type="button"
          className="chip help-trigger"
          aria-haspopup="dialog"
          aria-expanded={helpOpen}
          onClick={() => setHelpOpen((v) => !v)}
          style={{ marginTop: 12, fontSize: 10 }}
        >
          ? shortcuts & glossary
        </button>
      </header>

      <section className="band" aria-labelledby="why-heading">
        <p className="eyebrow">
          <b>◢</b> WHY THIS MATTERS
        </p>
        <h2 id="why-heading">The pool hides who. Not how much.</h2>
        <p className="lede">
          Imagine the pool is a dark room. Everyone&apos;s deposits go in and withdrawals come out, but
          the amounts written on the door are still visible. If yours is the only <b>1,234.567</b>{" "}
          STRK in the room, it&apos;s you.{" "}
          <span className="mono" style={{ color: "var(--dim)", fontSize: 13 }}>
            Rhizome only reads that public door, never your private keys.
          </span>
        </p>

        <div className="cards">
          <div className="card">
            <div className="num">01</div>
            <h3>Your amount can give you away</h3>
            <p>
              Every deposit and withdrawal is public: who, which token, exact amount. A rare amount is
              a fingerprint the pool can&apos;t erase.
            </p>
          </div>
          <div className="card">
            <div className="num">02</div>
            <h3>In ≠ out</h3>
            <p>
              An amount can be common going in and rare going out. Rhizome checks both; the weaker
              side decides your safety.
            </p>
          </div>
          <div className="card">
            <div className="num">03</div>
            <h3>Privacy has a fee</h3>
            <p>
              Each step costs a flat fee (now 6 STRK). To keep two steps unlinkable you pay it twice.
              Splitting a small position can cost more than it protects.
            </p>
          </div>
          <div className="card">
            <div className="num">04</div>
            <h3>Sometimes the answer is &ldquo;don&apos;t&rdquo;</h3>
            <p>
              If the fee eats your position, Rhizome says so instead of selling you a schedule that
              isn&apos;t worth it.
            </p>
          </div>
        </div>
      </section>

      {stats && (
        <section className="band">
          <p className="eyebrow">
            <b>◢</b> WHAT HIDES YOU
          </p>
          <h2>Popular amounts are your camouflage.</h2>
          <p className="lede">
            A <b>cohort</b> = how many other people used the exact same amount. Bigger cohort = harder
            to single you out. Rhizome scores every amount on its <b>weaker side</b> (whichever is
            smaller: going in or coming out). The two bars show the difference.
            {stats.feeLegShare > 0 && (
              <>
                {" "}
                Fee reimbursements ({stats.feeLegShare.toFixed(1)}% of withdrawals) are excluded, so they
                cannot fake a huge cohort at exactly the fee amount.
              </>
            )}
          </p>

          <div className="bars" aria-label="Popular amount cohorts: each row shows an amount, its entry-cohort bar (going in), and its exit-cohort bar (coming out)">
            {stats.popular.map((p) => (
              <div className="bar-row" key={p.amount.toString()}>
                <div className="mono" style={{ fontSize: 13, color: "var(--dim)" }}>
                  {strk(p.amount)}
                </div>
                <div className="bar-stack">
                  <div className="bar-track">
                    <div
                      className="bar-fill"
                      style={{ width: `${Math.max(2, (p.entryCohort / maxCohort) * 100)}%` }}
                    />
                  </div>
                  <div className="bar-track thin">
                    <div
                      className="bar-fill exit"
                      style={{
                        width: `${Math.max(p.exitCohort ? 2 : 0, ((p.exitCohort ?? 0) / maxCohort) * 100)}%`,
                      }}
                    />
                  </div>
                </div>
                <div className="mono" style={{ fontSize: 13, textAlign: "right" }}>
                  {p.entryCohort} / {p.exitKnown ? p.exitCohort : "?"}
                </div>
              </div>
            ))}
          </div>
          <div className="bar-legend">
            <span>▬ going in (darker = more popular)</span>
            <span>▭ coming out</span>
            <span>number = others with same amount</span>
          </div>
        </section>
      )}

      <section className="band">
        <p className="eyebrow">
          <b>◢</b> YOUR PLAN
        </p>
        <h2>How much to split, and what it costs.</h2>
        <p className="lede">
          Enter your total STRK. Rhizome finds a way to split it into popular amounts, prices the fee,
          and picks the cheapest split worth doing.
        </p>

        <div className="controls">
          <label className="field">
            Your amount (STRK)
            <input
              type="text"
              inputMode="decimal"
              value={positionText}
              autoFocus
              onChange={(e) => setPositionText(e.target.value)}
              aria-label="Position in STRK"
            />
          </label>
          <label className="field">
            Network
            <select value={network} onChange={(e) => setNetwork(e.target.value)}>
              <option value="mainnet">mainnet</option>
              <option value="sepolia">sepolia: free test run</option>
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
                      <p className="ghost-text" style={{ fontSize: 11, color: "var(--dim)", marginTop: 4, direction: "ltr" }}>
                        100 = very common · 1,000 = common · 5,000 = uncommon · 50,000 = rare
                      </p>
                    </div>
        </div>

        <details className="advanced">
          <summary>Advanced: fee model, which costs are shown</summary>
          <label className="field" style={{ marginTop: 14 }}>
            Fee model
            <select value={feeModel} onChange={(e) => setFeeModel(e.target.value)}>
              {Object.entries(FEE_MODELS).map(([key, m]) => (
                              <option key={key} value={key} title={m.label}>
                                {m.label} — {m.txPerLeg} tx per leg
                              </option>
                            ))}
            </select>
          </label>
          <p className="status" style={{ marginTop: 10 }}>
            {FEE_MODELS[feeModel].note}
          </p>
        </details>

        {network !== "mainnet" && (
          <p className="status" style={{ marginTop: 12, color: "var(--orange)" }}>
            Sepolia is for free practice: different fee, tiny traffic, fake amounts. Read the real
            plan on mainnet, then rehearse it here.
          </p>
        )}

        {!analysis && state.status === "ready" && (
          <div className="error-state" role="status">
            <p className="err-title">No pool data yet</p>
            <p className="err-body">
              We couldn&apos;t find deposit history for this token. Try a different token, or
              switch to Sepolia to rehearse the flow with a free test run.
            </p>
          </div>
        )}
        {analysis?.error && (
          <div className="error-state" role="alert">
            <p className="err-title">Analysis error</p>
            <p className="err-body">{analysis.error}</p>
          </div>
        )}

        {computing && (
          <p className="computing" style={{ direction: "ltr", fontSize: 12, color: "var(--faint)", marginTop: 8 }}>
            computing…
          </p>
        )}

        {analysis?.rows && (
          <>
            <div className={`verdict ${analysis.rec.verdict}`}>
              <h3>{VERDICTS[analysis.rec.verdict]?.title ?? analysis.rec.verdict}</h3>
              <p>{VERDICTS[analysis.rec.verdict]?.body}</p>
              <div className="facts">
                              <span className="tag hot">
                                {analysis.rec.tranches === 1 ? "1 piece" : `${analysis.rec.tranches} pieces`}
                              </span>
                              <span className="tag">fee {strk(analysis.rec.feeCost)} STRK</span>
                              <span className="tag">
                                {(analysis.rec.feeCostRatio * 100).toFixed(2)}% of your amount
                              </span>
                              <span className="tag">
                                hides among {analysis.rec.minCohort} others at weakest
                              </span>
                            </div>
                            {analysis.rec.verdict === "position-too-small" && (
                              <p className="verdict-guidance" style={{ direction: "ltr", marginTop: 8, fontSize: 11 }}>
                                Fees would eat this position. Minimum ~10 STRK recommended — or{' '}
                                <button
                                  className="chip"
                                  style={{ marginLeft: 4, fontSize: 10 }}
                                  onClick={() => window.location.replace("?network=sepolia")}
                                >
                                  Switch to Sepolia
                                </button>
                              </p>
                            )}
                            <p className="status" style={{ marginTop: 12 }}>
                Round trip (in + out): {strk(analysis.rec.roundTripFeeCost)} STRK (
                {(analysis.rec.roundTripFeeCostRatio * 100).toFixed(2)}%).
              </p>
            </div>

            <FrontierChart rows={analysis.rows} chosen={analysis.rec.tranches} />

            {analysis.rec.tranches > 1 && (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Piece</th>
                      <th>Amount</th>
                      <th>Hides among (in / out)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.rec.schedule.map((leg, i) => (
                      <tr key={i}>
                        <td>{i + 1}</td>
                        <td>{strk(leg.amount)} STRK</td>
                        <td>
                          {leg.entryCohort} / {leg.exitKnown ? leg.exitCohort : "?"}
                          {!leg.covered && <span className="pill">rare, easier to trace</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <details className="advanced" style={{ marginTop: 22 }}>
              <summary>Show full comparison table</summary>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Pieces</th>
                      <th>Steps</th>
                      <th>Fee</th>
                      <th>% of amount</th>
                      <th>Weakest cohort</th>
                      <th>All common?</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.rows.map((r) => (
                      <tr
                        key={r.tranches}
                        className={r.tranches === analysis.rec.tranches ? "chosen" : ""}
                      >
                        <td>{r.tranches}</td>
                        <td>{r.poolTransactions}</td>
                        <td>{strk(r.feeCost)}</td>
                        <td>{(r.feeCostRatio * 100).toFixed(2)}%</td>
                        <td>{r.minCohort}</td>
                        <td>{r.allCovered ? "yes" : "no"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </>
        )}
      </section>

      {timing && (
        <section className="band">
          <p className="eyebrow">
            <b>◢</b> TIMING
          </p>
          <h2>Waiting is free, when others are moving.</h2>
          <p className="lede">
            Splitting hides the <b>amount</b>. Waiting hides the <b>timing</b>: it only works if
            someone else uses the pool while you wait. We checked the last{" "}
            {TIMING_SAMPLE_BLOCKS.toLocaleString()} blocks (~{formatDelay(TIMING_SAMPLE_BLOCKS, state.secondsPerBlock)}).
            The pool has {timing.total.toLocaleString()} moves ever, {timing.recent.toLocaleString()}{" "}
            recently; old bursts don&apos;t count for today.
          </p>

          <div className={`verdict ${timing.rec.verdict}`}>
            <h3>
              {timing.rec.verdict === "delay-earns-it"
                ? `Wait about ${formatDelay(timing.rec.window, state.secondsPerBlock)} between hiding and entering the vault.`
                : "This pool is quiet: timing won't hide you much right now."}
            </h3>
            <p>
              {timing.rec.verdict === "delay-earns-it"
                ? `That's ${timing.rec.window.toLocaleString()} blocks. At that wait, a move usually has ${timing.rec.medianCohort} others nearby, alone only ${(timing.rec.aloneShare * 100).toFixed(0)}% of the time.`
                : `Even waiting ${formatDelay(timing.rec.window, state.secondsPerBlock)} leaves you alone ${(timing.rec.aloneShare * 100).toFixed(0)}% of the time; the amount split is doing more work than the wait.`}
              {timing.floor && (
                <>
                  {" "}
                  At the minimum {NOTE_MATURITY_BLOCKS} blocks you&apos;re alone{" "}
                  <b>{(timing.floor.aloneShare * 100).toFixed(0)}%</b>; paying the extra fee to split
                  and then going immediately buys almost nothing.
                </>
              )}
            </p>
          </div>

          <details className="advanced" style={{ marginTop: 18 }}>
            <summary>Show timing table</summary>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Wait</th>
                    <th>~Time</th>
                    <th>Others nearby (median)</th>
                    <th>Alone</th>
                  </tr>
                </thead>
                <tbody>
                  {timing.rows.map((r) => (
                    <tr key={r.window} className={r.window === timing.rec.window ? "chosen" : ""}>
                      <td>
                        {r.window.toLocaleString()} blocks
                        {r.window === NOTE_MATURITY_BLOCKS && (
                          <span className="pill">minimum</span>
                        )}
                      </td>
                      <td>{formatDelay(r.window, state.secondsPerBlock)}</td>
                      <td>{r.medianCohort}</td>
                      <td>{(r.aloneShare * 100).toFixed(0)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </section>
      )}

      <ExecutePanel
        net={cfg[network]}
        network={network}
        token={cfg[network].tokens?.STRK ?? cfg.mainnet.tokens.STRK}
        schedule={executionPlan.schedule}
        scheduleSource={executionPlan.source}
        paidSubmissionAllowed={executionPlan.paidSubmissionAllowed}
        paidSubmissionReason={
          executionPlan.source === "sepolia-rehearsal"
            ? "The synthetic Sepolia leg is only an action-path rehearsal, not a cohort recommendation."
            : null
        }
        analysisError={analysis?.error ?? null}
        fee={state.fee ?? null}
        delay={timing?.rec ?? null}
        secondsPerBlock={state.secondsPerBlock ?? null}
      />

      <footer>
        <div className="meta">Rhizome reads only public pool data, never your private keys.</div>
        Your amounts and timing on the public door are visible by design. Rhizome makes the{" "}
        fingerprint harder to match; it can&apos;t make the amount itself private, because the pool
        doesn&apos;t. <a href="https://github.com/cipoklean/rhizome">Source</a> ·{" "}
        <a href="https://strk20.starknet.io/hackathon">STRK20 Private Sprint</a>
      </footer>

      {helpOpen && (
        <div
          className="help-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Shortcuts and glossary"
          onClick={(e) => {
            if (e.target === e.currentTarget) setHelpOpen(false);
          }}
        >
          <div className="help-card">
            <div className="help-head">
              <h3>Shortcuts & glossary</h3>
              <button type="button" className="chip" onClick={() => setHelpOpen(false)} aria-label="Close">
                Esc
              </button>
            </div>
            <h4>Shortcuts</h4>
            <ul>
              <li><kbd>?</kbd> open / close this panel</li>
              <li><kbd>Esc</kbd> close this panel</li>
              <li>Use the number-input arrows on any amount field for quick steps.</li>
            </ul>
            <h4>Glossary</h4>
            <dl>
              <dt>Cohort</dt>
              <dd>How many other people used the exact same amount. Bigger cohort = harder to single you out. Rhizome scores every amount on its weaker side (whichever is smaller: going in or coming out).</dd>
              <dt>Distinctiveness</dt>
              <dd>How unique your amount is versus the crowd. 0 is invisible, 1 is a one-of-a-kind fingerprint. Lower is better; Rhizome targets 0.05 or below.</dd>
              <dt>Frontier</dt>
              <dd>The cost/unlinkability trade-off: every way to split your position into tranches, scored by cohort cover and total pool fees. The plan picks the cheapest split that reaches good cover.</dd>
            </dl>
          </div>
        </div>
      )}
    </div>
  );
}
