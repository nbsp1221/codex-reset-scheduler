# Safety model

## Authorization

One plan authorizes one exact currently detailed reset credit. `arm --all`
creates several such plans; it does not create a count-based or future-credit
authorization.

Interactive arming keeps the reviewed exact credit IDs in memory until
confirmation. It then reconnects and checks the account, Codex executable and
version, credit details, and remaining scheduler time before writing state. New
credits are excluded; changed or missing approved credits require a new review.
This applies to `--all`, an explicit selector, and the default earliest expiry
selection. A separate `--dry-run` invocation does not grant approval to a later
command; `--yes` authorizes the selection visible to that invocation.

## State machine

```text
armed -> attempting -> settling -> succeeded
   |         |             |
   |         |             +-- wait for authoritative target retirement
   |         +-- ambiguous failure: remain attempting with same UUID
   |         +-- nothingToReset: armed, next attempt gets new UUID
   +-- expired / unavailable / disarmed / paused
```

`paused` means an operator must inspect a fail-closed condition such as an
account, runtime, target, or protocol mismatch. Pausing does not resolve a
persisted attempt. A paused plan with an attempt cannot be disarmed unless its
reason records the confirmed `noCredit` contradiction. The state format does not
distinguish whether older paused plans came from `attempting` or `settling`, so
these records are retained conservatively; restoring a safety gate does not
automatically resume a paused plan. There is currently no supported recovery
command for these paused attempts. Do not delete or edit their state to re-arm.

An exact credit ID with any retained attempt cannot be armed in another plan,
even after cancellation, success, expiry, or an unavailable result. This also
protects attempts already disarmed by older versions. Resolved `settling` and
terminal plans can still be disarmed and cleaned up, but cancellation never
authorizes a new UUID for that credit. Only a confirmed `nothingToReset` clears
the attempt, permitting a subsequent logical attempt or cancellation/re-arming.

## Outcome handling

| Outcome             | Handling                                                         |
| ------------------- | ---------------------------------------------------------------- |
| `reset`             | settle, then confirm target retirement with a fresh snapshot     |
| `alreadyRedeemed`   | idempotent success, then the same reconciliation                 |
| `nothingToReset`    | target remains armed; the next logical attempt uses a fresh UUID |
| `noCredit`          | reconcile; a contradictory visible target pauses the plan        |
| timeout, EOF, crash | retain `attempting` and the same UUID                            |
| unknown outcome     | fail as ambiguous; do not select another credit                  |

## Detail truncation

The backend may report an `availableCount` larger than the returned detail list.
codex-reset-scheduler never arms a count-only credit. If an already armed target
is absent from an incomplete snapshot, the worker waits rather than inferring
retirement.

## Time

UTC epoch seconds in the private plan are authoritative. Native scheduler events
are only delivery attempts. The worker refuses to consume before `notBefore` or
at and after expiry.
