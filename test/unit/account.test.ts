import assert from "node:assert/strict";
import test from "node:test";

import { accountFingerprint } from "../../src/codex/account.js";

test("account fingerprint normalizes email without retaining it", () => {
  const salt = "a".repeat(64);
  const first = accountFingerprint(
    { type: "chatgpt", email: " User@Example.Invalid ", planType: "pro" },
    salt,
  );
  const second = accountFingerprint(
    { type: "chatgpt", email: "user@example.invalid", planType: "pro" },
    salt,
  );
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(first, /example/u);
});

test("automatic account binding rejects a missing stable identity", () => {
  assert.throws(
    () =>
      accountFingerprint(
        { type: "chatgpt", email: null, planType: "pro" },
        "a".repeat(64),
      ),
    /no stable email identity/u,
  );
});
