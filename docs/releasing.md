# Releasing

This is a single npm package. Its version lives in `package.json`. Builds embed
that version in the standalone scheduled runtime; there is no second version to
maintain.

## Workflows

- `ci.yml`: lint, tests, build and installed-package smoke checks on Linux,
  macOS and Windows, for the minimum supported Node version and Node 24.
- `publish.yml`: a `v*` tag triggers checks, build and npm publication using
  OIDC. A separate dependent job creates a GitHub Release with generated notes.
- `native-integration.yml`: optional, manually triggered tests of real native
  schedulers with a synthetic Codex backend on disposable hosted runners.

## One-time setup

In npm's package settings, configure a GitHub Actions trusted publisher:

- Owner: `nbsp1221`
- Repository: `codex-reset-scheduler`
- Workflow: `publish.yml`
- Environment: blank
- Allow direct `npm publish`; no separate dist-tag management permission needed.

npm includes staged publishing in new configurations by default. This workflow
uses direct publishing. No npm token is stored in GitHub. See
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for the
current configuration expiry and authentication requirements.

## Publish a version

1. Update `package.json` in a PR and describe the release. Run `pnpm check` and
   `pnpm test:package`.
2. Merge after CI passes and wait for main CI to pass. Publishing requires a
   separate explicit approval.
3. Tag that exact approved main commit and push the tag:

   ```sh
   git tag v0.1.2 <approved-main-commit>
   git push origin v0.1.2
   ```

4. Watch **Publish release**. Stable versions use npm's `latest` tag; versions
   containing a prerelease suffix use `next` and a GitHub prerelease.

Do not move or reuse a published tag. Publishing a GitHub Release does not
trigger npm.

## Publication and availability are different

A successful `npm publish` may report that the package is still processing.
Immediate registry visibility is not a condition of the publishing job. Do not
turn propagation delay into a second publishing attempt. Pre-publication package
checks run in CI; a later public-install check can confirm availability without
repeating the write.

If a publication step fails or is interrupted, inspect the original log and
exact registry version before deciding what to do. Never blindly rerun
publishing or change the version just to get a green workflow. npm versions are
immutable.

If npm publishing succeeded and only **github-release** failed, rerun that job
using GitHub's standard job rerun controls. First check whether the Release was
already created despite a lost response. Do not rerun the successful publisher.
See
[GitHub rerun documentation](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs).

Changing a workflow now does not repair an old run: reruns use its original SHA
and ref.
