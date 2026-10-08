# State lock and recovery

State-writing commands and workers share one state lock. A worker holds it
through account checks, persistence of the attempt UUID, the exact-credit
request, and its follow-up read. A slow app-server can therefore delay other
mutations. After five seconds, a competing command returns `state_locked`; retry
after the worker finishes. `status` reads state without this lock. A status
snapshot is not proof that an irreversible request has completed.

`attempt_in_flight` is a separate refusal: a persisted ambiguous attempt cannot
be cancelled as though it never ran. Keep its UUID and state for reconciliation.
Do not delete state or edit an attempt to bypass either error.

## Lock protocol v2

The private state directory contains:

- `.lock`: a permanent regular file identifying protocol v2. Never delete it
  while this installation is in use. It prevents earlier immutable workers from
  acquiring their directory-based lock.
- `.lock.v2`: the active lock directory, published atomically with one completed
  `owner-v2.<pid>.<uuid>` marker. The marker's filename identifies its
  generation; its contents are not used for ownership.

Only a process probe reporting that the owner PID does not exist permits
recovery. File age never overrides a live PID, permission refusal, or unknown
probe error. PID reuse can delay recovery conservatively. Recovery unlinks only
the observed marker and then removes an empty directory nonrecursively. A late
reaper cannot delete the different marker of a new owner. An empty v2 directory
left during release is recoverable; a preparation directory left before publish
is never an active lock.

Unknown markers, extra entries, and legacy lock directories return
`state_lock_recovery_required`. Symlinks and junctions fail with a safety error.
They are not automatically deleted. The protocol requires a private local
filesystem with atomic same-directory rename and hard links. Network and
synchronised state directories are unsupported.

## Upgrading an existing installation

Installing a new CLI does not update the private runtimes in existing schedules.
When the permanent v2 file is absent, existing `armed`, `attempting`,
`settling`, or `paused` plans return `state_lock_migration_required` before a
protocol file is prepared or published. The command leaves state and native
registrations unchanged and directs you to the previous executable. Already
migrated v2 installations can continue using their own active plans.

This gate checks a snapshot of persisted plans; it cannot prove that all old
writers have exited or prevent an old writer from changing that snapshot during
the transition. Before the first mutating command with v2:

1. Use the previous executable's `status` and `logs` to review every plan.
   Resolve any in-flight or ambiguous attempt before proceeding; preserve its
   persisted UUID and result evidence.
2. Use that previous executable to disarm the existing plans. Check that native
   registrations were removed, and wait until all old workers and mutating CLI
   processes have exited. Do not run old and new writers concurrently during
   this transition.
3. If a legacy `.lock` directory remains, inspect it only after confirming the
   previous processes and schedules have stopped. Move that directory aside for
   diagnosis. Do not remove `state.json`, runtime snapshots, or audit logs.
4. Run the new CLI. The first mutation publishes the permanent `.lock` file.
   Inspect current visible credits and explicitly approve any new schedules; old
   schedules are not silently rebound or upgraded.

Definite rename collisions are retried within the same five-second budget,
including when the previous owner has already released the path. I/O and
permission errors are propagated. Windows can report `EPERM` for an existing
directory collision; it is considered contention only when that directory is
actually observed. A missing path does not turn `EPERM` into a retry.

An old worker that is triggered after v2 installation will stop with
`state_locked`. Its scheduled runtime still uses the previous protocol. Finish
the transition rather than removing the permanent fence to make it run.

For an unrecognised v2 lock, stop all writers and schedules before moving only
`.lock.v2` aside for diagnosis. Keep the permanent `.lock` file and state. A
manual repair while a worker is active can break mutual exclusion and is unsafe.
