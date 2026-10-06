import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  armResets,
  type ArmDependencies,
  type ArmOptions,
  type ArmResult,
} from "../../src/application/arm-service.js";
import { accountFingerprint } from "../../src/codex/account.js";
import { creditSelector } from "../../src/domain/policy.js";
import type { ResetCredit } from "../../src/domain/types.js";
import { managedPaths } from "../../src/persistence/paths.js";
import { StateStore } from "../../src/persistence/state-store.js";

const now = new Date("2026-01-01T00:00:00.000Z");
const seconds = now.getTime() / 1_000;
const approved = syntheticCredit("synthetic-approved-a", seconds + 7_200);
const added = syntheticCredit("synthetic-unapproved-b", seconds + 3_600);
const options: ArmOptions = { all: false, beforeSeconds: 600, dryRun: false };

for (const mode of ["all", "default", "selector"] as const) {
  test(`confirmation pins the reviewed exact credit when another is added: ${mode}`, async () => {
    await withFixture(async (fixture) => {
      const armed = await armResets(
        {
          ...options,
          all: mode === "all",
          ...(mode === "selector"
            ? { selector: creditSelector(approved.id) }
            : {}),
        },
        {
          ...fixture.dependencies,
          confirm: async (preview) => {
            assert.deepEqual(
              preview.plans.map((plan) => plan.selector),
              [creditSelector(approved.id)],
            );
            assertPublic(preview);
            await fixture.assertNoWrites();
            fixture.current.credits = [approved, added];
          },
        },
      );
      assertPublic(armed);
      const state = await fixture.store.load();
      assert.ok(state);
      assert.deepEqual(
        state.plans.map((plan) => plan.creditId),
        [approved.id],
      );
      assert.equal(
        state.plans[0]?.accountFingerprint,
        accountFingerprint(
          { type: "chatgpt", email: fixture.current.email, planType: "pro" },
          state.accountSalt,
        ),
      );
      assert.equal(fixture.current.installs, 1);
      assert.equal(fixture.current.connections, 2);
      assert.equal(fixture.current.closes, 2);
    });
  });
}

test("all preserves every approved ID even when snapshot order changes", async () => {
  await withFixture(async (fixture) => {
    fixture.current.credits = [approved, added];
    await armResets(
      { ...options, all: true },
      {
        ...fixture.dependencies,
        confirm: () => {
          fixture.current.credits = [added, approved];
          return Promise.resolve();
        },
      },
    );
    const state = await fixture.store.load();
    assert.deepEqual(
      new Set(state?.plans.map((plan) => plan.creditId)),
      new Set([approved.id, added.id]),
    );
    assert.equal(fixture.current.installs, 2);
  });
});

const unsafeChanges: readonly (readonly [
  string,
  (fixture: Fixture) => void,
])[] = [
  [
    "approved credit disappears while another remains",
    (fixture) => {
      fixture.current.credits = [added];
    },
  ],
  [
    "approved selector is now another raw ID",
    (fixture) => {
      fixture.current.credits = [
        syntheticCredit(creditSelector(approved.id), seconds + 7_200),
      ];
    },
  ],
  [
    "account changes",
    (fixture) => {
      fixture.current.email = "synthetic-other@example.invalid";
    },
  ],
  [
    "Codex executable changes",
    (fixture) => {
      fixture.current.executable = "/synthetic/other-codex";
    },
  ],
  [
    "Codex version changes",
    (fixture) => {
      fixture.current.version = "codex-cli 2.0.0";
    },
  ],
  [
    "credit expiry changes",
    (fixture) => {
      fixture.current.credits = [{ ...approved, expiresAt: seconds + 9_000 }];
    },
  ],
  [
    "credit grant changes",
    (fixture) => {
      fixture.current.credits = [{ ...approved, grantedAt: seconds - 2_000 }];
    },
  ],
  [
    "credit is no longer available",
    (fixture) => {
      fixture.current.credits = [{ ...approved, status: "redeemed" }];
    },
  ],
  [
    "credit type changes",
    (fixture) => {
      fixture.current.credits = [{ ...approved, resetType: "unknown" }];
    },
  ],
  [
    "duplicate exact IDs appear",
    (fixture) => {
      fixture.current.credits = [approved, approved];
    },
  ],
  [
    "fresh snapshot is incomplete",
    (fixture) => {
      fixture.current.detailsComplete = false;
    },
  ],
  [
    "credit expires during the prompt",
    (fixture) => {
      fixture.current.now = new Date((seconds + 7_201) * 1_000);
    },
  ],
  [
    "scheduler lead time elapses during the prompt",
    (fixture) => {
      fixture.current.now = new Date((seconds + 7_175) * 1_000);
    },
  ],
];

for (const [name, change] of unsafeChanges) {
  test(`confirmation rejects without writes when ${name}`, async () => {
    await withFixture(async (fixture) => {
      await assert.rejects(
        () =>
          armResets(
            { ...options, selector: creditSelector(approved.id) },
            {
              ...fixture.dependencies,
              confirm: () => {
                change(fixture);
                return Promise.resolve();
              },
            },
          ),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assertPublic(error.message);
          return /review and arm again|expires too soon|No safe scheduler trigger/u.test(
            error.message,
          );
        },
      );
      await fixture.assertNoWrites();
      assert.equal(fixture.current.closes, 2);
    });
  });
}

test("all rejects the whole approval when one reviewed credit disappears", async () => {
  await withFixture(async (fixture) => {
    fixture.current.credits = [approved, added];
    await assert.rejects(
      () =>
        armResets(
          { ...options, all: true },
          {
            ...fixture.dependencies,
            confirm: () => {
              fixture.current.credits = [approved];
              return Promise.resolve();
            },
          },
        ),
      /review and arm again/u,
    );
    await fixture.assertNoWrites();
  });
});

test("an ambiguous selector fails before confirmation or writes", async () => {
  await withFixture(async (fixture) => {
    // The alias of one synthetic ID also matches another synthetic raw ID.
    fixture.current.credits = [
      approved,
      syntheticCredit(creditSelector(approved.id), seconds + 9_000),
    ];
    let confirmations = 0;
    await assert.rejects(
      () =>
        armResets(
          { ...options, selector: creditSelector(approved.id) },
          {
            ...fixture.dependencies,
            confirm: () => {
              confirmations++;
              return Promise.resolve();
            },
          },
        ),
      /ambiguous/u,
    );
    assert.equal(confirmations, 0);
    await fixture.assertNoWrites();
  });
});

test("cancelled confirmation writes nothing", async () => {
  await withFixture(async (fixture) => {
    await assert.rejects(
      () =>
        armResets(options, {
          ...fixture.dependencies,
          confirm: () =>
            Promise.reject(new Error("synthetic confirmation cancelled")),
        }),
      /synthetic confirmation cancelled/u,
    );
    await fixture.assertNoWrites();
    assert.equal(fixture.current.connections, 1);
    assert.equal(fixture.current.closes, 1);
  });
});

test("dry-run does not confirm, reconnect, or write", async () => {
  await withFixture(async (fixture) => {
    const result = await armResets(
      { ...options, dryRun: true },
      {
        ...fixture.dependencies,
        confirm: () => Promise.reject(new Error("must not confirm dry-run")),
      },
    );
    assert.equal(result.dryRun, true);
    assertPublic(result);
    await fixture.assertNoWrites();
    assert.equal(fixture.current.connections, 1);
    assert.equal(fixture.current.closes, 1);
  });
});

function assertPublic(value: ArmResult | string): void {
  const text = JSON.stringify(value);
  for (const privateValue of [
    approved.id,
    added.id,
    "synthetic@example.invalid",
    "synthetic-other@example.invalid",
  ]) {
    assert.equal(text.includes(privateValue), false);
  }
}

function syntheticCredit(id: string, expiresAt: number): ResetCredit {
  return {
    id,
    resetType: "codexRateLimits",
    status: "available",
    grantedAt: seconds - 1_000,
    expiresAt,
    title: null,
    description: null,
  };
}

type Fixture = Awaited<ReturnType<typeof makeFixture>>;

async function withFixture(
  run: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const fixture = await makeFixture();
  try {
    await run(fixture);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
}

async function makeFixture() {
  const home = await mkdtemp(join(tmpdir(), "resetrail-arm-approval-"));
  const paths = managedPaths({ platform: "linux", home, environment: {} });
  const store = new StateStore(paths);
  const current = {
    credits: [approved] as readonly ResetCredit[],
    email: "synthetic@example.invalid",
    executable: "/synthetic/codex",
    version: "codex-cli 1.0.0",
    now,
    detailsComplete: true,
    installs: 0,
    runtimes: 0,
    connections: 0,
    closes: 0,
  };
  const dependencies: ArmDependencies = {
    paths,
    store,
    home,
    nodeExecutable: process.execPath,
    codexHome: join(home, ".codex"),
    now: () => current.now,
    connect: () => {
      current.connections++;
      return Promise.resolve({
        executable: current.executable,
        version: current.version,
        client: {
          readAccount: () =>
            Promise.resolve({
              type: "chatgpt",
              email: current.email,
              planType: "pro",
            }),
          readRateLimits: () =>
            Promise.resolve({
              primary: null,
              secondary: null,
              resetCredits: {
                availableCount: current.credits.length,
                detailsComplete: current.detailsComplete,
                credits: current.credits,
              },
            }),
          close: () => {
            current.closes++;
            return Promise.resolve();
          },
        },
      });
    },
    installRuntime: () => {
      current.runtimes++;
      return Promise.resolve({
        version: "0.1.0",
        sha256: "a".repeat(64),
        directory: join(home, "runtime"),
        entrypoint: join(home, "runtime", "cli.js"),
      });
    },
    scheduler: {
      preview: (plan) => ({
        platform: "systemd",
        artifactId: plan.planId,
        files: [],
        registration: { executable: "synthetic", arguments: [] },
      }),
      install: () => {
        current.installs++;
        return Promise.resolve();
      },
      inspect: () =>
        Promise.resolve({
          installed: true,
          enabled: true,
          detail: "synthetic",
        }),
      remove: () => Promise.resolve(),
    },
  };
  return {
    home,
    current,
    store,
    dependencies,
    assertNoWrites: async () => {
      assert.equal(current.installs, 0);
      assert.equal(current.runtimes, 0);
      assert.equal(await store.load(), null);
      assert.deepEqual(await readdir(home), []);
    },
  };
}
