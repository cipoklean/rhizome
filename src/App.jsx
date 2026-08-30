// Rhizome — Private yield without leaving a fingerprint.

// H1 (keep): "Private yield without leaving a fingerprint."
// New one-sentence sub: "Rhizome picks STRK amounts that match what hundreds of
//   others already deposited — so your move hides in the crowd."
// A 3-step "how it works" strip directly under the sub, rendered as chips:
//   "1 · Pick a crowd-sized amount" → "2 · Pay the privacy fee" →
//   "3 · Wait for timing cover, then vault."
// Delete the remaining hero paragraphs. Nothing else on the page moves.

import { useEffect, useMemo, useState } from "react";
import cfg from "../config/addresses.json";
import { TIMING_SAMPLE_BLOCKS, NOTE_MATURITY_BLOCKS } from "../config/constants.mjs";
import ExecutePanel from "./ExecutePanel.jsx";
import FrontierChart from "./FrontierChart.jsx";
import { popularAmounts, roundTripCohort } from "./lib/cohorts.mjs";
import { DEFAULT_FEE_MODEL, FEE_MODELS, computeFrontier, recommend } from "./lib/frontier.mjs";
import { formatUnits, parseUnits } from "./lib/units.mjs";
import { loadPoolState } from "./lib/pool-state.mjs";

/** Timing cover is judged on recent traffic only. This pool put roughly 80% of
 * its lifetime transactions into 2.5% of its life, and averaging that burst in
 * would promise company that will not be there today.
 */
const TIMING_SAMPLE_BLOCKS = 500000;

/** Documented note maturity: freshly shielded funds are not spendable for about
 * ten blocks. It is the floor on any two-transaction schedule — and at that
 * floor you are almost certainly the only pool transaction in the window.
 */
const NOTE_MATURITY_BLOCKS = 10;

/** Maximum number of tranches to consider in the frontier. */
const MAX_TRANCHES = 24;

/** Never spend more than this fraction of the position on fees. */
const MAX_FEE_RATIO = 0.1;

/** "Good enough" cover — past this, more tranches buy nothing worth paying for. */
const TARGET_DISTINCTIVENESS = 0.05;

/** Minimum cohort size for an amount to be "well-populated". */
const MIN_COHORT = 3;

/** Tolerance for snapToCohort. */
const COHORT_TOLERANCE = 0.25;

/** ...