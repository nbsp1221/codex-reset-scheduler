import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTriggerPlan,
  creditSelector,
  eligibleCredits,
  parseDurationSeconds,
  selectCredit,
} from "../../src/domain/policy.js";
import type { ResetCredit } from "../../src/domain/types.js";

function credit(overrides: Partial<ResetCredit> = {}): ResetCredit {
  return {
    id: "synthetic-credit-a",
    resetType: "codexRateLimits",
    status: "available",
    grantedAt: 1_000,
    expiresAt: 10_000,
    title: null,
    description: null,
    ...overrides,
  };
}

test("eligible credits are exact, available, unexpired Codex resets sorted by expiry", () => {
  const result = eligibleCredits(
    [
      credit({ id: "later", expiresAt: 9_000 }),
      credit({ id: "wrong-type", resetType: "unknown", expiresAt: 7_000 }),
      credit({ id: "expired", expiresAt: 4_000 }),
      credit({ id: "earlier", expiresAt: 8_000 }),
    ],
    5_000,
  );
  assert.deepEqual(
    result.map((item) => item.id),
    ["earlier", "later"],
  );
});

test("duration parser enforces the safety range", () => {
  assert.equal(parseDurationSeconds("10m"), 600);
  assert.throws(() => parseDurationSeconds("90s"), /between 2m and 7d/);
  assert.throws(() => parseDurationSeconds("1.5h"), /integer/);
});

test("trigger plan adds an OS-scheduled immediate trigger inside the window", () => {
  const result = buildTriggerPlan({
    expiresAt: 10_000,
    beforeSeconds: 600,
    nowSeconds: 9_500,
  });
  assert.equal(result.immediate, true);
  assert.ok(result.triggerTimes.includes(9_505));
  assert.ok(result.triggerTimes.every((time) => time < 9_970));
});

test("trigger plan rejects deadlines too close for the scheduler", () => {
  assert.throws(
    () =>
      buildTriggerPlan({
        expiresAt: 1_025,
        beforeSeconds: 600,
        nowSeconds: 1_000,
      }),
    /expires too soon/,
  );
});

test("selectors do not expose raw IDs and resolve exactly one credit", () => {
  const target = credit();
  const selector = creditSelector(target.id);
  assert.equal(selector.length, 12);
  assert.equal(selectCredit([target], selector), target);
  assert.throws(() => selectCredit([target], "missing"), /not found/);
});
