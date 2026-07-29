export type ResetCreditStatus =
  "available" | "redeeming" | "redeemed" | "unknown";

export type ResetCredit = Readonly<{
  id: string;
  resetType: "codexRateLimits" | "unknown";
  status: ResetCreditStatus;
  grantedAt: number;
  expiresAt: number | null;
  title: string | null;
  description: string | null;
}>;

export type ResetCreditsSnapshot = Readonly<{
  availableCount: number;
  credits: readonly ResetCredit[] | null;
  detailsComplete: boolean;
}>;

export type RateLimitWindow = Readonly<{
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}>;

export type RateLimitsSnapshot = Readonly<{
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  resetCredits: ResetCreditsSnapshot | null;
}>;

export type ChatgptAccount = Readonly<{
  type: "chatgpt";
  email: string | null;
  planType: string;
}>;

export type ConsumeOutcome =
  "reset" | "alreadyRedeemed" | "nothingToReset" | "noCredit";

export type PlanStatus =
  | "armed"
  | "attempting"
  | "settling"
  | "succeeded"
  | "expired"
  | "unavailable"
  | "disarmed"
  | "paused";

export type Attempt = Readonly<{
  idempotencyKey: string;
  startedAt: string;
  lastTriedAt: string | null;
  tryCount: number;
}>;

export type SchedulerPlatform = "systemd" | "launchd" | "task-scheduler";

export type SchedulerBinding = Readonly<{
  platform: SchedulerPlatform;
  artifactId: string;
  triggerTimesUtc: readonly string[];
}>;

export type ResetPlan = Readonly<{
  planId: string;
  status: PlanStatus;
  creditId: string;
  creditSelector: string;
  resetType: "codexRateLimits";
  grantedAt: number;
  expiresAt: number;
  notBefore: number;
  accountFingerprint: string;
  runtimeVersion: string;
  runtimeSha256: string;
  codexExecutable: string;
  codexVersionAtArm: string;
  codexHome: string;
  attempt: Attempt | null;
  scheduler: SchedulerBinding;
  terminalReason: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type InstallState = Readonly<{
  schemaVersion: 1;
  revision: number;
  installId: string;
  accountSalt: string;
  plans: readonly ResetPlan[];
}>;

export type TriggerPlan = Readonly<{
  notBefore: number;
  expiresAt: number;
  triggerTimes: readonly number[];
  immediate: boolean;
}>;
