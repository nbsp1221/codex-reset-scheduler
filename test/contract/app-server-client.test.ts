import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("initialization and later requests share one absolute deadline", async (context) => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  const fake = fileURLToPath(
    new URL("../helpers/fake-app-server.js", import.meta.url),
  );
  const connecting = AppServerClient.connect({
    executable: process.execPath,
    arguments: [fake],
    environment: {
      ...process.env,
      RESETRAIL_FAKE_HOLD_METHOD: "account/read",
    },
    deadlineAtEpochMilliseconds: Date.now() + 150,
  });
  // Charge initialization to the same budget without depending on child startup speed.
  context.mock.timers.tick(100);
  const client = await connecting;
  try {
    let settled = false;
    const request = client.readAccount().finally(() => {
      settled = true;
    });
    const rejection = assert.rejects(
      request,
      /request timed out: account\/read/u,
    );
    context.mock.timers.tick(49);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    context.mock.timers.tick(1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, true);
    await rejection;
    await assert.rejects(
      () => client.readRateLimits(),
      /worker deadline was reached/u,
    );
  } finally {
    await client.close();
  }
});

test("the absolute deadline also bounds initialization", async (context) => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  const fake = fileURLToPath(
    new URL("../helpers/fake-app-server.js", import.meta.url),
  );
  const rejection = assert.rejects(
    AppServerClient.connect({
      executable: process.execPath,
      arguments: [fake],
      environment: {
        ...process.env,
        RESETRAIL_FAKE_HOLD_METHOD: "initialize",
      },
      deadlineAtEpochMilliseconds: Date.now() + 150,
    }),
    /request timed out: initialize/u,
  );
  context.mock.timers.tick(150);
  await rejection;
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

test("file-backed fake credits retire and preserve UUID results across app-server processes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "resetrail-native-fixture-"));
  const stateFile = join(directory, "fake.json");
  const productStateFile = join(directory, "product.json");
  const requestLog = join(directory, "requests.jsonl");
  const key = "00000000-0000-4000-8000-000000000002";
  const creditId = "synthetic-persistent-target";
  await writeFile(
    productStateFile,
    JSON.stringify({
      plans: [
        {
          planId: "synthetic-plan",
          status: "attempting",
          creditId,
          attempt: { idempotencyKey: key },
        },
      ],
    }),
  );
  await writeFile(
    stateFile,
    JSON.stringify({
      nonce: "synthetic-nonce",
      accountEmail: "synthetic@example.invalid",
      requestLog,
      productStateFile,
      credits: [
        {
          id: creditId,
          resetType: "codexRateLimits",
          status: "available",
          grantedAt: 1000,
          expiresAt: 10000,
          title: "Synthetic",
          description: "Fixture only",
        },
      ],
      results: {},
    }),
  );
  try {
    const first = await connectFake({ RESETRAIL_FAKE_STATE_FILE: stateFile });
    try {
      assert.equal(
        (await first.readRateLimits()).resetCredits?.availableCount,
        1,
      );
      assert.equal(await first.consumeExactCredit(creditId, key), "reset");
    } finally {
      await first.close();
    }
    const second = await connectFake({ RESETRAIL_FAKE_STATE_FILE: stateFile });
    try {
      assert.equal(
        (await second.readRateLimits()).resetCredits?.availableCount,
        0,
      );
      assert.equal(await second.consumeExactCredit(creditId, key), "reset");
    } finally {
      await second.close();
    }
    const saved = JSON.parse(await readFile(stateFile, "utf8")) as {
      credits: unknown[];
      results: Record<string, unknown>;
    };
    assert.deepEqual(saved.credits, []);
    assert.deepEqual(saved.results[key], { creditId, outcome: "reset" });
    const consumed = (await readFile(requestLog, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            method: string;
            pid: number;
            persistedAttempt?: { idempotencyKey: string };
          },
      )
      .filter((m) => m.method === "account/rateLimitResetCredit/consume");
    assert.equal(new Set(consumed.map((m) => m.pid)).size, 2);
    assert.ok(
      consumed.every((m) => m.persistedAttempt?.idempotencyKey === key),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
