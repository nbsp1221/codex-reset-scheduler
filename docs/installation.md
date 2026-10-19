# Installation

codex-reset-scheduler is a release candidate. The package name is
`codex-reset-scheduler`; the installed executable is `codex-reset-scheduler`. A
public registry release is not available yet. Package-name lookup results do not
establish ownership or reserve a name.

The project was previously named Resetrail.

The current repository and default checkout directory are
`nbsp1221/codex-reset-scheduler` and `codex-reset-scheduler`. Existing private
state and schedules keep their original names; see
[compatibility notes](name-change.md).

## From source

Use Node.js 22.14 or newer and pnpm 10.33.4:

```sh
git clone https://github.com/nbsp1221/codex-reset-scheduler.git
cd codex-reset-scheduler
corepack enable
pnpm install --frozen-lockfile
pnpm build
node dist/cli.js version
node dist/cli.js doctor
```

Continue with `node dist/cli.js` for the
[inspect, schedule, cancel, and result-check flow](../README.md#inspect-and-preview).
Building a checkout does not put `codex-reset-scheduler` on PATH.

## From a locally built tarball

A maintainer builds and validates the tarball with pnpm:

```sh
pnpm check
pnpm pack
```

The resulting `codex-reset-scheduler-0.1.0.tgz` can be installed by a consumer
with Node.js 22.14+ and npm. The package has no production dependencies and
installation does not require pnpm. This example uses a separate prefix rather
than changing an existing global installation:

```sh
npm install --global --prefix ./codex-reset-scheduler-local --ignore-scripts ./codex-reset-scheduler-0.1.0.tgz
```

On Linux/macOS, check the installed command:

```sh
./codex-reset-scheduler-local/bin/codex-reset-scheduler version
./codex-reset-scheduler-local/bin/codex-reset-scheduler --help
./codex-reset-scheduler-local/bin/codex-reset-scheduler doctor
```

On Windows PowerShell, npm places the command directly in the prefix:

```powershell
.\codex-reset-scheduler-local\codex-reset-scheduler.cmd version
.\codex-reset-scheduler-local\codex-reset-scheduler.cmd --help
.\codex-reset-scheduler-local\codex-reset-scheduler.cmd doctor
```

Use that same executable path for subsequent `resets`, `plan`, `arm`, `status`,
`disarm`, and `logs` commands. Linux prefix installation was directly tested;
these Windows command locations describe npm's layout, not a new Windows QA run.

`version`, `--help`, and `status` with no existing state do not require an
authenticated Codex account. `doctor`, `resets`, `plan`, and `arm --dry-run` use
read-only account access through the locally authenticated app-server. Arming a
real plan needs explicit confirmation and can cause irreversible redemption
later.

## After a public release

Only after registry publication, the intended commands are:

```sh
npm install --global codex-reset-scheduler
codex-reset-scheduler doctor
```

Use `codex-reset-scheduler` both for package-manager operations and to run the
installed CLI.

The current release workflow validates and uploads a tarball only.
`publishConfig.provenance=true` remains in place. Publishing method, registry
ownership, and approval are separate release decisions; this guide does not
authorize registry login, staging, or publication.

## Upgrading an existing installation

Before using a new build with existing schedules, follow the
[state lock migration and recovery guide](state-lock.md). Existing schedules
keep their immutable previous runtimes; installing the CLI alone does not
upgrade them.

## Runtime and device requirements

codex-reset-scheduler needs a current Codex CLI and detailed banked reset rows
for a ChatGPT Codex account. The scheduler needs a working systemd user manager
on Linux or a logged-in session on macOS/Windows. Keep the device powered on and
connected to the network during the plan window.

The worker uses a private snapshot and recorded absolute Node and Codex paths.
Review `doctor` before arming and `status` afterward. Codex updates are
experimental-protocol changes; see
[compatibility evidence](protocol-compatibility.md) and
[platform validation limits](platform-support.md).
