import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkBranding, readBrandingFiles } from "./check-branding.mjs";

const files = await readBrandingFiles(
  fileURLToPath(new URL("../", import.meta.url)),
);
const repository = "https://github.com/nbsp1221/codex-reset-scheduler";
const oldRepository = "https://github.com/nbsp1221/resetrail";

function changed(path, transform) {
  const fixture = new Map(files);
  const original = fixture.get(path);
  assert.notEqual(original, undefined);
  const modified = transform(original);
  assert.notEqual(modified, original);
  fixture.set(path, modified);
  return fixture;
}

function rejected(fixture, category) {
  const findings = checkBranding(fixture);
  assert.ok(
    findings.some((finding) => finding.includes(category)),
    findings.join("\n"),
  );
}

test("current files pass with documented history and namespace mentions", () => {
  assert.deepEqual(checkBranding(files), []);
});

test("the active security contact cannot borrow the canonical URL", () => {
  const path = ".github/ISSUE_TEMPLATE/config.yml";
  const advisory = repository + "/security/advisories/new";
  const original = files.get(path);
  const wrong = original.replace(advisory, "https://example.invalid/report");
  for (const config of [
    wrong + "# url: " + advisory + "\n",
    wrong + "  - name: Project home\n    url: " + advisory + "\n",
    wrong +
      original
        .split("\n")
        .map((line) => "# " + line)
        .join("\n"),
    original.replace("Security vulnerability", "Project home"),
    original.replace(
      "    about:",
      "    url: https://example.invalid/report\n    about:",
    ),
  ]) {
    const fixture = new Map(files);
    fixture.set(path, config);
    rejected(fixture, "canonical active security contact configuration");
  }
});

test("the canonical security configuration permits LF and CRLF endings", () => {
  const path = ".github/ISSUE_TEMPLATE/config.yml";
  const original = files.get(path);
  for (const config of [
    original.trimEnd(),
    original.replace(/\n/gu, "\r\n"),
    original + "\n \t\n",
  ]) {
    const fixture = new Map(files);
    fixture.set(path, config);
    assert.deepEqual(checkBranding(fixture), []);
  }
});

test("retired URL in the hidden security issue configuration fails", () => {
  rejected(
    changed(".github/ISSUE_TEMPLATE/config.yml", (text) =>
      text.replace(repository, oldRepository),
    ),
    "retired repository URL",
  );
});

for (const path of ["README.md", "docs/installation.md"]) {
  test("wrong clone checkout directory in " + path + " fails", () => {
    rejected(
      changed(path, (text) =>
        text.replace("cd codex-reset-scheduler", "cd resetrail"),
      ),
      "checkout directory",
    );
  });
}

test("wrong source URL fails even without a retired brand", () => {
  rejected(
    changed("README.md", (text) =>
      text.replace(
        "git clone " + repository + ".git",
        "git clone https://github.com/example/other.git",
      ),
    ),
    "canonical repository",
  );
});

test("npm product and bin names must agree", () => {
  for (const key of ["name", "bin"]) {
    rejected(
      changed("package.json", (text) => {
        const pkg = JSON.parse(text);
        if (key === "name") pkg.name = "resetpilot";
        else pkg.bin = { resetpilot: "dist/cli.js" };
        return JSON.stringify(pkg);
      }),
      key === "name" ? "npm name" : "official CLI bin",
    );
  }
});

test("each package repository field must be canonical", () => {
  for (const key of ["repository", "bugs", "homepage"]) {
    rejected(
      changed("package.json", (text) => {
        const pkg = JSON.parse(text);
        if (key === "repository") pkg.repository.url = oldRepository + ".git";
        else if (key === "bugs") pkg.bugs.url = oldRepository + "/issues";
        else pkg.homepage = oldRepository + "#readme";
        return JSON.stringify(pkg);
      }),
      key + " must use",
    );
  }
});

test("README product heading must agree with npm and bin", () => {
  rejected(
    changed("README.md", (text) =>
      text.replace("# codex-reset-scheduler", "# Codex ResetPilot"),
    ),
    "heading differs",
  );
});

test("retired current product wording in CONTRIBUTING fails", () => {
  rejected(
    changed("CONTRIBUTING.md", (text) =>
      text.replace("codex-reset-scheduler is MIT", "Resetrail is MIT"),
    ),
    "retired product name",
  );
});

test("compatibility documents cannot hide a current obsolete URL or brand", () => {
  rejected(
    changed(
      "docs/name-change.md",
      (text) => text + "\nCurrent repository: " + oldRepository + "\n",
    ),
    "retired repository URL",
  );
  rejected(
    changed(
      "docs/name-change.md",
      (text) => text + "\nCurrent product: Codex ResetPilot\n",
    ),
    "retired product name",
  );
});

test("new files inside historical directories are not automatically exempt", () => {
  const fixture = new Map(files);
  fixture.set(
    "docs/validation/current-guide.md",
    "Use Resetrail from " + oldRepository + ".",
  );
  rejected(fixture, "retired repository URL");
  rejected(fixture, "retired product name");
});

test("obsolete repository URLs in source comments also fail", () => {
  rejected(
    changed("src/cli-core.ts", (text) => text + "\n// " + oldRepository + "\n"),
    "retired repository URL",
  );
});

test("URL query strings and Markdown closing delimiters cannot bypass checks", () => {
  for (const ending of ["?tab=readme", ")", "#readme", ".git"]) {
    rejected(
      changed(
        "src/cli-core.ts",
        (source) => source + "\n// " + oldRepository + ending + "\n",
      ),
      "retired repository URL",
    );
  }
});

test("valid JSON that is not package metadata fails", () => {
  for (const value of [null, [], "package", 0]) {
    rejected(
      changed("package.json", () => JSON.stringify(value)),
      "invalid package metadata",
    );
  }
});

test("the CLI exits nonzero for isolated bad URL, checkout and brand fixtures", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "codex-reset-scheduler-branding-test-"),
  );
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  const paths = [
    "package.json",
    "README.md",
    "CONTRIBUTING.md",
    "docs/installation.md",
    "docs/name-change.md",
    ".github/ISSUE_TEMPLATE/config.yml",
    "scripts/check-branding.mjs",
  ];
  try {
    for (const path of paths) {
      await mkdir(dirname(join(directory, path)), { recursive: true });
      await writeFile(join(directory, path), files.get(path));
    }
    const initialized = spawnSync("git", ["init", "--quiet", directory], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(initialized.error, undefined);
    assert.equal(initialized.status, 0);
    const run = (entry = join(directory, "scripts/check-branding.mjs")) =>
      spawnSync(process.execPath, [entry], {
        cwd: directory,
        encoding: "utf8",
        windowsHide: true,
        timeout: 20_000,
      });
    assert.equal(run().status, 0);
    const imported = spawnSync(process.execPath, ["--input-type=module", "-"], {
      cwd: directory,
      encoding: "utf8",
      windowsHide: true,
      timeout: 20_000,
      input:
        "await import(" +
        JSON.stringify(
          pathToFileURL(join(directory, "scripts/check-branding.mjs")).href,
        ) +
        "); console.log('import-only');",
    });
    assert.equal(imported.error, undefined);
    assert.equal(imported.status, 0);
    assert.equal(imported.stdout, "import-only\n");
    let alias;
    if (process.platform !== "win32") {
      alias = join(directory, "checker-alias.mjs");
      await symlink(join(directory, "scripts/check-branding.mjs"), alias);
      assert.equal(run(alias).status, 0);
    }
    for (const [path, original, replacement, category] of [
      [
        ".github/ISSUE_TEMPLATE/config.yml",
        repository,
        oldRepository,
        "retired repository URL",
      ],
      [
        ".github/ISSUE_TEMPLATE/config.yml",
        "    url: " + repository + "/security/advisories/new",
        "    url: https://example.invalid/report\n# url: " +
          repository +
          "/security/advisories/new",
        "canonical active security contact configuration",
      ],
      [
        "README.md",
        "cd codex-reset-scheduler",
        "cd resetrail",
        "checkout directory",
      ],
      [
        "CONTRIBUTING.md",
        "codex-reset-scheduler is MIT",
        "Resetrail is MIT",
        "retired product name",
      ],
    ]) {
      const text = files.get(path);
      assert.ok(text.includes(original));
      await writeFile(
        join(directory, path),
        text.replace(original, replacement),
      );
      const result = run();
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes(category), result.stderr);
      if (alias) {
        const aliasedResult = run(alias);
        assert.equal(aliasedResult.error, undefined);
        assert.equal(aliasedResult.status, 1);
        assert.ok(
          aliasedResult.stderr.includes(category),
          aliasedResult.stderr,
        );
      }
      await writeFile(join(directory, path), text);
    }
    assert.equal(run().status, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
