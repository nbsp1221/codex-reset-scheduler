# Codex ResetPilot

Schedule a currently visible banked Codex reset before it expires.

Codex ResetPilot is a small local open-source CLI. You inspect a reset, review
its schedule, confirm one exact credit, and check or cancel the plan. The
operating system invokes the worker inside the final window; there is no
resident Codex ResetPilot daemon. The device must be powered on, online, and
have the required user session available. Delivery before expiry is not
guaranteed.

Codex ResetPilot is independent and is not affiliated with, endorsed by,
sponsored by, or supported by OpenAI.

> [!WARNING] Redeeming a banked reset is permanent. A full reset also changes
> the weekly reset date. Review that tradeoff before confirming a schedule.
> Codex ResetPilot always uses the selected credit ID and never chooses a
> fallback credit.

The project was previously named Resetrail. The new command shares its original
state and scheduler namespaces; existing plans are not migrated or rescheduled.
See [name-change compatibility](docs/name-change.md).

## Release status

This is a release candidate; no public package registry release has been made.
Codex `0.159.2` schema inspection and synthetic CLI validation are recorded in
[the current validation report](docs/validation/2026-10-03-release-preparation.md).
They do not establish authenticated current-account compatibility. Linux and
Windows native marker QA are historical observations; macOS real-device marker
QA is still pending. See [platform support](docs/platform-support.md).

## Install from source

Requirements: Node.js 22.14 or newer, pnpm 10.33.4, an authenticated Codex CLI
with `codex app-server`, and detailed reset rows for your ChatGPT Codex account.
The native scheduler also needs a working systemd user manager on Linux, a
logged-in LaunchAgent session on macOS, or a logged-in Task Scheduler session on
Windows.

```sh
git clone https://github.com/nbsp1221/resetrail.git
cd resetrail
corepack enable
pnpm install --frozen-lockfile
pnpm build
node dist/cli.js doctor
```

The source checkout uses `node dist/cli.js` in the examples below. The package
name is **codex-resetpilot** and its installed command is **resetpilot**.
[Installation details](docs/installation.md) include a local tarball option
whose consumer needs Node.js and npm, without pnpm.

To try the full flow with fake data and no Codex account, see the
[synthetic CLI demo](docs/synthetic-demo.md).

## Inspect and preview

```sh
node dist/cli.js resets
node dist/cli.js plan --credit <selector> --before 10m
node dist/cli.js arm --credit <selector> --before 10m --dry-run
```

Copy the public selector from `resets`. Review the expiry and trigger times.
These commands do not redeem a reset. `plan` calculates times; `arm --dry-run`
renders scheduler artifacts without writing state or registering a task.

If `doctor` reports a required check failure, resolve it before arming.
Count-only reset information cannot identify a credit to schedule. A capped
detail list permits selection only from the rows actually visible.

## Confirm and check the schedule

```sh
node dist/cli.js arm --credit <selector> --before 10m
node dist/cli.js status
```

The interactive command shows a fresh preview and asks for `ARM <selector>`.
Confirmation creates a local plan and native schedule; it does not redeem the
reset immediately. Save the plan ID from the output and verify that `status`
shows `armed` with an installed, enabled scheduler.

Every plan binds one current exact credit, account, expiry, and worker snapshot.
New promotional grants are not guaranteed and require separate explicit
authorization if they become visible later.

## Cancel or check the result

To cancel a reviewed plan:

```sh
node dist/cli.js disarm --plan <plan-id> --dry-run
node dist/cli.js disarm --plan <plan-id>
node dist/cli.js status --plan <plan-id>
```

Type `DISARM` when prompted, then verify `disarmed` in `status`. Cancellation
does not undo a redemption. An ambiguous in-flight attempt cannot be disarmed.

To check a scheduled run:

```sh
node dist/cli.js status --plan <plan-id>
node dist/cli.js logs --plan <plan-id>
```

| Status                    | Meaning                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| `armed`                   | Waiting for an eligible worker invocation; no confirmed redemption |
| `attempting`              | A persisted attempt exists; its result may be ambiguous            |
| `settling`                | Waiting for an authoritative snapshot to retire the exact target   |
| `succeeded`               | A complete fresh snapshot confirmed retirement of the exact target |
| `expired` / `unavailable` | The deadline passed or the target is no longer eligible            |
| `paused`                  | A safety gate requires attention; inspect `terminalReason`         |
| `disarmed`                | The plan was cancelled                                             |

Logs record arming and worker events. Confirm cancellation with `status`; it
does not currently add a separate disarm audit event. Incomplete credit details
are never treated as proof of success.

## Safety and privacy

Banked resets are distinct from purchased usage credits. Codex ResetPilot does
not buy usage, configure auto-reload, or change paid-credit settings.

- Exact credit/account/runtime binding; no backend-selected fallback
- UUID persisted before consume and reused after ambiguous failures
- Only confirmed `nothingToReset` starts a fresh logical attempt
- No standing authorization for future credits
- Read-after-consume reconciliation using complete credit details
- Private state and a content-addressed worker snapshot
- Sanitized logs without raw credit IDs, email addresses, or credentials
- Dry-run commands that create no state or scheduler entries

Codex ResetPilot starts the local `codex app-server`. It does not read
`auth.json`, Keychain, Credential Manager, tokens, or cookies, and has no
telemetry. An armed scheduler uses the private worker snapshot and recorded
absolute Node and Codex paths, independently of package-manager caches.

## Commands

The installed `resetpilot` command accepts:

```text
resetpilot doctor [--json]
resetpilot resets [--timezone <IANA>] [--json]
resetpilot plan [--credit <selector> | --all] [--before 10m] [--json]
resetpilot arm [--credit <selector> | --all] [--before 10m] [--yes] [--dry-run] [--json]
resetpilot status [--plan <id-or-selector>] [--json]
resetpilot disarm [--plan <id> | --all] [--yes] [--dry-run] [--json]
resetpilot logs [--plan <id-or-selector>] [--json]
resetpilot gc [--dry-run] [--json]
resetpilot version [--json]
```

For a reviewed non-interactive run, use `--yes` after reviewing
`arm --dry-run --json`. Interactive arming is rejected with `--json` to keep
machine output a single JSON document. `--all` selects only currently visible
eligible rows and does not authorize future grants.

Human output uses a short SHA-256 selector. Raw credit IDs exist only in private
state needed for exact consume requests. `doctor` checks read access and
scheduler availability. `gc --dry-run` previews cleanup; `gc` removes only
managed terminal scheduler artifacts and unreferenced runtime snapshots.

## Platform behavior

| Platform | Native scheduler             | Required session behavior                                                      |
| -------- | ---------------------------- | ------------------------------------------------------------------------------ |
| Linux    | systemd user service/timer   | User manager must remain available; linger is an explicit user choice          |
| macOS    | per-user launchd LaunchAgent | User must be logged in; powered-off deadlines cannot be recovered after expiry |
| Windows  | per-user Task Scheduler task | User must be logged in; no stored password or SYSTEM task                      |

The scheduler invokes several finite workers inside the final window. Early,
late, duplicate, or catch-up invocations no-op when ineligible. The worker's UTC
`notBefore` and expiry are authoritative. No resident daemon does not mean there
are no repeated invocations or account reads.

See [platform support](docs/platform-support.md),
[the safety model](docs/safety-model.md), and
[protocol compatibility](docs/protocol-compatibility.md).

## Development

```sh
pnpm check
```

Tests use synthetic app-server data and isolated state. Tests and CI must never
point the consume path at a real Codex installation or account. The
[release preparation record](docs/validation/2026-10-03-release-preparation.md)
distinguishes direct checks, historical evidence, and checks not performed.

## Acknowledgements

The design research reviewed these independent projects without copying code:

- [codex-auto-reset](https://github.com/RobertTLange/codex-auto-reset)
- [CodexResets](https://github.com/maximpri/CodexResets)
- [codex-quota-keeper](https://github.com/jimyag/codex-quota-keeper)
- [codex-limit-auto-reset](https://github.com/fa0311/codex-limit-auto-reset)
- [codex-reset](https://github.com/hcsolakoglu/codex-reset)

The protocol source of truth is the
[official Codex app-server documentation](https://developers.openai.com/codex/app-server).

## License

[MIT](LICENSE)
