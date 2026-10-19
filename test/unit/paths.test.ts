import assert from "node:assert/strict";
import test from "node:test";

import { managedPaths } from "../../src/persistence/paths.js";

test("managed paths preserve the original shared namespace after the name change", () => {
  if (process.platform !== "win32") {
    assert.equal(
      managedPaths({ platform: "linux", home: "/home/test", environment: {} })
        .stateFile,
      "/home/test/.local/state/resetrail/state.json",
    );
    assert.equal(
      managedPaths({ platform: "darwin", home: "/Users/test", environment: {} })
        .stateDirectory,
      "/Users/test/Library/Application Support/Resetrail",
    );
    assert.equal(
      managedPaths({ platform: "darwin", home: "/Users/test", environment: {} })
        .logDirectory,
      "/Users/test/Library/Logs/Resetrail",
    );
    assert.equal(
      managedPaths({ platform: "darwin", home: "/Users/test", environment: {} })
        .schedulerDirectory,
      "/Users/test/Library/LaunchAgents",
    );
  }
  assert.match(
    managedPaths({
      platform: "win32",
      home: "C:\\Users\\test",
      environment: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
    }).stateDirectory,
    /Resetrail$/,
  );
  assert.equal(
    managedPaths({ platform: "win32", environment: {} }).schedulerDirectory,
    "\\Resetrail",
  );
});
