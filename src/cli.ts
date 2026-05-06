// codex-transfer — Responses API ↔ Chat Completions translation bridge
// Usage: codex-transfer [--port PORT] [--upstream URL] [--api-key KEY] [--insecure] [--config PATH]
import { createTransfer } from "./server.js";

// Parse CLI args
const args = process.argv.slice(2);
let disableTlsVerify = false;
const overrides: Record<string, string> = {};

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--insecure" || a === "-k") {
    disableTlsVerify = true;
  } else if ((a === "--port" || a === "-p") && args[i + 1]) {
    overrides.port = args[++i];
  } else if ((a === "--upstream" || a === "-u") && args[i + 1]) {
    overrides.upstream = args[++i];
  } else if ((a === "--api-key") && args[i + 1]) {
    overrides.apiKey = args[++i];
  } else if ((a === "--config" || a === "-c") && args[i + 1]) {
    overrides.configPath = args[++i];
  } else if (a === "--help" || a === "-h") {
    console.log(`
codex-transfer — Responses API ↔ Chat Completions bridge

Usage:
  codex-transfer [options]

Options:
  -p, --port PORT        Listen port (default: 4444)
  -u, --upstream URL     Upstream Chat Completions base URL
      --api-key KEY      API key for upstream
  -c, --config PATH      Path to config file (JSON)
  -k, --insecure         Skip TLS certificate verification
  -h, --help             Show this help

Environment variables:
  CODEX_TRANSFER_PORT         Same as --port
  CODEX_TRANSFER_UPSTREAM     Same as --upstream
  CODEX_TRANSFER_API_KEY      Same as --api-key
  CODEX_TRANSFER_CONFIG       Same as --config
  CODEX_TRANSFER_INSECURE     Set to "1" to skip TLS verification

Config file locations (searched in order):
  1. --config path
  2. CODEX_TRANSFER_CONFIG env var
  3. ./codex-transfer.json
  4. ~/.codex-transfer/config.json
`);
    process.exit(0);
  }
}

const { app, port } = createTransfer({
  configPath: overrides.configPath,
  port: overrides.port ? Number(overrides.port) : undefined,
  upstream: overrides.upstream,
  apiKey: overrides.apiKey,
  disableTlsVerify,
});

const { serve } = await import("@hono/node-server");
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`codex-transfer listening on 127.0.0.1:${info.port}`);
});
