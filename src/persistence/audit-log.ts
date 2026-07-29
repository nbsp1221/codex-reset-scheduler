import { lstat, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

import { ProtocolError, SafetyError } from "../domain/errors.js";
import type { ConsumeOutcome, PlanStatus } from "../domain/types.js";

const MAX_AUDIT_LOG_BYTES = 1024 * 1024;
const ALLOWED_KEYS = new Set([
  "timestamp",
  "event",
  "planSelector",
  "status",
  "outcome",
  "errorCode",
]);
const ALLOWED_EVENTS = new Set([
  "plan-armed",
  "consume-ambiguous",
  "consume-result",
]);
const PLAN_STATUSES = new Set<PlanStatus>([
  "armed",
  "attempting",
  "settling",
  "succeeded",
  "expired",
  "unavailable",
  "disarmed",
  "paused",
]);
const OUTCOMES = new Set<ConsumeOutcome>([
  "reset",
  "alreadyRedeemed",
  "nothingToReset",
  "noCredit",
]);

export type AuditEvent = Readonly<{
  timestamp: string;
  event: "plan-armed" | "consume-ambiguous" | "consume-result";
  planSelector?: string;
  status?: PlanStatus;
  outcome?: ConsumeOutcome;
  errorCode?: string;
}>;

export async function appendAuditEvent(
  path: string,
  event: AuditEvent,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await rejectSymlink(directory, "Audit log directory");
  await rejectSymlink(path, "Audit log");
  await rotateIfNeeded(path);
  const handle = await open(path, "a", 0o600);
  try {
    await handle.appendFile(`${JSON.stringify(event)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function decodeAuditEvent(value: unknown): AuditEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ProtocolError("Audit event must be an object.");
  const event = value as Record<string, unknown>;
  if (Object.keys(event).some((key) => !ALLOWED_KEYS.has(key)))
    throw new ProtocolError("Audit event contains an unknown field.");
  requiredString(event.timestamp, "timestamp");
  requiredString(event.event, "event");
  optionalString(event.planSelector, "planSelector");
  optionalString(event.status, "status");
  optionalString(event.outcome, "outcome");
  optionalString(event.errorCode, "errorCode");
  if (Number.isNaN(new Date(event.timestamp).getTime()))
    throw new ProtocolError("Audit timestamp is invalid.");
  if (!ALLOWED_EVENTS.has(event.event))
    throw new ProtocolError("Audit event type is invalid.");
  if (
    event.planSelector !== undefined &&
    !/^[a-f0-9]{12}$/u.test(event.planSelector)
  )
    throw new ProtocolError("Audit plan selector is invalid.");
  if (
    event.status !== undefined &&
    !PLAN_STATUSES.has(event.status as PlanStatus)
  )
    throw new ProtocolError("Audit plan status is invalid.");
  if (
    event.outcome !== undefined &&
    !OUTCOMES.has(event.outcome as ConsumeOutcome)
  )
    throw new ProtocolError("Audit outcome is invalid.");
  if (
    event.errorCode !== undefined &&
    !/^[a-z0-9_-]{1,64}$/u.test(event.errorCode)
  )
    throw new ProtocolError("Audit error category is invalid.");
  return event as AuditEvent;
}

async function rotateIfNeeded(path: string): Promise<void> {
  try {
    if ((await stat(path)).size < MAX_AUDIT_LOG_BYTES) return;
    const backup = `${path}.1`;
    await rejectSymlink(backup, "Audit log backup");
    await rm(backup, { force: true });
    await rename(path, backup);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function rejectSymlink(path: string, label: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink())
      throw new SafetyError(
        `${label} must not be a symbolic link.`,
        "unsafe_log_path",
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function requiredString(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256)
    throw new ProtocolError(`Audit ${label} is invalid.`);
}

function optionalString(
  value: unknown,
  label: string,
): asserts value is string | undefined {
  if (value !== undefined) requiredString(value, label);
}
