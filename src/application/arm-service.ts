import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { accountFingerprint } from "../codex/account.js";
import { connectLiveCodex } from "../codex/live.js";
import type { ChatgptAccount, RateLimitsSnapshot } from "../domain/types.js";
import { SafetyError } from "../domain/errors.js";
import {
  buildTriggerPlan,
  creditSelector,
  eligibleCredits,
  selectCredit,
} from "../domain/policy.js";
import type { InstallState, ResetCredit, ResetPlan } from "../domain/types.js";
import { appendAuditEvent } from "../persistence/audit-log.js";
import {
  defaultCodexHome,
  managedPaths,
  type ManagedPaths,
} from "../persistence/paths.js";
import { StateStore } from "../persistence/state-store.js";
import {
  installRuntimeSnapshot,
  type RuntimeSnapshot,
} from "../runtime/installer.js";
import { schedulerAdapter } from "../scheduler/index.js";
import type {
  ExecSpec,
  SchedulerAdapter,
  SchedulerPreview,
} from "../scheduler/types.js";

export type ArmOptions = Readonly<{
  selector?: string;
  all: boolean;
  beforeSeconds: number;
  dryRun: boolean;
}>;

export type ArmResult = Readonly<{
  dryRun: boolean;
  plans: readonly Readonly<{
    planId: string;
    selector: string;
    expiresAt: string;
    triggerTimes: readonly string[];
    scheduler: string;
  }>[];
  previews: readonly SchedulerPreview[];
}>;

export type ArmDependencies = Readonly<{
  paths: ManagedPaths;
  store: StateStore;
  scheduler: SchedulerAdapter;
  connect: () => Promise<ArmLiveCodex>;
  installRuntime: (paths: ManagedPaths) => Promise<RuntimeSnapshot>;
  now: () => Date;
  nodeExecutable: string;
  codexHome: string;
  home: string;
  confirm?: (preview: ArmResult) => Promise<void>;
}>;

export type ArmLiveCodex = Readonly<{
  executable: string;
  version: string;
  client: Readonly<{
    readAccount(): Promise<ChatgptAccount>;
    readRateLimits(): Promise<RateLimitsSnapshot>;
    close(): Promise<void>;
  }>;
}>;

export function defaultArmDependencies(): ArmDependencies {
  const paths = managedPaths();
  return {
    paths,
    store: new StateStore(paths),
    scheduler: schedulerAdapter(paths),
    connect: connectLiveCodex,
    installRuntime: installRuntimeSnapshot,
    now: () => new Date(),
    nodeExecutable: process.execPath,
    codexHome: defaultCodexHome(),
    home: homedir(),
  };
}

export async function armResets(
  options: ArmOptions,
  dependencies = defaultArmDependencies(),
): Promise<ArmResult> {
  if (options.all && options.selector !== undefined) {
    throw new SafetyError(
      "Use either --all or --credit, not both.",
      "invalid_arguments",
    );
  }
  let live: ArmLiveCodex | undefined = await dependencies.connect();
  try {
    let [account, limits] = await Promise.all([
      live.client.readAccount(),
      live.client.readRateLimits(),
    ]);
    let now = dependencies.now();
    const nowSeconds = Math.floor(now.getTime() / 1_000);
    const eligible = eligibleCredits(
      limits.resetCredits?.credits ?? null,
      nowSeconds,
    );
    let selected = options.all
      ? eligible
      : [selectCredit(eligible, options.selector)];
    if (selected.length === 0) {
      throw new SafetyError(
        "No eligible detailed reset is available.",
        "no_eligible_reset",
      );
    }

    if (options.dryRun || dependencies.confirm !== undefined) {
      const syntheticRuntime: RuntimeSnapshot = {
        version: "current",
        sha256: "dry-run",
        directory: join(
          dependencies.paths.runtimeDirectory,
          "<version>-<sha256>",
        ),
        entrypoint: join(
          dependencies.paths.runtimeDirectory,
          "<version>-<sha256>",
          "cli.js",
        ),
      };
      const previewLive = live;
      const plans = selected.map((credit) =>
        makePlan({
          credit,
          accountFingerprint: "dry-run",
          runtime: syntheticRuntime,
          live: previewLive,
          now,
          beforeSeconds: options.beforeSeconds,
          dependencies,
        }),
      );
      const preview = result(
        true,
        plans,
        plans.map((plan) =>
          dependencies.scheduler.preview(
            plan,
            action(plan, syntheticRuntime, dependencies),
          ),
        ),
      );
      if (options.dryRun) return preview;

      // Keep approval private to this invocation; never resolve selectors again.
      const approved = selected.map((credit) => ({ ...credit }));
      const salt = randomUUID();
      const approvedAccount = accountFingerprint(account, salt);
      const approvedExecutable = live.executable;
      const approvedVersion = live.version;
      const approvedNode = dependencies.nodeExecutable;
      const approvedCodexHome = dependencies.codexHome;
      await dependencies.confirm?.(preview);

      const previous = live;
      live = undefined;
      await previous.client.close();
      live = await dependencies.connect();
      [account, limits] = await Promise.all([
        live.client.readAccount(),
        live.client.readRateLimits(),
      ]);
      now = dependencies.now();
      if (
        accountFingerprint(account, salt) !== approvedAccount ||
        live.executable !== approvedExecutable ||
        live.version !== approvedVersion ||
        dependencies.nodeExecutable !== approvedNode ||
        dependencies.codexHome !== approvedCodexHome
      ) {
        throw new SafetyError(
          "The account or runtime changed during confirmation; review and arm again.",
          "approval_context_changed",
        );
      }
      if (limits.resetCredits?.detailsComplete !== true) {
        throw new SafetyError(
          "Complete reset details are required after confirmation; review and arm again.",
          "approval_target_changed",
        );
      }
      const current = eligibleCredits(
        limits.resetCredits.credits,
        Math.floor(now.getTime() / 1_000),
      );
      const approvedIds = new Set(approved.map((credit) => credit.id));
      selected = approved.map((credit) => {
        const matches = current.filter(
          (candidate) => candidate.id === credit.id,
        );
        const match = matches[0];
        if (
          approvedIds.size !== approved.length ||
          matches.length !== 1 ||
          match?.grantedAt !== credit.grantedAt ||
          match.expiresAt !== credit.expiresAt ||
          credit.expiresAt === null
        ) {
          throw new SafetyError(
            "An approved reset changed or is unavailable; review and arm again.",
            "approval_target_changed",
          );
        }
        // Recheck scheduler timing after the prompt, before any state writes.
        const trigger = buildTriggerPlan({
          expiresAt: credit.expiresAt,
          beforeSeconds: options.beforeSeconds,
          nowSeconds: Math.floor(now.getTime() / 1_000),
        });
        normalizeTriggerTimes(
          dependencies.paths.platform,
          trigger.triggerTimes,
          trigger.expiresAt,
        );
        return credit;
      });
    }

    const armedLive = live;
    const initial = await dependencies.store.initialize();
    const fingerprint = accountFingerprint(account, initial.accountSalt);
    const runtime = await dependencies.installRuntime(dependencies.paths);
    const plans = selected.map((credit) =>
      makePlan({
        credit,
        accountFingerprint: fingerprint,
        runtime,
        live: armedLive,
        now,
        beforeSeconds: options.beforeSeconds,
        dependencies,
      }),
    );

    await dependencies.store.withLock(async (locked) => {
      const state = locked.get();
      const activeIds = new Set(
        state.plans
          .filter((plan) =>
            ["armed", "attempting", "settling", "paused"].includes(plan.status),
          )
          .map((plan) => plan.creditId),
      );
      if (plans.some((plan) => activeIds.has(plan.creditId))) {
        throw new SafetyError(
          "A selected reset already has an active plan.",
          "already_armed",
        );
      }
      await locked.save({
        ...state,
        revision: state.revision + 1,
        plans: [...state.plans, ...plans],
      });
    });

    try {
      for (const plan of plans) {
        await dependencies.scheduler.install(
          plan,
          action(plan, runtime, dependencies),
        );
        await appendAuditEvent(dependencies.paths.auditLog, {
          timestamp: dependencies.now().toISOString(),
          event: "plan-armed",
          planSelector: plan.creditSelector,
          status: "armed",
        });
      }
    } catch (error) {
      // An adapter may fail after writing an artifact but before returning.
      // Remove every intended plan, including the currently failing one.
      await Promise.allSettled(
        plans.map((plan) => dependencies.scheduler.remove(plan)),
      );
      await pausePlans(
        dependencies.store,
        plans,
        "scheduler_install_failed",
        dependencies.now(),
      );
      throw error;
    }
    return result(
      false,
      plans,
      plans.map((plan) =>
        dependencies.scheduler.preview(
          plan,
          action(plan, runtime, dependencies),
        ),
      ),
    );
  } finally {
    await live?.client.close();
  }
}

function makePlan(options: {
  credit: ResetCredit;
  accountFingerprint: string;
  runtime: RuntimeSnapshot;
  live: ArmLiveCodex;
  now: Date;
  beforeSeconds: number;
  dependencies: ArmDependencies;
}): ResetPlan {
  const expiresAt = options.credit.expiresAt;
  if (expiresAt === null)
    throw new SafetyError(
      "A reset without expiry cannot be armed.",
      "missing_expiry",
    );
  const trigger = buildTriggerPlan({
    expiresAt,
    beforeSeconds: options.beforeSeconds,
    nowSeconds: Math.floor(options.now.getTime() / 1_000),
  });
  const planId = randomUUID();
  const triggerTimes = normalizeTriggerTimes(
    options.dependencies.paths.platform,
    trigger.triggerTimes,
    expiresAt,
  );
  return {
    planId,
    status: "armed",
    creditId: options.credit.id,
    creditSelector: creditSelector(options.credit.id),
    resetType: "codexRateLimits",
    grantedAt: options.credit.grantedAt,
    expiresAt,
    notBefore: trigger.notBefore,
    accountFingerprint: options.accountFingerprint,
    runtimeVersion: options.runtime.version,
    runtimeSha256: options.runtime.sha256,
    codexExecutable: options.live.executable,
    codexVersionAtArm: options.live.version,
    codexHome: options.dependencies.codexHome,
    attempt: null,
    scheduler: {
      platform: options.dependencies.paths.platform,
      artifactId: planId,
      triggerTimesUtc: triggerTimes.map((time) =>
        new Date(time * 1_000).toISOString(),
      ),
    },
    terminalReason: null,
    createdAt: options.now.toISOString(),
    updatedAt: options.now.toISOString(),
  };
}

function normalizeTriggerTimes(
  platform: ManagedPaths["platform"],
  triggerTimes: readonly number[],
  expiresAt: number,
): readonly number[] {
  if (platform !== "launchd") return triggerTimes;
  const rounded = triggerTimes
    .map((time) => Math.ceil(time / 60) * 60)
    .filter((time) => time < expiresAt - 30);
  const unique = [...new Set(rounded)].toSorted((left, right) => left - right);
  if (unique.length === 0) {
    throw new SafetyError(
      "No safe minute-resolution launchd trigger remains.",
      "no_safe_trigger",
    );
  }
  return unique;
}

function action(
  plan: ResetPlan,
  runtime: RuntimeSnapshot,
  dependencies: ArmDependencies,
): ExecSpec {
  return {
    command: dependencies.nodeExecutable,
    arguments: [runtime.entrypoint, "__worker", "--plan", plan.planId],
    environment: {
      HOME: dependencies.home,
      CODEX_HOME: dependencies.codexHome,
      PATH: minimalSchedulerPath(
        dependencies.nodeExecutable,
        plan.codexExecutable,
      ),
    },
    stateDirectory: dependencies.paths.stateDirectory,
    codexHome: dependencies.codexHome,
    stdoutPath: join(
      dependencies.paths.logDirectory,
      `${plan.planId}.stdout.log`,
    ),
    stderrPath: join(
      dependencies.paths.logDirectory,
      `${plan.planId}.stderr.log`,
    ),
  };
}

function minimalSchedulerPath(
  nodeExecutable: string,
  codexExecutable: string,
): string {
  const directories = [dirname(nodeExecutable), dirname(codexExecutable)];
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    directories.push(join(systemRoot, "System32"), systemRoot);
  } else directories.push("/usr/local/bin", "/usr/bin", "/bin");
  return [...new Set(directories)].join(delimiter);
}

function result(
  dryRun: boolean,
  plans: readonly ResetPlan[],
  previews: readonly SchedulerPreview[],
): ArmResult {
  return {
    dryRun,
    plans: plans.map((plan) => ({
      planId: plan.planId,
      selector: plan.creditSelector,
      expiresAt: new Date(plan.expiresAt * 1_000).toISOString(),
      triggerTimes: plan.scheduler.triggerTimesUtc,
      scheduler: plan.scheduler.platform,
    })),
    previews,
  };
}

async function pausePlans(
  store: StateStore,
  plans: readonly ResetPlan[],
  reason: string,
  now: Date,
): Promise<void> {
  const ids = new Set(plans.map((plan) => plan.planId));
  await store.withLock(async (locked) => {
    const state = locked.get();
    const next: InstallState = {
      ...state,
      revision: state.revision + 1,
      plans: state.plans.map((plan) =>
        ids.has(plan.planId)
          ? {
              ...plan,
              status: "paused",
              terminalReason: reason,
              updatedAt: now.toISOString(),
            }
          : plan,
      ),
    };
    await locked.save(next);
  });
}
