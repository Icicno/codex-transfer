import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";

export interface Config {
  port: number;
  upstream: string;
  apiKey: string;
  /** Skip TLS certificate verification (for corporate proxies with MITM) */
  insecure: boolean;
  /** Model name mapping: { "codex-auto-review": "deepseek-v4-pro", "*": "deepseek-v4-pro" } */
  modelMap: Record<string, string>;
  /** Whether to send reasoning_effort to upstream (default: true).
   *  Set to false if the upstream rejects this field. The thinking toggle is always sent. */
  reasoningEffort: boolean;
}

const DEFAULT_CONFIG: Config = {
  port: 4444,
  upstream: "https://openrouter.ai/api/v1",
  apiKey: "",
  insecure: false,
  modelMap: {},
  reasoningEffort: false,
};

/**
 * Load configuration from file and environment variables.
 * Priority: environment variables > config file > defaults
 */
export function loadConfig(configPath?: string): Config {
  const fileConfig = loadConfigFile(configPath);

  return {
    port: Number(process.env.CODEX_TRANSFER_PORT ?? fileConfig.port ?? DEFAULT_CONFIG.port),
    upstream: (
      process.env.CODEX_TRANSFER_UPSTREAM ??
      fileConfig.upstream ??
      DEFAULT_CONFIG.upstream
    ).replace(/\/+$/, ""),
    apiKey:
      process.env.CODEX_TRANSFER_API_KEY ??
      fileConfig.apiKey ??
      DEFAULT_CONFIG.apiKey,
    insecure: parseBool(
      process.env.CODEX_TRANSFER_INSECURE ?? fileConfig.insecure
    ),
    modelMap: fileConfig.modelMap ?? DEFAULT_CONFIG.modelMap,
    reasoningEffort: parseBool(
        process.env.CODEX_TRANSFER_REASONING_EFFORT ?? fileConfig.reasoningEffort ?? false
    ),
  };
}

interface FileConfig {
  port?: number;
  upstream?: string;
  apiKey?: string;
  insecure?: boolean;
  modelMap?: Record<string, string>;
  reasoningEffort?: boolean;
}

/**
 * Load configuration from JSON file.
 * Search paths (in order):
 *   1. Explicit path (from parameter or CODEX_TRANSFER_CONFIG env var)
 *   2. ./codex-transfer.json
 *   3. ~/.codex-transfer/config.json
 */
function loadConfigFile(explicitPath?: string): FileConfig {
  const searchPaths: string[] = [];

  // Explicit path from parameter or env
  if (explicitPath) {
    searchPaths.push(resolve(explicitPath));
  } else if (process.env.CODEX_TRANSFER_CONFIG) {
    searchPaths.push(resolve(process.env.CODEX_TRANSFER_CONFIG));
  }

  // Default search paths
  searchPaths.push(
    resolve("./codex-transfer.json"),
    join(process.env.HOME ?? "~", ".codex-transfer", "config.json")
  );

  for (const path of searchPaths) {
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, "utf-8");
        const parsed = JSON.parse(content) as Record<string, unknown>;

        return {
          port: typeof parsed.port === "number" ? parsed.port : undefined,
          upstream: typeof parsed.upstream === "string" ? parsed.upstream : undefined,
          apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : undefined,
          insecure: typeof parsed.insecure === "boolean" ? parsed.insecure : undefined,
          modelMap: typeof parsed.modelMap === "object" && parsed.modelMap !== null
            ? parsed.modelMap as Record<string, string>
            : undefined,
          reasoningEffort: typeof parsed.reasoningEffort === "boolean" ? parsed.reasoningEffort : undefined,
        };
      } catch {
        // Ignore parse errors, continue to next path
      }
    }
  }

  return {};
}

/** Parse a value as boolean (handles string "true"/"1" and actual booleans). */
function parseBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    return value === "true" || value === "1";
  }
  return false;
}

/**
 * Resolve the directory where the config file lives.
 * Falls back to process.cwd() if no config file is found.
 * Used to place logs/ next to the config file.
 */
export function resolveConfigDir(configPath?: string): string {
  const candidates: string[] = [];

  if (configPath) {
    candidates.push(resolve(configPath));
  } else if (process.env.CODEX_TRANSFER_CONFIG) {
    candidates.push(resolve(process.env.CODEX_TRANSFER_CONFIG));
  }

  candidates.push(
    resolve("./codex-transfer.json"),
    join(process.env.HOME ?? "~", ".codex-transfer", "config.json")
  );

  for (const p of candidates) {
    if (existsSync(p)) return dirname(p);
  }

  // No config file found — default to ~/.codex-transfer/
  return join(process.env.HOME ?? "~", ".codex-transfer");
}

/** Ensure a logs/ directory exists under the given base directory. */
export function ensureLogDir(configPath?: string): string {
  const base = resolveConfigDir(configPath);
  const logDir = join(base, "logs");
  mkdirSync(logDir, { recursive: true });
  return logDir;
}
