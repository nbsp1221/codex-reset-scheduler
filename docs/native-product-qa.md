# Optional native product QA

`Installed product native flow` is a permanent, optional manual regression
workflow. Run it on a release candidate after changes to packaging, CLI arm or
cancel, scheduling, worker execution, or persistence. It is not an automatic
release gate. Existing ordinary CI continues to run safety regressions.

Run the workflow from GitHub Actions after it exists on the default branch. Only
disposable GitHub-hosted runners are supported. Local and self-hosted/shared
environments are refused before product/native mutation. Environment overrides
alone do not isolate the production worker on every platform, so the test uses
the real default product paths in each fresh hosted runner. Absence checks and
nonce directories are not an exclusivity guarantee for a shared account.

Only Codex is fake. The packed/installed bin, CLI, real user/session scheduler,
production runtime snapshot, worker and persistence remain real. The bounded
wait observes natural timers; no direct worker invocation or kickstart counts.
User actions run the installed npm bin on every OS. Internal product imports are
limited to readiness, native cleanup and runtime/state evidence. The fake API
owns only protocol responses and synthetic credit/UUID results; a separate
synchronous test callback observes product storage at receipt of consume, before
any fake effect or response. Logs check required event counts/order and
forbidden consume results while permitting unrelated informational events.

Reports cover normal exact-target processing, cancellation, account/target
change blocking, persist-before-consume UUID evidence, status/logs, and cleanup.

Cleanup removes recorded unique native resources and known product files only.
It never recursively removes product or QA directories. Missing/empty/unrelated
state, unknown files/directories, changed symlinks or failed cleanup are
preserved and reported as failures. Empty owned directories are removed with
`rmdir`.

A passing hosted run verifies product behavior against this synthetic protocol
fixture; it does not establish compatibility with the current external API. It
does not verify real-account/current-Codex compatibility, physical-device
sleep/reboot, login-session changes, or network outages. Unsupported or
unexecuted environments do not count as a pass. No real credentials or credits
are accessed. No package is published by this workflow.
