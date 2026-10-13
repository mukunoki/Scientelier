import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import assert from "node:assert/strict";

test("the full goal, native handoff, MCP, queue and cancellation workflow uses the prepared final-shell transport", async () => {
  // Separate process keeps the production IPC integration fixture isolated.
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", HARNESS_TEST_PREPARED: "1" };
  delete (env as NodeJS.ProcessEnv).NODE_TEST_CONTEXT;
  const result = await promisify(execFile)(process.execPath, ["--test", join(__dirname, "remote-workflow.test.js")], {
    env, maxBuffer: 1024 * 1024
  });
  assert.match(result.stdout, /pass 1/);
});
