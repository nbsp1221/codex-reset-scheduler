import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../.test-dist/test", import.meta.url));

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) return collect(path);
      return entry.isFile() && entry.name.endsWith(".test.js") ? [path] : [];
    }),
  );
  return files.flat().sort();
}

const files = await collect(root);
if (files.length === 0) throw new Error("No compiled tests were found.");

const coverage = process.argv.includes("--coverage");
const arguments_ = [
  ...(coverage ? ["--experimental-test-coverage"] : []),
  "--test",
  ...files,
];
const child = spawn(process.execPath, arguments_, { stdio: "inherit" });
child.once("error", (error) => {
  throw error;
});
const exitCode = await new Promise((resolve) => {
  child.once("exit", (code, signal) =>
    resolve(signal === null ? (code ?? 1) : 1),
  );
});
process.exitCode = exitCode;
