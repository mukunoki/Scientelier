import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyRestartReport, restartedTask, validateRestart } from "./task-restart";
import { JsonTaskStore } from "./task-store";
import { buildWorkUnitPrompt } from "./orchestration";
import type { TaskRecord } from "./types";

test("restart retains goal/settings but resets execution; carry and fresh have distinct context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "restart-test-"));
  try {
    const store = new JsonTaskStore(join(directory, "tasks.json")); await store.init();
    let source = await store.create({ title: "Source", prompt: "Original objective", cwd: directory, goalMode: "manual", strategy: "balanced", allowedAgentIds: ["codex"], modelOverrides: { codex: "custom" } });
    source = await store.update(source.id, { state: "completed", goal: { ...source.goal!, questions: [], status: "approved" }, instruction: "Latest instruction", workUnits: source.workUnits.map(u => ({ ...u, state: "completed", output: "OLD_WORK_CLAIM" })), autonomyState: "satisfied", output: "OLD_OUTPUT", budgetStatus: { used: 9999, reserve: 1, estimated: true }, contextPath: "/old/context", resumeCount: 8, pendingFollowup: { instruction: "Saved request", kind: "continue", assignments: {}, pauseAfterPlan: false } });
    const unchanged = JSON.stringify(source);
    assert.equal(restartedTask({...source,localCodexPermissions:"full-access"},"carry",directory).localCodexPermissions,"full-access");
    for (const state of ["completed", "paused", "blocked", "failed", "cancelled", "awaiting-input"] as const) {
      for (const mode of ["carry", "fresh"] as const) {
        const next = restartedTask({ ...source, state }, mode, mode === "carry" ? directory : join(directory, "clean"));
        assert.deepEqual(next.goal, source.goal); assert.deepEqual(next.execution, source.execution);
        assert.deepEqual(next.modelOverrides, source.modelOverrides);
        assert.notEqual(next.id, source.id); assert.equal(next.state, "queued");
        assert.deepEqual(next.runs, []); assert.equal(next.history, undefined); assert.equal(next.evaluations, undefined);
        assert.equal(next.executionPlans, undefined); assert.equal(next.autonomyState, undefined); assert.equal(next.contextPath, undefined);
        assert.equal(next.budgetStatus, undefined); assert.equal(next.resumeCount, undefined); assert.equal(next.output, "");
        assert.ok(next.workUnits.every(u => u.state === "pending" && !source.workUnits.some(old => old.id === u.id)));
        const prompt = buildWorkUnitPrompt(next, next.workUnits[0]);
        if (mode === "carry") { assert.match(prompt, /OLD_WORK_CLAIM/); assert.match(prompt, /Saved request/); }
        else { assert.doesNotMatch(prompt, /OLD_WORK_CLAIM|Saved request|OLD_OUTPUT|Latest instruction/); assert.match(prompt, /Fresh restart/); }
        assert.doesNotMatch(buildWorkUnitPrompt(next, next.workUnits.find(u => u.role === "reviewer")!), /OLD_WORK_CLAIM/);
        await store.insertRestart(next);
      }
    }
    assert.equal(JSON.stringify(store.get(source.id)), unchanged);
    const reloaded = new JsonTaskStore(join(directory, "tasks.json")); await reloaded.init();
    assert.equal(reloaded.list().length, 13);
    for (const mode of ["carry", "fresh"] as const) {
      for (const permission of [undefined, "sandbox", "full-access"] as const) {
        const original = { ...source, localCodexPermissions: permission };
        const next = restartedTask(original, mode, directory);
        assert.equal(next.localCodexPermissions, permission ?? "full-access");
        assert.equal(original.localCodexPermissions, permission, "the source task must not be migrated");
        const remote = { ...original, remote: { id: "r", name: "R", host: "cluster", cwd: "/work", nodeCommand: "node", startup: "", instructions: "", texCommand: "latexmk", codexPermissions: "sandbox" as const } };
        const remoteNext = restartedTask(remote, mode, directory);
        assert.equal(remoteNext.localCodexPermissions, permission, "remote restarts must not grant local fallback access");
        assert.deepEqual(remoteNext.remote, remote.remote);
      }
    }
    const draft = restartedTask({ ...source, goal: { ...source.goal!, status: "draft" } }, "fresh", directory);
    assert.equal(draft.awaitingReason, "goal"); assert.equal(draft.state, "awaiting-input");
    for (const state of ["queued", "planning", "running", "reviewing", "reporting"] as const) assert.throws(() => validateRestart({ ...source, state }, "fresh"));
    assert.throws(() => validateRestart(source, "invalid"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("report handoff copies sources/assets, excludes logs/cache and cannot modify originals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "restart-copy-"));
  try {
    const root = join(directory, "original"); await mkdir(join(root, "paper"), { recursive: true });
    for (const path of ["report.tex", "report.pdf", "paper/main.tex", "paper/main.pdf", "figure.svg"]) await writeFile(join(root, path), `Original ${path}`);
    for (const name of ["logs", "versions", ".tex-cache"]) { await mkdir(join(root, name)); await writeFile(join(root, name, "old"), "ignored"); }
    const report: TaskRecord["report"] = { state: "ready", texPath: join(root, "report.tex"), pdfPath: join(root, "report.pdf"), documents: { paper: { state: "ready", texPath: join(root, "paper/main.tex"), pdfPath: join(root, "paper/main.pdf") } } };
    const copied = await copyRestartReport(report, join(directory, "copied"));
    assert.equal(copied!.state, "draft"); assert.equal(copied!.previewUrl, undefined); assert.equal(copied!.documents!.paper!.state, "draft");
    assert.deepEqual((await readdir(join(directory, "copied"))).sort(), ["figure.svg", "paper", "report.pdf", "report.tex"]);
    await writeFile(copied!.texPath!, "Changed copy");
    assert.equal(await readFile(report.texPath!, "utf8"), "Original report.tex");
    assert.equal(await readFile(copied!.documents!.paper!.texPath!, "utf8"), "Original paper/main.tex");
    const occupied = join(directory, "occupied"); await mkdir(occupied);
    await writeFile(join(occupied, "keep.txt"), "Do not overwrite or delete");
    await assert.rejects(copyRestartReport(report, occupied), { code: "EEXIST" });
    assert.equal(await readFile(join(occupied, "keep.txt"), "utf8"), "Do not overwrite or delete");
    assert.deepEqual(await readdir(occupied), ["keep.txt"]);
    await assert.rejects(copyRestartReport(report, root), { code: "EEXIST" });
    assert.equal(await readFile(report.texPath!, "utf8"), "Original report.tex");
    await symlink(join(root, "report.tex"), join(root, "link.tex"));
    await assert.rejects(copyRestartReport(report, join(directory, "unsafe")), /リンク/);
    assert.equal(await copyRestartReport(undefined, join(directory, "none")), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("failed report copy removes only its own partial destination, preserving the original", async t => {
  const directory = await mkdtemp(join(tmpdir(), "restart-failed-copy-"));
  try {
    const root = join(directory, "source"), destination = join(directory, "new-copy");
    await mkdir(root); await writeFile(join(root, "report.tex"), "Original source");
    t.mock.method(require("node:fs/promises"), "cp", async (_from: string, target: string) => {
      await writeFile(target, "partial copy");
      throw Object.assign(new Error("Fixture copy failure"), { code: "EIO" });
    });
    await assert.rejects(copyRestartReport({ state: "draft", texPath: join(root, "report.tex") }, destination), { code: "EIO" });
    await assert.rejects(readdir(destination), { code: "ENOENT" });
    assert.equal(await readFile(join(root, "report.tex"), "utf8"), "Original source");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
