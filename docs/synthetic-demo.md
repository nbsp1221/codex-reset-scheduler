# Synthetic CLI demo

This demo runs the actual CLI as separate processes, using the existing fake
app-server fixture and synthetic scheduler executables. It demonstrates the
first-user flow without a real account, credit, or native scheduler.

Run from a source checkout on Linux after installing development dependencies:

```sh
pnpm build:test
node scripts/demo.mjs
```

The script uses a fresh temporary directory for state, worker snapshots, empty
Codex home, and generated scheduler files. Its child PATH contains only the
synthetic executables and Node, so a missing fake cannot fall through to an
installed Codex or native scheduler. The fake backend rejects consume calls, and
the script asserts that it sent zero such requests.

## What it shows

1. `doctor` and `resets` show two synthetic credits.
2. `status` starts with no plans.
3. `plan --credit <selector>` previews one currently visible synthetic credit.
4. `arm --dry-run` creates no state or scheduler files.
5. `arm --credit <selector> --yes` persists one plan and registers it with the
   fake scheduler.
6. `status --plan <id>` confirms `armed`.
7. `disarm --dry-run`, then `disarm --yes`, remove the synthetic schedule.
8. `status` confirms `disarmed`; `logs` shows the real `plan-armed` audit event.
9. The script verifies zero consume requests and removes its temporary
   directory.

Cancellation currently has no separate audit event. The demo does not invent
one: it confirms cancellation from `status`.

Selected lines from the synthetic run (UUIDs vary):

```text
SYNTHETIC DEMO — actual CLI, fake Codex and scheduler, no consume, no native tasks.
$ resetpilot doctor --json
  doctor: OK (synthetic checks)
$ resetpilot resets --timezone UTC --json
  currently visible synthetic resets: 2; selected 6b7fdd4bf204
$ resetpilot status --json
  status: no plans
$ resetpilot plan --credit 6b7fdd4bf204 --json
  preview: one current synthetic credit, 10 minutes before expiry
$ resetpilot arm --credit 6b7fdd4bf204 --dry-run --json
  dry-run: no state or scheduler files created
  status: armed; synthetic scheduler registered
  status: disarmed; synthetic scheduler removed
  logs: plan-armed; cancellation confirmed by status
PASS: current-credit arm → status → disarm → status → logs; zero consume requests.
Cleanup: temporary synthetic state, runtimes and scheduler files removed.
```

The script prints command labels and summaries derived from actual CLI JSON; it
does not print raw app-server payloads. It does not run a worker or demonstrate
redemption success. Worker success and incomplete-snapshot behavior are checked
separately with synthetic contract tests.

For a maintainer's local tarball validation, the script also accepts an explicit
installed `dist/cli.js` path:

```sh
node scripts/demo.mjs /absolute/prefix/lib/node_modules/codex-resetpilot/dist/cli.js
```

The compiled fake fixture must still exist from `pnpm build:test`. `pnpm pack`
cleans that directory during its build, so compile fixtures again afterward.

This is CLI integration evidence, not systemd, Windows, or macOS real-device QA.
