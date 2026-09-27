import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { AddressInfo } from "node:net";
import { createServer } from "../src/server";
import { buildRegistry } from "../src/providers/registry";
import { saveToken } from "../src/auth/token-storage";
import { Config } from "../src/config";

const BUILD = "a".repeat(40);
const MODEL = "gpt-6-luna";

function event(name: string, data: unknown) {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function terminal(model: string = MODEL, status = "completed") {
  return (
    event("response.output_item.done", {
      item: { type: "message", content: [{ type: "output_text", text: "ok" }] },
    }) +
    event("response.completed", {
      response: {
        id: "resp_test",
        object: "response",
        status,
        model,
        output: [],
        usage: { input_tokens: 4, output_tokens: 2 },
      },
    })
  );
}

test("strict Portal contract selects Codex and dispatches at most once", async (t) => {
  const oldBuild = process.env.AUTH2API_BUILD_ID;
  const oldFetch = globalThis.fetch;
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-portal-"));
  process.env.AUTH2API_BUILD_ID = BUILD;
  const token = {
    accessToken: "test-access",
    refreshToken: "test-refresh",
    email: "codex-test@example.com",
    accountUuid: "acct-test",
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    provider: "codex" as const,
  };
  saveToken(authDir, token);
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    "auth-dir": authDir,
    "api-keys": new Set(["test-key"]),
    "body-limit": "1mb",
    cloaking: {},
    timeouts: {
      "messages-ms": 5000,
      "stream-messages-ms": 5000,
      "count-tokens-ms": 5000,
    },
    stats: { enabled: false },
    debug: "off",
  };
  const registry = buildRegistry(authDir, config);
  for (const provider of registry.all()) provider.manager.load();
  const server = http.createServer(createServer(config, registry));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    globalThis.fetch = oldFetch;
    if (oldBuild === undefined) delete process.env.AUTH2API_BUILD_ID;
    else process.env.AUTH2API_BUILD_ID = oldBuild;
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const port = (server.address() as AddressInfo).port;
  const request = async (
    route: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const response = await oldFetch(`http://127.0.0.1:${port}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      headers: response.headers,
      body: (await response.json()) as any,
    };
  };
  const contract = await request("/v1/portal/contract");
  assert.equal(contract.status, 200);
  assert.equal(contract.body.contract, "portal-v1");
  assert.equal(contract.body.build, BUILD);
  assert.equal(contract.body.capabilities.streaming, false);
  assert.equal(contract.body.capabilities.enforcedOutputCap, false);
  assert.equal(contract.body.capabilities.requestBodyLimit, "1mb");
  assert.equal(contract.body.capabilities.requestBodyLimitBytes, 1024 * 1024);
  assert.ok(contract.body.capabilities.models.includes(MODEL));
  assert.match(contract.body.scope, /^[0-9a-f]{64}$/);
  assert.equal(contract.headers.get("X-Auth2api-Provider"), "codex");
  assert.equal(contract.headers.get("X-Auth2api-Contract"), contract.body.contract);
  assert.equal(contract.headers.get("X-Auth2api-Build"), contract.body.build);
  assert.equal(contract.headers.get("X-Auth2api-Scope"), contract.body.scope);
  const unauthenticated = await oldFetch(
    `http://127.0.0.1:${port}/v1/portal/contract`,
  );
  assert.equal(unauthenticated.status, 401);

  const headers = {
    "X-Auth2api-Contract": "portal-v1",
    "X-Auth2api-Build": BUILD,
    "X-Auth2api-Scope": contract.body.scope as string,
  };
  const body = {
    model: MODEL,
    instructions: "reply",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "test" },
          {
            type: "input_image",
            image_url:
              "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZkAAAAASUVORK5CYII=",
            detail: "high",
          },
        ],
      },
    ],
    reasoning: { effort: "xhigh" },
    store: false,
    max_output_tokens: 100,
  };
  let calls = 0;
  let upstreamBody: any = null;
  let upstreamRedirect: RequestRedirect | undefined;
  let upstreamAuthorization: string | undefined;
  let nextResponse = () =>
    new Response(terminal(), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  globalThis.fetch = async (_input: any, init?: RequestInit) => {
    calls++;
    upstreamBody = JSON.parse(String(init?.body));
    upstreamRedirect = init?.redirect;
    upstreamAuthorization = (init?.headers as Record<string, string>)
      ?.Authorization;
    return nextResponse();
  };

  assert.equal(
    (
      await request("/v1/portal/responses", body, {
        ...headers,
        "X-Auth2api-Build": "b".repeat(40),
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request("/v1/portal/responses", body, {
        ...headers,
        "X-Auth2api-Scope": "wrong",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(
        "/v1/portal/responses",
        { ...body, model: "unknown" },
        headers,
      )
    ).status,
    400,
  );
  assert.equal(
    (await request("/v1/portal/responses", { ...body, stream: true }, headers))
      .status,
    400,
  );
  assert.equal(
    (
      await request(
        "/v1/portal/responses",
        { ...body, stream: "true" },
        headers,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        "/v1/portal/responses",
        { ...body, reasoning: undefined },
        headers,
      )
    ).status,
    400,
  );
  const oversized = await oldFetch(
    `http://127.0.0.1:${port}/v1/portal/responses`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify({ ...body, input: "x".repeat(1_100_000) }),
    },
  );
  assert.equal(
    oversized.status,
    413,
    "configured JSON body limit must apply before dispatch",
  );
  assert.equal(calls, 0);

  const otherToken = {
    ...token,
    accessToken: "other-access",
    email: "other-codex@example.com",
    accountUuid: "other-account",
  };
  registry.get("codex").manager.addAccount(otherToken);
  // Force the ordinary sticky pool to rotate between GET and POST. The POST
  // must still use the account represented by the original qualified scope.
  (registry.get("codex").manager as any).stickyUntil = 0;
  const switched = await request("/v1/portal/contract");
  assert.equal(switched.status, 200);
  assert.notEqual(switched.body.scope, contract.body.scope);

  nextResponse = () =>
    new Response(
      event("response.completed", {
        response: {
          id: "resp_empty",
          object: "response",
          status: "completed",
          model: MODEL,
          output: [{ type: "message", content: [] }],
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
  const missingText = await request("/v1/portal/responses", body, headers);
  assert.equal(missingText.status, 502);
  assert.equal(missingText.body.error.type, "portal_output_missing");
  assert.equal(calls, 1, "missing text must fail after one upstream attempt");
  calls = 0;
  nextResponse = () =>
    new Response(terminal(), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

  const success = await request("/v1/portal/responses", body, headers);
  assert.equal(success.status, 200);
  assert.equal(success.body.model, MODEL);
  assert.equal(success.body.status, "completed");
  assert.equal(success.body.output[0].content[0].text, "ok");
  assert.equal(success.headers.get("x-auth2api-provider"), "codex");
  assert.equal(success.headers.get("x-auth2api-contract"), "portal-v1");
  assert.equal(success.headers.get("x-auth2api-build"), BUILD);
  assert.equal(success.headers.get("x-auth2api-scope"), contract.body.scope);
  assert.equal(upstreamBody.model, MODEL);
  assert.deepEqual(
    upstreamBody.input,
    body.input,
    "image data URL and detail must be forwarded unchanged",
  );
  assert.equal(upstreamBody.reasoning.effort, "xhigh");
  assert.equal(upstreamBody.stream, true);
  assert.equal(upstreamBody.store, false);
  assert.equal(upstreamBody.max_output_tokens, undefined);
  assert.equal(upstreamRedirect, "error");
  assert.equal(upstreamAuthorization, "Bearer test-access");
  assert.equal(calls, 1);

  nextResponse = () => new Response("", { status: 401 });
  const unauthorized = await request("/v1/portal/responses", body, headers);
  assert.equal(unauthorized.status, 502);
  assert.equal(calls, 2, "401 must not refresh and resend");
  nextResponse = () => new Response(terminal("gpt-6-sol"), { status: 200 });
  assert.equal(
    (await request("/v1/portal/responses", body, headers)).status,
    502,
  );
  assert.equal(calls, 3, "model mismatch must not retry");
  nextResponse = () =>
    new Response(event("response.output_text.delta", { delta: "partial" }), {
      status: 200,
    });
  assert.equal(
    (await request("/v1/portal/responses", body, headers)).status,
    502,
  );
  assert.equal(
    calls,
    4,
    "missing terminal event must not retry or publish partial text",
  );
  nextResponse = () =>
    new Response(terminal(MODEL, "incomplete"), { status: 200 });
  assert.equal(
    (await request("/v1/portal/responses", body, headers)).status,
    502,
  );
  assert.equal(calls, 5, "incomplete terminal status must not publish output");
  nextResponse = () => new Response("", { status: 503 });
  assert.equal(
    (await request("/v1/portal/responses", body, headers)).status,
    502,
  );
  assert.equal(calls, 6, "5xx must not retry");
  registry.get("codex").manager.addAccount(token);
  nextResponse = () => new Response("", { status: 429 });
  assert.equal(
    (await request("/v1/portal/responses", body, headers)).status,
    429,
  );
  assert.equal(calls, 7, "429 must not retry");
  const current = await request("/v1/portal/contract");
  assert.equal(current.body.scope, switched.body.scope);
  assert.equal(
    (await request("/v1/portal/responses", body, headers)).status,
    409,
  );
  assert.equal(
    calls,
    7,
    "stale selected-account scope must reject before dispatch",
  );
  nextResponse = () => {
    throw new Error("simulated network failure");
  };
  assert.equal(
    (
      await request("/v1/portal/responses", body, {
        ...headers,
        "X-Auth2api-Scope": switched.body.scope,
      })
    ).status,
    502,
  );
  assert.equal(calls, 8, "network ambiguity must not retry");
});
