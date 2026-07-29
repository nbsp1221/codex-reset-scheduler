# macOS scheduler validation

Status: pending real-device marker QA.

Required evidence:

- macOS version and architecture
- build archive SHA-256
- `plutil -lint` success
- LaunchAgent bootstrap and `launchctl print` read-back
- marker observed inside the expected window
- duplicate invocation behavior
- bootout and plist removal
- optional sleep/wake catch-up observation

No Codex app-server or credential access is permitted in this QA.
