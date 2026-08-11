# Resetrail for Codex

Safe, deterministic scheduling for expiring Codex rate-limit resets.

Resetrail is an independent open-source tool designed to work with OpenAI Codex.
It is not affiliated with, endorsed by, sponsored by, or supported by OpenAI.

> [!WARNING] Redeeming a banked rate-limit reset is permanent. Resetrail never
> chooses a fallback credit: every schedule is bound to one exact
> backend-provided credit ID.

## Project status

Resetrail is currently a release candidate under cross-platform validation. The
Linux app-server and systemd paths have been validated, including one historical
live redemption and a separate harmless marker-based scheduler test. The Windows
Task Scheduler path has also passed non-elevated real-device marker validation.
macOS is implemented and contract-tested, but its real-device marker validation
must be completed before the project declares all three platforms stable.

No public package registry release has been made yet.

## Why Resetrail

Codex may provide banked rate-limit resets that expire. Resetrail lets you
inspect them, preview an exact schedule, and explicitly arm one or more
currently visible resets so the operating system attempts redemption shortly
before expiry.

These banked resets are not purchased usage credits. Resetrail does not buy
usage, configure auto-reload, or change paid-credit settings. Arming changes
private local state and the native scheduler, but it does not immediately redeem
anything; the irreversible action can happen later only inside the reviewed
plan's bounded window.

Safety properties:

- one immutable plan per exact credit ID
- no backend-selected fallback credit
- no standing authorization for future credits in v1
- idempotency identity persisted before a consume request
- ambiguous retries reuse the same UUID
- a confirmed `nothingToReset` starts a new logical attempt with a fresh UUID
- account, time, runtime hash, reset type, status, ID, and expiry gates
- read-after-consume reconciliation
- private state and a content-addressed worker snapshot
- sanitized logs with no raw credit IDs, email addresses, or credentials
- dry-run commands that do not create files or scheduler entries

Resetrail uses the documented Codex app-server methods rather than reading Codex
credentials or calling private backend routes.

## Requirements

- Node.js 22.14 or newer; Node.js 24 LTS is recommended
- a current authenticated Codex CLI with `codex app-server`
- a ChatGPT Codex account whose app-server response includes detailed reset rows
- one of:
  - Linux with a working systemd user manager
  - macOS with a logged-in LaunchAgent session
  - Windows with a logged-in Task Scheduler session

## Install during development

```sh
git clone https://github.com/nbsp1221/resetrail.git
cd resetrail
corepack enable
pnpm install --frozen-lockfile
pnpm build
node dist/cli.js doctor
```

After a public package registry release, the intended entrypoints are:

```sh
pnpm dlx codex-resetrail doctor
pnpm add --global codex-resetrail
resetrail doctor
```

An armed scheduler never points at a `pnpm dlx` cache. Resetrail copies its
built worker into a private, content-addressed runtime directory and records the
absolute Node and Codex executable paths.

## Safe first run

```sh
resetrail doctor
resetrail resets
resetrail plan --before 10m
resetrail arm --dry-run --before 10m
```

These commands do not redeem a reset. `plan` calculates times; `arm --dry-run`
also renders the native scheduler artifacts without writing them.

To arm the earliest-expiring detailed reset:

```sh
resetrail arm --before 10m
```

The interactive flow shows a fresh preview and binds its exact confirmation to
the public selector (`ARM <selector>`) for one reset, or to the reviewed count
for `--all`. For a reviewed non-interactive run:

```sh
resetrail arm --before 10m --yes
```

To create independent plans for all currently visible eligible resets:

```sh
resetrail arm --all --before 10m
```

`--all` does not authorize resets issued later.

## Commands

```text
resetrail doctor [--json]
resetrail resets [--timezone <IANA>] [--json]
resetrail plan [--credit <selector> | --all] [--before 10m] [--json]
resetrail arm [--credit <selector> | --all] [--before 10m] [--yes] [--dry-run]
resetrail status [--plan <id-or-selector>] [--json]
resetrail disarm [--plan <id> | --all] [--yes] [--dry-run]
resetrail logs [--plan <id-or-selector>] [--json]
resetrail gc [--dry-run] [--json]
resetrail version [--json]
```

Human output uses a short SHA-256 selector. Raw credit IDs exist only in the
private state needed to send an exact consume request.

`doctor` checks Codex read access and the native scheduler without changing
either. `gc --dry-run` lists terminal scheduler artifacts and unreferenced,
strictly named runtime snapshots; plain `gc` removes only those managed paths.
For machine-readable arming, review `arm --dry-run --json` first and then pass
`--yes`; interactive confirmation is intentionally rejected with `--json` so the
command always emits one valid JSON document.

## Platform behavior

| Platform | Native scheduler             | Required session behavior                                                        |
| -------- | ---------------------------- | -------------------------------------------------------------------------------- |
| Linux    | systemd user service/timer   | user manager must remain available; linger is recommended for logged-out servers |
| macOS    | per-user launchd LaunchAgent | user must be logged in; powered-off deadlines cannot be recovered after expiry   |
| Windows  | per-user Task Scheduler task | user must be logged in; Resetrail does not store a password or run as SYSTEM     |

All platforms schedule several independent invocations inside the final window.
The worker's UTC `notBefore` and expiry values are authoritative, so early,
late, duplicate, annual, or catch-up invocations safely no-op when ineligible.

See [platform support](docs/platform-support.md) and the
[safety model](docs/safety-model.md) for details.

## Privacy

Resetrail starts the local `codex app-server` process. It does not read
`auth.json`, Keychain, Credential Manager, tokens, or cookies. The scheduler
definition contains only an opaque plan ID and private worker path. There is no
telemetry.

## Development

```sh
pnpm test
pnpm coverage
pnpm lint
pnpm format:check
pnpm security:secrets
pnpm check
```

Tests use a synthetic app-server. Tests and CI must never point the consume path
at a real Codex installation or account.

## Compatibility

The Codex app-server is experimental and may change. Resetrail validates the
response shape at runtime and fails closed on unknown required fields or outcome
values. See [protocol compatibility](docs/protocol-compatibility.md).

## Acknowledgements

The design research reviewed these independent community projects without
copying their code:

- [codex-auto-reset](https://github.com/RobertTLange/codex-auto-reset)
- [CodexResets](https://github.com/maximpri/CodexResets)
- [codex-quota-keeper](https://github.com/jimyag/codex-quota-keeper)
- [codex-limit-auto-reset](https://github.com/fa0311/codex-limit-auto-reset)
- [codex-reset](https://github.com/hcsolakoglu/codex-reset)

The protocol source of truth is the
[Codex app-server documentation](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#8-earned-rate-limit-resets-chatgpt).

## License

[MIT](LICENSE)
