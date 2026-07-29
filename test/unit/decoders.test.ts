import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeConsumeResponse,
  decodeRateLimitsResponse,
} from "../../src/codex/decoders.js";

test("decoder marks capped credit details as incomplete", () => {
  const decoded = decodeRateLimitsResponse({
    rateLimits: { primary: { usedPercent: 10 }, secondary: null },
    rateLimitResetCredits: {
      availableCount: 2,
      credits: [
        {
          id: "synthetic-credit-a",
          resetType: "codexRateLimits",
          status: "available",
          grantedAt: 1_000,
          expiresAt: 2_000,
        },
      ],
    },
  });
  assert.equal(decoded.resetCredits?.detailsComplete, false);
});

test("decoder fails closed on unknown credit state", () => {
  assert.throws(
    () =>
      decodeRateLimitsResponse({
        rateLimits: { primary: { usedPercent: 10 }, secondary: null },
        rateLimitResetCredits: {
          availableCount: 1,
          credits: [
            {
              id: "synthetic-credit-a",
              resetType: "codexRateLimits",
              status: "future-state",
              grantedAt: 1_000,
            },
          ],
        },
      }),
    /status is unknown/,
  );
});

test("consume decoder fails closed on a future outcome", () => {
  assert.throws(
    () => decodeConsumeResponse({ outcome: "futureOutcome" }),
    /outcome is unknown/u,
  );
});
