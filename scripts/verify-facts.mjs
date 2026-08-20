// Re-verify every load-bearing on-chain fact Rhizome depends on.
//
// Rhizome's whole argument is that you measure the cost of privacy rather than
// reading it out of documentation, so the repo checks its own claims. Run with:
//
//   node scripts/verify-facts.mjs
//
// Exits non-zero if anything drifted from config/addresses.json.

import { existsSync, readFileSync } from "node:fs";
import { RpcProvider, hash } from "starknet";
import { classifyWithdrawals, fetchFeeHistory, fetchWithdrawals } from "../src/lib/pool.mjs";

const cfg = JSON.parse(readFileSync(new URL("../config/addresses.json", import.meta.url)));
const SIERRA = new URL(
  "../artifacts/rhizome_anonymizer_RhizomeVesuAnonymizer.contract_class.json",
  import.meta.url,
);

const fmt = (wei, decimals = 18) => Number(BigInt(wei)) / 10 ** decimals;
const same = (a, b) => BigInt(a) === BigInt(b);

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const skip = (label, why) => console.log(`  ..   ${label} — ${why}`);

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
      `pool fee = ${fmt(live)} STRK per pool transaction`,
      live === expected,
      live === expected ? undefined : `config says ${fmt(expected)}, chain says ${fmt(live)}`,
    );
  } catch (e) {
    check("pool get_fee_amount", false, e.message);
  }

  // 2. Who the fee is paid to. Rhizome's fee-leg filter depends on this being
  //    the address the pool actually uses.
  if (net.observed.feeCollector) {
    try {
      const [live] = await callFn(provider, net.strk20Pool, "get_fee_collector");
      check(
        "fee collector matches config",
        same(live, net.observed.feeCollector),
        same(live, net.observed.feeCollector) ? undefined : `chain says ${live}`,
      );
    } catch (e) {
      check("pool get_fee_collector", false, e.message);
    }
  } else {
    skip("fee collector", "not recorded in config");
  }

  // 3. The fee history. The fee is admin-settable, so the schedule of what it
  //    has been is as load-bearing as what it is now — old cohort data was
  //    priced differently, and some of it was priced at zero.
  if (net.observed.feeHistory) {
    try {
      const live = await fetchFeeHistory(provider, net.strk20Pool);
      // config carries an explicit leading zero-fee epoch that emits no event.
      const expected = net.observed.feeHistory.filter((h) => BigInt(h.feeAmountWei) > 0n);
      const matches =
        live.length === expected.length &&
        live.every(
          (h, i) =>
            h.blockNumber === expected[i].fromBlock &&
            h.feeAmount === BigInt(expected[i].feeAmountWei),
        );
      check(
        `fee history: ${live.map((h) => `${fmt(h.feeAmount)} @ ${h.blockNumber}`).join(" -> ") || "never set"}`,
        matches,
        matches ? undefined : `config expects ${expected.length} change(s), chain has ${live.length}`,
      );
    } catch (e) {
      check("fee history", false, e.message);
    }
  } else {
    skip("fee history", "not recorded in config");
  }

  // 4. The fee router. Every priced pool transaction reimburses it with a public
  //    Withdrawal of exactly the fee, which is why most public withdrawals are
  //    not positions. If this stops being true, the exit-side cohort numbers are
  //    wrong and the analysis must not quietly keep filtering.
  if (net.observed.feeRouter && net.tokens?.STRK) {
    try {
      const fromBlock = Math.max(0, block - 200000);
      const history = await fetchFeeHistory(provider, net.strk20Pool);
      const recent = await fetchWithdrawals(provider, net.strk20Pool, {
        token: net.tokens.STRK,
        fromBlock,
      });
      if (recent.length === 0) {
        skip("fee router", `no STRK withdrawals since block ${fromBlock}`);
      } else {
        const { feeLegs, routers } = classifyWithdrawals(recent, history);
        const share = (feeLegs.length / recent.length) * 100;
        check(
          `fee router is the dominant fee-leg destination (${share.toFixed(1)}% of ${recent.length} recent STRK withdrawals)`,
          routers.some((r) => same(r, net.observed.feeRouter)),
          routers.length === 0
            ? "no fee-sized legs found at all"
            : `derived routers: ${routers.join(", ")}`,
        );
      }
    } catch (e) {
      check("fee router", false, e.message);
    }
  } else {
    skip("fee router", "not recorded in config");
  }

  // 5. The venue. On mainnet that is a real Vesu vToken and must be an ERC-4626
  //    over the token we think it is. On Sepolia it is our own 1:1 mock, because
  //    Vesu is not deployed there — so check the surface the anonymizer actually
  //    calls, and prove the deployed class is the mock we published rather than
  //    asserting an ERC-4626 interface it never claimed to have.
  const vToken = net.vesu?.vTokens?.STRK;
  const isMockVenue = net.vesu?.kind === "mock";
  if (vToken) {
    try {
      // Everything `privacy_invoke` touches on the vault side.
      const required = ["deposit", "withdraw", "balance_of", "approve"];
      const cls = await provider.getClassAt(vToken);
      const names = new Set();
      const walk = (items) => {
        for (const it of items ?? []) {
          if (it.type === "function") names.add(it.name);
          if (it.type === "interface") walk(it.items);
        }
      };
      walk(cls.abi);

      if (isMockVenue) {
        console.log("  ..   venue is a minimal Sepolia test double (MockVesuVault)");
        for (const fn of [
          ...required,
          "name",
          "symbol",
          "decimals",
          "asset",
          "convert_to_assets",
        ]) {
          check(`mock vault exposes ${fn}()`, names.has(fn));
        }

        const [assetAddr] = await callFn(provider, vToken, "asset");
        const expectedAsset = net.tokens?.STRK ?? cfg.mainnet.tokens.STRK;
        check(
          "mock vault asset() is STRK",
          same(assetAddr, expectedAsset),
          same(assetAddr, expectedAsset) ? undefined : `got ${assetAddr}`,
        );
        const [decimals] = await callFn(provider, vToken, "decimals");
        check(
          "mock vault shares use 18 decimals",
          BigInt(decimals) === 18n,
          BigInt(decimals) === 18n ? undefined : `got ${decimals}`,
        );
        const name = await callFn(provider, vToken, "name");
        const symbol = await callFn(provider, vToken, "symbol");
        check("mock vault name() is callable", name.length > 0);
        check("mock vault symbol() is callable", symbol.length > 0);
        const converted = await callFn(provider, vToken, "convert_to_assets", ["0x1", "0x0"]);
        check(
          "mock vault converts shares 1:1",
          BigInt(converted[0]) === 1n && BigInt(converted[1] ?? 0) === 0n,
        );

        const liveClass = await provider.getClassHashAt(vToken);
        if (net.vesu.classHash) {
          check(
            "mock vault class hash matches config",
            same(liveClass, net.vesu.classHash),
            same(liveClass, net.vesu.classHash) ? undefined : `chain says ${liveClass}`,
          );
        }
        const mockSierra = new URL(
          "../artifacts/rhizome_anonymizer_MockVesuVault.contract_class.json",
          import.meta.url,
        );
        if (existsSync(mockSierra)) {
          const computed = hash.computeContractClassHash(JSON.parse(readFileSync(mockSierra)));
          check(
            "mock vault is the class in artifacts/",
            same(liveClass, computed),
            same(liveClass, computed) ? undefined : `artifact hashes to ${computed}`,
          );
        }
      } else {
        const [assetAddr] = await callFn(provider, vToken, "asset");
        const expectedAsset = net.tokens.STRK;
        check(
          "vSTRK.asset() is STRK",
          same(assetAddr, expectedAsset),
          same(assetAddr, expectedAsset) ? undefined : `got ${assetAddr}`,
        );
        for (const fn of [...required, "convert_to_assets"]) {
          check(`vSTRK exposes ${fn}()`, names.has(fn));
        }
      }
    } catch (e) {
      check("venue checks", false, e.message);
    }
  } else {
    skip("venue", "no vault configured for this network");
  }

  // 6. Our anonymizer: deployed from the class in artifacts/, and not blocked.
  if (net.anonymizer) {
    try {
      const liveClass = await provider.getClassHashAt(net.anonymizer);
      if (net.anonymizerClassHash) {
        check(
          "deployed class hash matches config",
          same(liveClass, net.anonymizerClassHash),
          same(liveClass, net.anonymizerClassHash) ? undefined : `chain says ${liveClass}`,
        );
      }
      if (existsSync(SIERRA)) {
        const computed = hash.computeContractClassHash(JSON.parse(readFileSync(SIERRA)));
        check(
          "deployed class is the class in artifacts/",
          same(liveClass, computed),
          same(liveClass, computed) ? undefined : `artifact hashes to ${computed}`,
        );
      } else {
        skip("artifact class hash", "artifacts/ not present");
      }
    } catch (e) {
      check("anonymizer class hash", false, e.message);
    }

    try {
      const [blocked] = await callFn(provider, net.strk20Pool, "is_open_note_depositor_blocked", [
        net.anonymizer,
      ]);
      check("anonymizer not blocked as open-note depositor", BigInt(blocked) === 0n);
    } catch (e) {
      check("blocklist check", false, e.message);
    }
  } else {
    skip("anonymizer", "not deployed on this network yet");
  }
}

console.log(failures === 0 ? "\nAll facts verified.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
