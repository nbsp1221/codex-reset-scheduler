import { createHash } from "node:crypto";

import { SafetyError } from "../domain/errors.js";
import type { ChatgptAccount } from "../domain/types.js";

export function accountFingerprint(
  account: ChatgptAccount,
  salt: string,
): string {
  if (account.email === null || account.email.trim().length === 0) {
    throw new SafetyError(
      "The ChatGPT account has no stable email identity; automatic arming is unavailable.",
      "account_identity_unavailable",
    );
  }
  return createHash("sha256")
    .update(salt)
    .update("\0")
    .update(account.email.trim().toLocaleLowerCase("en-US"))
    .digest("hex");
}
