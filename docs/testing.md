# Testing

Before a gateway release, run `npm run build` and
`node --import tsx --test tests/*.test.ts` in an isolated checkout. The Portal
contract test uses a local HTTP server and mocked Codex upstream. It proves
unauthenticated rejection, pre-dispatch contract and account-scope rejection,
exact model/effort forwarding, gateway-owned response headers, completed
response validation, synthetic image data-URL preservation, configured body
limit rejection, exact-account pinning across sticky-pool rotation, and one
upstream generation attempt across 401, 429, 5xx,
network failure, incomplete and mismatched-model cases.

Strict disconnect tests cover a client leaving midstream, an upstream response
arriving after disconnect, and a disconnect racing with terminal drain cleanup.
They require one upstream attempt, no late success/publication, and exact reader
and listener cleanup. Reader tests also cover an already-aborted signal, a
pending read whose cancellation acknowledgment never resolves, normal terminal
completion, and upstream read failure. These tests use synthetic streams and
mocked fetches; local cancellation does not prove that a provider stopped
generation, and unknown outcomes must not trigger automatic retry. Ordinary
compatibility calls do not opt into the strict reader's abort signal.

These local tests do not prove live account access or model capacity. For a
release, verify the exact image revision, authenticated contract response,
reverse-proxy path and header preservation, then run a bounded real canary
under the Portal release plan before activating policy defaults.

Run `npm ci`, `npm test`, and `npm run build` before release. Tests use synthetic accounts and mocked upstream calls; they must not load production OAuth state. Model changes require routing, catalog/version, and Portal contract tests.

Production acceptance uses authenticated model discovery and bounded synthetic generation through `https://ai.sapicture.day`: require the exact requested model, completed response, and expected output. Use structured Responses input. Never print gateway credentials, OAuth state, or customer content. No isolated hosted staging gateway is currently documented; mocked local HTTP tests and bounded live acceptance cover this release.

## JSON keepalive acceptance

Run `PORTAL_LONG_RESPONSE_TEST=1 node --import tsx --test tests/portal.test.ts` for the synthetic 130-second upstream test. It uses a local HTTP server and no provider work. Require whitespace before the 125-second boundary, exactly one completed terminal JSON value, unchanged model/identity and one upstream attempt. Focused tests also cover backpressure, cleanup, disconnect, deadline, short-error status preservation and a post-header error recorded as a failure. No model output, private source, credentials or raw provider errors are written in heartbeat bytes.

After deployment, verify the actual public contract's new build and keepalive capability and run qualified bounded synthetic requests through Portal. The local 130-second server test proves gateway transport behavior, not Cloudflare behavior or natural meeting quality. Verify real recording completion independently and preserve uncertain generations.
