# Linux validation

## Historical live protocol evidence

Before Resetrail was created, a one-off exact-credit Node.js worker on this
Ubuntu server successfully redeemed one banked Codex rate-limit reset through
the documented app-server method. The worker pinned one target ID and expiry,
protected the remaining bank, persisted one UUID, consumed the exact target,
read a fresh snapshot, and observed that the target retired while three other
credits remained. Later timer invocations safely no-op'd.

The live action is not repeated for this project. Real credit IDs, account
details, and raw payloads are intentionally omitted.

## Resetrail systemd marker validation

- Date: 2026-07-28 KST
- Environment: Ubuntu Linux, x64, Node.js 24.18.0
- Action: synthetic marker writer; no Codex process or credentials
- Native path: systemd user service and timer
- Read-back: loaded, active, enabled
- Planned UTC time: 2026-07-27T20:39:10.294Z
- Observed UTC time: 2026-07-27T20:39:10.896Z
- Observed delay: 602ms
- Cleanup: temporary harness, state directory, service, and timer removed

Result: pass.

## pnpm release-candidate package validation

- Date: 2026-07-29 KST
- Environment: Ubuntu Linux, x64
- Package manager: pnpm 10.33.4 with a frozen `pnpm-lock.yaml`
- Runtime matrix: Node.js 22.14.0 (declared minimum) and 24.18.0
- Codex read-only compatibility: Codex CLI 0.146.0
- Package path: a fresh `pnpm pack` tarball installed into an isolated temporary
  consumer project
- Quality gate: format, lint, secret scan, 62 tests, build, and pack passed on
  both Node.js versions
- Coverage: 87.30% lines, 77.60% branches, 85.86% functions
- Dependency audit: no known vulnerabilities
- Live read-only commands: `doctor`, `resets`, `plan --all`, and
  `arm --all --dry-run`
- Dry-run result: no Resetrail state directory or `resetrail-*` systemd unit
  existed before or after
- Native marker: two close systemd triggers, first delivery at +881ms, two
  sequential invocations, no overlap
- Native read-back: installed and enabled
- Cleanup: service, timer, and isolated QA state removed and confirmed absent

Result: pass. No Codex consume method was called.
