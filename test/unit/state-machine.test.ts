import assert from "node:assert/strict";
import test from "node:test";

import {
  applyConsumeOutcome,
  beginAttempt,
  disarmPlan,
  reconcileSettling,
  recordAttemptSent,
} from "../../src/domain/state-machine.js";
import type { ResetPlan } from "../../src/domain/types.js";

function plan(): ResetPlan {
  return {
    planId: "plan-a",
    status: "armed",
    creditId: "synthetic-credit-a",
    creditSelector: "selector-a",
    resetType: "codexRateLimits",
    grantedAt: 1_000,
    expiresAt: 10_000,
    notBefore: 9_000,
    accountFingerprint: "account-a",
    runtimeVersion: "0.1.0",
    runtimeSha256: "a".repeat(64),
    codexExecutable: "/synthetic/codex",
    codexVersionAtArm: "codex-cli 1.0.0",
    codexHome: "/synthetic/.codex",
    attempt: null,
    scheduler: {
      platform: "systemd",
      artifactId: "artifact-a",
      triggerTimesUtc: [],
    },
    terminalReason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("ambiguous retries preserve one persisted attempt identity", () => {
  const now = new Date("2026-01-01T00:01:00.000Z");
  const attempting = beginAttempt(
    plan(),
    now,
    "00000000-0000-4000-8000-000000000001",
  );
  const sent = recordAttemptSent(attempting, now);
  const retried = beginAttempt(sent, new Date("2026-01-01T00:02:00.000Z"));
  assert.equal(
    retried.attempt?.idempotencyKey,
    attempting.attempt?.idempotencyKey,
  );
  assert.equal(sent.attempt?.tryCount, 1);
});

test("nothingToReset clears the attempt so the next logical attempt gets a fresh UUID", () => {
  const now = new Date("2026-01-01T00:01:00.000Z");
  const attempting = beginAttempt(
    plan(),
    now,
    "00000000-0000-4000-8000-000000000001",
  );
  const deferred = applyConsumeOutcome(attempting, "nothingToReset", now);
  assert.equal(deferred.status, "armed");
  assert.equal(deferred.attempt, null);
  const next = beginAttempt(
    deferred,
    now,
    "00000000-0000-4000-8000-000000000002",
  );
  assert.notEqual(
    next.attempt?.idempotencyKey,
    attempting.attempt?.idempotencyKey,
  );
});

test("success settles until a fresh snapshot retires the exact target", () => {
  const now = new Date("2026-01-01T00:01:00.000Z");
  const attempting = beginAttempt(plan(), now);
  const settling = applyConsumeOutcome(attempting, "reset", now);
  assert.equal(reconcileSettling(settling, true, now).status, "settling");
  assert.equal(reconcileSettling(settling, false, now).status, "succeeded");
});

test("disarm refuses an ambiguous in-flight attempt", () => {
  assert.throws(
    () => disarmPlan(beginAttempt(plan(), new Date()), new Date()),
    /Cannot disarm/,
  );
});
