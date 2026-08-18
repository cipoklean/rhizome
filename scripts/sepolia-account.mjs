// Throwaway Sepolia deployer account.
//
//   node scripts/sepolia-account.mjs create   # generate a key, print the address
//   node scripts/sepolia-account.mjs status   # funded? deployed?
//   node scripts/sepolia-account.mjs deploy   # deploy once funded
//
// This key is Sepolia-only and holds nothing of value. It exists so that
// declaring and deploying contracts never touches a mainnet key. It is written
// to .env.sepolia, which .gitignore excludes — do not commit it, and do not
// reuse it on mainnet.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Account, RpcProvider, ec, hash } from "starknet";

const ENV_PATH = new URL("../.env.sepolia", import.meta.url);
const cfg = JSON.parse(readFileSync(new URL("../config/addresses.json", import.meta.url)));
const NET = cfg.sepolia;
const STRK = cfg.mainnet.tokens.STRK; // same canonical address on Sepolia

async function connect() {
  for (const url of NET.rpc) {
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

function readEnv() {
  if (!existsSync(ENV_PATH)) return null;
  const out = {};
  for (const line of readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

async function strkBalance(provider, address) {
  const [low] = await provider.callContract({
    contractAddress: STRK,
    entrypoint: "balance_of",
    calldata: [address],
  });
  return BigInt(low);
}

const mode = process.argv[2] ?? "status";

if (mode === "create") {
  if (existsSync(ENV_PATH)) {
    console.error("refusing to overwrite existing .env.sepolia — delete it first if you mean to");
    process.exit(1);
  }

  const privateKey = "0x" + Buffer.from(ec.starkCurve.utils.randomPrivateKey()).toString("hex");
  const publicKey = ec.starkCurve.getStarkKey(privateKey);
  const classHash = NET.accountClassHash;

  // Counterfactual: salt = public key, no deployer.
  const address = hash.calculateContractAddressFromHash(publicKey, classHash, [publicKey], 0);

  writeFileSync(
    ENV_PATH,
    [
      "# Sepolia-only throwaway deployer. Never use on mainnet. Never commit.",
      `SEPOLIA_DEPLOYER_PRIVATE_KEY=${privateKey}`,
      `SEPOLIA_DEPLOYER_PUBLIC_KEY=${publicKey}`,
      `SEPOLIA_DEPLOYER_ADDRESS=${address}`,
      `SEPOLIA_ACCOUNT_CLASS_HASH=${classHash}`,
      "",
    ].join("\n"),
  );

  console.log("Created .env.sepolia (private key stays in that file, not printed here).\n");
  console.log(`  address     ${address}`);
  console.log(`  class hash  ${classHash}\n`);
  console.log("Next: fund it with Sepolia STRK at https://faucet.starknet.io/");
  console.log("Then: node scripts/sepolia-account.mjs deploy");
} else if (mode === "status") {
  const env = readEnv();
  if (!env) {
    console.error("no .env.sepolia — run `node scripts/sepolia-account.mjs create` first");
    process.exit(1);
  }
  const provider = await connect();
  const address = env.SEPOLIA_DEPLOYER_ADDRESS;
  const balance = await strkBalance(provider, address);

  let deployed = false;
  try {
    await provider.getClassHashAt(address);
    deployed = true;
  } catch {
    deployed = false;
  }

  console.log(`  address   ${address}`);
  console.log(`  STRK      ${Number(balance) / 1e18}`);
  console.log(`  deployed  ${deployed ? "yes" : "no"}`);
  if (!deployed && balance === 0n) {
    console.log("\nFund it at https://faucet.starknet.io/ then run `deploy`.");
  }
} else if (mode === "deploy") {
  const env = readEnv();
  if (!env) {
    console.error("no .env.sepolia — run `create` first");
    process.exit(1);
  }
  const provider = await connect();
  const address = env.SEPOLIA_DEPLOYER_ADDRESS;

  try {
    await provider.getClassHashAt(address);
    console.log("already deployed, nothing to do");
    process.exit(0);
  } catch {
    /* not deployed, continue */
  }

  const balance = await strkBalance(provider, address);
  if (balance === 0n) {
    console.error(`${address} has no STRK — fund it at https://faucet.starknet.io/ first`);
    process.exit(1);
  }

  const account = new Account({
    provider,
    address,
    signer: env.SEPOLIA_DEPLOYER_PRIVATE_KEY,
    cairoVersion: "1",
  });

  const { transaction_hash, contract_address } = await account.deployAccount({
    classHash: env.SEPOLIA_ACCOUNT_CLASS_HASH,
    constructorCalldata: [env.SEPOLIA_DEPLOYER_PUBLIC_KEY],
    addressSalt: env.SEPOLIA_DEPLOYER_PUBLIC_KEY,
    contractAddress: address,
  });

  console.log(`deploy tx ${transaction_hash}`);
  await provider.waitForTransaction(transaction_hash);
  console.log(`deployed at ${contract_address}`);
} else {
  console.error(`unknown mode "${mode}" — use create | status | deploy`);
  process.exit(1);
}
