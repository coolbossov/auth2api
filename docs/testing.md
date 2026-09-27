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
