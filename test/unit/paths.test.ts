import assert from "node:assert/strict";
import test from "node:test";

import { managedPaths } from "../../src/persistence/paths.js";

test("managed paths follow native per-user conventions", () => {
  assert.equal(
    managedPaths({ platform: "linux", home: "/home/test", environment: {} })
      .stateFile,
    "/home/test/.local/state/resetrail/state.json",
  );
  assert.equal(
    managedPaths({ platform: "darwin", home: "/Users/test", environment: {} })
      .schedulerDirectory,
    "/Users/test/Library/LaunchAgents",
  );
  assert.match(
    managedPaths({
      platform: "win32",
      home: "C:\\Users\\test",
      environment: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
    }).stateDirectory,
    /Resetrail$/,
  );
});
