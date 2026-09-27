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

These local tests do not prove live account access or model capacity. For a
release, verify the exact image revision, authenticated contract response,
reverse-proxy path and header preservation, then run a bounded real canary
under the Portal release plan before activating policy defaults.
