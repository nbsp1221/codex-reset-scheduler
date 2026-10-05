# Name-change compatibility

The current product name is **codex-reset-scheduler**, the npm package is
**codex-reset-scheduler**, and the installed command is
**codex-reset-scheduler**. The project was previously named Resetrail. The
GitHub repository remains `https://github.com/nbsp1221/resetrail`; cloning it
still creates a `resetrail` checkout directory.

A registry release is still a separate decision. The absence of a public npm
release does not establish that nobody has used a source checkout or a local
package. Existing private state and scheduled plans must remain discoverable.

## Preserved namespaces

The renamed command deliberately uses the original storage and scheduler
namespaces on all supported platforms:

| Platform | State and runtime storage                                                     | Scheduler identity                         |
| -------- | ----------------------------------------------------------------------------- | ------------------------------------------ |
| Linux    | `$XDG_STATE_HOME/resetrail` or `~/.local/state/resetrail`                     | `resetrail-<plan-id>` service/timer        |
| macOS    | `~/Library/Application Support/Resetrail`; logs in `~/Library/Logs/Resetrail` | `dev.resetrail.plan.<plan-id>` LaunchAgent |
| Windows  | `%LOCALAPPDATA%/Resetrail`                                                    | `\Resetrail\<plan-id>` Task Scheduler task |

The state schema, state lock, install/account identity, exact credit ID, plan
ID, persisted attempt UUID, and recorded worker hash are unchanged. There is no
state migration, separate new state root, or automatic re-arming. Existing
schedules retain their recorded private worker snapshot. A newly armed plan can
use a new content-addressed snapshot without replacing an existing one.

`codex-reset-scheduler status`, `codex-reset-scheduler logs`, and
`codex-reset-scheduler disarm` use this shared state. Inspect existing plans
before deciding to arm anything again. Existing ambiguous-attempt and
cancellation safety gates still apply. The new package exports only
`codex-reset-scheduler`; it does not claim the old `resetrail` executable name
or overwrite an older package's global command.

The app-server client name `resetrail`, internal `ResetrailError` class,
`RESETRAIL_FAKE_*` test variables, and temporary artifact prefixes also remain.
Changing them is unnecessary for the user-facing name and would add avoidable
compatibility or fixture churn. No new product-prefixed environment variables or
second scheduler namespace are introduced.

## Historical records and validation limits

Dated documents under `docs/validation` and `docs/plans` retain the names and
commands used when their observations were recorded. Their old spelling is
intentional; it does not identify the current npm package or command. Current
installation and command documentation uses the new names.

Cross-platform contract tests check the preserved paths and scheduler IDs.
Synthetic CLI checks can verify an old-brand plan through the renamed command
without contacting a real account or native scheduler. They do not establish
real-device scheduler delivery or permission behavior on macOS/Windows.
