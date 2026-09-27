import crypto from "node:crypto";
import { Request, Response as ExpressResponse } from "express";
import { Config } from "../config";
import { ProviderRegistry } from "../providers/registry";
import { tagStatsModel, tagStatsUsage } from "../stats/recorder";
import {
  callCodexResponses,
  normalizeCodexResponsesBody,
} from "../upstream/codex-api";
import { drainCodexResponsesSse } from "../upstream/responses-translator";

const CONTRACT = "portal-v1";
const MODELS = [
  "gpt-5.5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-6-luna",
  "gpt-6-sol",
  "gpt-6-astra",
] as const;
const EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
const REQUEST_FIELDS = new Set([
  "model",
  "instructions",
  "input",
  "reasoning",
  "text",
  "store",
  "stream",
  "max_output_tokens",
]);

function bodyLimitBytes(value: string): number | null {
  const match = /^([1-9][0-9]*)(b|kb|mb|gb)$/i.exec(value.trim());
  if (!match) return null;
  const power = { b: 0, kb: 1, mb: 2, gb: 3 }[match[2].toLowerCase() as "b" | "kb" | "mb" | "gb"];
  const bytes = Number(match[1]) * 1024 ** power;
  return Number.isSafeInteger(bytes) ? bytes : null;
}

function fail(resp: ExpressResponse, status: number, code: string): void {
  resp.status(status).json({ error: { type: code, message: code } });
}

function validRequest(body: any): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  if (Object.keys(body).some((key) => !REQUEST_FIELDS.has(key))) return false;
  if (!(MODELS as readonly string[]).includes(body.model)) return false;
  if (typeof body.instructions !== "string") return false;
  if (
    !(typeof body.input === "string" && body.input.length > 0) &&
    !(Array.isArray(body.input) && body.input.length > 0)
  )
    return false;
  if (
    body.store !== false ||
    (body.stream !== undefined && body.stream !== false)
  )
    return false;
  if (
    body.reasoning === undefined ||
    !body.reasoning ||
    typeof body.reasoning !== "object" ||
    Array.isArray(body.reasoning) ||
    Object.keys(body.reasoning).some((key) => key !== "effort") ||
    !(EFFORTS as readonly string[]).includes(body.reasoning.effort)
  )
    return false;
  if (
    body.max_output_tokens !== undefined &&
    (!Number.isSafeInteger(body.max_output_tokens) ||
      body.max_output_tokens < 1)
  )
    return false;
  if (
    body.text !== undefined &&
    (!body.text || typeof body.text !== "object" || Array.isArray(body.text))
  )
    return false;
  return true;
}

/** A dedicated, fail-closed Portal transport. No generic model routing or retry helper is used. */
export function createPortalHandlers(
  config: Config,
  registry: ProviderRegistry,
) {
  const build = process.env.AUTH2API_BUILD_ID || "";
  const configuredBodyLimitBytes = bodyLimitBytes(config["body-limit"]);
  const codex = () => registry.get("codex");
  const buildVerified = /^[0-9a-f]{40}$/.test(build);
  // The Codex account ID is a high-entropy UUID. The domain-separated digest
  // keeps it out of the public contract while remaining stable across restart
  // and access-token refresh for the same build, account and plan tier.
  const scopeFor = (accountUuid: string, planType?: string) =>
    crypto
      .createHash("sha256")
      .update(
        `auth2api:${CONTRACT}:${build}:codex:${accountUuid}:${planType || "unknown"}`,
      )
      .digest("hex");
  const select = () => {
    const result = codex().manager.getNextAccount();
    if (!result.account || !result.account.accountUuid) return null;
    return result.account;
  };
  const identityHeaders = (resp: ExpressResponse, scope: string) => {
    resp.setHeader("X-Auth2api-Provider", "codex");
    resp.setHeader("X-Auth2api-Contract", CONTRACT);
    resp.setHeader("X-Auth2api-Build", build);
    resp.setHeader("X-Auth2api-Scope", scope);
  };

  const contract = (_req: Request, resp: ExpressResponse) => {
    if (!buildVerified) return fail(resp, 503, "portal_build_unverified");
    if (configuredBodyLimitBytes === null) return fail(resp, 503, "portal_body_limit_unverified");
    const account = select();
    if (!account) return fail(resp, 503, "portal_codex_account_unavailable");
    const scope = scopeFor(account.accountUuid, account.token.planType);
    identityHeaders(resp, scope);
    resp.json({
      contract: CONTRACT,
      build,
      scope,
      capabilities: {
        provider: "codex",
        models: MODELS,
        reasoningEfforts: EFFORTS,
        streaming: false,
        enforcedOutputCap: false,
        requestBodyLimit: config["body-limit"],
        requestBodyLimitBytes: configuredBodyLimitBytes,
      },
    });
  };

  const responses = async (
    req: Request,
    resp: ExpressResponse,
  ): Promise<void> => {
    if (!buildVerified) return fail(resp, 503, "portal_build_unverified");
    if (configuredBodyLimitBytes === null) return fail(resp, 503, "portal_body_limit_unverified");
    if (
      req.header("X-Auth2api-Contract") !== CONTRACT ||
      req.header("X-Auth2api-Build") !== build ||
      !req.header("X-Auth2api-Scope")
    ) {
      return fail(resp, 409, "portal_contract_mismatch");
    }
    if (!validRequest(req.body))
      return fail(resp, 400, "portal_request_invalid");
    const requestedScope = req.header("X-Auth2api-Scope")!;
    if (!/^[0-9a-f]{64}$/.test(requestedScope)) {
      return fail(resp, 409, "portal_scope_mismatch");
    }
    // A generic sticky selection may rotate after the GET contract. Search
    // available Codex accounts by the exact scope the caller qualified; never
    // select a different account or dispatch when that account is unavailable.
    const account = codex()
      .manager.getAvailableAccounts()
      .find(
        (candidate) =>
          candidate.accountUuid &&
          scopeFor(candidate.accountUuid, candidate.token.planType) ===
            requestedScope,
      );
    if (!account) return fail(resp, 409, "portal_scope_mismatch");
    const scope = requestedScope;

    const model = req.body.model as string;
    tagStatsModel(resp, model, "codex");
    const stats = (resp.locals as any).stats;
    if (stats) stats.accountEmail = account.token.email;
    codex().manager.recordAttempt(account.token.email);
    const controller = new AbortController();
    const onClose = () => controller.abort(new Error("client disconnected"));
    resp.on("close", onClose);
    try {
      // ChatGPT's Codex backend requires streaming and rejects public output caps.
      // The cap remains advisory until the transport can enforce it.
      const body = normalizeCodexResponsesBody(req.body);
      delete body.max_output_tokens;
      body.stream = true;
      const upstream = await callCodexResponses({
        body,
        request: req,
        account,
        config,
        signal: controller.signal,
        rejectRedirects: true,
      });
      if (!upstream.ok) {
        if (upstream.status === 429 || upstream.status >= 500) {
          codex().manager.recordFailure(
            account.token.email,
            upstream.status === 429 ? "rate_limit" : "server",
          );
        }
        return fail(
          resp,
          upstream.status === 429 ? 429 : 502,
          "portal_upstream_error",
        );
      }
      const drained = await drainCodexResponsesSse(upstream);
      const terminal = drained.completedResponse;
      if (
        !terminal ||
        terminal.status !== "completed" ||
        terminal.model !== model ||
        drained.upstreamError ||
        !Array.isArray(terminal.output) ||
        !Array.isArray(drained.outputItems)
      ) {
        return fail(resp, 502, "portal_terminal_invalid");
      }
      const hasOutputText = (items: unknown[]): boolean =>
        items.some((item) =>
          !!item && typeof item === "object" &&
          Array.isArray((item as { content?: unknown }).content) &&
          (item as { content: unknown[] }).content.some((part) =>
            !!part && typeof part === "object" &&
            (part as { type?: unknown }).type === "output_text" &&
            typeof (part as { text?: unknown }).text === "string" &&
            (part as { text: string }).text.trim().length > 0,
          ),
        );
      const output = hasOutputText(terminal.output)
        ? terminal.output
        : drained.outputItems;
      if (!hasOutputText(output)) return fail(resp, 502, "portal_output_missing");
      const usage = drained.usage;
      codex().manager.recordSuccess(account.token.email, {
        inputTokens: usage?.input_tokens || 0,
        outputTokens: usage?.output_tokens || 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: usage?.input_tokens_details?.cached_tokens || 0,
        reasoningOutputTokens:
          usage?.output_tokens_details?.reasoning_tokens || 0,
      });
      tagStatsUsage(resp, {
        inputTokens: usage?.input_tokens || 0,
        outputTokens: usage?.output_tokens || 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: usage?.input_tokens_details?.cached_tokens || 0,
        reasoningOutputTokens:
          usage?.output_tokens_details?.reasoning_tokens || 0,
      });
      identityHeaders(resp, scope);
      resp.json({ ...terminal, output });
    } catch {
      if (!controller.signal.aborted && !resp.headersSent) {
        codex().manager.recordFailure(account.token.email, "network");
        fail(resp, 502, "portal_upstream_error");
      }
    } finally {
      resp.off("close", onClose);
    }
  };
  return { contract, responses };
}
