// 4M tests: gas-price parsing, bounds math, map-shape errorMessages, guard.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGasPrices, boundsStrkWei, declaredBoundsForMove } from "../src/lib/wallet.mjs";

const REFUSAL = `Resource bounds were not satisfied: Max L1Gas price (1) is lower than the actual gas price: 115151955204254.
Max L1DataGas price (1) is lower than the actual gas price: 199707566251.
Max L2Gas price (1) is lower than the actual gas price: 33044742581.`;

test("parseGasPrices: extracts all three live prices from a node refusal", () => {
  const p = parseGasPrices(REFUSAL);
  assert.equal(p.l1, 115151955204254n);
  assert.equal(p.l1d, 199707566251n);
  assert.equal(p.l2, 33044742581n);
});

test("parseGasPrices: null on unrelated text", () => {
  assert.equal(parseGasPrices("some other error"), null);
  assert.equal(parseGasPrices(null), null);
});

test("boundsStrkWei: amount × price in wei; garbage → 0n", () => {
  assert.equal(boundsStrkWei("0x8be103b", "0xbf343fd4e"), 0x8be103bn * 0xbf343fd4en);
  assert.equal(boundsStrkWei("garbage", "0x1"), 0n);
  assert.equal(boundsStrkWei("0x1", null), 0n);
});

test("declaredBoundsForMove: refuses to probe without a prepared call", async () => {
  await assert.rejects(
    declaredBoundsForMove({ rpcUrls: [], senderAddress: "0x1", call: null }),
    /no prepared call/,
  );
  await assert.rejects(
    declaredBoundsForMove({ rpcUrls: [], senderAddress: "0x1", call: { calldata: [] } }),
    /no prepared call/,
  );
});
