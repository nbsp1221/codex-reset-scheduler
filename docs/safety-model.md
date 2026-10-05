# Safety model

## Authorization

One plan authorizes one exact currently detailed reset credit. `arm --all`
creates several such plans; it does not create a count-based or future-credit
authorization.

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
account, runtime, target, or protocol mismatch.

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
