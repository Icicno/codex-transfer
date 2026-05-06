import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

export interface Config {
  port: number;
  upstream: string;
  apiKey: string;
  /** Skip TLS certificate verification (for corporate proxies with MITM) */
  insecure: boolean;
}

const DEFAULT_CONFIG: Config = {
  port: 4444,
  upstream: "https://openrouter.ai/api/v1",
  apiKey: "",
  insecure: false,
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
  };
}

interface FileConfig {
  port?: number;
  upstream?: string;
  apiKey?: string;
  insecure?: boolean;
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
