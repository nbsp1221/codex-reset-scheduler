# Windows scheduler validation

## Real-device marker QA

- Date: 2026-08-09 KST
- Environment: Windows 11 Pro 10.0.26200.8875, x64
- Runtime: Node.js 24.14.0, pnpm 10.33.4
- Session: normal logged-in user, non-elevated
- Package: fresh `pnpm pack` tarball installed into an isolated `%TEMP%`
  consumer directory with lifecycle scripts disabled
- Native path: current-user Task Scheduler task under `\Resetrail\`
- XML read-back: installed and enabled with `InteractiveToken`,
  `LeastPrivilege`, `StartWhenAvailable`, and `IgnoreNew`
- Planned triggers: two triggers separated by five seconds
- Observed delivery: one invocation, 150ms after the first trigger
- Duplicate behavior: the second trigger did not start an overlapping instance
- Cleanup: task, empty `\Resetrail\` folder, temporary XML, marker directory,
  and isolated consumer directory removed and confirmed absent

Result: pass.

```json
{
  "ok": true,
  "platform": "windows",
  "artifactId": "qa-55020-1786245835387",
  "osRelease": "Microsoft Windows [Version 10.0.26200.8875]",
  "architecture": "x64",
  "node": "v24.14.0",
  "plannedAt": ["2026-08-09T03:24:55.389Z", "2026-08-09T03:25:00.389Z"],
  "firstObservedAt": "2026-08-09T03:24:55.539Z",
  "firstDelayMilliseconds": 150,
  "configuredTriggerCount": 2,
  "observedInvocationCount": 1,
  "overlapDetected": false,
  "elevated": false,
  "installedReadBack": true,
  "enabledReadBack": true,
  "cleanedUp": true,
  "removalReadBackMissing": true
}
```

No Codex process, app-server method, credential, account data, or reset credit
was used in this QA.
