// Deploy the Sepolia test venue for rehearsing the vault leg.
//
//   node scripts/deploy-test-vault.mjs
//
// Vesu has no Sepolia deployment, so stage 2 of the runner — the pool
// withdrawing to the anonymizer, the anonymizer depositing into a vault, and the
// output landing in an open note — has nowhere to happen on testnet. This
// deploys `MockVesuVault` over the real Sepolia STRK token: a 1:1 vault the
// snforge suite already exercises in both directions.
//
// It is a test double and it is deliberately Sepolia-only. Mainnet must point at
// the real Vesu vToken; this script refuses to touch mainnet config at all.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Account, RpcProvider } from "starknet";

const ROOT = new URL("../", import.meta.url);
const CFG_PATH = new URL("config/addresses.json", ROOT);
const SIERRA = new URL("artifacts/rhizome_anonymizer_MockVesuVault.contract_class.json", ROOT);
const CASM = new URL("artifacts/rhizome_anonymizer_MockVesuVault.compiled_contract_class.json", ROOT);

const cfg = JSON.parse(readFileSync(CFG_PATH));
const net = cfg.sepolia;
const STRK = net.tokens?.STRK ?? cfg.mainnet.tokens.STRK;

for (const p of [SIERRA, CASM]) {
  if (!existsSync(p)) {
    console.error(
      `missing ${p.pathname}\n` +
        "The mock vault class is published by CI. Push the contracts workflow and `git pull`.",
    );
    process.exit(1);
  }
}

const envPath = new URL(".env.sepolia", ROOT);
if (!existsSync(envPath)) {
  console.error("missing .env.sepolia — run `node scripts/sepolia-account.mjs create` first");
  process.exit(1);
}
const env = {};
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const address = env.SEPOLIA_DEPLOYER_ADDRESS;
const privateKey = env.SEPOLIA_DEPLOYER_PRIVATE_KEY;
if (!address || !privateKey) {
  console.error(".env.sepolia must define SEPOLIA_DEPLOYER_ADDRESS and _PRIVATE_KEY");
  process.exit(1);
}

async function connect() {
  for (const url of net.rpc) {
    try {
      const provider = new RpcProvider({ nodeUrl: url });
      await provider.getBlockNumber();
      return provider;
    } catch {
      /* next */
    }
  }
  throw new Error("no reachable Sepolia RPC");
}

const provider = await connect();
const account = new Account({ provider, address, signer: privateKey, cairoVersion: "1" });

console.log(`network    sepolia`);
console.log(`deployer   ${address}`);
console.log(`underlying ${STRK}  (real Sepolia STRK)`);

const declared = await account.declareIfNot({
  contract: JSON.parse(readFileSync(SIERRA)),
  casm: JSON.parse(readFileSync(CASM)),
});
console.log(`class      ${declared.class_hash}`);
if (declared.transaction_hash) {
  await provider.waitForTransaction(declared.transaction_hash);
  console.log(`declare    ${declared.transaction_hash}`);
} else {
  console.log("declare    already declared, skipped");
}

// constructor(underlying: ContractAddress, mints_shares: bool)
const deployed = await account.deployContract({
  classHash: declared.class_hash,
  constructorCalldata: [STRK, "0x1"],
});
console.log(`deploy     ${deployed.transaction_hash}`);
await provider.waitForTransaction(deployed.transaction_hash);
console.log(`address    ${deployed.contract_address}`);

cfg.sepolia.vesu = {
  kind: "mock",
  note: "MockVesuVault over real Sepolia STRK, 1:1 shares. A test double for rehearsing the vault leg — Vesu has no Sepolia deployment. Not an ERC-4626: no asset() or convert_to_assets().",
  vTokens: { STRK: deployed.contract_address },
  classHash: declared.class_hash,
};
writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2) + "\n");
console.log("\nrecorded as sepolia.vesu in config/addresses.json");
console.log("next: npm run verify:facts, then rehearse stage 2 in the UI");
