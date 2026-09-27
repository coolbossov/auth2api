# Changelog

## 2026-09-27

- Added authenticated Portal contract and strict Codex Responses routes so the
  Portal can bind requests to an exact gateway build and selected account,
  reject model mismatches, and avoid automatic generation retries. The ordinary
  compatibility routes retain their existing behavior.
- Added a source-revision Docker build argument and response capability notice.
  A build without a verified revision leaves the Portal routes unavailable.
- If Portal calls return `portal_build_unverified`, rebuild the image from the
  verified source commit with `AUTH2API_BUILD_ID`; if they return
  `portal_scope_mismatch`, fetch the contract again and requalify the selected
  account. The client must treat an upstream failure as potentially sent and
  must not blindly retry.
