import { execFileSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const product = "codex-reset-scheduler";
const repository = "https://github.com/nbsp1221/codex-reset-scheduler";

// These six records keep the names used when their observations were made.
// New documents in either directory are not automatically exempt.
const historicalFiles = new Set([
  "docs/plans/2026-08-09-windows-task-xml-encoding-design.md",
  "docs/plans/2026-08-09-windows-task-xml-encoding.md",
  "docs/validation/2026-10-03-release-preparation.md",
  "docs/validation/linux-live-redemption.md",
  "docs/validation/macos-scheduler.md",
  "docs/validation/windows-scheduler.md",
]);

const normalize = (line) => line.trim().replace(/\s+/gu, " ");
// Whole lines only: attribution and documented storage/protocol identities.
// This never exempts a current URL or the rest of a compatibility document.
const compatibilityLines = new Map([
  ["README.md", ["The project was previously named Resetrail."]],
  ["docs/installation.md", ["The project was previously named Resetrail."]],
  [
    "docs/name-change.md",
    [
      "The project was previously named Resetrail.",
      "| Linux | `$XDG_STATE_HOME/resetrail` or `~/.local/state/resetrail` | `resetrail-<plan-id>` service/timer |",
      "| macOS | `~/Library/Application Support/Resetrail`; logs in `~/Library/Logs/Resetrail` | `dev.resetrail.plan.<plan-id>` LaunchAgent |",
      "| Windows | `%LOCALAPPDATA%/Resetrail` | `\\Resetrail\\<plan-id>` Task Scheduler task |",
      "`codex-reset-scheduler`; it does not claim the old `resetrail` executable name",
      "The app-server client name `resetrail`, internal `ResetrailError` class,",
      "`RESETRAIL_FAKE_*` test variables, and temporary artifact prefixes also remain.",
    ],
  ],
]);

const retiredBrand = /resetrail|resetpilot/iu;
const retiredURL =
  /github\.com\/nbsp1221\/(?:resetrail|codex-resetpilot)(?![A-Za-z0-9_-])/iu;
const isCurrentDocument = (path) =>
  (path.endsWith(".md") ||
    (path.startsWith(".github/") && /\.ya?ml$/u.test(path))) &&
  !historicalFiles.has(path);

export async function readBrandingFiles(root) {
  const paths = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  return new Map(
    await Promise.all(
      paths.map(async (path) => [
        path,
        await readFile(resolve(root, path), "utf8"),
      ]),
    ),
  );
}

export function checkBranding(files) {
  const findings = [];
  const fail = (path, line, message) =>
    findings.push(path + ":" + line + ": " + message);
  let pkg;
  try {
    pkg = JSON.parse(files.get("package.json") ?? "");
    if (pkg === null || typeof pkg !== "object" || Array.isArray(pkg)) {
      fail("package.json", 1, "missing or invalid package metadata");
      pkg = undefined;
    }
  } catch {
    fail("package.json", 1, "missing or invalid package metadata");
  }
  if (pkg) {
    if (pkg.name !== product)
      fail("package.json", 1, "npm name differs from the official product");
    if (
      JSON.stringify(pkg.bin) !== JSON.stringify({ [product]: "dist/cli.js" })
    )
      fail("package.json", 1, "export exactly the official CLI bin");
    for (const [key, actual, expected] of [
      ["repository", pkg.repository?.url, "git+" + repository + ".git"],
      ["bugs", pkg.bugs?.url, repository + "/issues"],
      ["homepage", pkg.homepage, repository + "#readme"],
    ]) {
      if (actual !== expected)
        fail("package.json", 1, key + " must use the canonical repository URL");
    }
  }
  if ((files.get("README.md") ?? "").split(/\r?\n/u)[0] !== "# " + product)
    fail("README.md", 1, "heading differs from the official product");

  for (const [path, text] of files) {
    if (historicalFiles.has(path)) continue;
    const allowed = compatibilityLines.get(path) ?? [];
    for (const [index, line] of text.split(/\r?\n/u).entries()) {
      // Deliberate obsolete URL fixtures, never shipped examples.
      if (path !== "scripts/check-branding.test.mjs" && retiredURL.test(line))
        fail(path, index + 1, "retired repository URL");
      if (
        isCurrentDocument(path) &&
        retiredBrand.test(line) &&
        !allowed.includes(normalize(line))
      )
        fail(
          path,
          index + 1,
          "retired product name outside an exact compatibility line",
        );
    }
  }

  for (const path of ["README.md", "docs/installation.md"]) {
    const lines = (files.get(path) ?? "").split(/\r?\n/u);
    const clones = lines.flatMap((line, index) =>
      line.startsWith("git clone ") ? [index] : [],
    );
    if (clones.length !== 1)
      fail(path, 1, "document exactly one canonical source clone");
    for (const index of clones) {
      if (lines[index] !== "git clone " + repository + ".git")
        fail(path, index + 1, "source clone must use the canonical repository");
      if (lines[index + 1] !== "cd " + product)
        fail(
          path,
          index + 2,
          "clone checkout directory must match the repository name",
        );
    }
  }
  if (
    !(files.get(".github/ISSUE_TEMPLATE/config.yml") ?? "").includes(
      "url: " + repository + "/security/advisories/new",
    )
  )
    fail(
      ".github/ISSUE_TEMPLATE/config.yml",
      1,
      "security reporting must use the canonical repository",
    );
  return findings;
}

const modulePath = await realpath(fileURLToPath(import.meta.url));
const entryPath = process.argv[1]
  ? await realpath(process.argv[1]).catch(() => undefined)
  : undefined;

if (entryPath === modulePath) {
  const root = resolve(modulePath, "..", "..");
  const findings = checkBranding(await readBrandingFiles(root));
  if (findings.length > 0) {
    console.error(findings.join("\n"));
    process.exitCode = 1;
  } else console.log("Branding consistency check passed.");
}
