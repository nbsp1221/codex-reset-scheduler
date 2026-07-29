import { ProtocolError } from "../domain/errors.js";
import type {
  ChatgptAccount,
  ConsumeOutcome,
  RateLimitsSnapshot,
  RateLimitWindow,
  ResetCredit,
  ResetCreditsSnapshot,
} from "../domain/types.js";

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value))
    throw new ProtocolError(`${label} must be an integer.`);
  return Number(value);
}

function nullableInteger(value: unknown, label: string): number | null {
  return value === null ? null : integer(value, label);
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string")
    throw new ProtocolError(`${label} must be a string or null.`);
  return value;
}

export function decodeAccountResponse(value: unknown): ChatgptAccount {
  const root = record(value, "account/read result");
  const account = record(root.account, "account");
  if (account.type !== "chatgpt") {
    throw new ProtocolError("Reset credits require a ChatGPT Codex account.");
  }
  const email = nullableString(account.email, "account.email");
  if (typeof account.planType !== "string") {
    throw new ProtocolError("account.planType must be a string.");
  }
  return { type: "chatgpt", email, planType: account.planType };
}

export function decodeRateLimitsResponse(value: unknown): RateLimitsSnapshot {
  const root = record(value, "account/rateLimits/read result");
  const byLimitId = root.rateLimitsByLimitId;
  let selected: unknown = root.rateLimits;
  if (
    typeof byLimitId === "object" &&
    byLimitId !== null &&
    !Array.isArray(byLimitId)
  ) {
    const codex = (byLimitId as Record<string, unknown>).codex;
    if (codex !== undefined) selected = codex;
  }
  const limits = record(selected, "Codex rate limits");
  return {
    primary: decodeWindow(limits.primary, "primary"),
    secondary: decodeWindow(limits.secondary, "secondary"),
    resetCredits: decodeResetCredits(root.rateLimitResetCredits),
  };
}

function decodeWindow(value: unknown, label: string): RateLimitWindow | null {
  if (value === null || value === undefined) return null;
  const window = record(value, `${label} window`);
  const usedPercent = integer(window.usedPercent, `${label}.usedPercent`);
  if (usedPercent < 0 || usedPercent > 100) {
    throw new ProtocolError(`${label}.usedPercent is outside 0..100.`);
  }
  return {
    usedPercent,
    windowDurationMins: nullableInteger(
      window.windowDurationMins ?? null,
      `${label}.windowDurationMins`,
    ),
    resetsAt: nullableInteger(window.resetsAt ?? null, `${label}.resetsAt`),
  };
}

function decodeResetCredits(value: unknown): ResetCreditsSnapshot | null {
  if (value === null || value === undefined) return null;
  const summary = record(value, "rateLimitResetCredits");
  const availableCount = integer(
    summary.availableCount,
    "rateLimitResetCredits.availableCount",
  );
  if (availableCount < 0)
    throw new ProtocolError("availableCount must be non-negative.");
  if (summary.credits === null || summary.credits === undefined) {
    return { availableCount, credits: null, detailsComplete: false };
  }
  if (!Array.isArray(summary.credits)) {
    throw new ProtocolError(
      "rateLimitResetCredits.credits must be an array or null.",
    );
  }
  const credits = summary.credits.map(decodeCredit);
  return {
    availableCount,
    credits,
    detailsComplete: credits.length === availableCount,
  };
}

function decodeCredit(value: unknown, index: number): ResetCredit {
  const item = record(value, `reset credit ${index}`);
  if (typeof item.id !== "string" || item.id.length === 0) {
    throw new ProtocolError(`reset credit ${index}.id must be non-empty.`);
  }
  const resetTypes = ["codexRateLimits", "unknown"] as const;
  if (!resetTypes.includes(item.resetType as (typeof resetTypes)[number])) {
    throw new ProtocolError(`reset credit ${index}.resetType is unknown.`);
  }
  const statuses = ["available", "redeeming", "redeemed", "unknown"] as const;
  if (!statuses.includes(item.status as (typeof statuses)[number])) {
    throw new ProtocolError(`reset credit ${index}.status is unknown.`);
  }
  return {
    id: item.id,
    resetType: item.resetType as ResetCredit["resetType"],
    status: item.status as ResetCredit["status"],
    grantedAt: integer(item.grantedAt, `reset credit ${index}.grantedAt`),
    expiresAt: nullableInteger(
      item.expiresAt ?? null,
      `reset credit ${index}.expiresAt`,
    ),
    title: nullableString(item.title ?? null, `reset credit ${index}.title`),
    description: nullableString(
      item.description ?? null,
      `reset credit ${index}.description`,
    ),
  };
}

export function decodeConsumeResponse(value: unknown): ConsumeOutcome {
  const root = record(value, "consume result");
  const outcomes = [
    "reset",
    "alreadyRedeemed",
    "nothingToReset",
    "noCredit",
  ] as const;
  if (!outcomes.includes(root.outcome as ConsumeOutcome)) {
    throw new ProtocolError("consume outcome is unknown.");
  }
  return root.outcome as ConsumeOutcome;
}
