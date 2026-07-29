import assert from "node:assert/strict";
import test from "node:test";

import { decodeInstallState } from "../../src/domain/state-schema.js";
import { creditSelector } from "../../src/domain/policy.js";

test("state decoder rejects fields that could silently broaden authority", () => {
  assert.throws(
    () =>
      decodeInstallState({
        schemaVersion: 1,
        revision: 0,
        installId: "00000000-0000-4000-8000-000000000001",
        accountSalt: "a".repeat(64),
        plans: [],
        continuous: true,
      }),
    /unexpected or missing fields/,
  );
});

test("state decoder rejects malformed installation identity", () => {
  assert.throws(
    () =>
      decodeInstallState({
        schemaVersion: 1,
        revision: 0,
        installId: "not-a-uuid",
        accountSalt: "short",
        plans: [],
      }),
    /installation identity/,
  );
});

test("state decoder binds the selector to the exact raw credit ID", () => {
  const creditId = "synthetic-credit-a";
  assert.throws(
    () =>
      decodeInstallState({
        schemaVersion: 1,
        revision: 1,
        installId: "00000000-0000-4000-8000-000000000001",
        accountSalt: "a".repeat(64),
        plans: [
          {
            planId: "00000000-0000-4000-8000-000000000002",
            status: "armed",
            creditId,
            creditSelector: creditSelector("different-credit"),
            resetType: "codexRateLimits",
            grantedAt: 1_000,
            expiresAt: 3_000,
            notBefore: 2_000,
            accountFingerprint: "b".repeat(64),
            runtimeVersion: "0.1.0",
            runtimeSha256: "c".repeat(64),
            codexExecutable: "/synthetic/codex",
            codexVersionAtArm: "synthetic",
            codexHome: "/synthetic/.codex",
            attempt: null,
            scheduler: {
              platform: "systemd",
              artifactId: "synthetic",
              triggerTimesUtc: ["2026-01-01T00:00:00.000Z"],
            },
            terminalReason: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    /does not match its credit ID/u,
  );
});
