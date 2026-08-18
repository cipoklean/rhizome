// Declare and deploy the Rhizome anonymizer from the CI-built class.
//
//   node scripts/deploy-anonymizer.mjs sepolia
//   node scripts/deploy-anonymizer.mjs mainnet --confirm
//
// Reads the compiled class from artifacts/ (published by CI, since there is no
// local Cairo toolchain) and records the deployed address in
// config/addresses.json. Mainnet requires --confirm.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Account, RpcProvider } from "starknet";

const ROOT = new URL("../", import.meta.url);
const CFG_PATH = new URL("config/addresses.json", ROOT);
const SIERRA = new URL(
  "artifacts/rhizome_anonymizer_RhizomeVesuAnonymizer.contract_class.json",
  ROOT,
);
const CASM = new URL(
  "artifacts/rhizome_anonymizer_RhizomeVesuAnonymizer.compiled_contract_class.json",
  ROOT,
);

const network = process.argv[2];
const confirmed = process.argv.includes("--confirm");

if (!["sepolia", "mainnet"].includes(network)) {
  console.error("usage: node scripts/deploy-anonymizer.mjs <sepolia|mainnet> [--confirm]");
  process.exit(1);
}
if (network === "mainnet" && !confirmed) {
  console.error("mainnet deployment spends real funds — re-run with --confirm");
  process.exit(1);
}

const cfg = JSON.parse(readFileSync(CFG_PATH));
const net = cfg[network];

for (const p of [SIERRA, CASM]) {
  if (!existsSync(p)) {
    console.error(`missing ${p.pathname} — run \`git pull\` to fetch CI-built artifacts`);
    process.exit(1);
  }
}

const envPath = new URL(`.env.${network}`, ROOT);
if (!existsSync(envPath)) {
  console.error(`missing .env.${network} with a deployer key`);
  process.exit(1);
}
const env = {};
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const prefix = network.toUpperCase();
const address = env[`${prefix}_DEPLOYER_ADDRESS`];
const privateKey = env[`${prefix}_DEPLOYER_PRIVATE_KEY`];
if (!address || !privateKey) {
  console.error(`.env.${network} must define ${prefix}_DEPLOYER_ADDRESS and _PRIVATE_KEY`);
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
  throw new Error(`no reachable ${network} RPC`);
}

const provider = await connect();
const account = new Account({ provider, address, signer: privateKey, cairoVersion: "1" });

const sierra = JSON.parse(readFileSync(SIERRA));
const casm = JSON.parse(readFileSync(CASM));

console.log(`network   ${network}`);
console.log(`deployer  ${address}`);

const declared = await account.declareIfNot({ contract: sierra, casm });
console.log(`class     ${declared.class_hash}`);
if (declared.transaction_hash) {
  console.log(`declare   ${declared.transaction_hash}`);
  await provider.waitForTransaction(declared.transaction_hash);
} else {
  console.log("declare   already declared, skipped");
}

const deployed = await account.deployContract({ classHash: declared.class_hash });
console.log(`deploy    ${deployed.transaction_hash}`);
await provider.waitForTransaction(deployed.transaction_hash);
console.log(`address   ${deployed.contract_address}`);

// Record it so verify-facts and the app pick it up.
cfg[network].anonymizer = deployed.contract_address;
cfg[network].anonymizerClassHash = declared.class_hash;
writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2) + "\n");
console.log("\nrecorded in config/addresses.json");
