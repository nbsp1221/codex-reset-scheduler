# Architecture

codex-reset-scheduler separates irreversible policy from operating-system
delivery.

```text
CLI read/preview
  -> Codex app-server read methods
  -> pure credit selection and UTC trigger planning

arm
  -> exact current credit
  -> private plan + runtime snapshot
  -> native scheduler registration

native trigger
  -> private worker(plan ID)
  -> state/account/time/runtime/target gates
  -> persisted logical attempt UUID
  -> exact-credit consume gateway
  -> fresh snapshot reconciliation
```

The scheduler cannot choose a credit. It knows only an opaque plan ID. The
worker cannot broaden authorization: it loads one plan containing one raw credit
ID and passes that exact ID to the only consume gateway.

## Layers

- `domain`: pure credit policy, time calculation, and state transitions
- `codex`: strict JSON-RPC client and decoders
- `persistence`: private versioned state, atomic writes, locks, sanitized audit
  log
- `runtime`: content-addressed copy used by scheduled work
- `scheduler`: systemd, launchd, and Task Scheduler adapters
- `application`: arm, status/disarm, and worker orchestration
- `cli-core`: parsing and presentation

Production dependencies are intentionally zero. Native commands are executed
with argv arrays and never through a shell.

## State mutation exclusion

The state store publishes a prepared, nonempty lock directory with one unique
PID/UUID marker. Only a definitely absent PID is recoverable; removal targets
that exact marker and uses nonrecursive directory removal. The permanent
legacy-path protocol file fences out previous immutable workers. See the
[state lock guide](state-lock.md) for busy responses and the required upgrade
transition. The JSON state schema, persisted attempt UUID, and consume ordering
are unchanged.
