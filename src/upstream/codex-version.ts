import type { Config } from "../config";

// Keep the catalog query and generation headers on one effective Codex version.
export const DEFAULT_CODEX_CLI_VERSION = "0.156.1";

export function codexCliVersion(config?: Config): string {
  return config?.cloaking.codex?.["cli-version"]?.trim() || DEFAULT_CODEX_CLI_VERSION;
}
