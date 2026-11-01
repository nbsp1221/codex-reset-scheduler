import { readFile, writeFile } from "node:fs/promises";

// Scheduled runtime snapshots contain dist only, so embed the package version.
const { version } = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
await writeFile(
  new URL("../src/version.ts", import.meta.url),
  `export const VERSION = ${JSON.stringify(version)};\n`,
);
