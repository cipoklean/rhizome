// Decimal <-> wei conversion, in integer arithmetic only.
//
// `BigInt(Math.round(50000 * 1e18))` does not give 50000e18. Doubles cannot
// represent it, so the result lands a few thousand wei off — and an amount a few
// thousand wei off matches no cohort at all. Cohort analysis compares exact
// amounts, so a float anywhere in this path silently destroys the result.

/** Parse a decimal string or integer into base units. */
export function parseUnits(value, decimals = 18) {
  const s = String(value).trim();
  if (!/^-?\d*(\.\d*)?$/.test(s) || s === "" || s === "." || s === "-") {
    throw new Error(`not a decimal number: ${value}`);
  }

  const negative = s.startsWith("-");
  const body = negative ? s.slice(1) : s;
  const [whole = "0", fraction = ""] = body.split(".");

  if (fraction.length > decimals) {
    throw new Error(`${value} has more than ${decimals} decimal places`);
  }

  const padded = fraction.padEnd(decimals, "0");
  const result = BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0");
  return negative ? -result : result;
}

/** Format base units as a decimal string, trimming trailing zeros. */
export function formatUnits(value, decimals = 18, { maxFractionDigits = 6 } = {}) {
  const v = BigInt(value);
  const negative = v < 0n;
  const abs = negative ? -v : v;
  const scale = 10n ** BigInt(decimals);

  const whole = abs / scale;
  let fraction = (abs % scale).toString().padStart(decimals, "0");
  fraction = fraction.slice(0, maxFractionDigits).replace(/0+$/, "");

  const withGrouping = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${withGrouping}${fraction ? `.${fraction}` : ""}`;
}
