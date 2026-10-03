# Release preparation: 2026-10-03

Baseline: `7b259e7af9b87e0e68aa5c6c5a85b88a935c3036` (application-code commit:
`6766c89`).

This record covers isolated local release preparation. It does not authorize a
real reset plan, consumption, account login, repository publication, or npm
publication. Final package hash and full command logs are retained with the
local audit artifacts rather than embedded in the package they identify.

## Direct checks

- Selected Linux sandbox: Node.js `22.22.1`, pnpm `10.33.4`, npm `9.2.0`.
- Public baseline cloned into a separate checkout; existing projects untouched.
- Frozen-lockfile installation passed.
- Baseline `pnpm check` passed on recheck with 63 tests. The first full run and
  separate contract run exposed an initialization timing assumption; a recheck
  pass alone was not treated as a fix.
- Windows Codex `0.159.2`: version/help and experimental TypeScript schema
  generation with an empty isolated Codex home passed. No authenticated account
  request was made.
- Current-shaped synthetic decoder/client data includes unused usage metadata.
  Credit fields and the four consume outcomes match the generated schema.
- Actual CLI subprocess demo uses a fake app-server and fake scheduler on an
  exclusive temporary PATH. One current synthetic credit is armed, inspected,
  and disarmed. Dry-run creates no state or scheduler files. Logs show the
  existing arming event; cancellation is verified through status. Zero consume
  requests are asserted and temporary paths are removed.
- Baseline local tarball installed offline through npm into a separate prefix,
  with lifecycle scripts disabled. No pnpm was present on the consumer PATH.
  Installed `version`, `--help`, empty `status`, and `logs` passed without
  creating state paths.
- Final `pnpm check` passed with 66 tests on Node.js `22.22.1` and the declared
  minimum `22.14.0`, including format, lint, secret scan, build, and pack
  checks. Rebuilt tarball installation details, file-list checks, and the final
  SHA-256 are retained with the local audit artifacts.

## Deadline test cause and correction

The old test set an absolute deadline 150ms in the future immediately before
calling `connect`, then expected initialization to finish before a delayed
account-read timeout. Process startup and initialization correctly share that
deadline, so a loaded sandbox could fail at initialization before reaching the
intended assertion.

The production code and deadline budget are unchanged. The contract test uses
Node's mock clock and a synthetic backend that holds the selected reply. It
charges 100ms of mock time to initialization, then drains one event-loop turn at
both the 49ms and 50ms account-read checkpoints. The held request must still be
pending at 49ms and rejected at 50ms; later requests are also rejected.
Memory-only timer mutations to 1ms and to the remaining budget plus 1ms each
fail the corresponding assertion. The compiled production module's hash was
unchanged before and after those mutation runs. A second test verifies that
initialization itself is bounded.

No sleep duration, retry-until-pass behavior, or timeout increase is used to
make the deadline test pass.

## Incomplete-snapshot coverage

Existing decoder tests marked capped details incomplete, but worker tests did
not directly exercise incomplete snapshots before consumption or after a
successful response. The new regression covers:

- unavailable summary
- count-only details
- capped rows without the selected target
- empty details with a nonzero available count

Each case keeps the armed plan from consuming a missing target, keeps a
post-response plan settling, retains its UUID, and accepts success only after a
complete fresh snapshot retires the exact target. The safety policy is
unchanged.

## Historical records

[Linux validation](linux-live-redemption.md) records earlier app-server, systemd
marker, and package checks. [Windows validation](windows-scheduler.md) records
the earlier normal-session Task Scheduler marker test. These are historical
observations, not reruns in this preparation session.

## Not performed and environment limits

Current authenticated Codex account reads and eligibility checks were not
performed. Generated schema compatibility is not live service compatibility.

The selected Linux sandbox uses `tini` as PID 1 and has no `systemctl`. Its fake
scheduler demo does not establish native systemd delivery.

Windows `node --version` resolved to `%LOCALAPPDATA%\mise\shims\node.exe` and
failed:

```text
mise-shim: failed to execute mise: Access is denied. (os error 5)
Ensure `mise` is installed and available on your PATH.
See https://mise.jdx.dev for installation instructions.
```

This was a command-execution restriction in the managed Windows sandbox. No
alternate executable path or elevated execution was used to bypass it. Windows
full Node/package tests and new native scheduler QA were not run.

[macOS real-device QA](macos-scheduler.md) remains pending; no Mac device was
available. No real arm, consume, scheduler changes, credential-file reads,
commit, push, PR operation, or publication occurred.

## Release decisions remaining

- Access to an authenticated current Codex environment for separately reviewed
  read-only compatibility checks, if required before release.
- macOS real-device marker QA or explicit experimental support labeling.
- Package registry ownership and publishing method with provenance. The workflow
  currently validates and uploads a tarball only.
  `publishConfig.provenance=true` remains unchanged.
