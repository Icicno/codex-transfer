// codex-transfer — Responses API ↔ Chat Completions translation bridge
// Usage: codex-transfer [--port PORT] [--upstream URL] [--api-key KEY] [--insecure] [--config PATH]
import { createTransfer } from "./server.js";
import { ensureLogDir } from "./config.js";
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Parse CLI args
const args = process.argv.slice(2);
let disableTlsVerify = false;
let daemonMode = false;
const overrides: Record<string, string> = {};

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--insecure" || a === "-k") {
    disableTlsVerify = true;
  } else if (a === "--daemon" || a === "-d") {
    daemonMode = true;
  } else if ((a === "--port" || a === "-p") && args[i + 1]) {
    overrides.port = args[++i];
  } else if ((a === "--upstream" || a === "-u") && args[i + 1]) {
    overrides.upstream = args[++i];
  } else if (a === "--api-key" && args[i + 1]) {
    overrides.apiKey = args[++i];
  } else if ((a === "--config" || a === "-c") && args[i + 1]) {
    overrides.configPath = args[++i];
  } else if ((a === "--model" || a === "-m") && args[i + 1]) {
    overrides.model = args[++i];
  } else if (a === "--help" || a === "-h") {
    console.log(`
codex-transfer — Responses API ↔ Chat Completions bridge

Usage:
  codex-transfer [options]

Options:
  -p, --port PORT        Listen port (default: 4444)
  -u, --upstream URL     Upstream Chat Completions base URL
      --api-key KEY      API key for upstream
  -m, --model MODEL      Override model name (highest priority model mapping)
  -c, --config PATH      Path to config file (JSON)
  -k, --insecure         Skip TLS certificate verification
  -d, --daemon           Run in background, logs to logs/ directory
  -h, --help             Show this help

Environment variables:
  CODEX_TRANSFER_PORT         Same as --port
  CODEX_TRANSFER_UPSTREAM     Same as --upstream
  CODEX_TRANSFER_API_KEY      Same as --api-key
  CODEX_TRANSFER_CONFIG       Same as --config
  CODEX_TRANSFER_INSECURE     Set to "1" to skip TLS verification

Config file options:
  modelMap               Model name mapping, e.g. {"*": "deepseek-v4-pro"}
                         Lookup: exact match → wildcard "*" → original name

Config file locations (searched in order):
  1. --config path
  2. CODEX_TRANSFER_CONFIG env var
  3. ./codex-transfer.json
  4. ~/.codex-transfer/config.json
`);
    process.exit(0);
  }
}

// ── Daemon mode: fork detached child, parent exits ──────────────────────────

if (daemonMode) {
  const logDir = ensureLogDir(overrides.configPath);
  const logFile = join(logDir, "codex-transfer.log");
  const pidFile = join(logDir, "codex-transfer.pid");

  // Filter out --daemon / -d from child args to avoid recursion
  const childArgs = process.argv.slice(2).filter(
    (a) => a !== "--daemon" && a !== "-d"
  );

  const child = spawn(process.execPath, [process.argv[1]!, ...childArgs], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: {
      ...process.env,
      __CODEX_TRANSFER_LOG: logFile,
    },
  });

  child.unref();

  writeFileSync(pidFile, String(child.pid), "utf-8");

  console.log(`codex-transfer started in background (PID: ${child.pid})`);
  console.log(`Log file: ${logFile}`);
  console.log(`PID file: ${pidFile}`);
  console.log(`Stop:   kill $(cat ${pidFile})`);
  process.exit(0);
}

// ── Child process (or foreground): set up log redirection if needed ──────────

const logFile = process.env.__CODEX_TRANSFER_LOG;
if (logFile) {
  // Redirect all console output to log file
  const write = (msg: string) => {
    try {
      appendFileSync(logFile, msg + "\n");
    } catch {
      // If log file write fails, fall back to stderr
      process.stderr.write(msg + "\n");
    }
  };

  console.log = (...args: unknown[]) => write(args.map(String).join(" "));
  console.error = (...args: unknown[]) => write("[ERROR] " + args.map(String).join(" "));
  console.warn = (...args: unknown[]) => write("[WARN] " + args.map(String).join(" "));
}

// ── Start server ────────────────────────────────────────────────────────────

const { app, port } = createTransfer({
  configPath: overrides.configPath,
  port: overrides.port ? Number(overrides.port) : undefined,
  upstream: overrides.upstream,
  apiKey: overrides.apiKey,
  modelOverride: overrides.model,
  disableTlsVerify,
});

const { serve } = await import("@hono/node-server");
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`codex-transfer listening on 127.0.0.1:${info.port}`);
});
