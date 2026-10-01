import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { saveToken } from "../src/auth/token-storage";
import { buildRegistry } from "../src/providers/registry";
import { __resetCodexModelsCache } from "../src/upstream/codex-models";
import { DEFAULT_CODEX_CLI_VERSION, codexCliVersion } from "../src/upstream/codex-version";
import type { Config } from "../src/config";

function config(authDir: string, version: string): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    "auth-dir": authDir,
    "api-keys": new Set(["test-key"]),
    "body-limit": "1mb",
    cloaking: { codex: { "cli-version": version } },
    timeouts: {
      "messages-ms": 1000,
      "stream-messages-ms": 1000,
      "count-tokens-ms": 1000,
    },
    stats: { enabled: false },
    debug: "off",
  };
}

test("Codex model catalog uses the configured client version and isolates its cache", async () => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-models-"));
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const urls: string[] = [];
  const conditionalHeaders: Array<string | null> = [];
  try {
    saveToken(authDir, {
      accessToken: "synthetic-access-token",
      refreshToken: "synthetic-refresh-token",
      email: "model-test@example.invalid",
      expiresAt: "2030-01-01T00:00:00.000Z",
      accountUuid: "synthetic-account",
      provider: "codex",
    });
    __resetCodexModelsCache();
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      urls.push(url);
      conditionalHeaders.push(new Headers(init?.headers).get("If-None-Match"));
      const version = new URL(url).searchParams.get("client_version");
      return Response.json({
        models: [{ slug: version === "0.156.1" ? "gpt-6-luna" : "gpt-5.6-luna" }],
      }, { headers: { ETag: '"catalog-version"' } });
    };

    const oldRegistry = buildRegistry(authDir, config(authDir, "0.144.4"));
    oldRegistry.get("codex").manager.load();
    assert.deepEqual((await oldRegistry.get("codex").listModels()).map((m) => m.id), ["gpt-5.6-luna"]);

    const newRegistry = buildRegistry(authDir, config(authDir, "0.156.1"));
    newRegistry.get("codex").manager.load();
    assert.deepEqual((await newRegistry.get("codex").listModels()).map((m) => m.id), ["gpt-6-luna"]);
    assert.deepEqual((await newRegistry.get("codex").listModels()).map((m) => m.id), ["gpt-6-luna"]);
    assert.deepEqual(urls.map((url) => new URL(url).searchParams.get("client_version")), ["0.144.4", "0.156.1"]);
    assert.deepEqual(conditionalHeaders, [null, null]);

    Date.now = () => originalNow() + 6 * 60 * 1000;
    globalThis.fetch = async () => new Response("temporary upstream failure", { status: 503 });
    assert.deepEqual((await newRegistry.get("codex").listModels()).map((m) => m.id), ["gpt-6-luna"]);

    __resetCodexModelsCache();
    const fallback = (await newRegistry.get("codex").listModels()).map((m) => m.id);
    assert.equal(fallback.includes("gpt-6-luna"), false);
  } finally {
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
    __resetCodexModelsCache();
    fs.rmSync(authDir, { recursive: true, force: true });
  }
});

test("default Codex client version discovers Sol 6.1 while preserving configured overrides", () => {
  assert.equal(DEFAULT_CODEX_CLI_VERSION, "0.159.2");
  assert.equal(codexCliVersion(), "0.159.2");
  assert.equal(codexCliVersion(config("unused", "0.156.1")), "0.156.1");
});
