import { randomUUID } from "node:crypto";

import { SafetyError } from "./errors.js";
import type { ConsumeOutcome, ResetPlan } from "./types.js";

function updated(
  plan: ResetPlan,
  patch: Partial<ResetPlan>,
  now: Date,
): ResetPlan {
  return { ...plan, ...patch, updatedAt: now.toISOString() };
}

export function beginAttempt(
  plan: ResetPlan,
  now: Date,
  idempotencyKey = randomUUID(),
): ResetPlan {
  if (plan.status === "attempting") return plan;
  if (plan.status !== "armed") {
    throw new SafetyError(
      `Cannot begin an attempt while plan is ${plan.status}.`,
      "invalid_transition",
    );
  }
  return updated(
    plan,
    {
      status: "attempting",
      attempt: {
        idempotencyKey,
        startedAt: now.toISOString(),
        lastTriedAt: null,
        tryCount: 0,
      },
    },
    now,
  );
}

export function recordAttemptSent(plan: ResetPlan, now: Date): ResetPlan {
  if (plan.status !== "attempting" || plan.attempt === null) {
    throw new SafetyError("No persisted attempt exists.", "invalid_transition");
  }
  return updated(
    plan,
    {
      attempt: {
        ...plan.attempt,
        lastTriedAt: now.toISOString(),
        tryCount: plan.attempt.tryCount + 1,
      },
    },
    now,
  );
}

export function applyConsumeOutcome(
  plan: ResetPlan,
  outcome: ConsumeOutcome,
  now: Date,
): ResetPlan {
  if (plan.status !== "attempting" || plan.attempt === null) {
    throw new SafetyError(
      "Consume outcome has no active attempt.",
      "invalid_transition",
    );
  }
  if (outcome === "reset" || outcome === "alreadyRedeemed") {
    return updated(plan, { status: "settling" }, now);
  }
  if (outcome === "nothingToReset") {
    return updated(plan, { status: "armed", attempt: null }, now);
  }
  return updated(
    plan,
    { status: "unavailable", terminalReason: "backend_no_credit" },
    now,
  );
}

export function reconcileSettling(
  plan: ResetPlan,
  targetStillAvailable: boolean,
  now: Date,
): ResetPlan {
  if (plan.status !== "settling") return plan;
  if (targetStillAvailable) return plan;
  return updated(
    plan,
    { status: "succeeded", terminalReason: "target_retired" },
    now,
  );
}

export function expirePlan(plan: ResetPlan, now: Date): ResetPlan {
  if (plan.status !== "armed") return plan;
  return updated(
    plan,
    { status: "expired", terminalReason: "deadline_passed" },
    now,
  );
}

export function disarmPlan(plan: ResetPlan, now: Date): ResetPlan {
  if (plan.status === "attempting") {
    throw new SafetyError(
      "Cannot disarm an attempt whose result may be ambiguous.",
      "attempt_in_flight",
    );
  }
  if (plan.status === "disarmed") return plan;
  return updated(
    plan,
    { status: "disarmed", terminalReason: "user_disarmed" },
    now,
  );
}
