import test from "node:test";
import assert from "node:assert/strict";
import { resolveRemoteBaseDir } from "../src/import-config";

test("empty Remotely Save directory falls back to vault name", () => {
  assert.equal(resolveRemoteBaseDir("", "Obsidian"), "Obsidian");
  assert.equal(resolveRemoteBaseDir(undefined, "Obsidian"), "Obsidian");
});

test("explicit Remotely Save directory remains authoritative", () => {
  assert.equal(resolveRemoteBaseDir("/Obsidian/", "Other Vault"), "Obsidian");
});
