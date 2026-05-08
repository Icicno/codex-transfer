// codex-transfer — Responses API ↔ Chat Completions translation bridge
// Usage: codex-transfer [--port PORT] [--upstream URL] [--api-key KEY] [--insecure] [--config PATH]
import { createTransfer } from "./server.js";
import { ensureLogDir } from "./config.js";
import { spawn } from "node:child_process";
import {
  appendFileSync,
  writeFileSync,
  statSync,
  renameSync,
  unlinkSync,
  existsSync,
} from "node:fs";
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
  } else if (a === "--no-reasoning-effort") {
    overrides.reasoningEffort = "false";
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
      --no-reasoning-effort  Don't send reasoning_effort to upstream
  -d, --daemon           Run in background, logs to logs/ directory
  -h, --help             Show this help

Environment variables:
  CODEX_TRANSFER_PORT         Same as --port
  CODEX_TRANSFER_UPSTREAM     Same as --upstream
  CODEX_TRANSFER_API_KEY      Same as --api-key
  CODEX_TRANSFER_CONFIG       Same as --config
  CODEX_TRANSFER_INSECURE     Set to "1" to skip TLS verification
  CODEX_TRANSFER_REASONING_EFFORT  Set to "0" to disable reasoning_effort

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
  const ts = formatTimestampCompact(new Date());
  const logFile = join(logDir, `codex-transfer-${ts}.log`);
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
  const logFilePath: string = logFile;
  const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
  const MAX_LOG_FILES = 5;

  /** Rotate log files when current file exceeds MAX_LOG_SIZE. */
  function rotateIfNeeded(): void {
    try {
      if (!existsSync(logFilePath)) return;
      const stat = statSync(logFilePath);
      if (stat.size < MAX_LOG_SIZE) return;

      const base = logFilePath.slice(0, -".log".length);

      // Delete oldest rotation file
      const oldest = `${base}.${MAX_LOG_FILES}.log`;
      if (existsSync(oldest)) unlinkSync(oldest);

      // Shift: .4 → .5, .3 → .4, ..., .1 → .2
      for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
        const from = `${base}.${i}.log`;
        if (existsSync(from)) renameSync(from, `${base}.${i + 1}.log`);
      }

      // Current → .1
      renameSync(logFilePath, `${base}.1.log`);
    } catch {
      // Rotation failure is not fatal
    }
  }

  function logWrite(msg: string): void {
    try {
      rotateIfNeeded();
      const ts = formatTimestamp(new Date());
      appendFileSync(logFilePath, `[${ts} transfer] ${msg}\n`);
    } catch {
      process.stderr.write(msg + "\n");
    }
  }

  console.log = (...args: unknown[]) => logWrite(args.map(String).join(" "));
  console.error = (...args: unknown[]) => logWrite("[ERROR] " + args.map(String).join(" "));
  console.warn = (...args: unknown[]) => logWrite("[WARN] " + args.map(String).join(" "));
}

// ── Start server ────────────────────────────────────────────────────────────

// Apply reasoningEffort override via env (loadConfig reads CODEX_TRANSFER_REASONING_EFFORT)
if (overrides.reasoningEffort) {
  process.env.CODEX_TRANSFER_REASONING_EFFORT = overrides.reasoningEffort;
}

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

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Format date as `yyyy-MM-dd HH:mm:ss` for log prefixes. */
function formatTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    ` ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** Format date as `yyyyMMdd-HHmmss` for log filenames. */
function formatTimestampCompact(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}
