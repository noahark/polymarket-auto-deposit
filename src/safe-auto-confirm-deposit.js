import { parseArgs } from "node:util";
import { config as dotenvConfig } from "dotenv";
import fs from "fs";
import { join } from "path";
import {
  parseUnits,
  formatUnits,
  encodeFunctionData,
  createPublicClient,
  createWalletClient,
  http,
  isAddress,
  parseAbi
} from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import Safe from "@safe-global/protocol-kit";
import { OperationType, SigningMethod } from "@safe-global/types-kit";
import {
  USDCE,
  PUSD,
  COLLATERAL_ONRAMP,
  POLYGON_CHAIN_ID,
  ERC20_ABI as ERC20_ABI_RAW,
  ONRAMP_ABI as ONRAMP_ABI_RAW
} from "./constants.js";
import { createLogger } from "./logger.js";

const ERC20_ABI = parseAbi(ERC20_ABI_RAW);
const ONRAMP_ABI = parseAbi(ONRAMP_ABI_RAW);

const MIN_POL = parseUnits("0.05", 18);
const CLOB_RETRY_DELAYS = [2000, 5000, 10000, 20000, 30000];
const PENDING_FILE = "clob-refresh-pending.json";

// ---------------------------------------------------------------------------
// Custom errors
// ---------------------------------------------------------------------------

class VerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = "VerificationError";
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseCli() {
  const { values } = parseArgs({
    options: {
      config: { type: "string" },
      once: { type: "boolean" },
      watch: { type: "boolean" },
      wallet: { type: "string" },
      "dry-run": { type: "boolean" },
      amount: { type: "string" },
      "no-clob-refresh": { type: "boolean" },
      "refresh-only": { type: "boolean" }
    },
    strict: true
  });

  if (!values.config) {
    console.error("--config is required");
    process.exit(1);
  }

  const hasMode = values.once || values.watch || values["refresh-only"];

  if (!hasMode) {
    console.error("one of --once, --watch, or --refresh-only is required");
    process.exit(1);
  }

  const modes = [values.once, values.watch, values["refresh-only"]].filter(Boolean);
  if (modes.length > 1) {
    console.error("--once, --watch, and --refresh-only are mutually exclusive");
    process.exit(1);
  }

  return values;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function validateAmount(field, value) {
  if (typeof value !== "string") {
    throw new Error(`${field} must be string, got ${typeof value}`);
  }
  let parsed;
  try {
    parsed = parseUnits(value, 6);
  } catch {
    throw new Error(`${field} "${value}" is not a valid 6-decimal amount`);
  }
  if (parsed <= 0n) {
    throw new Error(`${field} "${value}" must be > 0`);
  }
}

function resolveSafeWallet(wallet) {
  if (!wallet.name) throw new Error("Each wallet must have a name");

  if (wallet.executionMode !== "safe") {
    throw new Error(`Wallet ${wallet.name}: executionMode must be "safe", got "${wallet.executionMode}"`);
  }

  if (!wallet.safeAddress) {
    throw new Error(
      `Wallet ${wallet.name}: safeAddress is required. ` +
      `This must be the Polymarket Safe Proxy Wallet address, not the EOA owner address.`
    );
  }

  if (!isAddress(wallet.safeAddress)) {
    throw new Error(
      `Wallet ${wallet.name}: invalid safeAddress "${wallet.safeAddress}". ` +
      `Expected the Polymarket Safe Proxy Wallet address.`
    );
  }

  if (!wallet.ownerPrivateKeyEnv) {
    throw new Error(`Wallet ${wallet.name}: ownerPrivateKeyEnv is required`);
  }

  const privateKey = process.env[wallet.ownerPrivateKeyEnv];
  if (!privateKey) {
    throw new Error(`Wallet ${wallet.name}: env var ${wallet.ownerPrivateKeyEnv} not set`);
  }

  const normalizedPrivateKey = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
  const derivedAccount = privateKeyToAccount(normalizedPrivateKey);

  let ownerAddress = derivedAccount.address;

  if (wallet.ownerAddress !== undefined && wallet.ownerAddress !== "") {
    if (!isAddress(wallet.ownerAddress)) {
      throw new Error(`Wallet ${wallet.name}: invalid ownerAddress "${wallet.ownerAddress}"`);
    }
    if (derivedAccount.address.toLowerCase() !== wallet.ownerAddress.toLowerCase()) {
      throw new Error(
        `Wallet ${wallet.name}: private key derives to ${derivedAccount.address}, ` +
        `expected ${wallet.ownerAddress}`
      );
    }
    ownerAddress = wallet.ownerAddress;
  }

  const result = {
    name: wallet.name,
    safeAddress: wallet.safeAddress,
    ownerAddress,
    privateKey: normalizedPrivateKey,
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

function loadSafeConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch (e) {
    throw new Error(`Invalid JSON in config: ${e.message}`);
  }

  if (!raw.rpcUrl) throw new Error("rpcUrl is required");

  const pollIntervalMs = raw.pollIntervalMs ?? 60000;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 10000 || pollIntervalMs > 60000) {
    throw new Error("pollIntervalMs must be integer in [10000, 60000]");
  }

  const confirmations = raw.confirmations ?? 1;
  if (!Number.isInteger(confirmations) || confirmations < 1 || confirmations > 20) {
    throw new Error("confirmations must be integer in [1, 20]");
  }

  const concurrency = raw.concurrency ?? 1;
  if (concurrency !== 1) {
    throw new Error("concurrency must be 1 for Safe mode");
  }

  const minUsdceToWrap = raw.minUsdceToWrap ?? "0.000001";
  const maxWrapPerWalletPerRun = raw.maxWrapPerWalletPerRun ?? "1000000";
  validateAmount("minUsdceToWrap", minUsdceToWrap);
  validateAmount("maxWrapPerWalletPerRun", maxWrapPerWalletPerRun);

  if (!raw.wallets || !Array.isArray(raw.wallets) || raw.wallets.length === 0) {
    throw new Error("wallets must be a non-empty array");
  }

  const enabledWallets = raw.wallets.filter(w => w.enabled !== false);
  if (enabledWallets.length === 0) {
    throw new Error("At least one wallet must be enabled");
  }

  const names = enabledWallets.map(w => w.name);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length > 0) {
    throw new Error(`Duplicate wallet names: ${[...new Set(dupes)].join(", ")}`);
  }

  const wallets = enabledWallets.map(w => resolveSafeWallet(w));

  return {
    rpcUrl: raw.rpcUrl,
    clobHost: raw.clobHost || "https://clob.polymarket.com",
    pollIntervalMs,
    confirmations,
    concurrency,
    minUsdceToWrap,
    maxWrapPerWalletPerRun,
    wallets
  };
}

// ---------------------------------------------------------------------------
// Viem clients
// ---------------------------------------------------------------------------

function createViemClients(rpcUrl, ownerPrivateKey) {
  const account = privateKeyToAccount(ownerPrivateKey);
  const transport = http(rpcUrl);

  const publicClient = createPublicClient({ chain: polygon, transport });
  const walletClient = createWalletClient({ account, chain: polygon, transport });

  return { publicClient, walletClient, account };
}

async function readUsdceBalance(publicClient, address) {
  return publicClient.readContract({
    address: USDCE,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [address]
  });
}

async function readPusdBalance(publicClient, address) {
  return publicClient.readContract({
    address: PUSD,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [address]
  });
}

async function readUsdceAllowance(publicClient, owner, spender) {
  return publicClient.readContract({
    address: USDCE,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [owner, spender]
  });
}

// ---------------------------------------------------------------------------
// CLOB refresh with retry
// ---------------------------------------------------------------------------

function isRetryableError(err) {
  const retryableCodes = ["ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "EPIPE"];
  const code = err.code || err.cause?.code || err.cause?.errors?.[0]?.code;
  if (retryableCodes.includes(code)) return true;
  const status = err.status || err.response?.status;
  if (typeof status === "number" && status >= 500 && status < 600) return true;
  return false;
}

function safeErrorMessage(err) {
  const code = err.code || err.cause?.code || "";
  const status = err.status || err.response?.status || "";
  if (code) return `${code}: ${err.message || "network error"}`;
  if (status) return `HTTP ${status}`;
  return err.message || "unknown error";
}

async function retryWithBackoff(fn, tag, logger) {
  for (let i = 0; i <= CLOB_RETRY_DELAYS.length; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryableError(err) || i === CLOB_RETRY_DELAYS.length) throw err;
      const delay = CLOB_RETRY_DELAYS[i];
      logger.warn(tag, `CLOB retry ${i + 1}/${CLOB_RETRY_DELAYS.length} after ${delay}ms: ${safeErrorMessage(err)}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

async function refreshSafeClob(clobHost, walletClient, wallet, tag, logger) {
  return retryWithBackoff(async () => {
    const { AssetType, Chain, ClobClient, SignatureTypeV2 } =
      await import("@polymarket/clob-client-v2");

    const clobClient = new ClobClient({
      host: clobHost,
      chain: Chain.POLYGON,
      signer: walletClient,
      creds: {
        key: wallet.clob.key,
        secret: wallet.clob.secret,
        passphrase: wallet.clob.passphrase
      },
      signatureType: SignatureTypeV2.POLY_GNOSIS_SAFE,
      funderAddress: wallet.safeAddress,
      throwOnError: true,
      retryOnError: true
    });

    await clobClient.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });

    const collateral = await clobClient.getBalanceAllowance({
      asset_type: AssetType.COLLATERAL
    });

    if (!collateral || collateral.balance === undefined || collateral.allowance === undefined) {
      throw new Error("CLOB getBalanceAllowance returned invalid response");
    }

    return collateral;
  }, tag, logger);
}

// ---------------------------------------------------------------------------
// Pending CLOB state file
// ---------------------------------------------------------------------------

function pendingPath() {
  return join(process.cwd(), "logs", PENDING_FILE);
}

function writeClobPending(tag, entry) {
  const p = pendingPath();
  const dir = join(process.cwd(), "logs");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let entries = [];
  if (fs.existsSync(p)) {
    try { entries = JSON.parse(fs.readFileSync(p, "utf-8")); } catch { entries = []; }
  }

  entries.push({ wallet: tag, ...entry, ts: new Date().toISOString() });
  fs.writeFileSync(p, JSON.stringify(entries, null, 2) + "\n");
}

function readClobPending(tag) {
  const p = pendingPath();
  if (!fs.existsSync(p)) return [];
  try {
    const entries = JSON.parse(fs.readFileSync(p, "utf-8"));
    return entries.filter(e => e.wallet === tag);
  } catch {
    return [];
  }
}

function clearClobPending(tag) {
  const p = pendingPath();
  if (!fs.existsSync(p)) return;
  try {
    const entries = JSON.parse(fs.readFileSync(p, "utf-8"));
    const remaining = entries.filter(e => e.wallet !== tag);
    if (remaining.length === 0) {
      fs.unlinkSync(p);
    } else {
      fs.writeFileSync(p, JSON.stringify(remaining, null, 2) + "\n");
    }
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Process pending CLOB refreshes
// ---------------------------------------------------------------------------

async function processPendingClobRefresh(wallets, globalConfig, logger) {
  const results = [];

  for (const wallet of wallets) {
    if (!wallet.clob.enabled) continue;
    const pending = readClobPending(wallet.name);
    if (pending.length === 0) continue;

    const tag = wallet.name;
    logger.info(tag, `found ${pending.length} pending CLOB refresh(es)`);

    const { walletClient } = createViemClients(globalConfig.rpcUrl, wallet.privateKey);

    try {
      const collateral = await refreshSafeClob(globalConfig.clobHost, walletClient, wallet, tag, logger);
      logger.info(tag, `CLOB pending refresh OK: balance=${collateral.balance} allowance=${collateral.allowance}`);
      clearClobPending(tag);
      results.push({ status: "success", wallet: tag });
    } catch (err) {
      logger.error(tag, `CLOB pending refresh failed: ${safeErrorMessage(err)}`);
      results.push({ status: "clob_error", wallet: tag });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// --refresh-only mode
// ---------------------------------------------------------------------------

async function runRefreshOnly(wallets, globalConfig, logger) {
  const results = [];

  // First handle any pending
  const pendingResults = await processPendingClobRefresh(wallets, globalConfig, logger);
  results.push(...pendingResults);

  // Then do a fresh refresh for each wallet
  for (const wallet of wallets) {
    if (!wallet.clob.enabled) {
      logger.info(wallet.name, "CLOB disabled, skipping");
      results.push({ status: "skip", wallet: wallet.name, reason: "clob_disabled" });
      continue;
    }

    const tag = wallet.name;
    const { walletClient } = createViemClients(globalConfig.rpcUrl, wallet.privateKey);

    try {
      const collateral = await refreshSafeClob(globalConfig.clobHost, walletClient, wallet, tag, logger);
      logger.info(tag, `CLOB balance=${collateral.balance} allowance=${collateral.allowance}`);
      results.push({ status: "success", wallet: tag });
    } catch (err) {
      logger.error(tag, `CLOB refresh failed: ${safeErrorMessage(err)}`);
      results.push({ status: "clob_error", wallet: tag });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Process one wallet (wrap mode)
// ---------------------------------------------------------------------------

async function processWallet(wallet, globalConfig, logger, opts) {
  const tag = wallet.name;

  // Create viem clients for reading + CLOB
  const { publicClient, walletClient } = createViemClients(globalConfig.rpcUrl, wallet.privateKey);

  // Initialize Safe Protocol Kit
  const safe = await Safe.init({
    provider: globalConfig.rpcUrl,
    signer: wallet.privateKey,
    safeAddress: wallet.safeAddress
  });

  // Validate chain
  const chainId = Number(await safe.getChainId());
  if (chainId !== POLYGON_CHAIN_ID) {
    throw new Error(`Wrong chain: ${chainId}, expected ${POLYGON_CHAIN_ID}`);
  }

  // Validate owner
  const owners = await safe.getOwners();
  if (!owners.some(x => x.toLowerCase() === wallet.ownerAddress.toLowerCase())) {
    throw new Error(
      `${wallet.ownerAddress} is not an owner of Safe ${wallet.safeAddress}`
    );
  }

  // Validate threshold
  const threshold = await safe.getThreshold();
  if (threshold !== 1) {
    throw new Error(
      `Unsupported Safe threshold ${threshold}; this script only supports 1/1 Safe`
    );
  }

  const nonce = await safe.getNonce();

  // Read chain state
  const eoaPolBalance = await publicClient.getBalance({ address: wallet.ownerAddress });
  const safeUsdceBalance = await readUsdceBalance(publicClient, wallet.safeAddress);
  const safePusdBalance = await readPusdBalance(publicClient, wallet.safeAddress);
  const safeAllowance = await readUsdceAllowance(publicClient, wallet.safeAddress, COLLATERAL_ONRAMP);

  // Log state
  logger.info(tag, `owner=${wallet.ownerAddress}`);
  logger.info(tag, `safe=${wallet.safeAddress}`);
  logger.info(tag, `chainId=${chainId}`);
  logger.info(tag, `threshold=${threshold}`);
  logger.info(tag, `safe nonce=${nonce}`);
  logger.info(tag, `EOA POL balance=${formatUnits(eoaPolBalance, 18)}`);
  logger.info(tag, `Safe USDC.e balance=${formatUnits(safeUsdceBalance, 6)}`);
  logger.info(tag, `Safe pUSD balance=${formatUnits(safePusdBalance, 6)}`);
  logger.info(tag, `Safe allowance to Onramp=${formatUnits(safeAllowance, 6)}`);

  // Determine amount to wrap
  const minWrap = parseUnits(globalConfig.minUsdceToWrap, 6);
  let amountToWrap;

  if (opts.amount) {
    amountToWrap = parseUnits(opts.amount, 6);
    if (amountToWrap > safeUsdceBalance) {
      if (opts.watchMode) {
        logger.info(
          tag,
          `waiting for --amount ${opts.amount}; current Safe USDC.e balance is ${formatUnits(safeUsdceBalance, 6)}`
        );
        return { status: "skip", wallet: tag, reason: "insufficient_fixed_amount" };
      }
      logger.error(
        tag,
        `--amount ${opts.amount} exceeds Safe USDC.e balance ${formatUnits(safeUsdceBalance, 6)}`
      );
      return { status: "amount_error", wallet: tag };
    }
  } else {
    if (safeUsdceBalance < minWrap) {
      logger.info(tag, "no pending USDC.e to wrap");
      return { status: "skip", wallet: tag, reason: "no_pending" };
    }
    const maxWrap = parseUnits(globalConfig.maxWrapPerWalletPerRun, 6);
    amountToWrap = safeUsdceBalance < maxWrap ? safeUsdceBalance : maxWrap;
  }

  // Gas check — now we know there is pending USDC.e to wrap
  if (eoaPolBalance < MIN_POL) {
    if (opts.dryRun) {
      logger.warn(tag, `WARNING: EOA POL balance too low (${formatUnits(eoaPolBalance, 18)}) for real execution`);
    } else {
      logger.error(tag, `EOA POL balance too low (${formatUnits(eoaPolBalance, 18)}) to execute wrap of ${formatUnits(amountToWrap, 6)} USDC.e`);
      return { status: "chain_error", wallet: tag, error: "low_gas" };
    }
  }

  logger.info(tag, `amountToWrap=${formatUnits(amountToWrap, 6)}`);

  // Dry-run
  if (opts.dryRun) {
    logger.info(tag, "DRY RUN: would execute Safe batch:");
    logger.info(tag, `  1. USDC.e.approve(CollateralOnramp, ${formatUnits(amountToWrap, 6)})`);
    logger.info(tag, `  2. CollateralOnramp.wrap(USDC.e, ${wallet.safeAddress}, ${formatUnits(amountToWrap, 6)})`);
    return { status: "dry_run", wallet: tag };
  }

  // -----------------------------------------------------------------------
  // Build Safe batch: approve + wrap
  // -----------------------------------------------------------------------

  const approveData = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "approve",
    args: [COLLATERAL_ONRAMP, amountToWrap]
  });

  const wrapData = encodeFunctionData({
    abi: ONRAMP_ABI,
    functionName: "wrap",
    args: [USDCE, wallet.safeAddress, amountToWrap]
  });

  const transactions = [
    {
      to: USDCE,
      value: "0",
      data: approveData,
      operation: OperationType.Call
    },
    {
      to: COLLATERAL_ONRAMP,
      value: "0",
      data: wrapData,
      operation: OperationType.Call
    }
  ];

  // Create, sign, execute
  const safeTransaction = await safe.createTransaction({
    transactions,
    onlyCalls: true
  });

  const safeTxHash = await safe.getTransactionHash(safeTransaction);

  const signedSafeTransaction = await safe.signTransaction(
    safeTransaction,
    SigningMethod.ETH_SIGN_TYPED_DATA_V4
  );

  const txResult = await safe.executeTransaction(signedSafeTransaction);

  logger.info(tag, `safeTxHash=${safeTxHash}`);
  logger.info(tag, `polygonTxHash=${txResult.hash}`);

  // Wait for receipt
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txResult.hash,
    confirmations: globalConfig.confirmations
  });

  if (receipt.status !== "success") {
    logger.error(tag, `Safe execTransaction reverted: ${txResult.hash}`);
    return { status: "chain_error", wallet: tag, error: "reverted", polygonTxHash: txResult.hash };
  }

  // -----------------------------------------------------------------------
  // pUSD increment verification
  // -----------------------------------------------------------------------

  const pusdBefore = safePusdBalance;
  const pusdAfter = await readPusdBalance(publicClient, wallet.safeAddress);

  logger.info(tag, `pUSD before=${formatUnits(pusdBefore, 6)} after=${formatUnits(pusdAfter, 6)}`);

  if (pusdAfter - pusdBefore !== amountToWrap) {
    throw new VerificationError(
      `pUSD delta mismatch: expected ${formatUnits(amountToWrap, 6)}, ` +
      `got ${formatUnits(pusdAfter - pusdBefore, 6)}`
    );
  }

  // -----------------------------------------------------------------------
  // After-state logging
  // -----------------------------------------------------------------------

  const usdceAfter = await readUsdceBalance(publicClient, wallet.safeAddress);
  const allowanceAfter = await readUsdceAllowance(publicClient, wallet.safeAddress, COLLATERAL_ONRAMP);

  logger.info(tag, `Safe USDC.e after=${formatUnits(usdceAfter, 6)}`);
  logger.info(tag, `Safe pUSD after=${formatUnits(pusdAfter, 6)}`);
  logger.info(tag, `Safe allowance after=${formatUnits(allowanceAfter, 6)}`);

  if (allowanceAfter !== 0n) {
    logger.warn(tag, `allowance after wrap is not 0 (${formatUnits(allowanceAfter, 6)}), expected exact approve to be consumed`);
  }

  // -----------------------------------------------------------------------
  // CLOB refresh (optional)
  // -----------------------------------------------------------------------

  if (wallet.clob.enabled && !opts.noClobRefresh) {
    try {
      const collateral = await refreshSafeClob(globalConfig.clobHost, walletClient, wallet, tag, logger);
      logger.info(tag, `CLOB balance=${collateral.balance} allowance=${collateral.allowance}`);
    } catch (err) {
      logger.error(tag, `CLOB refresh failed: ${safeErrorMessage(err)}`);
      // Write pending so next run can retry
      writeClobPending(tag, {
        safe: wallet.safeAddress,
        amount: formatUnits(amountToWrap, 6),
        safeTxHash,
        polygonTxHash: txResult.hash
      });
      logger.json({
        wallet: tag,
        owner: wallet.ownerAddress,
        safe: wallet.safeAddress,
        action: "wrap_success_clob_refresh_failed",
        amount: formatUnits(amountToWrap, 6),
        safeTxHash,
        polygonTxHash: txResult.hash,
        pusdBefore: formatUnits(pusdBefore, 6),
        pusdAfter: formatUnits(pusdAfter, 6)
      });
      return { status: "clob_error", wallet: tag };
    }
  }

  // -----------------------------------------------------------------------
  // Success
  // -----------------------------------------------------------------------

  logger.json({
    wallet: tag,
    owner: wallet.ownerAddress,
    safe: wallet.safeAddress,
    action: "safe_wrap_success",
    amount: formatUnits(amountToWrap, 6),
    safeTxHash,
    polygonTxHash: txResult.hash,
    pusdBefore: formatUnits(pusdBefore, 6),
    pusdAfter: formatUnits(pusdAfter, 6),
    usdceAfter: formatUnits(usdceAfter, 6),
    allowanceAfter: formatUnits(allowanceAfter, 6)
  });

  return { status: "success", wallet: tag };
}

// ---------------------------------------------------------------------------
// Run once
// ---------------------------------------------------------------------------

async function runOnce(wallets, globalConfig, logger, opts) {
  // First handle any pending CLOB refreshes
  const pendingResults = await processPendingClobRefresh(wallets, globalConfig, logger);

  const results = [...pendingResults];

  for (const wallet of wallets) {
    try {
      const result = await processWallet(wallet, globalConfig, logger, opts);
      results.push(result);
    } catch (err) {
      if (err instanceof VerificationError) {
        logger.error(wallet.name, err.message);
        results.push({ status: "verification_error", wallet: wallet.name, error: err.message });
      } else {
        logger.error(wallet.name, `Chain operation failed: ${err.message}`);
        results.push({ status: "chain_error", wallet: wallet.name, error: err.message });
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

function getExitCode(results) {
  const priorities = ["verification_error", "chain_error", "clob_error", "amount_error"];
  const codeMap = {
    verification_error: 4,
    chain_error: 2,
    clob_error: 3,
    amount_error: 1
  };

  for (const p of priorities) {
    if (results.some(r => r.status === p)) return codeMap[p];
  }
  return 0;
}

function printSummary(results) {
  const success = results.filter(r => r.status === "success").length;
  const skip = results.filter(r => r.status === "skip" || r.status === "dry_run").length;
  const fail = results.filter(r => !["success", "skip", "dry_run"].includes(r.status)).length;
  console.log(`\n--- Health: ${success} ok, ${skip} skip, ${fail} fail ---\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  dotenvConfig();

  const args = parseCli();

  let globalConfig;
  try {
    globalConfig = loadSafeConfig(args.config);
  } catch (err) {
    console.error(`Config error: ${err.message}`);
    process.exit(1);
  }

  const logDir = join(process.cwd(), "logs");
  const logger = createLogger(logDir);

  let wallets = globalConfig.wallets;
  if (args.wallet) {
    wallets = wallets.filter(w => w.name === args.wallet);
    if (wallets.length === 0) {
      console.error(`Wallet "${args.wallet}" not found in config`);
      process.exit(1);
    }
  }

  const opts = {
    dryRun: args["dry-run"] || false,
    noClobRefresh: args["no-clob-refresh"] || false,
    amount: args.amount || null,
    watchMode: args.watch || false
  };

  // Validate --amount at CLI phase (exit 1 for user input errors)
  if (args.amount) {
    try {
      validateAmount("--amount", args.amount);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }

  // --amount + --watch requires exactly one wallet
  if (args.watch && args.amount && wallets.length !== 1) {
    console.error("--amount with --watch requires exactly one wallet. Use --wallet <name>.");
    process.exit(1);
  }

  // --refresh-only: only do CLOB refresh, no chain operations
  if (args["refresh-only"]) {
    const results = await runRefreshOnly(wallets, globalConfig, logger);
    printSummary(results);
    process.exit(getExitCode(results));
    return;
  }

  if (args.watch) {
    console.log(`Watching every ${globalConfig.pollIntervalMs}ms, ${wallets.length} wallet(s)...`);

    let shuttingDown = false;
    let signalCount = 0;
    let currentTick = null;
    let requestedExitCode = null;

    const runningWallets = new Set();

    const tick = async () => {
      if (shuttingDown) return;

      for (const wallet of wallets) {
        if (runningWallets.has(wallet.name) || shuttingDown) continue;
        runningWallets.add(wallet.name);
        try {
          await processPendingClobRefresh([wallet], globalConfig, logger);
          let result;
          try {
            result = await processWallet(wallet, globalConfig, logger, opts);
          } catch (err) {
            if (err instanceof VerificationError) {
              logger.error(wallet.name, err.message);
              result = { status: "verification_error", wallet: wallet.name, error: err.message };
            } else {
              throw err;
            }
          }

          // --amount + --watch: stop after successful wrap
          if (opts.amount && ["success", "dry_run", "clob_error", "verification_error"].includes(result.status)) {
            requestedExitCode = getExitCode([result]);
            shuttingDown = true;
            if (intervalId) clearInterval(intervalId);
            break;
          }
        } catch (err) {
          logger.error(wallet.name, err.message);
        } finally {
          runningWallets.delete(wallet.name);
        }
      }
    };

    const startTick = () => {
      if (shuttingDown || currentTick) return currentTick;
      currentTick = tick().finally(() => {
        currentTick = null;
        if (requestedExitCode !== null && !currentTick) {
          console.log(`--amount wrap completed. Exiting with code ${requestedExitCode}.`);
          process.exit(requestedExitCode);
        }
      });
      return currentTick;
    };

    let intervalId = null;

    const shutdown = async (signal) => {
      signalCount += 1;
      if (signalCount > 1) {
        console.error(`\n${signal} received again. Force exiting.`);
        process.exit(130);
      }
      shuttingDown = true;
      if (intervalId) clearInterval(intervalId);
      console.log(`\n${signal} received. Waiting for current wallet operation to finish...`);
      if (currentTick) await currentTick;
      console.log("Shutdown complete.");
      process.exit(0);
    };

    process.on("SIGINT", () => { void shutdown("SIGINT"); });
    process.on("SIGTERM", () => { void shutdown("SIGTERM"); });

    await startTick();
    if (!shuttingDown) intervalId = setInterval(startTick, globalConfig.pollIntervalMs);
  } else {
    const results = await runOnce(wallets, globalConfig, logger, opts);
    printSummary(results);
    process.exit(getExitCode(results));
  }
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
