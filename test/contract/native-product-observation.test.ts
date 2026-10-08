import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AppServerClient } from "../../src/codex/app-server-client.js";
import { assertProductLogEvents } from "../helpers/native-product-observation.js";

test("request-time observer rejects unpersisted UUIDs before fake effects and captures the accepted attempt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "resetrail-observe-request-"));
  const productStateFile = join(directory, "product.json");
  const stateFile = join(directory, "fake.json");
  const requestLog = join(directory, "requests.jsonl");
  const launcher = join(directory, "launch.mjs");
  const key = "00000000-0000-4000-8000-000000000003";
  const creditId = "synthetic-observed-target";
  const plan = {
    planId: "synthetic-plan",
    status: "attempting",
    creditId,
    attempt: { idempotencyKey: key },
  };
  await writeFile(
    launcher,
    `import { startFakeAppServer } from ${JSON.stringify(new URL("../helpers/fake-app-server.js", import.meta.url).href)};\nimport { observeConsumeAtRequest } from ${JSON.stringify(new URL("../helpers/native-product-observation.js", import.meta.url).href)};\nstartFakeAppServer(message => observeConsumeAtRequest(${JSON.stringify(productStateFile)}, message));\n`,
  );
  await writeFile(
    stateFile,
    JSON.stringify({
      nonce: "synthetic-nonce",
      accountEmail: "synthetic@example.invalid",
      requestLog,
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
  async function connect() {
    return AppServerClient.connect({
      executable: process.execPath,
      arguments: [launcher],
      environment: { ...process.env, RESETRAIL_FAKE_STATE_FILE: stateFile },
    });
  }
  try {
    for (const rejected of [
      null,
      { ...plan, status: "armed", attempt: null },
      { ...plan, attempt: { idempotencyKey: "different" } },
    ]) {
      if (rejected !== null)
        await writeFile(
          productStateFile,
          JSON.stringify({ plans: [rejected] }),
        );
      const client = await connect();
      try {
        assert.equal(
          (await client.readRateLimits()).resetCredits?.availableCount,
          1,
        );
        await assert.rejects(client.consumeExactCredit(creditId, key));
      } finally {
        await client.close();
      }
      const unchanged = JSON.parse(await readFile(stateFile, "utf8")) as {
        results: Record<string, unknown>;
        credits: { id: string }[];
      };
      assert.deepEqual(unchanged.results, {});
      assert.equal(unchanged.credits[0]?.id, creditId);
    }
    await writeFile(productStateFile, JSON.stringify({ plans: [plan] }));
    const client = await connect();
    try {
      assert.equal(await client.consumeExactCredit(creditId, key), "reset");
    } finally {
      await client.close();
    }
    // A later state change must not replace the snapshot captured at receipt.
    await writeFile(
      productStateFile,
      JSON.stringify({
        plans: [{ ...plan, attempt: { idempotencyKey: "later" } }],
      }),
    );
    const messages = (await readFile(requestLog, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as { method: string; persistedAttempt?: unknown },
      );
    const consumed = messages.filter(
      (m) => m.method === "account/rateLimitResetCredit/consume",
    );
    assert.equal(consumed.length, 1);
    assert.deepEqual(consumed[0]?.persistedAttempt, {
      planId: plan.planId,
      status: "attempting",
      creditId,
      idempotencyKey: key,
    });
    const retired = JSON.parse(await readFile(stateFile, "utf8")) as {
      results: Record<string, unknown>;
      credits: unknown[];
    };
    assert.deepEqual(retired.credits, []);
    assert.deepEqual(retired.results[key], { creditId, outcome: "reset" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("product log checks allow unrelated informational events", () => {
  const armed = { event: "plan-armed", status: "armed" };
  const result = {
    event: "consume-result",
    status: "succeeded",
    outcome: "reset",
  };
  const info = { event: "worker-started" };
  assertProductLogEvents([info, armed, info, result, info], true);
  assertProductLogEvents([info, armed, info], false);
});

test("product log checks require counts and order and forbid blocked consume results", () => {
  const armed = { event: "plan-armed", status: "armed" };
  const result = {
    event: "consume-result",
    status: "succeeded",
    outcome: "reset",
  };
  for (const invalid of [
    [],
    [armed],
    [armed, armed, result],
    [armed, result, result],
    [result, armed],
    [armed, { ...result, outcome: "noCredit" }],
  ])
    assert.throws(() => assertProductLogEvents(invalid, true));
  assert.throws(() => assertProductLogEvents([armed, result], false));
});
