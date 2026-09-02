import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OPERATION,
  buildPrepareInvokeRequest,
  buildShieldActions,
  buildTrancheActions,
  canonicalFelt,
  dryRun,
  ensureWalletChain,
  execute,
  executeSelfPay,
  pickLandedPoolTx,
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

test("the proven vault dry run opens an output note then invokes", () => {
  const actions = buildTrancheActions({
    anonymizer: "0xaaa",
    inToken: "0x111",
    outToken: "0x222",
    amount: 1n,
    recipient: "0x333",
    operation: OPERATION.Deposit,
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

test("the visible dry-run diagnostic matches starknet.js request serialization", () => {
  const actions = buildTrancheActions({
    anonymizer: "0xaaa",
    inToken: "0x111",
    outToken: "0x222",
    amount: 1n,
    recipient: "0x333",
  });
  assert.deepEqual(buildPrepareInvokeRequest(actions), {
    type: "wallet_strk20PrepareInvoke",
    params: { actions, simulate: true },
  });
});

test("a wallet that never answers cannot hold the runner hostage", async () => {
  const actions = buildShieldActions({
    token: "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
    amount: 1n,
  });
  await assert.rejects(
    execute({ strk20InvokeTransaction: () => new Promise(() => {}) }, actions, { timeoutMs: 30 }),
    (e) => e.code === "EXECUTE_TIMEOUT" && /use Check/.test(e.message),
  );
});

test("a slow-but-successful wallet answer still wins the race", async () => {
  const actions = buildShieldActions({
    token: "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
    amount: 1n,
  });
  const result = await execute(
    { strk20InvokeTransaction: async () => ({ transaction_hash: "0xabc" }) },
    actions,
    { timeoutMs: 2000 },
  );
  assert.equal(result.transaction_hash, "0xabc");
});

// ── 4K BUG B: wallet error + chain reconciliation ──────────────────────────
test("pickLandedPoolTx: wallet error + chain shows SUCCEEDED in window -> reconcile success", () => {
  const txs = [
    { hash: "0xold", status: "SUCCEEDED", block: 1000 },
    { hash: "0xreverted", status: "REVERTED", block: 1120 },
    { hash: "0xnew", status: "SUCCEEDED", block: 1115 },
  ];
  const picked = pickLandedPoolTx(txs, 1200, 120);
  assert.equal(picked.hash, "0xnew", "newest in-window SUCCEEDED tx wins");
});

test("pickLandedPoolTx: wallet error + no matching activity -> null (failure card)", () => {
  assert.equal(pickLandedPoolTx([], 1200), null, "empty scan -> null");
  assert.equal(
    pickLandedPoolTx([{ hash: "0xa", status: "REVERTED", block: 1150 }], 1200, 120),
    null,
    "reverted tx never reconciles",
  );
  assert.equal(
    pickLandedPoolTx([{ hash: "0xb", status: "SUCCEEDED", block: 100 }], 1200, 120),
    null,
    "SUCCEEDED outside the window never reconciles",
  );
  assert.equal(pickLandedPoolTx(null, 1200), null, "garbage scan -> null");
});

// ── 4L: self-pay broadcast (bypass the wallet's paymaster) ─────────────────
test("executeSelfPay: prepares real proofs and broadcasts via executeWithProof", async () => {
  const seen = { prepare: null, broadcast: null, simulate: null };
  const account = {
    strk20PrepareInvoke: async (actions, simulate) => {
      seen.prepare = actions;
      seen.simulate = simulate;
      return { call: { contractAddress: "0xpool", entrypoint: "apply_actions", calldata: ["0x1"] }, proof: { notes: ["0xproof"] } };
    },
    executeWithProof: async (call, proof) => {
      seen.broadcast = { call, proof };
      return { transaction_hash: "0xabc" };
    },
  };
  const tx = await executeSelfPay(account, [{ type: "deposit", token: "0x1", amount: "0x2" }]);
  assert.equal(tx.transaction_hash, "0xabc");
  assert.equal(seen.simulate, false, "must request REAL proofs (simulate=false)");
  assert.equal(seen.broadcast.proof.notes[0], "0xproof", "proof must be forwarded to the broadcast");
  assert.equal(seen.broadcast.call.entrypoint, "apply_actions");
});

test("executeSelfPay: empty prepared call is refused before broadcast", async () => {
  const account = {
    strk20PrepareInvoke: async () => ({ call: { calldata: [] }, proof: null }),
    executeWithProof: async () => {
      throw new Error("should not be reached");
    },
  };
  await assert.rejects(executeSelfPay(account, [{ type: "deposit", token: "0x1", amount: "0x2" }]), /empty self-pay call/);
});

// ── 4N: self-pay routing on every send path ────────────────────────────────
test("execute router: selfPay=false relays, selfPay=true self-pays", async () => {
  const calls = [];
  const account = {
    strk20InvokeTransaction: async () => calls.push("relayed") && { transaction_hash: "0xrelay" },
    strk20PrepareInvoke: async () => calls.push("prepare") && { call: { calldata: ["0x1"] }, proof: "p" },
    executeWithProof: async () => calls.push("selfpay") && { transaction_hash: "0xself" },
  };
  const actions = [{ type: "transfer", token: "0x1", amount: "0x1", recipient: "0x2" }];
  const relayed = await execute(account, actions, { selfPay: false });
  assert.equal(relayed.transaction_hash, "0xrelay", "default routes to the paymaster relay");
  const selfPaid = await execute(account, actions, { selfPay: true });
  assert.equal(selfPaid.transaction_hash, "0xself", "selfPay routes to executeWithProof");
  assert.deepEqual(calls, ["relayed", "prepare", "selfpay"], "each path used exactly its own machinery");
});

test("dryRun: selfPay mode prepares REAL proofs (simulate=false)", async () => {
  const seen = [];
  const account = { strk20PrepareInvoke: async (a, simulate) => (seen.push(simulate), {}) };
  await dryRun(account, [{ type: "transfer", token: "0x1", amount: "0x1", recipient: "0x2" }]);
  await dryRun(account, [{ type: "transfer", token: "0x1", amount: "0x1", recipient: "0x2" }], { selfPay: true });
  assert.deepEqual(seen, [true, false], "default = simulate; selfPay = real-proof prepare");
});
