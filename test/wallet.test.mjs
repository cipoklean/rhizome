import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OPERATION,
  buildPrepareInvokeRequest,
  buildShieldActions,
  buildTrancheActions,
  canonicalFelt,
  ensureWalletChain,
  resolveChainId,
  sameChain,
  supportsStrk20PrivateDefiVersion,
  validateStrk20Actions,
} from "../src/lib/wallet.mjs";

const MAIN = "0x534e5f4d41494e";
const SEPOLIA = "0x534e5f5345504f4c4941";
const wallet = { name: "mock wallet" };

function mockApi(initial, { accepts = true, actuallySwitches = true, error = null } = {}) {
  let chain = initial;
  let switches = 0;
  return {
    get switches() {
      return switches;
    },
    async requestChainId(received) {
      assert.equal(received, wallet);
      return chain;
    },
    async switchStarknetChain(received, target) {
      assert.equal(received, wallet);
      switches += 1;
      if (error) throw error;
      if (accepts && actuallySwitches) chain = target;
      return accepts;
    },
  };
}

test("private DeFi requires Wallet API 0.10.3 or newer", () => {
  assert.equal(supportsStrk20PrivateDefiVersion("0.10"), false);
  assert.equal(supportsStrk20PrivateDefiVersion("0.10.2"), false);
  assert.equal(supportsStrk20PrivateDefiVersion("0.10.3"), true);
  assert.equal(supportsStrk20PrivateDefiVersion("0.10.4"), true);
  assert.equal(supportsStrk20PrivateDefiVersion("0.11"), true);
  assert.equal(supportsStrk20PrivateDefiVersion("1.0"), true);
  assert.equal(supportsStrk20PrivateDefiVersion("0.10.3-rc.3"), false);
  assert.equal(supportsStrk20PrivateDefiVersion("garbage"), false);
});

test("readable config aliases resolve to Wallet API chain felts", () => {
  assert.equal(resolveChainId("SN_MAIN"), MAIN);
  assert.equal(resolveChainId("SN_SEPOLIA"), SEPOLIA);
  assert.equal(resolveChainId(SEPOLIA), SEPOLIA);
  assert.throws(() => resolveChainId("sepolia"), /unknown Starknet chain id/);
});

test("chain ids compare as felts, not strings", () => {
  assert.equal(sameChain("0x0534e5f4d41494e", MAIN), true);
  assert.equal(sameChain("SN_MAIN", MAIN.toUpperCase().replace("0X", "0x")), true);
  assert.equal(sameChain(MAIN, SEPOLIA), false);
  assert.equal(sameChain("not-a-chain", MAIN), false);
});

test("an already-correct wallet is not prompted to switch", async () => {
  const api = mockApi(SEPOLIA);
  const result = await ensureWalletChain(wallet, "SN_SEPOLIA", api);
  assert.equal(result.switched, false);
  assert.equal(result.chainId, SEPOLIA);
  assert.equal(api.switches, 0);
});

test("the wallet is actively switched and verified", async () => {
  const api = mockApi(MAIN);
  const result = await ensureWalletChain(wallet, "SN_SEPOLIA", api);
  assert.equal(result.switched, true);
  assert.equal(result.previousChainId, MAIN);
  assert.equal(result.chainId, SEPOLIA);
  assert.equal(api.switches, 1);
});

test("a rejected switch fails before any transaction can be sent", async () => {
  const api = mockApi(MAIN, { accepts: false });
  await assert.rejects(
    ensureWalletChain(wallet, "SN_SEPOLIA", api),
    /wallet refused to switch to SN_SEPOLIA/,
  );
});

test("a wallet that claims success but stays put is refused", async () => {
  const api = mockApi(MAIN, { actuallySwitches: false });
  await assert.rejects(
    ensureWalletChain(wallet, "SN_SEPOLIA", api),
    /wallet is still on .* selected network is SN_SEPOLIA.*No transaction was sent/,
  );
});

test("a wallet switch exception keeps the useful cause", async () => {
  const api = mockApi(MAIN, { error: new Error("user rejected request") });
  await assert.rejects(
    ensureWalletChain(wallet, "SN_SEPOLIA", api),
    /switch to SN_SEPOLIA failed or was rejected: user rejected request/,
  );
});

test("Wallet API action felts are canonicalized before reaching Ready", () => {
  const paddedStrk =
    "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
  const canonicalStrk =
    "0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
  assert.equal(canonicalFelt(paddedStrk), canonicalStrk);

  const shield = buildShieldActions({ token: paddedStrk, amount: 1n });
  assert.equal(shield[0].token, canonicalStrk);

  const actions = buildTrancheActions({
    anonymizer: "0x0552",
    inToken: paddedStrk,
    outToken: "0x072b",
    amount: 1n,
    recipient: "0x030c",
  });
  assert.equal(actions[0].token, "0x72b");
  assert.equal(actions[0].recipient, "0x30c");
  assert.equal(actions[1].contract, "0x552");
  assert.equal(actions[1].calldata[1], canonicalStrk);
  assert.deepEqual(validateStrk20Actions(actions), []);
});

test("local validation identifies a non-canonical felt by field", () => {
  const errors = validateStrk20Actions([
    { type: "deposit", token: "0x0471", amount: "0x1" },
  ]);
  assert.deepEqual(errors, ["actions[0].token must be a canonical Wallet API FELT"]);
  assert.throws(() => canonicalFelt(`0x1${"0".repeat(63)}`), /exceeds 63 hex digits/);
});

test("the documented vault dry run opens an output note then invokes", () => {
  const actions = buildTrancheActions({
    anonymizer: "0xaaa",
    inToken: "0x111",
    outToken: "0x222",
    amount: 1n,
    recipient: "0x333",
    operation: OPERATION.Deposit,
    shape: "implicit",
  });
  assert.deepEqual(actions, [
    { type: "transfer", token: "0x222", amount: "OPEN", recipient: "0x333" },
    {
      type: "invoke",
      contract: "0xaaa",
      calldata: ["0x0", "0x111", "0x222", "0x1", "0x0", "${openNoteIds[0]}"],
    },
  ]);
});

test("the explicit vault shape funds the helper before invoking it", () => {
  const actions = buildTrancheActions({
    anonymizer: "0xaaa",
    inToken: "0x111",
    outToken: "0x222",
    amount: 1n,
    recipient: "0x333",
    shape: "explicit-withdraw",
  });
  assert.deepEqual(actions, [
    { type: "transfer", token: "0x222", amount: "OPEN", recipient: "0x333" },
    {
      type: "withdraw",
      token: "0x111",
      amount: "0x1",
      recipient: "0xaaa",
    },
    {
      type: "invoke",
      contract: "0xaaa",
      calldata: ["0x0", "0x111", "0x222", "0x1", "0x0", "${openNoteIds[0]}"],
    },
  ]);
});

test("the visible dry-run diagnostic matches starknet.js request serialization", () => {
  const actions = buildTrancheActions({
    anonymizer: "0xaaa",
    inToken: "0x111",
    outToken: "0x222",
    amount: 1n,
    recipient: "0x333",
    shape: "explicit-withdraw",
  });
  assert.deepEqual(buildPrepareInvokeRequest(actions), {
    type: "wallet_strk20PrepareInvoke",
    params: { actions, simulate: true },
  });
});
