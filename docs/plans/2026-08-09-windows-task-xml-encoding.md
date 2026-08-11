# Windows Task XML Encoding Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.

**Goal:** Register Resetrail tasks reliably on Windows while keeping the native
scheduler QA and cross-platform quality gate deterministic.

**Architecture:** Keep the documented `schtasks /XML` adapter, but encode its
temporary task file as UTF-16LE with a BOM. Reuse the existing atomic-write
durability path for byte content and leave systemd/launchd text behavior
unchanged.

**Tech Stack:** TypeScript 6, Node.js 22/24, node:test, pnpm 10.33.4, Windows
Task Scheduler.

---

### Task 1: Add the byte-level regression test

**Files:**

- Modify: `test/unit/scheduler-render.test.ts`

1. Add an install test whose fake command runner reads the `/XML` file when
   `schtasks.exe /Create` is invoked.
2. Assert that the first two bytes are `0xff, 0xfe`.
3. Decode the remaining bytes with `utf16le` and assert the `UTF-16` declaration
   and existing least-privilege settings.
4. Run `pnpm build:test` and the compiled scheduler-render test.
5. Confirm RED: the current UTF-8 file fails the BOM assertion.

### Task 2: Implement atomic UTF-16LE task serialization

**Files:**

- Modify: `src/scheduler/write.ts`
- Modify: `src/scheduler/windows.ts`

1. Extract the atomic create/sync/rename implementation to accept
   `string | Uint8Array`.
2. Keep `atomicWriteText(path, content, mode)` as the UTF-8 text wrapper.
3. Add `atomicWriteBytes(path, content, mode)` for already encoded bytes.
4. Change the task declaration to `encoding="UTF-16"`.
5. Encode with:

   ```ts
   Buffer.concat([
     Buffer.from([0xff, 0xfe]),
     Buffer.from(file.content, "utf16le"),
   ]);
   ```

6. Run the focused test and confirm GREEN.

### Task 3: Repair the Windows quality gate

**Files:**

- Create: `.gitattributes`
- Modify: `test/unit/paths.test.ts`
- Modify: `test/integration/state-store.test.ts`

1. Add `* text=auto eol=lf` so Windows checkouts preserve Prettier's LF
   contract.
2. Run Linux/macOS absolute-path assertions only on non-Windows hosts and keep
   the Windows path assertion active on all hosts.
3. Assert POSIX private mode bits only when `process.platform !== "win32"`.
4. Run `pnpm test` and confirm all 63 tests pass on Windows.

### Task 4: Verify repository and package quality

**Files:**

- Verify all changed files

1. Run `pnpm check`.
2. Confirm format, lint, secret scan, all tests, build, and dry-run pack pass.
3. Review `git diff`, ensuring no real credit IDs, credentials, or generated
   artifacts are tracked.

### Task 5: Run real Windows marker QA from `%TEMP%`

**Files:**

- Use: supplied `windows-qa.mjs`
- Create temporarily: `%TEMP%/resetrail-windows-qa-*`

1. Pack the worktree package into a new `%TEMP%` QA directory.
2. Copy the supplied checksum-verified `windows-qa.mjs` into that directory.
3. Initialize pnpm 10.33.4 and install the packed tarball with
   `--ignore-scripts`.
4. Run the harness and capture its exact JSON.
5. Require `ok`, read-back, enabled, no overlap, cleanup, and removal read-back
   fields to be successful.
6. Verify no `qa-*` task, `Resetrail-QA-*` directory, or temporary XML remains.
7. Remove the temporary QA directory.

### Task 6: Commit, push, and open the pull request

**Files:**

- Stage only the intended source, tests, attributes, and plan documents

1. Detect and follow the repository Gitmoji convention using the requested
   `commit` skill and its guard script.
2. Commit with a bug-fix Gitmoji subject.
3. Push `codex/fix-windows-task-xml-encoding` to `origin`.
4. Open a ready-for-review PR targeting `main`.
5. Use the exact commit subject as the PR title for squash merge compatibility.
