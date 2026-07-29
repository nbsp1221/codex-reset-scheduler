# Repository instructions

- Never call a real `account/rateLimitResetCredit/consume` during development,
  tests, CI, review, examples, or QA.
- Use only synthetic credit IDs in tracked files.
- Keep every production consume request exact-ID-bound and plan-bound.
- Persist the idempotency key before sending consume; reuse it after ambiguity.
- Only confirmed `nothingToReset` may start a fresh logical attempt.
- Dry-run commands must not mutate filesystem state or native schedulers.
- Do not read or print Codex credentials, auth files, email addresses, or raw
  backend responses.
- Native scheduler QA must use a temporary harmless marker action and clean up.
- Run `pnpm check` before handing work off.
- Do not commit, push, or publish unless the user explicitly approves it.
