import { parseArgs } from "node:util";

import type { ChatgptAccount, RateLimitsSnapshot } from "./domain/types.js";
import { ResetrailError, SafetyError } from "./domain/errors.js";
import {
  buildTriggerPlan,
  creditSelector,
  eligibleCredits,
  parseDurationSeconds,
  selectCredit,
} from "./domain/policy.js";
import { connectLiveCodex } from "./codex/live.js";
import { VERSION } from "./version.js";
import {
  armResets,
  defaultArmDependencies,
} from "./application/arm-service.js";
import {
  disarmPlans,
  garbageCollect,
  planStatus,
  readAuditLog,
} from "./application/plan-operations.js";
import { runWorker } from "./application/worker-service.js";
import {
  inspectSchedulerEnvironment,
  type DoctorSchedulerReport,
} from "./application/doctor-service.js";
import { createInterface } from "node:readline/promises";

export type ReadSession = Readonly<{
  executable: string;
  version: string;
  readAccount(): Promise<ChatgptAccount>;
  readRateLimits(): Promise<RateLimitsSnapshot>;
  close(): Promise<void>;
}>;

export type CliDependencies = Readonly<{
  connect: () => Promise<ReadSession>;
  now: () => Date;
  platform?: NodeJS.Platform;
  inspectScheduler?: () => Promise<DoctorSchedulerReport>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}>;

const defaultDependencies: CliDependencies = {
  connect: async () => {
    const live = await connectLiveCodex();
    return {
      executable: live.executable,
      version: live.version,
      readAccount: () => live.client.readAccount(),
      readRateLimits: () => live.client.readRateLimits(),
      close: () => live.client.close(),
    };
  },
  now: () => new Date(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export async function runCli(
  arguments_: readonly string[],
  dependencies: CliDependencies = defaultDependencies,
): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...arguments_],
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        timezone: { type: "string" },
        credit: { type: "string" },
        all: { type: "boolean", default: false },
        before: { type: "string", default: "10m" },
        "dry-run": { type: "boolean", default: false },
        yes: { type: "boolean", default: false },
        plan: { type: "string" },
      },
    });
  } catch (error) {
    return reportError(error, false, dependencies);
  }

  const command = parsed.positionals[0];
  const json = parsed.values.json === true;
  const timezone = stringOption(parsed.values.timezone);
  const selector = stringOption(parsed.values.credit);
  const all = parsed.values.all === true;
  const before = stringOption(parsed.values.before) ?? "10m";
  const dryRun = parsed.values["dry-run"] === true;
  const yes = parsed.values.yes === true;
  const planSelector = stringOption(parsed.values.plan);
  if (
    parsed.values.help === true ||
    command === undefined ||
    command === "help"
  ) {
    dependencies.stdout(helpText());
    return 0;
  }
  if (parsed.positionals.length > 1) {
    return reportError(
      new SafetyError("Unexpected positional arguments.", "invalid_arguments"),
      json,
      dependencies,
    );
  }

  try {
    switch (command) {
      case "version":
        output(command, { version: VERSION }, json, dependencies);
        return 0;
      case "doctor":
        return await doctor(json, dependencies);
      case "resets":
        return await resets(timezone, json, dependencies);
      case "plan":
        return await planCommand(
          {
            timezone,
            selector,
            all,
            before,
          },
          json,
          dependencies,
        );
      case "arm": {
        const armOptions = {
          ...(selector === undefined ? {} : { selector }),
          all,
          beforeSeconds: parseDurationSeconds(before),
          dryRun,
        };
        if (!dryRun && !yes && json) {
          throw new SafetyError(
            "Interactive arm cannot emit one stable JSON document; review --dry-run --json, then use --yes.",
            "confirmation_required",
            2,
          );
        }
        const armDependencies = defaultArmDependencies();
        const armed = await armResets(armOptions, {
          ...armDependencies,
          ...(!dryRun && !yes
            ? {
                confirm: async (preview) => {
                  output("arm", preview, json, dependencies);
                  await confirmArm(preview.plans.map((plan) => plan.selector));
                },
              }
            : {}),
        });
        output("arm", armed, json, dependencies);
        return 0;
      }
      case "status":
        output("status", await planStatus(planSelector), json, dependencies);
        return 0;
      case "disarm":
        if (!dryRun && !yes)
          await confirmText(
            "DISARM",
            "Type DISARM to remove the selected schedule: ",
          );
        output(
          "disarm",
          await disarmPlans({
            ...(planSelector === undefined ? {} : { plan: planSelector }),
            all,
            dryRun,
          }),
          json,
          dependencies,
        );
        return 0;
      case "logs":
        output("logs", await readAuditLog(planSelector), json, dependencies);
        return 0;
      case "gc":
        output("gc", await garbageCollect(dryRun), json, dependencies);
        return 0;
      case "__worker": {
        if (planSelector === undefined) {
          throw new SafetyError(
            "Internal worker requires an exact --plan ID.",
            "missing_plan_selector",
          );
        }
        output("__worker", await runWorker(planSelector), json, dependencies);
        return 0;
      }
      default:
        throw new SafetyError(
          `Unknown command: ${command}.`,
          "unknown_command",
        );
    }
  } catch (error) {
    return reportError(error, json, dependencies);
  }
}

export function armConfirmationPhrase(selectors: readonly string[]): string {
  return selectors.length === 1
    ? `ARM ${selectors[0]}`
    : `ARM ${selectors.length} RESETS`;
}

async function confirmArm(selectors: readonly string[]): Promise<void> {
  const expected = armConfirmationPhrase(selectors);
  await confirmText(expected, `Type ${expected} to create the schedule: `);
}

async function confirmText(expected: string, prompt: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new SafetyError(
      "Interactive confirmation requires a TTY; use --yes after review.",
      "confirmation_required",
      2,
    );
  }
  const input = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await input.question(prompt);
    if (answer !== expected)
      throw new SafetyError(
        "Confirmation did not match; no changes made.",
        "confirmation_failed",
        2,
      );
  } finally {
    input.close();
  }
}

function stringOption(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

async function doctor(
  json: boolean,
  dependencies: CliDependencies,
): Promise<number> {
  const session = await dependencies.connect();
  try {
    const [account, limits] = await Promise.all([
      session.readAccount(),
      session.readRateLimits(),
    ]);
    const scheduler = await (dependencies.inspectScheduler?.() ??
      inspectSchedulerEnvironment());
    const data = {
      ok: scheduler.ready,
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      codexExecutable: session.executable,
      codexVersion: session.version,
      accountType: account.type,
      accountPlan: account.planType,
      accountIdentityAvailable: account.email !== null,
      resetDetailsAvailable: limits.resetCredits?.credits !== null,
      resetDetailsComplete: limits.resetCredits?.detailsComplete ?? false,
      availableResetCount: limits.resetCredits?.availableCount ?? 0,
      scheduler,
    };
    output("doctor", data, json, dependencies);
    return scheduler.ready ? 0 : 1;
  } finally {
    await session.close();
  }
}

async function resets(
  timezone: string | undefined,
  json: boolean,
  dependencies: CliDependencies,
): Promise<number> {
  const zone = validateTimezone(timezone);
  const session = await dependencies.connect();
  try {
    const snapshot = await session.readRateLimits();
    const summary = snapshot.resetCredits;
    const credits = summary?.credits ?? [];
    const data = {
      timezone: zone,
      availableCount: summary?.availableCount ?? 0,
      detailsAvailable: summary?.credits !== null && summary !== null,
      detailsComplete: summary?.detailsComplete ?? false,
      resets: credits.map((credit) => ({
        selector: creditSelector(credit.id),
        status: credit.status,
        resetType: credit.resetType,
        grantedAt: new Date(credit.grantedAt * 1_000).toISOString(),
        expiresAt:
          credit.expiresAt === null
            ? null
            : new Date(credit.expiresAt * 1_000).toISOString(),
        expiresLocal:
          credit.expiresAt === null
            ? null
            : formatInstant(credit.expiresAt, zone),
      })),
    };
    output("resets", data, json, dependencies);
    return 0;
  } finally {
    await session.close();
  }
}

async function planCommand(
  options: {
    timezone: string | undefined;
    selector: string | undefined;
    all: boolean;
    before: string;
  },
  json: boolean,
  dependencies: CliDependencies,
): Promise<number> {
  if (options.all && options.selector !== undefined) {
    throw new SafetyError(
      "Use either --all or --credit, not both.",
      "invalid_arguments",
    );
  }
  const zone = validateTimezone(options.timezone);
  const beforeSeconds = parseDurationSeconds(options.before);
  const now = dependencies.now();
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  const session = await dependencies.connect();
  try {
    const snapshot = await session.readRateLimits();
    const eligible = eligibleCredits(
      snapshot.resetCredits?.credits ?? null,
      nowSeconds,
    );
    const chosen = options.all
      ? eligible
      : [selectCredit(eligible, options.selector)];
    const plans = chosen.map((credit) => {
      if (credit.expiresAt === null) {
        throw new SafetyError(
          "A reset without an expiry cannot be armed.",
          "missing_expiry",
        );
      }
      const trigger = buildTriggerPlan({
        expiresAt: credit.expiresAt,
        beforeSeconds,
        nowSeconds,
      });
      return {
        selector: creditSelector(credit.id),
        expiresAt: new Date(credit.expiresAt * 1_000).toISOString(),
        expiresLocal: formatInstant(credit.expiresAt, zone),
        notBefore: new Date(trigger.notBefore * 1_000).toISOString(),
        triggerTimes: trigger.triggerTimes.map((time) =>
          new Date(time * 1_000).toISOString(),
        ),
        immediateSchedulerTrigger: trigger.immediate,
        nativeScheduler: schedulerSummary(
          dependencies.platform ?? process.platform,
        ),
      };
    });
    output(
      "plan",
      {
        dryRun: true,
        timezone: zone,
        beforeSeconds,
        plannedResetCount: plans.length,
        plans,
      },
      json,
      dependencies,
    );
    return 0;
  } finally {
    await session.close();
  }
}

function validateTimezone(timezone: string | undefined): string {
  const zone = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(0);
  } catch {
    throw new SafetyError(
      `Invalid IANA timezone: ${zone}.`,
      "invalid_timezone",
    );
  }
  return zone;
}

function formatInstant(epochSeconds: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "shortOffset",
  }).format(new Date(epochSeconds * 1_000));
}

function output(
  command: string,
  data: unknown,
  json: boolean,
  dependencies: CliDependencies,
): void {
  if (json) {
    dependencies.stdout(
      `${JSON.stringify({ schemaVersion: 1, command, ok: true, data }, null, 2)}\n`,
    );
    return;
  }
  dependencies.stdout(`${renderHuman(command, data)}\n`);
}

function renderHuman(command: string, data: unknown): string {
  if (command === "version") return `codex-reset-scheduler ${VERSION}`;
  if (command === "doctor") {
    const value = data as Record<string, unknown> & {
      scheduler: DoctorSchedulerReport;
    };
    const warnings = value.scheduler.checks
      .filter((check) => !check.ok)
      .map(
        (check) =>
          `- ${check.name}${check.required ? " (required)" : " (advisory)"}: ${check.hint ?? "unavailable"}`,
      );
    return [
      `codex-reset-scheduler doctor: ${value.ok === true ? "OK" : "ATTENTION"}`,
      `Node: ${String(value.node)}`,
      `Platform: ${String(value.platform)} (${String(value.architecture)})`,
      `Codex: ${String(value.codexVersion)}`,
      `Reset details: ${value.resetDetailsAvailable === true ? "available" : "unavailable"}`,
      `Available resets: ${String(value.availableResetCount)}`,
      ...warnings,
    ].join("\n");
  }
  if (command === "resets") {
    const value = data as {
      availableCount: number;
      resets: { selector: string; expiresLocal: string | null }[];
    };
    const rows = value.resets.map(
      (reset) => `- ${reset.selector}: ${reset.expiresLocal ?? "no expiry"}`,
    );
    return [`Available resets: ${value.availableCount}`, ...rows].join("\n");
  }
  if (command === "plan") {
    const value = data as {
      plans: {
        selector: string;
        expiresLocal: string;
        triggerTimes: string[];
        nativeScheduler: string;
      }[];
    };
    const rows = value.plans.flatMap((plan) => [
      `- ${plan.selector}: expires ${plan.expiresLocal}`,
      `  scheduler ${plan.nativeScheduler}`,
      ...plan.triggerTimes.map((time) => `  trigger ${time}`),
    ]);
    return ["Dry-run plan (no changes):", ...rows].join("\n");
  }
  if (command === "arm") {
    const value = data as {
      dryRun: boolean;
      plans: { selector: string; expiresAt: string }[];
    };
    return [
      value.dryRun ? "Arm preview (no changes):" : "Armed reset schedules:",
      ...value.plans.map(
        (plan) => `- ${plan.selector}: expires ${plan.expiresAt}`,
      ),
    ].join("\n");
  }
  return JSON.stringify(data, null, 2);
}

function schedulerSummary(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "launchd LaunchAgent plist";
  if (platform === "win32") return "current-user Task Scheduler XML task";
  return "systemd user service and timer";
}

function reportError(
  error: unknown,
  json: boolean,
  dependencies: CliDependencies,
): number {
  const resetrail =
    error instanceof ResetrailError
      ? error
      : new ResetrailError(
          error instanceof Error ? error.message : String(error),
          {
            code: "unexpected_error",
          },
        );
  if (json) {
    dependencies.stderr(
      `${JSON.stringify({ schemaVersion: 1, ok: false, error: { code: resetrail.code, message: resetrail.message } }, null, 2)}\n`,
    );
  } else {
    dependencies.stderr(`codex-reset-scheduler: ${resetrail.message}\n`);
  }
  return resetrail.exitCode;
}

function helpText(): string {
  return `codex-reset-scheduler ${VERSION}
Schedule automatic redemption of your existing Codex banked resets before they expire.

Usage:
  codex-reset-scheduler doctor [--json]
  codex-reset-scheduler resets [--timezone <IANA>] [--json]
  codex-reset-scheduler plan [--credit <selector> | --all] [--before 10m] [--json]
  codex-reset-scheduler arm [--credit <selector> | --all] [--before 10m] [--yes] [--dry-run] [--json]
  codex-reset-scheduler status [--plan <id-or-selector>] [--json]
  codex-reset-scheduler disarm [--plan <id> | --all] [--yes] [--dry-run] [--json]
  codex-reset-scheduler logs [--plan <id-or-selector>] [--json]
  codex-reset-scheduler gc [--dry-run] [--json]
  codex-reset-scheduler version [--json]

No command consumes a reset without an explicitly armed exact credit plan.
`;
}
