# Security policy

codex-reset-scheduler performs an irreversible account-level action. Changes to
the consume gateway, authorization state, scheduler definitions, path handling,
logs, and app-server protocol are security-sensitive.

## Supported versions

Until the first public release, only the current `main` branch is supported.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository. Do not include
Codex credentials, tokens, cookies, raw authentication files, raw backend
responses, email addresses, or real reset credit IDs in a report.

## Invariants

- Every consume request has a non-empty exact `creditId` from an armed plan.
- The idempotency UUID is persisted before the request is sent.
- Ambiguous failures retain the same UUID.
- Only a confirmed `nothingToReset` clears the attempt identity.
- A changed account, target, runtime, time boundary, or protocol shape fails
  closed.
- The worker never selects another credit when its target is absent.
- State, runtime, and logs are private per-user data.
- Scheduler arguments never contain credentials, email, or a raw credit ID.
- Live consume calls are prohibited in tests and CI.

## Threat boundaries

codex-reset-scheduler assumes the current operating-system user and the
installed Codex CLI are trusted. It does not protect against an attacker who can
replace the user's Node or Codex executable, control the account backend, or
write arbitrary files as the current user. Runtime hashing detects changes to
the private worker copy.

The app-server protocol is experimental. Unknown outcomes and malformed required
fields are treated as ambiguous or unsafe; they do not authorize a different
credit.
