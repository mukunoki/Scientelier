import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runtimePaths } from "./runtime-paths";

test("publication preserves existing data identity and keeps isolated profiles outside code", () => {
  const root = mkdtempSync(join(tmpdir(), "scientelier-paths-")), code = join(root, "source");
  mkdirSync(code);
  try {
    assert.deepEqual(runtimePaths(root, root, code), { userData: join(root, "agent-harness"), reports: join(root, "Agent Harness Reports") });
    const data = join(root, "profile");
    assert.deepEqual(runtimePaths(root, root, code, data), { userData: data, reports: join(data, "reports") });
    for (const invalid of ["", "relative", code, join(code, "new-data")]) assert.throws(() => runtimePaths(root, root, code, invalid));
    const alias = join(root, "alias"); symlinkSync(code, alias);
    assert.throws(() => runtimePaths(root, root, code, join(alias, "new-data")), /ソース/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
