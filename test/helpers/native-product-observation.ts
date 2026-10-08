import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// White-box test observation of product storage, separate from fake API behavior.
// Read synchronously at the consume request boundary, never after its response.
export function observeConsumeAtRequest(
  productStateFile: string,
  message: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (message.method !== "account/rateLimitResetCredit/consume") return;
  const params = message.params as { creditId: string; idempotencyKey: string };
  const state = JSON.parse(readFileSync(productStateFile, "utf8")) as {
    plans: {
      planId: string;
      status: string;
      creditId: string;
      attempt: { idempotencyKey: string } | null;
    }[];
  };
  const plan = state.plans.find((p) => p.creditId === params.creditId);
  if (
    plan?.status !== "attempting" ||
    plan.attempt?.idempotencyKey !== params.idempotencyKey
  )
    throw new Error(
      "Consume observation requires the matching UUID already persisted.",
    );
  return {
    persistedAttempt: {
      planId: plan.planId,
      status: plan.status,
      creditId: plan.creditId,
      idempotencyKey: plan.attempt.idempotencyKey,
    },
  };
}

type Event = { event: string; status?: string; outcome?: string };
export function assertProductLogEvents(
  events: readonly Event[],
  consumed: boolean,
): void {
  const armed = events.filter((e) => e.event === "plan-armed");
  const results = events.filter((e) => e.event === "consume-result");
  assert.equal(armed.length, 1);
  const arm = armed[0];
  assert.ok(arm);
  assert.equal(arm.status, "armed");
  assert.equal(results.length, consumed ? 1 : 0);
  if (consumed) {
    const result = results[0];
    assert.ok(result);
    assert.ok(events.indexOf(arm) < events.indexOf(result));
    assert.equal(result.status, "succeeded");
    assert.equal(result.outcome, "reset");
  }
}
