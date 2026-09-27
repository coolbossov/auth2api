# Decisions

## 2026-09-27: Dedicated Portal Responses contract

The Portal requires exact provider and model attribution. The generic gateway
routes intentionally support provider fallback and retries for other clients,
so the Portal receives separate authenticated routes. Their handler selects
Codex directly, checks caller build/account preconditions before dispatch,
and returns only a completed response with an exact upstream model match.

The account scope is a domain-separated digest of the verified build, selected
Codex account ID and plan tier. It stays stable through a token refresh and
changes with the build, account or tier. The contract advertises accepted
syntax, not live account entitlement or quality. Portal streaming is disabled
until a terminal-validated streaming contract is designed. The Codex backend
rejects `max_output_tokens`, so its value remains advisory and the contract
reports that no hard output cap is enforced.

POST resolves the requested scope against available Codex accounts directly.
The generic sticky account pointer can rotate between contract discovery and
generation without changing the selected Portal account. A cooling-down or
missing qualified account fails before dispatch; no other account is chosen.
