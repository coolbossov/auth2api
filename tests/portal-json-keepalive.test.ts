import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createPortalJsonKeepalive, PORTAL_JSON_DEADLINE_MS } from "../src/handlers/portal-json-keepalive";

class Sink extends EventEmitter {
  headersSent = false; destroyed = false; writableEnded = false;
  chunks: string[] = []; headers = new Map<string, unknown>(); statusCode = 200;
  blocked = false;
  setHeader(key: string, value: unknown) { assert.equal(this.headersSent, false); this.headers.set(key, value); }
  status(code: number) { this.statusCode = code; return this; }
  json(value: unknown) { this.end(JSON.stringify(value)); }
  write(value: string) { this.headersSent = true; this.chunks.push(value); return !this.blocked; }
  end(value: string) { this.write(value); this.writableEnded = true; }
}

test("short success and errors retain HTTP status and one JSON value", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  for (const status of [200, 429, 502]) {
    const sink = new Sink(); const ctl = new AbortController();
    const transport = createPortalJsonKeepalive(sink as any, ctl, () => sink.setHeader("identity", "synthetic"));
    if (status === 200) transport.finish({ status: "completed" });
    else transport.fail(status, "portal_upstream_error");
    t.mock.timers.tick(PORTAL_JSON_DEADLINE_MS + 1);
    assert.equal(sink.statusCode, status); assert.equal(sink.chunks.length, 1);
    assert.equal(ctl.signal.aborted, false); assert.equal(sink.listenerCount("drain"), 0);
  }
});

test("long response emits bounded whitespace beyond 125 seconds and one terminal", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const sink = new Sink(); const ctl = new AbortController();
  const transport = createPortalJsonKeepalive(sink as any, ctl, () => sink.setHeader("identity", "synthetic"));
  for (let i = 0; i < 9; i++) t.mock.timers.tick(15_000);
  assert.equal(sink.chunks.length, 9); assert.ok(sink.chunks.every(s => /^\s+$/.test(s)));
  transport.finish({ status: "completed", model: "gpt-6.1-sol" });
  assert.equal(JSON.parse(sink.chunks.join("")).status, "completed");
  t.mock.timers.tick(600_000); assert.equal(sink.chunks.length, 10); assert.equal(ctl.signal.aborted, false);
});

test("backpressure bounds pending whitespace and resumes only after drain", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const sink = new Sink(); sink.blocked = true;
  const transport = createPortalJsonKeepalive(sink as any, new AbortController(), () => {});
  t.mock.timers.tick(15_000); t.mock.timers.tick(120_000); assert.equal(sink.chunks.length, 1);
  sink.blocked = false; sink.emit("drain"); t.mock.timers.tick(15_000); assert.equal(sink.chunks.length, 2);
  transport.fail(502, "portal_terminal_invalid");
  const value = JSON.parse(sink.chunks.join(""));
  assert.equal(sink.statusCode, 200); assert.equal(value.error.httpStatus, 502);
  assert.equal(value.transport.outcome, "error"); assert.equal(sink.listenerCount("drain"), 0);
});

test("deadline aborts once and returns typed error after headers; disconnect cleanup prevents late output", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const sink = new Sink(); const ctl = new AbortController(); let aborts = 0;
  ctl.signal.addEventListener("abort", () => aborts++);
  const transport = createPortalJsonKeepalive(sink as any, ctl, () => {});
  t.mock.timers.tick(15_000); t.mock.timers.tick(PORTAL_JSON_DEADLINE_MS);
  assert.equal(transport.deadlineReached(), true); assert.equal(aborts, 1);
  assert.equal(sink.writableEnded, true, "deadline ends response even when upstream ignores abort");
  assert.equal(sink.listenerCount("drain"), 0);
  transport.fail(504, "portal_response_deadline");
  assert.equal(JSON.parse(sink.chunks.join("")).error.httpStatus, 504);
  const other = new Sink(); const disconnected = createPortalJsonKeepalive(other as any, new AbortController(), () => {});
  other.destroyed = true; disconnected.dispose(); disconnected.finish({ status: "completed" });
  t.mock.timers.tick(600_000); assert.deepEqual(other.chunks, []); assert.equal(other.listenerCount("drain"), 0);
});
