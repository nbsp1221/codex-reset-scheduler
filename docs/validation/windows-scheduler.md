# Windows scheduler validation

Status: pending real-device marker QA.

Required evidence:

- Windows version and architecture
- build archive SHA-256
- current-user non-elevated task registration
- XML read-back with `InteractiveToken`, `LeastPrivilege`, `StartWhenAvailable`,
  and `IgnoreNew`
- marker observed inside the expected window
- duplicate invocation behavior
- task deletion and temporary-file cleanup

No Codex app-server or credential access is permitted in this QA.
