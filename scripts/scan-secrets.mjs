import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const ignored = new Set([
  ".git",
  "node_modules",
  "dist",
  ".test-dist",
  "coverage",
]);
const textExtensions = new Set([
  ".ts",
  ".js",
  ".mjs",
  ".json",
  ".md",
  ".yml",
  ".yaml",
  ".toml",
  ".txt",
]);
const findings = [];

async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await scan(path);
      continue;
    }
    if (!entry.isFile() || !textExtensions.has(extname(entry.name))) continue;
    const text = await readFile(path, "utf8");
    const checks = [
      ["OpenAI-style secret", /\bsk-[A-Za-z0-9_-]{20,}\b/u],
      [
        "JWT",
        /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/u,
      ],
      ["real reset ID", /\bRateLimitResetCredit_[A-Fa-f0-9]{16,}\b/u],
      ["auth file payload", /"access_token"\s*:/u],
    ];
    for (const [label, pattern] of checks) {
      if (pattern.test(text))
        findings.push(`${relative(root, path)}: ${label}`);
    }
  }
}

await scan(root);
if (findings.length > 0) {
  console.error(findings.join("\n"));
  process.exitCode = 1;
} else console.log("Secret scan passed.");
