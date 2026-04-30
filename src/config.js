import fs from "fs";
import { isAddress, parseUnits } from "viem";

export function loadConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch (e) {
    throw new Error(`Invalid JSON in config: ${e.message}`);
  }

  // Global fields
  if (!raw.rpcUrl) throw new Error("rpcUrl is required");
  if (!raw.wallets || !Array.isArray(raw.wallets) || raw.wallets.length === 0) {
    throw new Error("wallets must be a non-empty array");
  }

  // Validate amount strings
  validateAmount("minUsdceToWrap", raw.minUsdceToWrap || "0.01");
  validateAmount("maxWrapPerWalletPerRun", raw.maxWrapPerWalletPerRun || "1000000");

  const concurrency = Math.max(1, raw.concurrency || 1);
  const enabledWallets = raw.wallets.filter(w => w.enabled !== false);

  if (enabledWallets.length === 0) {
    throw new Error("At least one wallet must be enabled");
  }

  // Duplicate name check
  const names = enabledWallets.map(w => w.name);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length > 0) {
    throw new Error(`Duplicate wallet names: ${[...new Set(dupes)].join(", ")}`);
  }

  // Resolve each wallet
  const resolved = enabledWallets.map(wallet => resolveWallet(wallet));

  return {
    rpcUrl: raw.rpcUrl,
    clobHost: raw.clobHost || "https://clob.polymarket.com",
    pollIntervalMs: raw.pollIntervalMs || 30000,
    confirmations: raw.confirmations || 1,
    concurrency,
    minUsdceToWrap: raw.minUsdceToWrap || "0.01",
    maxWrapPerWalletPerRun: raw.maxWrapPerWalletPerRun || "1000000",
    approveMode: raw.approveMode === "max" ? "max" : "exact",
    wallets: resolved
  };
}

function resolveWallet(wallet) {
  if (!wallet.name) throw new Error("Each wallet must have a name");
  if (!wallet.privateKeyEnv) throw new Error(`Wallet ${wallet.name}: privateKeyEnv is required`);

  const privateKey = process.env[wallet.privateKeyEnv];
  if (!privateKey) {
    throw new Error(`Wallet ${wallet.name}: env var ${wallet.privateKeyEnv} not set`);
  }

  const recipient = wallet.recipient;
  if (!recipient || !isAddress(recipient)) {
    throw new Error(`Wallet ${wallet.name}: invalid recipient address "${recipient}"`);
  }

  const result = {
    name: wallet.name,
    mode: wallet.mode || "eoa",
    privateKey,
    recipient,
    clob: { enabled: false }
  };

  if (wallet.clob?.enabled) {
    const apiKey = process.env[wallet.clob.apiKeyEnv];
    const secret = process.env[wallet.clob.secretEnv];
    const passphrase = process.env[wallet.clob.passphraseEnv];

    if (!apiKey || !secret || !passphrase) {
      throw new Error(
        `Wallet ${wallet.name}: CLOB enabled but credentials incomplete ` +
        `(check ${wallet.clob.apiKeyEnv}, ${wallet.clob.secretEnv}, ${wallet.clob.passphraseEnv})`
      );
    }

    result.clob = {
      enabled: true,
      key: apiKey,
      secret,
      passphrase
    };
  }

  return result;
}

function validateAmount(field, value) {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string, got ${typeof value}`);
  }
  try {
    parseUnits(value, 6);
  } catch {
    throw new Error(`${field} "${value}" is not a valid 6-decimal amount`);
  }
}
