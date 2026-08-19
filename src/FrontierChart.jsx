/**
 * The cost/unlinkability frontier, drawn.
 *
 * x = fee cost as a share of the position (what you pay)
 * y = weakest leg's cohort, log-scaled (what you get)
 *
 * Log scale because cohorts span 2 to several hundred; linear would flatten
 * everything interesting into the bottom of the plot.
 */
export default function FrontierChart({ rows, chosen }) {
  if (!rows || rows.length < 2) return null;

  const W = 720;
  const H = 260;
  const pad = { top: 18, right: 26, bottom: 42, left: 54 };
  const iw = W - pad.left - pad.right;
  const ih = H - pad.top - pad.bottom;

  const xs = rows.map((r) => r.feeCostRatio * 100);
  const ys = rows.map((r) => Math.max(1, r.minCohort));

  const xMax = Math.max(...xs) * 1.08 || 1;
  const yMin = 1;
  const yMax = Math.max(...ys) * 1.25;

  const px = (v) => pad.left + (v / xMax) * iw;
  const py = (v) => {
    const t = (Math.log(v) - Math.log(yMin)) / (Math.log(yMax) - Math.log(yMin));
    return pad.top + ih - t * ih;
  };

  const pts = rows.map((r, i) => ({
    x: px(xs[i]),
    y: py(ys[i]),
    row: r,
  }));

  const path = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

  // Log gridlines at powers of ten that fall inside the range.
  const gridY = [1, 10, 100, 1000].filter((v) => v <= yMax);

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Cost versus cover frontier">
        {gridY.map((v) => (
          <g key={v}>
            <line
              x1={pad.left}
              x2={W - pad.right}
              y1={py(v)}
              y2={py(v)}
              stroke="#262626"
              strokeWidth="1"
            />
            <text className="tick" x={pad.left - 10} y={py(v) + 3.5} textAnchor="end">
              {v}
            </text>
          </g>
        ))}

        <line
          x1={pad.left}
          x2={W - pad.right}
          y1={pad.top + ih}
          y2={pad.top + ih}
          stroke="#262626"
        />

        <path d={path} fill="none" stroke="#c53400" strokeWidth="1.5" opacity="0.75" />

        {pts.map((p) => {
          const isChosen = p.row.tranches === chosen;
          return (
            <g key={p.row.tranches}>
              <circle
                cx={p.x}
                cy={p.y}
                r={isChosen ? 6 : 3.5}
                fill={isChosen ? "#c53400" : "#0d0d0d"}
                stroke="#c53400"
                strokeWidth="1.5"
              />
              <text
                className="tick"
                x={p.x}
                y={p.y - (isChosen ? 14 : 11)}
                textAnchor="middle"
                fill={isChosen ? "#fafafa" : "#616161"}
              >
                {p.row.tranches}
              </text>
            </g>
          );
        })}

        <text className="axis-label" x={pad.left} y={H - 10}>
          fee cost — % of position →
        </text>
        <text
          className="axis-label"
          x={14}
          y={pad.top + ih / 2}
          transform={`rotate(-90 14 ${pad.top + ih / 2})`}
          textAnchor="middle"
        >
          weakest cohort →
        </text>
      </svg>
    </div>
  );
}
