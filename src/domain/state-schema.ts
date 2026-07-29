import { ProtocolError } from "./errors.js";
import type { InstallState, ResetPlan } from "./types.js";
import { creditSelector } from "./policy.js";
import { isAbsolute } from "node:path";

const SHA256 = /^[a-f0-9]{64}$/u;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const PLAN_STATUSES = new Set([
  "armed",
  "attempting",
  "settling",
  "succeeded",
  "expired",
  "unavailable",
  "disarmed",
  "paused",
]);
const SCHEDULER_PLATFORMS = new Set(["systemd", "launchd", "task-scheduler"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeInstallState(value: unknown): InstallState {
  if (!isRecord(value))
    throw new ProtocolError("State root must be an object.");
  exactKeys(
    value,
    ["schemaVersion", "revision", "installId", "accountSalt", "plans"],
    "state",
  );
  if (value.schemaVersion !== 1) {
    throw new ProtocolError("Unsupported state schema version.");
  }
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0) {
    throw new ProtocolError("State revision is invalid.");
  }
  if (
    typeof value.installId !== "string" ||
    !UUID.test(value.installId) ||
    typeof value.accountSalt !== "string" ||
    !SHA256.test(value.accountSalt)
  ) {
    throw new ProtocolError("State installation identity is invalid.");
  }
  if (!Array.isArray(value.plans)) {
    throw new ProtocolError("State plans must be an array.");
  }
  return {
    schemaVersion: 1,
    revision: Number(value.revision),
    installId: value.installId,
    accountSalt: value.accountSalt,
    plans: value.plans.map(decodePlan),
  };
}

function decodePlan(value: unknown): ResetPlan {
  if (!isRecord(value)) throw new ProtocolError("Plan must be an object.");
  exactKeys(
    value,
    [
      "planId",
      "status",
      "creditId",
      "creditSelector",
      "resetType",
      "grantedAt",
      "expiresAt",
      "notBefore",
      "accountFingerprint",
      "runtimeVersion",
      "runtimeSha256",
      "codexExecutable",
      "codexVersionAtArm",
      "codexHome",
      "attempt",
      "scheduler",
      "terminalReason",
      "createdAt",
      "updatedAt",
    ],
    "plan",
  );
  const stringFields = [
    "planId",
    "status",
    "creditId",
    "creditSelector",
    "resetType",
    "accountFingerprint",
    "runtimeVersion",
    "runtimeSha256",
    "codexExecutable",
    "codexVersionAtArm",
    "codexHome",
    "createdAt",
    "updatedAt",
  ] as const;
  for (const key of stringFields) {
    if (typeof value[key] !== "string") {
      throw new ProtocolError(`Plan field ${key} is invalid.`);
    }
  }
  if (!UUID.test(value.planId as string))
    throw new ProtocolError("Plan ID is invalid.");
  if ((value.creditId as string).length === 0)
    throw new ProtocolError("Plan credit ID is empty.");
  if (!/^[a-f0-9]{12}$/u.test(value.creditSelector as string)) {
    throw new ProtocolError("Plan credit selector is invalid.");
  }
  if (value.creditSelector !== creditSelector(value.creditId as string)) {
    throw new ProtocolError(
      "Plan credit selector does not match its credit ID.",
    );
  }
  if (value.resetType !== "codexRateLimits") {
    throw new ProtocolError("Plan reset type is invalid.");
  }
  if (!PLAN_STATUSES.has(value.status as string)) {
    throw new ProtocolError("Plan status is invalid.");
  }
  if (!SHA256.test(value.accountFingerprint as string)) {
    throw new ProtocolError("Plan account fingerprint is invalid.");
  }
  if (!SHA256.test(value.runtimeSha256 as string)) {
    throw new ProtocolError("Plan runtime hash is invalid.");
  }
  if (
    !isAbsolute(value.codexExecutable as string) ||
    !isAbsolute(value.codexHome as string)
  ) {
    throw new ProtocolError("Plan executable and Codex home must be absolute.");
  }
  if (
    !Number.isSafeInteger(value.grantedAt) ||
    !Number.isSafeInteger(value.expiresAt) ||
    !Number.isSafeInteger(value.notBefore)
  ) {
    throw new ProtocolError("Plan timestamps are invalid.");
  }
  if (Number(value.notBefore) >= Number(value.expiresAt)) {
    throw new ProtocolError("Plan activation must precede expiry.");
  }
  decodeScheduler(value.scheduler);
  decodeAttempt(value.attempt);
  if (
    value.terminalReason !== null &&
    typeof value.terminalReason !== "string"
  ) {
    throw new ProtocolError("Plan terminal reason is invalid.");
  }
  validIsoDate(value.createdAt, "plan.createdAt");
  validIsoDate(value.updatedAt, "plan.updatedAt");
  return value as unknown as ResetPlan;
}

function decodeScheduler(value: unknown): void {
  if (!isRecord(value))
    throw new ProtocolError("Plan scheduler binding is invalid.");
  exactKeys(value, ["platform", "artifactId", "triggerTimesUtc"], "scheduler");
  if (!SCHEDULER_PLATFORMS.has(String(value.platform))) {
    throw new ProtocolError("Plan scheduler platform is invalid.");
  }
  if (typeof value.artifactId !== "string" || value.artifactId.length === 0) {
    throw new ProtocolError("Plan scheduler artifact ID is invalid.");
  }
  if (
    !Array.isArray(value.triggerTimesUtc) ||
    value.triggerTimesUtc.length === 0
  ) {
    throw new ProtocolError("Plan scheduler triggers are invalid.");
  }
  for (const trigger of value.triggerTimesUtc)
    validIsoDate(trigger, "scheduler trigger");
}

function decodeAttempt(value: unknown): void {
  if (value === null) return;
  if (!isRecord(value)) throw new ProtocolError("Plan attempt is invalid.");
  exactKeys(
    value,
    ["idempotencyKey", "startedAt", "lastTriedAt", "tryCount"],
    "attempt",
  );
  if (
    typeof value.idempotencyKey !== "string" ||
    !UUID.test(value.idempotencyKey)
  ) {
    throw new ProtocolError("Attempt idempotency key is invalid.");
  }
  validIsoDate(value.startedAt, "attempt.startedAt");
  if (value.lastTriedAt !== null)
    validIsoDate(value.lastTriedAt, "attempt.lastTriedAt");
  if (!Number.isSafeInteger(value.tryCount) || Number(value.tryCount) < 0) {
    throw new ProtocolError("Attempt count is invalid.");
  }
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).toSorted();
  const wanted = [...expected].toSorted();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new ProtocolError(`${label} contains unexpected or missing fields.`);
  }
}

function validIsoDate(value: unknown, label: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new ProtocolError(`${label} is invalid.`);
  }
}
