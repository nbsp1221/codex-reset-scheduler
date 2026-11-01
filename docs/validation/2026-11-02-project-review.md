# Project structure review: 2026-11-02

Baseline: `bfe89d1c123e3c12a0b5071dab893c8b07104c3b` (published 0.1.1).

The review inventories all 119 tracked paths, examines production modules and
build/test/automation boundaries, and maps existing regression coverage. It is
not a claim that every line of every fixture has been independently proven, that
all platforms were exercised locally, or that the live Codex API was tested. No
credentials, live credits, operating installation or user schedules are used.

## Decision rule

Prefer existing Node/npm/GitHub mechanisms and a readable linear workflow. Keep
custom code only for an identified product requirement. Do not add a recovery
framework to compensate for a framework we should not have built. Do not remove
an irreversible-effect safeguard merely to reduce line count.

## Findings and disposition

| Area                     | Finding and decision                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI/CD                    | Remove the validation-only `release.yml`, three custom release coordinators, their obsolete tests, artifact transfers, prior-run API queries, and immediate registry visibility gate. Keep one tag-triggered publishing workflow and a separate dependent GitHub Release job. Its ordinary job rerun can recover Release creation without running a successful publisher. |
| Build/version            | A 134-line release helper also generated the runtime version. Replace that coupling with a small build-only generator. Keep embedding: existing scheduled runtimes intentionally contain only `dist`, without `package.json`. Test stable and prerelease values.                                                                                                          |
| Test runner              | Remove recursive discovery and subprocess forwarding. Node 22.14 already supports quoted test globs. Keep the same compiled unit/contract/integration/e2e tests and aggregate script tests.                                                                                                                                                                               |
| Lint/config/dependencies | Replace the script filename allowlist with `scripts/**/*.mjs` and lint all scripts. No package-manager migration, new production dependency or major library change is justified. Keep lockfile and TypeScript settings.                                                                                                                                                  |
| CLI                      | Add conventional `--version`/`-v` while preserving `version`. Fix absent reset details being reported available because `undefined !== null`. Preserve confirmation, machine-output and read-only contracts.                                                                                                                                                              |
| Codex boundary           | Replace hard-coded client version `0.1.0` with the generated package version. Preserve the protocol client name, bounded transport, strict decoders and single exact-credit consume gateway.                                                                                                                                                                              |
| Application              | Reuse one selector implementation for status/logs/disarm instead of duplicate filtering and ambiguity handling. Keep arm approval revalidation and worker state transitions.                                                                                                                                                                                              |
| Persistence              | Distinguish filesystem read failures from invalid JSON instead of relabeling every I/O error as corruption. Preserve durable writes, state schema, lock protocol and retained attempt UUIDs.                                                                                                                                                                              |
| Runtime                  | Keep content-addressed snapshots and hash checks: replacing an already scheduled worker on CLI upgrade would change previously authorized execution. No generic runtime abstraction added.                                                                                                                                                                                |
| Scheduler                | Remove two unused convenience exports. Keep real systemd/launchd/Windows adapters and escaping/encoding contracts rather than hide actual platform differences.                                                                                                                                                                                                           |
| Native integration       | Rename the workflow to `native-integration.yml` / Native integration tests. Keep the optional hosted-runner harness and owned-resource cleanup: it observes natural timers and must not delete unrelated state. It is not a release gate.                                                                                                                                 |
| Documentation            | Remove contradictory “no public npm release” text, lead with installed CLI examples, update release/install/contribution guides and workflow naming. Preserve dated historical evidence rather than rewrite it as current validation.                                                                                                                                     |
| Templates/security       | Keep issue safety reminders, contribution boundaries and the small product-specific scan for real reset IDs/credential payloads. The scanner is not represented as a comprehensive security audit.                                                                                                                                                                        |

## Alternatives considered

- npm's [official OIDC example](https://docs.npmjs.com/trusted-publishers/)
  provides a direct tag/build/publish baseline. This is adequate for a single
  package whose version decisions are explicitly approved.
- [tsx](https://github.com/privatenumber/tsx/blob/master/.github/workflows/release.yml)
  uses semantic-release. [release-it](https://github.com/release-it/release-it)
  also provides established version/tag/npm/Release automation. They are viable
  when that automation is wanted; introducing commit-message/version policy now
  would add a requirement rather than simplify the approved manual-version flow.
- [Changesets](https://github.com/changesets/action) supports release PR and
  package automation. Its additional change files and versioning machinery are
  not required for this single package today. These comparisons are examples,
  not a measured popularity ranking.
- The
  [Node 22.14 test documentation](https://github.com/nodejs/node/blob/v22.14.0/doc/api/test.md#running-tests-from-the-command-line)
  explicitly documents double-quoted globs for shell portability. No third-party
  test runner is needed to remove our custom test discovery.
- [proper-lockfile](https://github.com/moxystudio/node-proper-lockfile) uses
  heartbeat/mtime staleness. It is not a drop-in replacement for the current
  no-live-PID-reaping policy or the fence against old immutable workers. A lock
  or storage redesign would require a separately validated compatibility
  transition, not a cosmetic replacement in this PR.

## Safety and compatibility retained

Exact current credit and account binding, persist-before-consume UUIDs,
ambiguous-result retention, expiry gates, dry-run behavior, legacy storage
namespaces, immutable scheduled runtimes, native cleanup ownership and existing
OS support remain intact. The 2m–7d planning option and finite trigger policy
are existing product behavior, not publication workarounds; this review does not
silently redefine them. Unknown API outcomes still fail closed.

The production lock is complex and remains a maintenance concern. This review is
not evidence that replacing it is unnecessary forever; preserving it here avoids
inventing a new migration while changing unrelated release machinery. Likewise,
hosted native tests do not establish physical-device sleep/wake or current
real-account compatibility.

## Incident and validation boundary

[Run 41327868530](https://github.com/nbsp1221/codex-reset-scheduler/actions/runs/41327868530)
published 0.1.1 with OIDC. npm reported asynchronous processing. The old
54-second visibility wait failed; subsequent original-artifact integrity and
public-install smoke checks passed. The skipped GitHub Release is still
outstanding. This PR neither republishes 0.1.1 nor moves its tag or makes that
old run green.

Validation results and exact CI links are recorded in the PR. A green PR does
not prove a new live CD release: that requires a separately approved version.
