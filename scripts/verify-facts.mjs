// Re-verify every load-bearing on-chain fact Rhizome depends on.
//
// Rhizome's whole argument is that you measure the cost of privacy rather than
// reading it out of documentation, so the repo checks its own claims. Run with:
//
//   node scripts/verify-facts.mjs
//
// Exits non-zero if anything drifted from config/addresses.json.

import { readFileSync } from "node:fs";
import { RpcProvider } from "starknet";

const cfg = JSON.parse(readFileSync(new URL("../config/addresses.json", import.meta.url)));

const fmt = (wei, decimals = 18) => Number(BigInt(wei)) / 10 ** decimals;

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

/** First RPC in the list that responds. */
async function connect(urls) {
  for (const url of urls) {
    try {
      const p = new RpcProvider({ nodeUrl: url });
      await p.getBlockNumber();
      return { provider: p, url };
    } catch {
      /* try the next one */
    }
  }
  throw new Error(`no reachable RPC among: ${urls.join(", ")}`);
}

async function callFn(provider, contractAddress, entrypoint, calldata = []) {
  return provider.callContract({ contractAddress, entrypoint, calldata });
}

for (const [network, net] of Object.entries(cfg).filter(([k]) => k !== "$comment")) {
  console.log(`\n=== ${network} ===`);

  let provider, url;
  try {
    ({ provider, url } = await connect(net.rpc));
  } catch (e) {
    check(`rpc reachable`, false, e.message);
    continue;
  }
  const block = await provider.getBlockNumber();
  console.log(`  rpc ${url} @ block ${block}`);

  // 1. The pool fee. This is the number Rhizome prices everything from.
  try {
    const [raw] = await callFn(provider, net.strk20Pool, "get_fee_amount");
    const live = BigInt(raw).toString();
    const expected = net.observed.feeAmountWei;
    check(
      `pool fee = ${fmt(live)} tokens`,
      live === expected,
      live === expected ? undefined : `config says ${fmt(expected)}, chain says ${fmt(live)}`,
    );
  } catch (e) {
    check("pool get_fee_amount", false, e.message);
  }

  // 2. The Vesu vault really is an ERC-4626 over the token we think it is.
  const vToken = net.vesu?.vTokens?.STRK;
  if (vToken) {
    try {
      const [assetAddr] = await callFn(provider, vToken, "asset");
      const expectedAsset = net.tokens.STRK;
      check(
        "vSTRK.asset() is STRK",
        BigInt(assetAddr) === BigInt(expectedAsset),
        BigInt(assetAddr) === BigInt(expectedAsset) ? undefined : `got ${assetAddr}`,
      );

      const cls = await provider.getClassAt(vToken);
      const names = new Set();
      const walk = (items) => {
        for (const it of items ?? []) {
          if (it.type === "function") names.add(it.name);
          if (it.type === "interface") walk(it.items);
        }
      };
      walk(cls.abi);
      for (const fn of ["deposit", "withdraw", "balance_of", "approve", "convert_to_assets"]) {
        check(`vSTRK exposes ${fn}()`, names.has(fn));
      }
    } catch (e) {
      check("vSTRK checks", false, e.message);
    }
  }

  // 3. Our anonymizer, once deployed, must not be on the pool's blocklist.
  if (net.anonymizer) {
    try {
      const [blocked] = await callFn(
        provider,
        net.strk20Pool,
        "is_open_note_depositor_blocked",
        [net.anonymizer],
      );
      check("anonymizer not blocked as open-note depositor", BigInt(blocked) === 0n);
    } catch (e) {
      check("blocklist check", false, e.message);
    }
  } else {
    console.log("  ..   anonymizer not deployed yet, skipping blocklist check");
  }
}

console.log(
  failures === 0 ? "\nAll facts verified.\n" : `\n${failures} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
