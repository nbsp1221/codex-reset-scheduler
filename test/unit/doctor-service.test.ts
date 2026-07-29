import assert from "node:assert/strict";
import test from "node:test";

import { inspectSchedulerEnvironment } from "../../src/application/doctor-service.js";

test("doctor treats scheduler availability as required and clock/linger as advisory", async () => {
  const report = await inspectSchedulerEnvironment("linux", (executable) => {
    if (executable === "systemctl" || executable === "systemd-analyze")
      return Promise.resolve("available");
    return Promise.resolve("no");
  });
  assert.equal(report.ready, true);
  assert.equal(
    report.checks.find((check) => check.name === "clock-synchronized")?.ok,
    false,
  );
  assert.equal(
    report.checks.find((check) => check.name === "linger-enabled")?.required,
    false,
  );
});

test("doctor fails readiness when the native scheduler is unavailable", async () => {
  const report = await inspectSchedulerEnvironment("win32", () =>
    Promise.reject(new Error("missing")),
  );
  assert.equal(report.ready, false);
  assert.equal(report.scheduler, "task-scheduler");
  assert.equal(report.checks[0]?.required, true);
});
