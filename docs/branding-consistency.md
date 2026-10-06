# Branding and reference consistency

The official product, npm package, and installed command are all
**codex-reset-scheduler**. The canonical repository is
`https://github.com/nbsp1221/codex-reset-scheduler`.

`pnpm branding:check` runs the consistency checker and isolated in-memory
regression cases. A temporary local Git fixture also verifies that the CLI
returns a failing exit status for obsolete URLs, wrong checkout directories, and
retired current product wording. `pnpm check` includes that command.

The checker reads Git's tracked and non-ignored task files, including hidden
GitHub configuration. It checks the README heading, npm name and single bin,
package repository/bugs/homepage links, security reporting URL, and the source
clone plus checkout directory in README and installation instructions. Current
Markdown and GitHub YAML must not describe the product under a retired name.
Retired repository URLs are rejected outside the exact historical records and
the checker regression fixture file.

The security issue configuration must match the current explicit canonical
block, including the active `Security vulnerability` name and URL. LF/CRLF and
trailing whitespace at the end of the file are accepted. This narrow contract
rejects URLs hidden in comments or other contacts; review and update it
explicitly if the configuration structure changes.

## Intentional residual references

- Six named files under `docs/plans` and `docs/validation` preserve their
  original observations and commands. The checker lists those exact files; new
  documents in those directories receive normal checks.
- README, installation, and name-change notes contain specific whole lines
  identifying the former name or explaining the preserved namespaces. Other
  lines in those documents remain checked, including current URLs.
- Private state, locks, worker snapshots, scheduler identities, internal
  protocol/error names, fake variables, and temporary prefixes keep their
  original identifiers. Production source is not renamed by this check.
- The checker regression file keeps deliberate invalid inputs in isolated
  fixtures. It does not modify checkout files or contact accounts or schedulers;
  its CLI fixture is isolated and removed afterward.

Changing an exception requires a concrete historical or compatibility reason.
Keep current product declarations, clone instructions, and canonical links
outside exceptions. This check does not validate credentials, account
compatibility, native delivery, npm ownership, or every possible spelling error.
