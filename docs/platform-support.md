# Platform support

## Linux

Resetrail supports Linux systems with a systemd user manager. It writes one
oneshot service and timer per plan, using multiple UTC `OnCalendar` entries,
`AccuracySec=1s`, no randomized delay, and persistent catch-up behavior.

The service uses systemd hardening and allows writes only to Resetrail state and
the selected Codex home. Servers whose user manager stops at logout should
enable linger explicitly; Resetrail does not silently change linger policy.

## macOS

Resetrail uses a per-user LaunchAgent with `ProgramArguments`, an array of
`StartCalendarInterval` values, and `RunAtLoad`. launchd calendar values have
minute resolution and no year, so the worker's UTC window and terminal state are
the final gate. The user must be logged in.

A sleeping Mac can deliver a missed calendar event after wake. A powered-off Mac
cannot redeem a reset after its expiry; `RunAtLoad` helps only when login occurs
while the plan is still valid.

## Windows

Resetrail registers a per-user Task Scheduler XML task with exact TimeTriggers,
an expiry boundary, `StartWhenAvailable`, `IgnoreNew`, a 45-second execution
limit, and least privilege. It uses `InteractiveToken`, stores no password, does
not use SYSTEM, and therefore requires the user to remain logged in.

S4U is intentionally not used because Microsoft documents that it has no access
to the network or encrypted files.

## Stable validation gate

Each platform must pass a real-device harmless marker test that registers the
native artifact, reads it back, observes execution, checks duplicate behavior,
and removes all artifacts. A real Codex consume is neither necessary nor
permitted for macOS or Windows validation.
