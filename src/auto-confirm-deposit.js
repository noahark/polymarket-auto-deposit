import { parseArgs } from "node:util";
import { config as dotenvConfig } from "dotenv";
import { join } from "path";
import { parseUnits, formatUnits, maxUint256 } from "viem";
import { loadConfig } from "./config.js";
import {
  createClients,
  getChainId,
  getPolBalance,
  getUsdceBalance,
  getPusdBalance,
  getUsdceAllowance,
  approveUsdce,
  wrapUsdce
} from "./chain.js";
import { COLLATERAL_ONRAMP, POLYGON_CHAIN_ID } from "./constants.js";
import { refreshClobBalance } from "./clob.js";
import { createLogger } from "./logger.js";

dotenvConfig();

const MIN_POL = parseUnits("0.05", 18);

function parseCli() {
  const { values } = parseArgs({
    options: {
      config: { type: "string" },
      once: { type: "boolean" },
      watch: { type: "boolean" },
      wallet: { type: "string" },
      "dry-run": { type: "boolean" },
      "no-clob-refresh": { type: "boolean" }
    },
    strict: true
  });
  return values;
}

async function processWallet(wallet, globalConfig, logger, opts) {
  const { dryRun, noClobRefresh } = opts;
  const tag = wallet.name;

  try {
    const { publicClient, walletClient, account } = createClients(globalConfig.rpcUrl, wallet.privateKey);
    const sourceAddress = account.address;
    const recipient = wallet.recipient;

    logger.info(tag, `source=${sourceAddress} recipient=${recipient}`);

    // Chain ID check
    const chainId = await getChainId(publicClient);
    if (chainId !== POLYGON_CHAIN_ID) {
      logger.error(tag, `Wrong chain ID: ${chainId}, expected ${POLYGON_CHAIN_ID}`);
      return { status: "chain_error", wallet: tag, error: "wrong_chain" };
    }

    // POL balance check
    const polBalance = await getPolBalance(publicClient, sourceAddress);
    logger.info(tag, `POL balance=${formatUnits(polBalance, 18)}`);
    if (polBalance < MIN_POL) {
      logger.warn(tag, "POL balance too low, skipping");
      return { status: "skip", wallet: tag, reason: "low_pol" };
    }

    // USDC.e balance
    const usdceBalance = await getUsdceBalance(publicClient, sourceAddress);
    logger.info(tag, `USDC.e pending=${formatUnits(usdceBalance, 6)}`);

    const minWrap = parseUnits(globalConfig.minUsdceToWrap, 6);
    if (usdceBalance < minWrap) {
      logger.info(tag, "no pending deposit to wrap");
      return { status: "skip", wallet: tag, reason: "no_pending" };
    }

    // Calculate amount to wrap
    const maxWrap = parseUnits(globalConfig.maxWrapPerWalletPerRun, 6);
    const amountToWrap = usdceBalance < maxWrap ? usdceBalance : maxWrap;

    if (dryRun) {
      logger.info(tag, `[DRY RUN] would wrap ${formatUnits(amountToWrap, 6)} USDC.e to ${recipient}`);
      return { status: "dry_run", wallet: tag };
    }

    // Allowance check
    const allowance = await getUsdceAllowance(publicClient, sourceAddress, COLLATERAL_ONRAMP);
    let approveTx = null;

    if (allowance < amountToWrap) {
      const approveAmount = globalConfig.approveMode === "max" ? maxUint256 : amountToWrap;
      const approveLabel = globalConfig.approveMode === "max"
        ? "MAX"
        : formatUnits(approveAmount, 6);
      logger.info(tag, `allowance=${formatUnits(allowance, 6)}, approving ${approveLabel}`);

      approveTx = await approveUsdce(walletClient, publicClient, approveAmount, globalConfig.confirmations);
      logger.info(tag, `approve tx=${approveTx}`);
    }

    // pUSD before
    const pusdBefore = await getPusdBalance(publicClient, recipient);

    // Wrap
    const wrapTx = await wrapUsdce(walletClient, publicClient, recipient, amountToWrap, globalConfig.confirmations);
    logger.info(tag, `wrap tx=${wrapTx}`);

    // pUSD after
    const pusdAfter = await getPusdBalance(publicClient, recipient);
    logger.info(tag, `pUSD before=${formatUnits(pusdBefore, 6)} after=${formatUnits(pusdAfter, 6)}`);

    if (pusdAfter < pusdBefore + amountToWrap - 1n) {
      logger.warn(tag, "pUSD increase does not match wrap amount");
    }

    // CLOB refresh
    if (wallet.clob.enabled && !noClobRefresh) {
      try {
        const clobResult = await refreshClobBalance(globalConfig.clobHost, walletClient, wallet.clob);
        logger.info(tag, `clob collateral balance=${clobResult.balance} allowance=${clobResult.allowance}`);
      } catch (err) {
        logger.error(tag, `CLOB refresh failed: ${err.message}`);
        return {
          status: "clob_error",
          wallet: tag,
          wrapTx,
          approveTx,
          amount: formatUnits(amountToWrap, 6),
          pusdBefore: formatUnits(pusdBefore, 6),
          pusdAfter: formatUnits(pusdAfter, 6)
        };
      }
    }

    // Success
    logger.json({
      wallet: tag,
      source: sourceAddress,
      recipient,
      action: "wrap_success",
      amount: formatUnits(amountToWrap, 6),
      approveTx,
      wrapTx,
      pusdBefore: formatUnits(pusdBefore, 6),
      pusdAfter: formatUnits(pusdAfter, 6)
    });

    return { status: "success", wallet: tag };

  } catch (err) {
    logger.error(tag, `Chain operation failed: ${err.message}`);
    return { status: "chain_error", wallet: tag, error: err.message };
  }
}

async function runOnce(wallets, globalConfig, logger, opts) {
  const { concurrency } = globalConfig;
  const results = [];

  for (let i = 0; i < wallets.length; i += concurrency) {
    const batch = wallets.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(w => processWallet(w, globalConfig, logger, opts))
    );
    results.push(...batchResults);
  }

  return results;
}

function getExitCode(results) {
  let hasChainError = false;
  let hasClobError = false;

  for (const r of results) {
    if (r.status === "chain_error") hasChainError = true;
    if (r.status === "clob_error") hasClobError = true;
  }

  if (hasChainError) return 2;
  if (hasClobError) return 3;
  return 0;
}

function printSummary(results) {
  const success = results.filter(r => r.status === "success").length;
  const skip = results.filter(r => r.status === "skip" || r.status === "dry_run").length;
  const fail = results.filter(r => r.status === "chain_error" || r.status === "clob_error").length;
  console.log(`\n--- Health: ${success} ok, ${skip} skip, ${fail} fail ---\n`);
}

async function main() {
  const args = parseCli();

  if (!args.config) {
    console.error("Usage: auto-confirm-deposit.js --config <path> [--once|--watch] [--wallet <name>] [--dry-run] [--no-clob-refresh]");
    process.exit(1);
  }

  let globalConfig;
  try {
    globalConfig = loadConfig(args.config);
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
    noClobRefresh: args["no-clob-refresh"] || false
  };

  if (args.watch) {
    console.log(`Watching every ${globalConfig.pollIntervalMs}ms, ${wallets.length} wallet(s)...`);

    let running = false;

    const tick = async () => {
      if (running) return;
      running = true;
      try {
        const results = await runOnce(wallets, globalConfig, logger, opts);
        printSummary(results);
      } catch (err) {
        console.error(`Watch tick error: ${err.message}`);
      }
      running = false;
    };

    await tick();
    setInterval(tick, globalConfig.pollIntervalMs);

    process.on("SIGINT", () => {
      console.log("\nShutting down...");
      process.exit(0);
    });
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
