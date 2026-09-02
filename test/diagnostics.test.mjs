import assert from "node:assert/strict";
import { test } from "node:test";

// The module under test is ESM with JSX-incompatible neighbours, so we extract
// the two pure helpers by evaluating them in isolation — they are plain
// functions with no imports, defined at module scope in ExecutePanel.jsx.
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../src/ExecutePanel.jsx", import.meta.url), "utf8");
const grab = (name) => {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  let depth = 0;
  let end = start;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  return src.slice(start, end);
};
const extractDetailedErrors = new Function(`${grab("extractDetailedErrors")}; return extractDetailedErrors;`)();
const serializeWalletError = new Function(`${grab("serializeWalletError")}; return serializeWalletError;`)();

test("extractDetailedErrors: string cause (the Argent 163 shape) is captured, not skipped", () => {
  // The exact shape the user's console showed: errorMessages exists but the
  // reason rides in `cause` as a PLAIN STRING.
  const e = {
    name: "ln",
    message: "An error occurred (UNKNOWN_ERROR)",
    code: 163,
    errorMessages: [],
    context: undefined,
    cause: "PaymasterV2Error: Paymaster error 156: An error occurred (TRANSACTION_EXECUTION_ERROR)",
  };
  const out = extractDetailedErrors(e);
  assert.ok(
    out.some((s) => s.includes("Paymaster error 156")),
    `string cause must be captured, got: ${JSON.stringify(out)}`,
  );
});

test("serializeWalletError: string cause serializes as the string, not [depth limit]", () => {
  const e = { name: "ln", message: "UNKNOWN", code: 163, cause: "some real reason text" };
  const out = serializeWalletError(e);
  assert.equal(out.cause, "some real reason text");
});

test("serializeWalletError: errorMessages value is visible, not just the key", () => {
  const e = { name: "x", message: "y", code: 1, errorMessages: ["reason one", "reason two"] };
  const out = serializeWalletError(e);
  assert.deepEqual(out.errorMessages, ["reason one", "reason two"]);
});

test("extractDetailedErrors: object causes still work (no regression)", () => {
  const e = { cause: { errorMessages: ["nested object reason"], cause: "deepest string" } };
  const out = extractDetailedErrors(e);
  assert.ok(out.includes("nested object reason"));
  assert.ok(out.includes("deepest string"));
});

test("extractDetailedErrors: {code: message} MAP shape renders the occurred code, labels the rest catalog", () => {
  const e = {
    name: "ln",
    code: 163,
    errorMessages: {
      "163": "the real reason for 163",
      "156": "a paymaster refusal",
      "4001": "user rejected",
    },
  };
  const out = extractDetailedErrors(e);
  assert.equal(out[0], "the real reason for 163", "occurred code's entry leads");
  assert.ok(out.includes("catalog[156]: a paymaster refusal"), "rest labeled catalog");
  assert.ok(out.includes("catalog[4001]: user rejected"));
});
