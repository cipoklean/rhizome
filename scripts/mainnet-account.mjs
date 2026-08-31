// Throwaway MAINNET deployer account (OpenZeppelin-style).
//
//   node scripts/mainnet-account.mjs create   # generate a key, print the address
//   node scripts/mainnet-account.mjs status   # funded? deployed?
//   node scripts/mainnet-account.mjs deploy   # deploy once funded
//
// IMPORTANT: deploy-anonymizer.mjs signs with the starknet.js default (OZ-style)
// signer. Argent X / Braavos keys therefore fail with "invalid signature length".
// Use an OZ account created here, not your personal wallet. The key is written to
// .env.mainnet, which .gitignore excludes — never commit it.
//
// This account spends REAL mainnet STRK. Fund only what the deploy needs.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Account, RpcProvider, ec, hash } from "starknet";

const ENV_PATH = new URL("../.env.mainnet", import.meta.url);
const cfg = JSON.parse(readFileSync(new URL("../config/addresses.json", import.meta.url)));
const NET = cfg.mainnet;
const STRK = cfg.mainnet.tokens.STRK;

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
  throw new Error("no reachable mainnet RPC");
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
    const existing = readFileSync(ENV_PATH, "utf8");
    const hasKey = /^MAINNET_DEPLOYER_PRIVATE_KEY=.+/m.test(existing);
    if (hasKey) {
      console.error("refusing to overwrite existing .env.mainnet with a real key — delete it first if you mean to");
      process.exit(1);
    }
    // Blank/placeholder file (no key value): safe to recreate.
  }

  const privateKey = "0x" + Buffer.from(ec.starkCurve.utils.randomPrivateKey()).toString("hex");
  const publicKey = ec.starkCurve.getStarkKey(privateKey);
  const classHash = NET.accountClassHash;

  // Counterfactual: salt = public key, no deployer.
  const address = hash.calculateContractAddressFromHash(publicKey, classHash, [publicKey], 0);

  writeFileSync(
    ENV_PATH,
    [
      "# Mainnet OZ deployer. Holds REAL STRK. Never commit. Not your personal wallet.",
      `MAINNET_DEPLOYER_PRIVATE_KEY=${privateKey}`,
      `MAINNET_DEPLOYER_PUBLIC_KEY=${publicKey}`,
      `MAINNET_DEPLOYER_ADDRESS=${address}`,
      `MAINNET_ACCOUNT_CLASS_HASH=${classHash}`,
      "",
    ].join("\n"),
  );

  console.log("Created .env.mainnet (private key stays in that file, not printed here).\n");
  console.log(`  address     ${address}`);
  console.log(`  class hash  ${classHash}\n`);
  console.log("Next: fund it with mainnet STRK (a few STRK covers declare + deploy),");
  console.log("then: node scripts/mainnet-account.mjs deploy");
  console.log("then: node scripts/deploy-anonymizer.mjs mainnet --confirm");
} else if (mode === "status") {
  const env = readEnv();
  if (!env) {
    console.error("no .env.mainnet — run `node scripts/mainnet-account.mjs create` first");
    process.exit(1);
  }
  const provider = await connect();
  const address = env.MAINNET_DEPLOYER_ADDRESS;
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
    console.log("\nFund the address with mainnet STRK, then run `deploy`.");
  }
} else if (mode === "deploy") {
  const env = readEnv();
  if (!env) {
    console.error("no .env.mainnet — run `create` first");
    process.exit(1);
  }
  const provider = await connect();
  const address = env.MAINNET_DEPLOYER_ADDRESS;

  try {
    await provider.getClassHashAt(address);
    console.log("already deployed, nothing to do");
    process.exit(0);
  } catch {
    /* not deployed, continue */
  }

  const balance = await strkBalance(provider, address);
  if (balance === 0n) {
    console.error(`${address} has no STRK — fund it first`);
    process.exit(1);
  }

  const account = new Account({
    provider,
    address,
    signer: env.MAINNET_DEPLOYER_PRIVATE_KEY,
    cairoVersion: "1",
  });

  const { transaction_hash, contract_address } = await account.deployAccount({
    classHash: env.MAINNET_ACCOUNT_CLASS_HASH,
    constructorCalldata: [env.MAINNET_DEPLOYER_PUBLIC_KEY],
    addressSalt: env.MAINNET_DEPLOYER_PUBLIC_KEY,
    contractAddress: address,
  });

  console.log(`deploy tx ${transaction_hash}`);
  await provider.waitForTransaction(transaction_hash);
  console.log(`deployed at ${contract_address}`);
} else {
  console.error(`unknown mode "${mode}" — use create | status | deploy`);
  process.exit(1);
}
