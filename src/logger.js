import fs from "fs";
import path from "path";

export function createLogger(logDir) {
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const logPath = path.join(logDir, "deposit-confirmations.jsonl");

  return {
    info(wallet, message) {
      console.log(`[${wallet}] ${message}`);
    },

    warn(wallet, message) {
      console.warn(`[${wallet}] WARN: ${message}`);
    },

    error(wallet, message) {
      console.error(`[${wallet}] ERROR: ${message}`);
    },

    json(entry) {
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
      fs.appendFileSync(logPath, line);
    }
  };
}
