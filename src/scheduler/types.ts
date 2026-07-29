import type { ResetPlan, SchedulerPlatform } from "../domain/types.js";

export type ExecSpec = Readonly<{
  command: string;
  arguments: readonly string[];
  environment: Readonly<Record<string, string>>;
  stateDirectory: string;
  codexHome: string;
  stdoutPath: string;
  stderrPath: string;
}>;

export type SchedulerPreview = Readonly<{
  platform: SchedulerPlatform;
  artifactId: string;
  files: readonly Readonly<{ path: string; content: string }>[];
  registration: Readonly<{ executable: string; arguments: readonly string[] }>;
}>;

export type SchedulerInspection = Readonly<{
  installed: boolean;
  enabled: boolean;
  detail: string;
}>;

export type SchedulerAdapter = {
  preview(plan: ResetPlan, action: ExecSpec): SchedulerPreview;
  install(plan: ResetPlan, action: ExecSpec): Promise<void>;
  inspect(plan: ResetPlan): Promise<SchedulerInspection>;
  remove(plan: ResetPlan): Promise<void>;
};
