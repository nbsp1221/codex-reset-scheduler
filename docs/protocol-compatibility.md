# Codex protocol compatibility

codex-reset-scheduler uses the documented app-server methods `account/read`,
`account/rateLimits/read`, and `account/rateLimitResetCredit/consume`.

Upstream accepts an optional `creditId` and requires a non-empty
`idempotencyKey`. codex-reset-scheduler requires a non-empty exact credit ID,
persists a UUID before sending, and reuses it after an ambiguous result. The
documented outcomes remain `reset`, `alreadyRedeemed`, `nothingToReset`, and
`noCredit`. It reads limits again after consuming rather than inferring updated
windows. See the
[official app-server documentation](https://developers.openai.com/codex/app-server).

## Current evidence: 2026-10-03

Windows Codex CLI `0.159.2` was inspected without an authenticated account:
`--version`, `app-server --stdio --help`, and
`app-server generate-ts --experimental --out <temporary-directory>`. The schemas
were generated with an empty isolated Codex home. No account request, login,
real consume, or credential-file read was performed.

The generated types retain the reset-credit fields and four consume outcomes
used by codex-reset-scheduler. They also include optional usage metadata such as
`ordinaryUsageAllowed`, `accountId`, and `rateLimitUpsell`.
codex-reset-scheduler does not interpret those fields as proof of reset
completion.

The synthetic app-server fixture includes those additional fields and passes the
existing decoder/client boundary. Capped and count-only detail snapshots remain
incomplete. Worker regression tests cover unavailable details, capped rows, and
an empty incomplete list: absence of the target neither authorizes consume nor
confirms success. Complete fresh retirement is still required.

These are schema and synthetic observations. Current authenticated service
responses and account eligibility have not been validated. Generated TypeScript
types alone do not prove runtime JSON compatibility; numeric counts must still
be safe integers under codex-reset-scheduler's decoder.

## Runtime policy

Initialization enables the experimental API capability. The multi-bucket `codex`
limit is preferred, with the backward-compatible single-bucket value as a
fallback. Unknown outcome values or required enum shapes fail closed; additional
unused metadata is ignored.

Compatibility is decided by initialization and runtime decoding rather than a
version allowlist. Version drift is recorded for diagnostics. A schema
inspection is not a guarantee about future experimental releases.

All app-server requests in a worker share one absolute deadline, including
process startup and initialization. Contract tests advance a mock clock and hold
a synthetic reply to verify the remaining budget and initialization timeout
independently of machine startup speed. The production deadline calculation is
unchanged.

## Historical evidence

Linux records describe Codex `0.145.0` with Node.js `24.18.0`, followed by
read-only `0.146.0` validation. Those historical observations are separate from
the current schema inspection. See
[the Linux validation record](validation/linux-live-redemption.md) and
[the current release preparation record](validation/2026-10-03-release-preparation.md).
