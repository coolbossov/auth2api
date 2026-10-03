import { Response } from "express";

export const PORTAL_JSON_TRANSPORT = "json-keepalive-v1";
export const PORTAL_JSON_KEEPALIVE_MS = 15_000;
export const PORTAL_JSON_DEADLINE_MS = 540_000;

/** Whitespace is valid before one JSON value. Never queue another write while backpressured. */
export function createPortalJsonKeepalive(
  response: Response,
  controller: AbortController,
  identity: () => void,
  onDeadline?: () => void,
) {
  let closed = false;
  let waitingForDrain = false;
  let deadlineReached = false;
  const onDrain = () => { waitingForDrain = false; };
  response.on("drain", onDrain);
  const interval = setInterval(() => {
    if (closed || waitingForDrain || controller.signal.aborted || response.destroyed || response.writableEnded) return;
    if (!response.headersSent) {
      identity();
      response.setHeader("X-Auth2api-Response-Transport", PORTAL_JSON_TRANSPORT);
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.setHeader("Cache-Control", "no-store, no-transform");
    }
    // Node rejects header mutations after the first write. Later heartbeats only write whitespace.
    waitingForDrain = !response.write(" \n");
  }, PORTAL_JSON_KEEPALIVE_MS);
  const deadline = setTimeout(() => {
    deadlineReached = true;
    controller.abort(new Error("portal response deadline"));
    // End the client response even if an upstream fetch ignores cancellation.
    if (onDeadline) onDeadline();
    else finish({ error: { type: "portal_response_deadline", message: "portal_response_deadline", httpStatus: 504 }, transport: { version: PORTAL_JSON_TRANSPORT, outcome: "error" } }, 504);
  }, PORTAL_JSON_DEADLINE_MS);
  interval.unref();
  deadline.unref();
  const dispose = () => {
    if (closed) return;
    closed = true;
    clearInterval(interval);
    clearTimeout(deadline);
    response.off("drain", onDrain);
  };
  const finish = (body: unknown, status = 200) => {
    dispose();
    if (response.destroyed || response.writableEnded) return;
    if (!response.headersSent) {
      identity();
      response.setHeader("X-Auth2api-Response-Transport", PORTAL_JSON_TRANSPORT);
      response.status(status).json(body);
    } else {
      response.end(JSON.stringify(body));
    }
  };
  return {
    dispose, finish,
    deadlineReached: () => deadlineReached,
    fail: (status: number, code: string) => finish({
      error: { type: code, message: code, httpStatus: status },
      transport: { version: PORTAL_JSON_TRANSPORT, outcome: "error" },
    }, status),
  };
}
