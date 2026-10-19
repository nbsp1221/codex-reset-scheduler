import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  const requestLog = join(directory, "requests.jsonl");
  const key = "00000000-0000-4000-8000-000000000002";
  const creditId = "synthetic-persistent-target";
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
          },
      )
      .filter((m) => m.method === "account/rateLimitResetCredit/consume");
    assert.equal(new Set(consumed.map((m) => m.pid)).size, 2);
    assert.equal(consumed.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("close waits for a backend that ignores EOF and SIGTERM to be killed", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "resetrail-stubborn-backend-"),
  );
  const pidFile = join(directory, "child.pid");
  const fixture = join(directory, "fake.mjs");
  await writeFile(
    fixture,
    `
    import { writeFileSync } from 'node:fs';
    import { createInterface } from 'node:readline';
    writeFileSync(process.argv[2], String(process.pid));
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
    createInterface({ input: process.stdin }).on('line', line => {
      const message = JSON.parse(line);
      if (message.method === 'initialize')
        process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n');
    });
  `,
  );
  let pid: number | undefined;
  try {
    const client = await AppServerClient.connect({
      executable: process.execPath,
      arguments: [fixture, pidFile],
    });
    pid = Number(await readFile(pidFile, "utf8"));
    await client.close();
    const childPid = pid;
    assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
  } finally {
    if (pid !== undefined) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* Already exited. */
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("close releases inherited pipes after its direct backend exits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "resetrail-inherited-pipes-"));
  const pidFile = join(directory, "descendant.pid");
  const fixture = join(directory, "fake.mjs");
  await writeFile(
    fixture,
    `
    import { writeFileSync } from 'node:fs';
    import { spawn } from 'node:child_process';
    import { createInterface } from 'node:readline';
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: ['ignore', process.stdout, process.stderr]
    });
    writeFileSync(process.argv[2], String(child.pid));
    createInterface({ input: process.stdin }).on('line', line => {
      const message = JSON.parse(line);
      if (message.method === 'initialize')
        process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n');
    });
    process.stdin.on('end', () => process.exit(0));
  `,
  );
  const moduleUrl = new URL(
    "../../src/codex/app-server-client.js",
    import.meta.url,
  ).href;
  try {
    const completed = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { AppServerClient } from ${JSON.stringify(moduleUrl)};
        const client = await AppServerClient.connect({
          executable: process.execPath,
          arguments: ${JSON.stringify([fixture, pidFile])},
        });
        await client.close();
        console.log('closed');`,
      ],
      { timeout: 4_000, encoding: "utf8" },
    );
    assert.equal(completed.error, undefined);
    assert.equal(completed.status, 0, completed.stderr);
    assert.equal(completed.stdout.trim(), "closed");
    process.kill(Number(await readFile(pidFile, "utf8")), 0);
  } finally {
    try {
      process.kill(Number(await readFile(pidFile, "utf8")), "SIGKILL");
    } catch {
      /* Already exited or never started. */
    }
    await rm(directory, { recursive: true, force: true });
  }
});
