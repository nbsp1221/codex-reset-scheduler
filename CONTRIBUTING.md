# Contributing

Contributions are welcome after the initial release.

## Safety rules

1. Never run a live reset consume in tests, CI, examples, or review scripts.
2. Every consume call must be bound to one persisted exact credit ID.
3. Keep fake app-server fixtures synthetic; do not paste real IDs or responses.
4. Preserve persist-before-effect and read-after-consume ordering.
5. Treat timeout, EOF, crash, and unknown outcomes as ambiguous.
6. Dry-run code must not write files, register tasks, or mutate state.
7. Do not read Codex credential files. Use `codex app-server`.
8. Do not log raw credit IDs, email addresses, tokens, or backend payloads.

## Tests

Tests should validate externally meaningful contracts, not incidental
formatting. Unit tests cover pure policy and state transitions; contract tests
use a synthetic app-server; integration tests use isolated temporary
directories; native scheduler QA must use a harmless marker action.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

Before submitting a change, explain which safety invariant it affects and how
its failure cases are tested.

## Clean-room implementation

Resetrail is MIT licensed. Community projects may inform behavioral research,
but do not copy third-party source into this repository without a deliberate
license review and preserved attribution.
