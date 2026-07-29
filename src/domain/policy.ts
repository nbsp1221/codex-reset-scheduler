import { createHash } from "node:crypto";

import { SafetyError } from "./errors.js";
import type { ResetCredit, TriggerPlan } from "./types.js";

const MIN_BEFORE_SECONDS = 120;
const MAX_BEFORE_SECONDS = 7 * 24 * 60 * 60;
const MIN_SCHEDULER_LEAD_SECONDS = 30;

export function creditSelector(creditId: string): string {
  return createHash("sha256").update(creditId).digest("hex").slice(0, 12);
}

export function eligibleCredits(
  credits: readonly ResetCredit[] | null,
  nowSeconds: number,
): readonly ResetCredit[] {
  if (credits === null) return [];
  return credits
    .filter(
      (credit): credit is ResetCredit & { expiresAt: number } =>
        credit.status === "available" &&
        credit.resetType === "codexRateLimits" &&
        credit.expiresAt !== null &&
        credit.expiresAt > nowSeconds,
    )
    .toSorted((left, right) => left.expiresAt - right.expiresAt);
}

export function parseDurationSeconds(value: string): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(value);
  if (match === null) {
    throw new SafetyError(
      "Duration must be an integer followed by s, m, h, or d.",
      "invalid_duration",
    );
  }
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier =
    unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : 86400;
  const seconds = amount * multiplier;
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < MIN_BEFORE_SECONDS ||
    seconds > MAX_BEFORE_SECONDS
  ) {
    throw new SafetyError(
      "The before duration must be between 2m and 7d.",
      "duration_out_of_range",
    );
  }
  return seconds;
}

export function buildTriggerPlan(options: {
  expiresAt: number;
  beforeSeconds: number;
  nowSeconds: number;
}): TriggerPlan {
  const { expiresAt, beforeSeconds, nowSeconds } = options;
  if (expiresAt - nowSeconds <= MIN_SCHEDULER_LEAD_SECONDS) {
    throw new SafetyError(
      "The reset expires too soon to arm safely.",
      "insufficient_scheduler_lead",
    );
  }
  const notBefore = expiresAt - beforeSeconds;
  const immediate = nowSeconds >= notBefore;
  const candidates = [
    notBefore,
    expiresAt - 420,
    expiresAt - 240,
    expiresAt - 120,
    expiresAt - 60,
  ];
  if (immediate) candidates.push(nowSeconds + 5);
  const triggerTimes = [...new Set(candidates)]
    .filter(
      (candidate) =>
        candidate >= notBefore &&
        candidate > nowSeconds &&
        candidate < expiresAt - MIN_SCHEDULER_LEAD_SECONDS,
    )
    .toSorted((left, right) => left - right);
  if (triggerTimes.length === 0) {
    throw new SafetyError(
      "No safe scheduler trigger remains before expiry.",
      "no_safe_trigger",
    );
  }
  return { notBefore, expiresAt, triggerTimes, immediate };
}

export function selectCredit(
  credits: readonly ResetCredit[],
  selector: string | undefined,
): ResetCredit {
  if (credits.length === 0) {
    throw new SafetyError(
      "No eligible detailed reset is available.",
      "no_eligible_reset",
    );
  }
  if (selector === undefined) {
    const first = credits.at(0);
    if (first === undefined) {
      throw new SafetyError(
        "No eligible detailed reset is available.",
        "no_eligible_reset",
      );
    }
    return first;
  }
  const matches = credits.filter(
    (credit) =>
      creditSelector(credit.id) === selector || credit.id === selector,
  );
  if (matches.length !== 1) {
    throw new SafetyError(
      matches.length === 0
        ? "The reset selector was not found."
        : "The reset selector is ambiguous.",
      "invalid_selector",
    );
  }
  const match = matches.at(0);
  if (match === undefined) {
    throw new SafetyError(
      "The reset selector was not found.",
      "invalid_selector",
    );
  }
  return match;
}
