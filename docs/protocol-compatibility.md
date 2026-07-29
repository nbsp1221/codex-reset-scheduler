# Codex protocol compatibility

Resetrail uses these documented app-server methods:

- `account/read`
- `account/rateLimits/read`
- `account/rateLimitResetCredit/consume`

The current contract requires a non-empty `idempotencyKey`; `creditId` is
optional upstream. Resetrail deliberately narrows that contract and requires a
non-empty exact `creditId` for every consume request.

Resetrail initializes with the experimental API capability and validates
account, rate-window, reset-credit, and outcome shapes. The multi-bucket `codex`
limit is preferred, with the documented backward-compatible single-bucket value
as a fallback.

The app-server is experimental. A new required shape or unknown outcome fails
closed. Codex version drift is recorded for diagnostics but compatibility is
decided by initialization and strict runtime decoding, not by a hard-coded
version allowlist.

The local Linux release-candidate validation used Codex CLI `0.145.0` with
Node.js `24.18.0`. That observation is evidence for this build, not a promise
that future experimental protocol versions are compatible.

Source:
[openai/codex app-server documentation](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#8-earned-rate-limit-resets-chatgpt)
