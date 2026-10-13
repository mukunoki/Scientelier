import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonFileWriter } from "./json-file-writer";

test("JSON saves snapshot values in order and recover after write failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "json-writer-")), root = join(directory, "data");
  try {
    const writer = new JsonFileWriter(join(root, "state.json"));
    await assert.rejects(writer.write({ before: true }));
    await mkdir(root);
    const value = { sequence: 1 }, first = writer.write(value);
    value.sequence = 2;
    await first;
    assert.deepEqual(JSON.parse(await readFile(join(root, "state.json"), "utf8")), { sequence: 1 });
    await Promise.all([writer.write(value), writer.write({ sequence: 3 })]);
    assert.deepEqual(JSON.parse(await readFile(join(root, "state.json"), "utf8")), { sequence: 3 });
    assert.deepEqual(await readdir(root), ["state.json"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
