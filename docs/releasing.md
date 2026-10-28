# Releasing

Release decisions are manual. Version changes use an ordinary PR; pushing a
verified version tag starts the only npm publishing workflow. GitHub Release
notes are generated after npm publication and registry-install verification.

## One-time owner setup

Before the first automated publication, the package owner must confirm npm
account access and ownership of `codex-reset-scheduler`. A registry lookup does
not reserve the name or prove ownership. If the package has never been
published, complete its first publication separately with explicit approval and
a reviewed tarball; trusted-publisher settings require an existing package. Do
not add a token fallback to this workflow.

In the npm package's **Settings → Trusted publishing**, configure GitHub
Actions:

- Organization/user: `nbsp1221`
- Repository: `codex-reset-scheduler`
- Workflow filename: `publish.yml` (no directory prefix)
- Environment: leave blank; this workflow does not use a GitHub environment
- Allowed actions: enable direct `npm publish`

Create this configuration close to the intended release: npm expires an unused
configuration after two days. No npm secret is needed in GitHub. The publish job
uses GitHub-hosted Ubuntu, Node 24, pinned npm 11.6.2, and job-scoped
`id-token: write`. The project continues to build with pnpm 10.33.4. See
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and the
[initial-publication limitation](https://github.com/npm/cli/issues/8544).

## Each version

1. Open a version/release PR updating **both** `package.json` and
   `src/version.ts`, with release notes in the PR. The constant stays
   self-contained for immutable worker snapshots; checks reject drift from the
   manifest. Use a canonical `MAJOR.MINOR.PATCH` or
   `MAJOR.MINOR.PATCH-prerelease` version without build metadata.
2. Run `pnpm check` and `pnpm test:package`. Merge only after CI passes. Wait
   for the merged main commit's six OS/Node checks to succeed.
3. After publication approval, create `v<version>` on that exact verified main
   commit and push the tag. For example:

   ```sh
   git tag v0.1.1 <verified-main-commit>
   git push origin v0.1.1
   ```

   For `0.2.0-rc.1`, use tag `v0.2.0-rc.1`. Stable versions publish to npm's
   `latest` tag; prereleases publish to `next` and create a prerelease on
   GitHub. The pushed tag must match the manifest exactly and must not be
   deleted. Do not move or reuse a release tag. Publishing a GitHub Release does
   not trigger npm.

4. Check **Publish release** through completion. It validates the tag/SHA,
   version coherence and successful main CI, runs checks, packs once, and tests
   that installed tarball in an empty consumer. The publish job downloads and
   hashes that same artifact before its single OIDC publish attempt. It then
   checks exact registry-version integrity and installs
   `codex-reset-scheduler@<version>` with a fresh cache, checking the installed
   CLI's version, help and empty status. Only after those checks succeed does
   the final job create a public GitHub Release for the existing tag with
   generated notes. Only this job has `contents: write`; only the npm publisher
   has `id-token: write`.

Package smoke checks use isolated HOME/config/state directories and no Codex
account, native registration or reset consumption. Package access stays public
and provenance enabled. The manually runnable **Release validation** workflow
only checks and uploads a tarball; it cannot publish.

## Interrupted or failed publication

Do not blindly rerun a failed publish. npm may have accepted the request before
the client failed. Inspect the exact version and the retained Actions tarball.
Rerunning the npm publish job stops before another publication attempt, and a
new run refuses an already visible version; lookup errors are not treated as
absence. Registry visibility checks retry reads only. An uncertain publication
requires investigation, not another tag push or a GitHub Release event.

To repeat only the registry installation check after inspecting the result,
download that run's `codex-reset-scheduler-package-<attempt>` artifact and, from
the exact release checkout with Node and npm available, run:

```sh
node scripts/release-registry.mjs after /path/to/package.tgz
```

This command does not publish. It requires the registry bytes to match the
artifact before installing the exact version. If publication is confirmed,
finish verification rather than publish again. If the outcome remains unknown,
stop and investigate. Never overwrite a published version or repair it by moving
the Git tag; a corrected package needs a new version PR.

## GitHub Release creation failure

If npm publication and registry installation succeeded and only the
`github-release` job failed, rerun the failed job only:

```sh
gh run rerun <run-id> --failed
```

The successful verify/publish jobs are not rerun. The Release job rechecks the
existing tag and accepts an already published Release only when its tag and
prerelease metadata match. This also handles a creation request that succeeded
before its client failed. Lookup errors and mismatched visible metadata fail
without another creation attempt. Inspect existing drafts before retrying.
