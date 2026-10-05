import { lstat, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { SafetyError } from "../domain/errors.js";
import { disarmPlan } from "../domain/state-machine.js";
import type { ResetPlan } from "../domain/types.js";
import { managedPaths, type ManagedPaths } from "../persistence/paths.js";
import { StateStore } from "../persistence/state-store.js";
import { decodeAuditEvent } from "../persistence/audit-log.js";
import { schedulerAdapter } from "../scheduler/index.js";
import type { SchedulerAdapter } from "../scheduler/types.js";

export type OperationsDependencies = Readonly<{
  paths: ManagedPaths;
  store: StateStore;
  scheduler: SchedulerAdapter;
  now: () => Date;
}>;

function defaults(): OperationsDependencies {
  const paths = managedPaths();
  return {
    paths,
    store: new StateStore(paths),
    scheduler: schedulerAdapter(paths),
    now: () => new Date(),
  };
}

export async function planStatus(
  selector?: string,
  dependencies = defaults(),
): Promise<unknown> {
  const state = await dependencies.store.load();
  if (state === null) return { initialized: false, plans: [] };
  const selected =
    selector === undefined ? state.plans : selectOne(state.plans, selector);
  const plans = await Promise.all(
    selected.map(async (plan) => {
      const scheduler = await dependencies.scheduler.inspect(plan);
      return {
        planId: plan.planId,
        selector: plan.creditSelector,
        status: plan.status,
        expiresAt: new Date(plan.expiresAt * 1_000).toISOString(),
        scheduler,
        terminalReason: plan.terminalReason,
      };
    }),
  );
  return { initialized: true, revision: state.revision, plans };
}

export async function disarmPlans(
  options: { plan?: string; all: boolean; dryRun: boolean },
  dependencies = defaults(),
): Promise<unknown> {
  if (options.plan !== undefined && options.all) {
    throw new SafetyError(
      "Use either --plan or --all, not both.",
      "invalid_arguments",
    );
  }
  const state = await dependencies.store.load();
  if (state === null)
    throw new SafetyError(
      "codex-reset-scheduler is not initialized.",
      "not_initialized",
    );
  const targets = selectPlans(state.plans, options.plan, options.all);
  if (options.dryRun) {
    return { dryRun: true, plans: targets.map(sanitizedPlan) };
  }
  const targetIds = new Set(targets.map((plan) => plan.planId));
  await dependencies.store.withLock(async (locked) => {
    const current = locked.get();
    const plans = current.plans.map((plan) =>
      targetIds.has(plan.planId) ? disarmPlan(plan, dependencies.now()) : plan,
    );
    await locked.save({ ...current, revision: current.revision + 1, plans });
  });
  for (const plan of targets) await dependencies.scheduler.remove(plan);
  return { dryRun: false, plans: targets.map(sanitizedPlan) };
}

export async function readAuditLog(
  selector?: string,
  dependencies = defaults(),
): Promise<unknown> {
  try {
    let planSelector: string | undefined;
    if (selector !== undefined) {
      const state = await dependencies.store.load();
      if (state === null)
        throw new SafetyError(
          "codex-reset-scheduler is not initialized.",
          "not_initialized",
        );
      planSelector = selectOne(state.plans, selector)[0]?.creditSelector;
    }
    const contents = await Promise.all([
      readLogFile(`${dependencies.paths.auditLog}.1`),
      readLogFile(dependencies.paths.auditLog),
    ]);
    const lines = contents
      .flatMap((content) => content.split("\n"))
      .filter((line) => line.length > 0)
      .map((line) => decodeAuditEvent(JSON.parse(line) as unknown))
      .filter(
        (event) =>
          planSelector === undefined || event.planSelector === planSelector,
      );
    return { events: lines };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { events: [] };
    throw error;
  }
}

async function readLogFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export async function garbageCollect(
  dryRun: boolean,
  dependencies = defaults(),
): Promise<unknown> {
  const state = await dependencies.store.load();
  if (state === null)
    return { dryRun, removedSchedulers: [], removedRuntimes: [] };
  const terminal = state.plans.filter((plan) =>
    ["succeeded", "expired", "unavailable", "disarmed"].includes(plan.status),
  );
  if (!dryRun) {
    for (const plan of terminal) await dependencies.scheduler.remove(plan);
    for (const plan of terminal) {
      await Promise.all([
        rm(join(dependencies.paths.logDirectory, `${plan.planId}.stdout.log`), {
          force: true,
        }),
        rm(join(dependencies.paths.logDirectory, `${plan.planId}.stderr.log`), {
          force: true,
        }),
      ]);
    }
  }
  const activeRuntimeNames = new Set(
    state.plans
      .filter((plan) =>
        ["armed", "attempting", "settling", "paused"].includes(plan.status),
      )
      .map((plan) => `${plan.runtimeVersion}-${plan.runtimeSha256}`),
  );
  const removedRuntimes = await unreferencedRuntimes(
    dependencies.paths.runtimeDirectory,
    activeRuntimeNames,
  );
  if (!dryRun) {
    for (const runtime of removedRuntimes) {
      await rm(join(dependencies.paths.runtimeDirectory, runtime), {
        recursive: true,
        force: true,
      });
    }
  }
  return {
    dryRun,
    removedSchedulers: terminal.map((plan) => plan.planId),
    removedRuntimes,
  };
}

async function unreferencedRuntimes(
  directory: string,
  active: ReadonlySet<string>,
): Promise<readonly string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const candidates: string[] = [];
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        !/^[A-Za-z0-9._+-]+-[a-f0-9]{64}$/u.test(entry.name) ||
        active.has(entry.name)
      )
        continue;
      const metadata = await lstat(join(directory, entry.name));
      if (metadata.isDirectory() && !metadata.isSymbolicLink())
        candidates.push(entry.name);
    }
    return candidates.toSorted();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function selectPlans(
  plans: readonly ResetPlan[],
  selector: string | undefined,
  all: boolean,
): readonly ResetPlan[] {
  if (all)
    return plans.filter(
      (plan) => !["disarmed", "succeeded", "expired"].includes(plan.status),
    );
  if (selector === undefined) {
    throw new SafetyError("Specify --plan or --all.", "missing_plan_selector");
  }
  const matches = plans.filter(
    (plan) => plan.planId === selector || plan.creditSelector === selector,
  );
  if (matches.length !== 1)
    throw new SafetyError(
      "Plan selector was not found or ambiguous.",
      "invalid_plan",
    );
  return matches;
}

function selectOne(
  plans: readonly ResetPlan[],
  selector: string,
): readonly ResetPlan[] {
  const matches = plans.filter(
    (plan) => plan.planId === selector || plan.creditSelector === selector,
  );
  if (matches.length !== 1)
    throw new SafetyError(
      "Plan selector was not found or ambiguous.",
      "invalid_plan",
    );
  return matches;
}

function sanitizedPlan(plan: ResetPlan): unknown {
  return {
    planId: plan.planId,
    selector: plan.creditSelector,
    status: plan.status,
  };
}
