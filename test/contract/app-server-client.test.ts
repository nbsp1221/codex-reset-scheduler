import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AppServerClient } from "../../src/codex/app-server-client.js";

test("app-server client reads synthetic account and reset details", async () => {
  const client = await connectFake();
  try {
    const account = await client.readAccount();
    const limits = await client.readRateLimits();
    const resetCredits = limits.resetCredits;
    assert.equal(account.email, "synthetic@example.invalid");
    assert.ok(resetCredits);
    assert.equal(resetCredits.availableCount, 2);
    assert.equal(resetCredits.detailsComplete, true);
  } finally {
    await client.close();
  }
});

test("consume gateway always sends the exact credit ID and caller UUID", async () => {
  const directory = await mkdtemp(join(tmpdir(), "resetrail-contract-"));
  const requestLog = join(directory, "requests.jsonl");
  const client = await connectFake({ RESETRAIL_FAKE_REQUEST_LOG: requestLog });
  try {
    const outcome = await client.consumeExactCredit(
      "synthetic-credit-b",
      "00000000-0000-4000-8000-000000000001",
    );
    assert.equal(outcome, "reset");
    const messages = (await readFile(requestLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const consume = messages.find(
      (message) => message.method === "account/rateLimitResetCredit/consume",
    );
    assert.deepEqual(consume?.params, {
      creditId: "synthetic-credit-b",
      idempotencyKey: "00000000-0000-4000-8000-000000000001",
    });
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("consume gateway refuses an omitted exact credit identity", async () => {
  const client = await connectFake();
  try {
    await assert.rejects(
      () => client.consumeExactCredit("", "attempt"),
      /exact non-empty credit ID/,
    );
  } finally {
    await client.close();
  }
});

test("app-server requests honor the worker-wide absolute deadline", async () => {
  const fake = fileURLToPath(
    new URL("../helpers/fake-app-server.js", import.meta.url),
  );
  const client = await AppServerClient.connect({
    executable: process.execPath,
    arguments: [fake],
    environment: {
      ...process.env,
      RESETRAIL_FAKE_DELAY_METHOD: "account/read",
      RESETRAIL_FAKE_DELAY_MS: "500",
    },
    deadlineAtEpochMilliseconds: Date.now() + 150,
  });
  try {
    await assert.rejects(() => client.readAccount(), /request timed out/u);
  } finally {
    await client.close();
  }
});

async function connectFake(
  environment: NodeJS.ProcessEnv = {},
): Promise<AppServerClient> {
  const fake = fileURLToPath(
    new URL("../helpers/fake-app-server.js", import.meta.url),
  );
  return AppServerClient.connect({
    executable: process.execPath,
    arguments: [fake],
    environment: { ...process.env, ...environment },
  });
}
