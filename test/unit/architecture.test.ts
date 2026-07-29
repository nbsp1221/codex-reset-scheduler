import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

test("production exposes one exact-credit consume gateway and one plan-bound caller", async () => {
  const source = join(process.cwd(), "src");
  const files = await sourceFiles(source);
  const texts = await Promise.all(
    files.map(async (path) => ({ path, text: await readFile(path, "utf8") })),
  );
  const rpcOwners = texts.filter(({ text }) =>
    text.includes('"account/rateLimitResetCredit/consume"'),
  );
  assert.deepEqual(
    rpcOwners.map(({ path }) => path.slice(source.length + 1)),
    [join("codex", "app-server-client.ts")],
  );

  const callerOwners = texts.filter(({ text }) =>
    text.includes(".consumeExactCredit("),
  );
  assert.deepEqual(
    callerOwners.map(({ path }) => path.slice(source.length + 1)),
    [join("application", "worker-service.ts")],
  );
  assert.equal(
    texts.some(({ text }) => text.includes("auth.json")),
    false,
  );
  assert.equal(
    texts.some(({ text }) => text.includes("shell: true")),
    false,
  );
});

async function sourceFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
    }),
  );
  return nested.flat().toSorted();
}
