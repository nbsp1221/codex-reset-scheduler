import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendAuditEvent,
  decodeAuditEvent,
} from "../../src/persistence/audit-log.js";

test("audit log rotates at a bounded size and preserves sanitized events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "resetrail-audit-"));
  const path = join(directory, "logs", "events.jsonl");
  try {
    await mkdir(join(directory, "logs"), { recursive: true });
    await writeFile(path, "x".repeat(1024 * 1024), { flag: "wx" });
    await appendAuditEvent(path, {
      timestamp: "2026-01-01T00:00:00.000Z",
      event: "plan-armed",
      planSelector: "abc123def456",
    });
    assert.equal((await readFile(`${path}.1`, "utf8")).length, 1024 * 1024);
    const current = JSON.parse(await readFile(path, "utf8")) as unknown;
    assert.equal(decodeAuditEvent(current).event, "plan-armed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("audit decoder rejects fields outside the sanitized event contract", () => {
  assert.throws(
    () =>
      decodeAuditEvent({
        timestamp: "2026-01-01T00:00:00.000Z",
        event: "plan-armed",
        rawCreditId: "must-not-render",
      }),
    /unknown field/u,
  );
});

test("audit append refuses a symlink destination", async () => {
  if (process.platform === "win32") return;
  const directory = await mkdtemp(join(tmpdir(), "resetrail-audit-"));
  const target = join(directory, "target.txt");
  const path = join(directory, "events.jsonl");
  try {
    await writeFile(target, "unchanged");
    await symlink(target, path);
    await assert.rejects(
      () =>
        appendAuditEvent(path, {
          timestamp: "2026-01-01T00:00:00.000Z",
          event: "plan-armed",
        }),
      /symbolic link/u,
    );
    assert.equal(await readFile(target, "utf8"), "unchanged");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
