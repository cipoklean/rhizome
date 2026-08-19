import { useEffect, useMemo, useState } from "react";
import cfg from "../config/addresses.json";
import ExecutePanel from "./ExecutePanel.jsx";
import FrontierChart from "./FrontierChart.jsx";
import { amountHistogram, popularAmounts, roundTripCohort } from "./lib/cohorts.mjs";
import { DEFAULT_FEE_MODEL, FEE_MODELS, computeFrontier, recommend } from "./lib/frontier.mjs";
import {
  classifyWithdrawals,
  connect,
  fetchDeposits,
  fetchFeeHistory,
  fetchWithdrawals,
  getFeeAmount,
} from "./lib/pool.mjs";
import { formatUnits, parseUnits } from "./lib/units.mjs";
import {
  NOTE_MATURITY_BLOCKS,
  delayFrontier,
  formatDelay,
  measureBlockTime,
  poolTransactionBlocks,
  recommendDelay,
} from "./lib/timing.mjs";

/**
 * Timing cover is judged on recent traffic only. This pool put roughly 80% of
 * its lifetime transactions into 2.5% of its life, and averaging that burst in
 * would promise company that will not be there today.
 */
const TIMING_SAMPLE_BLOCKS = 500000;

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

    (async () => {
      try {
        const net = cfg[network];
        const provider = await connect(net.rpc);
        const [block, fee, feeHistory, secondsPerBlock] = await Promise.all([
          provider.getBlockNumber(),
          getFeeAmount(provider, net.strk20Pool),
          fetchFeeHistory(provider, net.strk20Pool),
          measureBlockTime(provider).catch(() => null),
        ]);
        const token = net.tokens?.STRK ?? cfg.mainnet.tokens.STRK;
        const [deposits, withdrawals] = await Promise.all([
          fetchDeposits(provider, net.strk20Pool, { token }),
          fetchWithdrawals(provider, net.strk20Pool, { token }),
        ]);
        if (cancelled) return;

        // The pool settles its own fee with an extra withdraw leg back to a fee
        // router, so most public withdrawals are fee reimbursement rather than
        // anybody's position. Counting them as cover would invent a cohort of
        // thousands at exactly the fee amount. They are still useful as a census
        // of pool transactions, which is what timing cover is measured against.
        const { positions: exits, feeLegs } = classifyWithdrawals(withdrawals, feeHistory);

        setState({
          status: "ready",
          block,
          fee,
          feeHistory,
          secondsPerBlock,
          deposits,
          exits,
          txBlocks: poolTransactionBlocks(feeLegs),
          feeLegs: feeLegs.length,
          withdrawals: withdrawals.length,
          entryHist: amountHistogram(deposits),
          exitHist: exits.length > 0 ? amountHistogram(exits) : null,
        });
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
    const share = (hist) => {
      if (!hist) return null;
      const unique = [...hist.values()].filter((c) => c === 1).length;
      return { amounts: hist.size, unique, pct: (unique / hist.size) * 100 };
    };
    return {
      deposits: state.deposits.length,
      depositors: new Set(state.deposits.map((d) => d.user)).size,
      exits: state.exits.length,
      destinations: new Set(state.exits.map((w) => w.to)).size,
      feeLegShare: state.withdrawals === 0 ? 0 : (state.feeLegs / state.withdrawals) * 100,
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
    if (state.status !== "ready" || state.deposits.length === 0) return null;
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

  const strk = (v) => formatUnits(v, 18, { maxFractionDigits: 4 });
  const maxCohort = Math.max(1, ...(stats?.popular ?? []).map((p) => p.entryCohort));

  return (
    <div className="wrap">
      <header className="hero">
        <p className="eyebrow">
          <b>◢</b> STRK20 PRIVATE SPRINT · RHIZOME
        </p>
        <h1>Privacy has a price. Rhizome measures it.</h1>
        <p className="sub">
          The STRK20 pool hides who paid whom. It does not hide the amounts on the public legs — and
          on mainnet, most of those amounts are unique enough to identify you, going in and coming
          out. Rhizome reads the live fee and every public deposit and withdrawal, prices what
          unlinkability actually costs, and refuses to recommend it when it isn&apos;t worth paying
          for.
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
              <div className="k">Fee / pool transaction</div>
              <div className="v">
                {strk(state.fee)}
                <small>STRK</small>
              </div>
              <div className="note">
                charged per <span className="mono">apply_actions</span> call, always in STRK
              </div>
            </div>
            <div className="cell">
              <div className="k">Public legs read</div>
              <div className="v">
                {stats ? (stats.deposits + stats.exits).toLocaleString() : "—"}
              </div>
              <div className="note">
                {stats ? `${stats.deposits.toLocaleString()} in · ${stats.exits.toLocaleString()} out` : ""} ·
                block {state.block.toLocaleString()}
              </div>
            </div>
            <div className="cell">
              <div className="k">Entry amounts that are fingerprints</div>
              <div className="v">
                {stats?.entry ? stats.entry.pct.toFixed(1) : "—"}
                <small>%</small>
              </div>
              <div className="note">
                {stats?.entry
                  ? `${stats.entry.unique.toLocaleString()} of ${stats.entry.amounts.toLocaleString()} used once`
                  : ""}
              </div>
            </div>
            <div className="cell">
              <div className="k">Exit amounts that are fingerprints</div>
              <div className="v">
                {stats?.exit ? stats.exit.pct.toFixed(1) : "—"}
                <small>%</small>
              </div>
              <div className="note">
                {stats?.exit
                  ? `${stats.exit.unique.toLocaleString()} of ${stats.exit.amounts.toLocaleString()} used once`
                  : "no exit data for this token"}
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
              Deposits publish the depositor, the token and the exact amount. Withdrawals publish the
              destination and the amount. Pick a number nobody else has used and the pool cannot help
              you.
            </p>
          </div>
          <div className="card">
            <div className="num">02</div>
            <h3>Cover is not symmetric</h3>
            <p>
              An amount can have hundreds of deposits behind it and almost no withdrawals. Scoring
              only the way in rates those amounts safest, right up to the moment you try to leave.
            </p>
          </div>
          <div className="card">
            <div className="num">03</div>
            <h3>Splitting costs real money</h3>
            <p>
              The fee is charged per pool transaction, and keeping a deposit unlinked from the venue
              action it funds takes two of them. So every leg is two fees in, two more back out.
            </p>
          </div>
          <div className="card">
            <div className="num">04</div>
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
            A cohort is how many other legs carry the exact same amount. These are the denominations
            the pool has grown organically — shown for both legs, because cover on the way in is not
            cover on the way out. Rhizome scores every amount on its weaker side.
            {stats.feeLegShare > 0 && (
              <>
                {" "}
                Fee reimbursement is excluded: the pool repays its own fee with an extra withdraw leg,
                which accounts for {stats.feeLegShare.toFixed(1)}% of all public withdrawals.
              </>
            )}
          </p>

          <div className="bars">
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
            <span>▬ entry cohort (deposits)</span>
            <span>▭ exit cohort (withdrawals)</span>
            <span>scored on the weaker side</span>
          </div>
        </section>
      )}

      <section className="band">
        <p className="eyebrow">
          <b>◢</b> THE FRONTIER
        </p>
        <h2>What cover costs, priced.</h2>
        <p className="lede">
          Enter a position. Rhizome builds schedules out of amounts that already have cover on both
          legs, prices each one at the live fee, and marks the schedule it would actually run.
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
          <label className="field">
            Fee model
            <select value={feeModel} onChange={(e) => setFeeModel(e.target.value)}>
              {Object.entries(FEE_MODELS).map(([key, m]) => (
                <option key={key} value={key}>
                  {m.txPerLeg}× — {m.label}
                </option>
              ))}
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

        <p className="status" style={{ marginTop: 16 }}>
          {FEE_MODELS[feeModel].note}
        </p>

        {network !== "mainnet" && (
          <p className="status" style={{ marginTop: 10, color: "var(--orange)" }}>
            Sepolia is the right place to dry-run execution and the wrong place to measure cover: a
            different fee, a fraction of the traffic, and testnet amounts that nobody chose for
            privacy. Read the frontier on mainnet, then rehearse the schedule here.
          </p>
        )}

        {!analysis && state.status === "ready" && (
          <p className="status">no deposits for this token yet.</p>
        )}
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
                <span className="tag">{analysis.rec.poolTransactions} pool transactions</span>
                <span className="tag">{strk(analysis.rec.feeCost)} STRK in fees</span>
                <span className="tag">
                  {(analysis.rec.feeCostRatio * 100).toFixed(2)}% of position
                </span>
                <span className="tag">weakest cohort {analysis.rec.minCohort}</span>
                <span className="tag">
                  round trip {strk(analysis.rec.roundTripFeeCost)} STRK (
                  {(analysis.rec.roundTripFeeCostRatio * 100).toFixed(2)}%)
                </span>
              </div>
            </div>

            <FrontierChart rows={analysis.rows} chosen={analysis.rec.tranches} />

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Legs</th>
                    <th>Pool tx</th>
                    <th>Fee cost</th>
                    <th>% of position</th>
                    <th>Entry cohort</th>
                    <th>Exit cohort</th>
                    <th>Weaker side</th>
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
                      <td>{r.poolTransactions}</td>
                      <td>{strk(r.feeCost)}</td>
                      <td>{(r.feeCostRatio * 100).toFixed(2)}%</td>
                      <td>{r.minEntryCohort}</td>
                      <td>{r.exitKnown ? r.minExitCohort : "?"}</td>
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
                      <th>Entry cohort</th>
                      <th>Exit cohort</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.rec.schedule.map((leg, i) => (
                      <tr key={i}>
                        <td>{i + 1}</td>
                        <td>{strk(leg.amount)} STRK</td>
                        <td>{leg.entryCohort}</td>
                        <td>
                          {leg.exitKnown ? leg.exitCohort : "?"}
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

      {timing && (
        <section className="band">
          <p className="eyebrow">
            <b>◢</b> TIMING
          </p>
          <h2>The cover that costs nothing.</h2>
          <p className="lede">
            Amount cover is bought with fees. Timing cover is bought by waiting, and waiting is free
            — but only if somebody else transacts while you wait. Shielding in a separate transaction
            is what stops an observer tying your deposit to the venue action it funds, and that
            separation is worthless if you are the only pool transaction in the window.{" "}
            {timing.total.toLocaleString()} pool transactions in the pool&apos;s history,{" "}
            {timing.recent.toLocaleString()} in the last {TIMING_SAMPLE_BLOCKS.toLocaleString()}{" "}
            blocks ({formatDelay(TIMING_SAMPLE_BLOCKS, state.secondsPerBlock)}). Judged on the recent
            window only — an old burst is not cover for a transaction sent today.
          </p>

          <div className={`verdict ${timing.rec.verdict}`}>
            <h3>
              {timing.rec.verdict === "delay-earns-it"
                ? `Wait ${timing.rec.window.toLocaleString()} blocks between the two legs.`
                : "This pool is too quiet for timing cover."}
            </h3>
            <p>
              {timing.rec.verdict === "delay-earns-it"
                ? `That is ${formatDelay(timing.rec.window, state.secondsPerBlock)}, and it costs nothing but patience. In a window that wide the median pool transaction has ${timing.rec.medianCohort} others for company, and is alone only ${(timing.rec.aloneShare * 100).toFixed(0)}% of the time.`
                : `Even at ${timing.rec.window.toLocaleString()} blocks (${formatDelay(timing.rec.window, state.secondsPerBlock)}) a transaction is alone ${(timing.rec.aloneShare * 100).toFixed(0)}% of the time. Wait as long as you can bear, and know the delay is doing less work here than the amounts are.`}
              {timing.floor && (
                <>
                  {" "}
                  At the {NOTE_MATURITY_BLOCKS}-block note maturity floor you are alone{" "}
                  <b>{(timing.floor.aloneShare * 100).toFixed(0)}%</b> of the time — so shielding
                  separately and then invoking immediately spends an extra fee for almost nothing.
                </>
              )}
            </p>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Delay</th>
                  <th>Wait</th>
                  <th>Other pool tx (median)</th>
                  <th>Alone</th>
                </tr>
              </thead>
              <tbody>
                {timing.rows.map((r) => (
                  <tr key={r.window} className={r.window === timing.rec.window ? "chosen" : ""}>
                    <td>
                      {r.window.toLocaleString()} blocks
                      {r.window === NOTE_MATURITY_BLOCKS && (
                        <span className="pill">maturity floor</span>
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
        </section>
      )}

      <ExecutePanel
        net={cfg[network]}
        network={network}
        token={cfg[network].tokens?.STRK ?? cfg.mainnet.tokens.STRK}
        schedule={analysis?.rec?.schedule ?? []}
        fee={state.fee ?? null}
        feeModel={feeModel}
        delay={timing?.rec ?? null}
        secondsPerBlock={state.secondsPerBlock ?? null}
      />

      <footer>
        <div className="meta">Honest accounting · reads public state only · no viewing key</div>
        Deposits, withdrawals, timing and open-note amounts are public by design. Rhizome claims
        reduced correlatability on the public legs — not amount privacy, which the pool does not
        provide and no scheduling strategy can create.{" "}
        <a href="https://github.com/cipoklean/rhizome">Source</a> ·{" "}
        <a href="https://strk20.starknet.io/hackathon">STRK20 Private Sprint</a>
      </footer>
    </div>
  );
}
