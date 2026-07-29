import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { accountFingerprint } from "../codex/account.js";
import { AppServerClient } from "../codex/app-server-client.js";
import type {
  ConsumeOutcome,
  InstallState,
  RateLimitsSnapshot,
  ResetPlan,
} from "../domain/types.js";
import {
  applyConsumeOutcome,
  beginAttempt,
  recordAttemptSent,
  reconcileSettling,
} from "../domain/state-machine.js";
import { SafetyError } from "../domain/errors.js";
import { appendAuditEvent, type AuditEvent } from "../persistence/audit-log.js";
import { managedPaths, type ManagedPaths } from "../persistence/paths.js";
import { StateStore, type LockedState } from "../persistence/state-store.js";
import { hashDirectory } from "../runtime/installer.js";

export type WorkerClient = Readonly<{
  readAccount: AppServerClient["readAccount"];
  readRateLimits: AppServerClient["readRateLimits"];
  consumeExactCredit: AppServerClient["consumeExactCredit"];
  close: AppServerClient["close"];
}>;

export type WorkerDependencies = Readonly<{
  paths: ManagedPaths;
  store: StateStore;
  connect: (plan: ResetPlan) => Promise<WorkerClient>;
  runtimeHash: () => Promise<string>;
  now: () => Date;
}>;

export type WorkerResult = Readonly<{
  planId: string;
  selector: string;
  status: string;
  event: string;
}>;

function defaults(): WorkerDependencies {
  const paths = managedPaths();
  return {
    paths,
    store: new StateStore(paths),
    connect: async (plan) =>
      AppServerClient.connect({
        executable: plan.codexExecutable,
        arguments: ["app-server", "--stdio"],
        environment: { ...process.env, CODEX_HOME: plan.codexHome },
        deadlineAtEpochMilliseconds: Date.now() + 43_000,
      }),
    runtimeHash: () =>
      hashDirectory(dirname(dirname(fileURLToPath(import.meta.url)))),
    now: () => new Date(),
  };
}

export async function runWorker(
  planId: string,
  dependencies = defaults(),
): Promise<WorkerResult> {
  return dependencies.store.withLock(async (locked) => {
    let state = locked.get();
    let plan = findPlan(state, planId);
    const now = dependencies.now();
    const nowSeconds = Math.floor(now.getTime() / 1_000);
    if (
      ["succeeded", "expired", "unavailable", "disarmed", "paused"].includes(
        plan.status,
      )
    ) {
      return result(plan, "terminal-noop");
    }
    if (plan.scheduler.platform !== dependencies.paths.platform) {
      plan = await savePlan(locked, state, plan, {
        ...plan,
        status: "paused",
        terminalReason: "scheduler_platform_mismatch",
        updatedAt: now.toISOString(),
      });
      return result(plan, "scheduler-platform-mismatch");
    }
    if ((await dependencies.runtimeHash()) !== plan.runtimeSha256) {
      plan = await savePlan(locked, state, plan, {
        ...plan,
        status: "paused",
        terminalReason: "runtime_hash_mismatch",
        updatedAt: now.toISOString(),
      });
      return result(plan, "runtime-mismatch");
    }

    const client = await dependencies.connect(plan);
    try {
      const account = await client.readAccount();
      if (
        accountFingerprint(account, state.accountSalt) !==
        plan.accountFingerprint
      ) {
        plan = await savePlan(locked, state, plan, {
          ...plan,
          status: "paused",
          terminalReason: "account_changed",
          updatedAt: now.toISOString(),
        });
        return result(plan, "account-mismatch");
      }

      if (plan.status === "settling") {
        const snapshot = await client.readRateLimits();
        const reconciled = reconcileAfterSnapshot(plan, snapshot, now);
        if (reconciled !== plan)
          plan = await savePlan(locked, state, plan, reconciled);
        return result(plan, "settling-reconciled");
      }

      if (nowSeconds >= plan.expiresAt) {
        if (plan.status === "attempting") {
          const snapshot = await client.readRateLimits();
          const reconciled = reconcileAfterSnapshot(
            { ...plan, status: "settling" },
            snapshot,
            now,
          );
          plan = await savePlan(
            locked,
            state,
            plan,
            reconciled.status === "succeeded"
              ? reconciled
              : {
                  ...plan,
                  status: "expired",
                  terminalReason: "deadline_passed",
                  updatedAt: now.toISOString(),
                },
          );
        } else {
          plan = await savePlan(locked, state, plan, {
            ...plan,
            status: "expired",
            terminalReason: "deadline_passed",
            updatedAt: now.toISOString(),
          });
        }
        return result(plan, "expired-noop");
      }
      if (plan.status === "armed" && nowSeconds < plan.notBefore)
        return result(plan, "too-early-noop");

      if (plan.status === "armed") {
        const snapshot = await client.readRateLimits();
        const target = exactTarget(snapshot, plan);
        if (target === "incomplete")
          return result(plan, "details-incomplete-noop");
        if (target === null) {
          plan = await savePlan(locked, state, plan, {
            ...plan,
            status: "unavailable",
            terminalReason: "target_unavailable",
            updatedAt: now.toISOString(),
          });
          return result(plan, "target-unavailable");
        }
        if (
          target.status !== "available" ||
          target.resetType !== "codexRateLimits" ||
          target.expiresAt !== plan.expiresAt
        ) {
          plan = await savePlan(locked, state, plan, {
            ...plan,
            status: "paused",
            terminalReason: "target_mismatch",
            updatedAt: now.toISOString(),
          });
          return result(plan, "target-mismatch");
        }
        const attemptTime = dependencies.now();
        if (Math.floor(attemptTime.getTime() / 1_000) >= plan.expiresAt) {
          plan = await savePlan(locked, state, plan, {
            ...plan,
            status: "expired",
            terminalReason: "deadline_passed",
            updatedAt: attemptTime.toISOString(),
          });
          return result(plan, "expired-before-attempt");
        }
        const attempting = recordAttemptSent(
          beginAttempt(plan, attemptTime),
          attemptTime,
        );
        plan = await savePlan(locked, state, plan, attempting);
        state = locked.get();
      }

      const attempt = plan.attempt;
      if (plan.status !== "attempting" || attempt === null)
        return result(plan, "state-noop");
      const sendTime = dependencies.now();
      if (Math.floor(sendTime.getTime() / 1_000) >= plan.expiresAt) {
        const snapshot = await client.readRateLimits();
        const reconciled = reconcileAfterSnapshot(
          { ...plan, status: "settling" },
          snapshot,
          sendTime,
        );
        plan = await savePlan(
          locked,
          state,
          plan,
          reconciled.status === "succeeded"
            ? reconciled
            : {
                ...plan,
                status: "expired",
                terminalReason: "deadline_passed",
                updatedAt: sendTime.toISOString(),
              },
        );
        return result(plan, "expired-before-consume");
      }
      let outcome: ConsumeOutcome;
      try {
        outcome = await client.consumeExactCredit(
          plan.creditId,
          attempt.idempotencyKey,
        );
      } catch (error) {
        await audit(
          dependencies,
          plan,
          "consume-ambiguous",
          undefined,
          "consume_failed",
        );
        throw error;
      }
      const transitioned = applyConsumeOutcome(plan, outcome, now);
      plan = await savePlan(locked, state, plan, transitioned);
      state = locked.get();
      const after = await client.readRateLimits();
      plan = await reconcileOutcome(locked, state, plan, outcome, after, now);
      await audit(dependencies, plan, "consume-result", outcome);
      return result(plan, "consume-result");
    } finally {
      await client.close();
    }
  });
}

async function reconcileOutcome(
  locked: LockedState,
  state: InstallState,
  plan: ResetPlan,
  outcome: ConsumeOutcome,
  snapshot: RateLimitsSnapshot,
  now: Date,
): Promise<ResetPlan> {
  if (outcome === "reset" || outcome === "alreadyRedeemed") {
    const reconciled = reconcileAfterSnapshot(plan, snapshot, now);
    return reconciled === plan
      ? plan
      : savePlan(locked, state, plan, reconciled);
  }
  const target = exactTarget(snapshot, plan);
  if (outcome === "nothingToReset") {
    if (target === null) {
      return savePlan(locked, state, plan, {
        ...plan,
        status: "unavailable",
        terminalReason: "target_unavailable_after_deferral",
        updatedAt: now.toISOString(),
      });
    }
    return plan;
  }
  if (target !== null && target !== "incomplete") {
    return savePlan(locked, state, plan, {
      ...plan,
      status: "paused",
      terminalReason: "backend_no_credit_contradiction",
      updatedAt: now.toISOString(),
    });
  }
  return plan;
}

function reconcileAfterSnapshot(
  plan: ResetPlan,
  snapshot: RateLimitsSnapshot,
  now: Date,
): ResetPlan {
  const target = exactTarget(snapshot, plan);
  if (target === "incomplete" || target !== null) return plan;
  return reconcileSettling(plan, false, now);
}

function exactTarget(
  snapshot: RateLimitsSnapshot,
  plan: ResetPlan,
): ResetCreditLike | null | "incomplete" {
  const summary = snapshot.resetCredits;
  if (summary?.credits === null || summary === null) return "incomplete";
  const target = summary.credits.find((credit) => credit.id === plan.creditId);
  if (target !== undefined) return target;
  return summary.detailsComplete ? null : "incomplete";
}

type ResetCreditLike = NonNullable<
  NonNullable<RateLimitsSnapshot["resetCredits"]>["credits"]
>[number];

async function savePlan(
  locked: LockedState,
  state: InstallState,
  previous: ResetPlan,
  next: ResetPlan,
): Promise<ResetPlan> {
  const plans = state.plans.map((plan) =>
    plan.planId === previous.planId ? next : plan,
  );
  await locked.save({ ...state, revision: state.revision + 1, plans });
  return next;
}

function findPlan(state: InstallState, planId: string): ResetPlan {
  const matches = state.plans.filter((plan) => plan.planId === planId);
  if (matches.length !== 1)
    throw new SafetyError("Exact plan ID was not found.", "invalid_plan");
  const match = matches.at(0);
  if (match === undefined)
    throw new SafetyError("Exact plan ID was not found.", "invalid_plan");
  return match;
}

function result(plan: ResetPlan, event: string): WorkerResult {
  return {
    planId: plan.planId,
    selector: plan.creditSelector,
    status: plan.status,
    event,
  };
}

async function audit(
  dependencies: WorkerDependencies,
  plan: ResetPlan,
  event: AuditEvent["event"],
  outcome?: ConsumeOutcome,
  errorCode?: string,
): Promise<void> {
  await appendAuditEvent(dependencies.paths.auditLog, {
    timestamp: dependencies.now().toISOString(),
    event,
    planSelector: plan.creditSelector,
    status: plan.status,
    ...(outcome === undefined ? {} : { outcome }),
    ...(errorCode === undefined ? {} : { errorCode }),
  });
}
