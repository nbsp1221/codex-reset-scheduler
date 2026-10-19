import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function atomicWriteText(
  path: string,
  content: string,
  mode: number,
): Promise<void> {
  await atomicWrite(path, content, mode);
}

export async function atomicWriteBytes(
  path: string,
  content: Uint8Array,
  mode: number,
): Promise<void> {
  await atomicWrite(path, content, mode);
}

async function atomicWrite(
  path: string,
  content: string | Uint8Array,
  mode: number,
): Promise<void> {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", mode);
  try {
    if (typeof content === "string") await handle.writeFile(content, "utf8");
    else await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
