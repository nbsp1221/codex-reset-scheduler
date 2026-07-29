import assert from "node:assert/strict";
import test from "node:test";

import { armConfirmationPhrase } from "../../src/cli-core.js";

test("a single arm confirmation binds the public selector", () => {
  assert.equal(armConfirmationPhrase(["abc123def456"]), "ARM abc123def456");
});

test("multi-arm confirmation binds the exact reviewed count", () => {
  assert.equal(
    armConfirmationPhrase(["abc123def456", "789abc012def"]),
    "ARM 2 RESETS",
  );
});
