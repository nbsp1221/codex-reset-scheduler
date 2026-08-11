# Windows Task XML Encoding Design

## Problem

Resetrail renders Windows Task Scheduler XML with an `encoding="UTF-8"`
declaration and writes it as UTF-8 bytes without a byte-order mark. On Windows
11 10.0.26200, `schtasks.exe /Create /XML` rejects that file with
`unable to switch the encoding`. The same task definition registers when it is
serialized as UTF-16LE with a BOM and an `encoding="UTF-16"` declaration.

## Research

As of 2026-08-09:

- Microsoft documents `schtasks /Create /XML` as supported on Windows 11 and
  Windows Server 2025.
- The Task Scheduler schema is the contract for task definitions, and Microsoft
  documents native registration through `ITaskFolder::RegisterTask` using a
  Unicode `BSTR` XML string.
- `Register-ScheduledTask -Xml` likewise accepts a PowerShell `String`.
- GitHub recommends repository-level `.gitattributes` rules to make line-ending
  behavior independent of contributor Git settings.
- Node.js documents that Windows can manipulate only the write permission, so
  POSIX mode-bit assertions are not portable to Windows.

The supported `schtasks /XML` path remains appropriate for Resetrail's
zero-production-dependency command adapter. Serializing its temporary XML in the
Windows-compatible Unicode form is a smaller and safer change than replacing the
registration backend.

## Design

1. Preserve `atomicWriteText` for systemd and launchd artifacts.
2. Add an atomic byte writer that shares the same create, sync, rename, and
   cleanup guarantees.
3. Render Windows task XML with an `UTF-16` declaration and serialize it as
   UTF-16LE with a leading `FF FE` BOM before invoking `schtasks.exe`.
4. Add a regression test that observes the exact temporary file at the `/Create`
   boundary and verifies both the BOM and decoded XML.
5. Make the two existing cross-platform tests reflect host filesystem semantics:
   POSIX path expectations run on POSIX, Windows path expectations run on
   Windows, and POSIX permission bits are asserted only on POSIX.
6. Add `.gitattributes` to keep repository text files LF on every checkout.

## Validation

- Observe the new regression test fail before production changes.
- Run focused scheduler tests, then the full `pnpm check` gate.
- Pack the branch into a `%TEMP%` directory, install that exact tarball with
  pnpm 10.33.4, and run the supplied harmless `windows-qa.mjs` harness.
- Require successful registration/read-back, one observed marker invocation,
  `IgnoreNew` overlap suppression, and complete task/directory cleanup.

## Sources

- https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/schtasks-create
- https://learn.microsoft.com/en-us/windows/win32/taskschd/task-scheduler-schema
- https://learn.microsoft.com/en-us/windows/win32/api/taskschd/nf-taskschd-itaskfolder-registertask
- https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/register-scheduledtask?view=windowsserver2025-ps
- https://docs.github.com/en/get-started/git-basics/configuring-git-to-handle-line-endings
- https://nodejs.org/api/fs.html#file-modes
