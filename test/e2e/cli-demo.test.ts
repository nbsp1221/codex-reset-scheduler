import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

test(
  "actual CLI synthetic demo arms and cancels without consume or native tasks",
  {
    skip: process.platform !== "linux",
  },
  async () => {
    const script = fileURLToPath(
      new URL("../../../scripts/demo.mjs", import.meta.url),
    );
    const { stdout } = await promisify(execFile)(process.execPath, [script], {
      timeout: 60_000,
      windowsHide: true,
    });
    assert.match(stdout, /SYNTHETIC DEMO/u);
    assert.match(stdout, /status: armed; synthetic scheduler registered/u);
    assert.match(stdout, /status: disarmed; synthetic scheduler removed/u);
    assert.match(stdout, /zero consume requests/u);
    assert.match(
      stdout,
      /Cleanup: temporary synthetic state, runtimes and scheduler files removed/u,
    );
  },
);
