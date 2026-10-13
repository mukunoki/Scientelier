import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { collectWorkSkills, workSkillsPrompt } from "./work-skills";
import { readRunSkill } from "./result-channel";
import { recordChannelState, readSkillUsage, recordSkillRead, SKILL_LOG_LIMIT } from "./channel-state";
import { buildWorkUnitPrompt, createStandardWorkflow } from "./orchestration";
import { WritingRulesStore, finishingPrompt, writingRulesPrompt } from "./finishing-skill";
import type { TaskRecord } from "./types";

function task(): TaskRecord {
  return { id: "skill-test", title: "Research", prompt: "Compare implementations", cwd: "/tmp/project", strategy: "balanced",
    allowedAgentIds: ["codex", "claude"], modelOverrides: {}, workUnits: createStandardWorkflow(), runs: [], state: "paused", createdAt: "", updatedAt: "", output: "" };
}

test("bundled skills have bounded, complete simple frontmatter and no placeholders", async () => {
  const root = join(__dirname, "../../assets/work-skills");
  const entries = await readdir(root);
  assert.equal(entries.length, 11);
  for (const id of entries) {
    const content = await readFile(join(root, id, "SKILL.md"), "utf8");
    // Deliberately restricted to our two plain scalar fields; not a YAML parser.
    const match = content.match(/^---\nname: ([a-z0-9]+(?:-[a-z0-9]+)*)\ndescription: ([^\n]+)\n---\n([\s\S]+)$/);
    assert.ok(match, id); assert.equal(match[1], id); assert.ok(id.length <= 64);
    assert.ok(match[2].length <= 1024); assert.doesNotMatch(match[2], /[<>]|: | #/);
    assert.doesNotMatch(content, /\[TODO:|TODO|TBD/);
    assert.ok(content.length < 12000 && match[3].trim().length > 100);
  }
});

test("skill routing exposes a small catalog; inspection/non-MCP retains complete applicable guidance", () => {
  const t = task(), unit = t.workUnits[1], before = JSON.stringify(t);
  const skills = collectWorkSkills(t, unit), catalog = workSkillsPrompt(t, unit, true);
  assert.equal(skills.length, 11);
  assert.equal(new Set(skills.map(s => s.id)).size, skills.length);
  for (const skill of skills) {
    assert.ok(catalog.includes(skill.id));
    assert.ok(!catalog.includes(skill.content), "catalog must not eagerly include skill bodies");
    assert.ok(buildWorkUnitPrompt(t, unit).includes(skill.content));
    assert.ok(!buildWorkUnitPrompt(t, unit, { deferSkills: true }).includes(skill.content));
  }
  assert.ok(catalog.length < workSkillsPrompt(t, unit).length / 3, "measure text reduction, not invented token savings");
  const reviewIds = collectWorkSkills(t, t.workUnits[2]).map(s => s.id);
  assert.ok(!reviewIds.includes("decision-memory"));
  const reporterIds = collectWorkSkills(t, t.workUnits[3]).map(s => s.id);
  assert.ok(!reporterIds.includes("hypothesis-design") && !reporterIds.includes("fair-benchmark"));
  const paperIds = collectWorkSkills(t, { ...unit, researchStage: "paper" }).map(s => s.id);
  assert.ok(!paperIds.includes("fair-benchmark") && paperIds.includes("related-research"));
  assert.deepEqual(collectWorkSkills({ ...t, goalPreparation: true }, unit), []);
  assert.equal(JSON.stringify(t), before);
});

test("managed catalog supplies captured overrides and does not resurrect retired builtins",()=>{
  const t=task();t.managedSkills=[{id:"fair-benchmark",description:"Changed purpose",content:"SAVED OVERRIDE"},{id:"project-check",description:"Project check",content:"PROJECT RULE"}];
  const worker=collectWorkSkills(t,t.workUnits[1]);
  assert.ok(worker.some(s=>s.content==="SAVED OVERRIDE"));
  assert.ok(worker.some(s=>s.id==="project-check"));
  assert.ok(!worker.some(s=>s.id==="hypothesis-design"));
  assert.ok(!collectWorkSkills(t,t.workUnits[3]).some(s=>s.id==="fair-benchmark"));
  assert.ok(buildWorkUnitPrompt(t,t.workUnits[1]).includes("PROJECT RULE"));
});

test("runtime skills reference complete pinned verification without duplicating it, retaining full fallbacks for older or partial custom rules", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shared-writing-rules-"));
  try {
    const store = new WritingRulesStore(join(process.cwd(), "assets/finishing-skills"), dir);
    const writing = await store.capture(), canonical = (await store.get("verification")).current.rules;
    const t = task(), originalTask = JSON.stringify(t), originalWriting = JSON.stringify(writing);
    for (const unit of t.workUnits) {
      const full = collectWorkSkills(t, unit), shared = collectWorkSkills(t, unit, writing);
      assert.deepEqual(shared.map(s => s.id), full.map(s => s.id));
      for (const id of ["document-checks", "related-research"]) {
        const fallback = full.find(s => s.id === id)!.content, routed = shared.find(s => s.id === id)!.content;
        assert.ok(routed.includes(writing.revision) && routed.includes("writing-rules"));
        assert.ok(routed.length < fallback.length * 0.7, "role boundary remains but shared details are not repeated");
        assert.ok(routed.includes("未確認"), "retrieval failure cannot be treated as pass");
      }
      assert.equal(shared.find(s => s.id === "script-reuse")!.content, full.find(s => s.id === "script-reuse")!.content);
      for (const partial of [writing.rules.replace(canonical, "## 数値・文献の検証\nCUSTOM SHORT RULE"), "LEGACY PINNED RULES"]) {
        assert.deepEqual(collectWorkSkills(t, unit, {...writing,rules:partial}), full, "labels or old revisions do not establish check coverage");
      }
      assert.deepEqual(collectWorkSkills(t, unit, {...writing, revision: "0".repeat(64)}), full, "a mismatched snapshot revision does not establish coverage");
      const customRules = writing.rules + "\nCUSTOM ADDITION";
      const customComplete = {...writing, revision: createHash("sha256").update(customRules).digest("hex"), rules: customRules};
      assert.ok(collectWorkSkills(t, unit, customComplete).find(s=>s.id==="document-checks")!.content.includes(customComplete.revision));
    }
    assert.equal(JSON.stringify(t), originalTask);
    assert.equal(JSON.stringify(writing), originalWriting, "pinned content remains unchanged");
  } finally { await rm(dir, {recursive:true,force:true}); }
});

test("deferred writing preserves revision/receipt requirements and complete custom rules on retrieval", () => {
  const t = task(), snapshot = { revision: "custom-revision", rules: "CUSTOM USER RULES", capturedAt: "" };
  assert.ok(writingRulesPrompt(snapshot).includes(snapshot.rules));
  assert.ok(!writingRulesPrompt(snapshot, true).includes(snapshot.rules));
  const prompt = finishingPrompt(t, snapshot, true);
  assert.ok(prompt.includes("writing-rules") && prompt.includes(snapshot.revision));
  assert.ok(prompt.includes("<editorial-check>") && prompt.includes("requiredSources"));
  const files = workSkillsPrompt(t, t.workUnits[1], true, "/tmp/space path/skills");
  assert.ok(files.includes('/tmp/space path/skills/script-reuse.md'));
  assert.ok(!files.includes("get_skill") && !files.includes(collectWorkSkills(t, t.workUnits[1])[0].content));
  const writingFile = finishingPrompt(t, snapshot, "/tmp/space path/skills/writing-rules.md");
  assert.ok(writingFile.includes("/tmp/space path/skills/writing-rules.md") && !writingFile.includes("get_skill"));
  assert.ok(writingFile.includes(snapshot.revision) && writingFile.includes("<editorial-check>"));
});

test("skill telemetry counts parallel/repeated reads, retains revisions and rejects foreign or partial records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-usage-"));
  try {
    assert.equal(await readSkillUsage(dir, "run"), undefined);
    const body = "本文の秘密ではない検証テキスト";
    await Promise.all(Array.from({ length: 30 }, () => recordSkillRead(dir, "run", "trial", body)));
    await recordSkillRead(dir, "run", "trial", "changed");
    await recordSkillRead(dir, "foreign", "trial", body);
    const log = await readFile(join(dir, "skill-reads.jsonl"), "utf8");
    assert.ok(!log.includes(body));
    await writeFile(join(dir, "skill-reads.jsonl"), log + 'null\n42\n{"token":');
    const usage = (await readSkillUsage(dir, "run"))!;
    assert.equal(usage.reads.length, 2); assert.equal(usage.reads[0].calls, 30);
    assert.equal(usage.estimatedTokens, 30 * Math.ceil(Buffer.byteLength(body) / 3) + Math.ceil(Buffer.byteLength("changed") / 3));
    assert.equal(usage.truncated, false);
    await writeFile(join(dir, "skill-reads.jsonl"), " ".repeat(SKILL_LOG_LIMIT));
    await recordSkillRead(dir, "run", "trial", body);
    assert.equal((await readFile(join(dir, "skill-reads.jsonl"))).length, SKILL_LOG_LIMIT);
    assert.equal((await readSkillUsage(dir, "run"))!.truncated, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("telemetry failure does not block a valid skill read and does not overwrite symlinks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-observation-"));
  try {
    await writeFile(join(dir, "instructions.txt"), "instructions");
    await writeFile(join(dir, "work-skills.json"), JSON.stringify({token:"run",skills:[{id:"trial",content:"body"}]}));
    await recordChannelState(dir, "run", "instructions-read");
    await writeFile(join(dir, "target.txt"), "unchanged");
    await symlink(join(dir, "target.txt"), join(dir, "skill-reads.jsonl"));
    assert.equal(await readRunSkill(dir, "run", {id:"trial"}), "body");
    assert.equal(await readFile(join(dir, "target.txt"), "utf8"), "unchanged");
    assert.equal(await readSkillUsage(dir, "run"), undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("run skill reader rejects arbitrary paths, stale/foreign runs, malformed and linked bundles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-reader-"));
  try {
    const bundle = { token: "run", skills: collectWorkSkills(task(), task().workUnits[1]) };
    await writeFile(join(dir, "instructions.txt"), "Scope");
    await writeFile(join(dir, "work-skills.json"), JSON.stringify(bundle));
    await assert.rejects(readRunSkill(dir, "run", { id: "skill-trial" }), /get_instructions/);
    await recordChannelState(dir, "run", "instructions-read");
    assert.equal(await readRunSkill(dir, "run", { id: "skill-trial" }), bundle.skills.find(s => s.id === "skill-trial")!.content);
    for (const args of [null, [], {}, { id: "../../secret" }, { id: "skill-trial", path: "/etc/passwd" }, { id: "unknown" }]) await assert.rejects(readRunSkill(dir, "run", args));
    await assert.rejects(readRunSkill(dir, "other", { id: "skill-trial" }));
    await writeFile(join(dir, "work-skills.json"), JSON.stringify({ ...bundle, token: "other" }));
    await assert.rejects(readRunSkill(dir, "run", { id: "skill-trial" }), /another run/);
    await writeFile(join(dir, "work-skills.json"), JSON.stringify({ ...bundle, skills: [bundle.skills[0], bundle.skills[0]] }));
    await assert.rejects(readRunSkill(dir, "run", { id: "script-reuse" }));
    await writeFile(join(dir, "other.json"), JSON.stringify(bundle));
    await rm(join(dir, "work-skills.json")); await symlink(join(dir, "other.json"), join(dir, "work-skills.json"));
    await assert.rejects(readRunSkill(dir, "run", { id: "script-reuse" }), /Invalid skill bundle/);
    await rm(join(dir, "instructions.txt"));
    await assert.rejects(readRunSkill(dir, "run", { id: "script-reuse" }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("standalone SSH helper exposes get_skill and returns exactly the frozen requested body", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-mcp-"));
  try {
    const skills = collectWorkSkills(task(), task().workUnits[1]);
    await writeFile(join(dir, "instructions.txt"), "CURRENT SCOPE AND CATALOG");
    await writeFile(join(dir, "work-skills.json"), JSON.stringify({ token: "run", skills }));
    for (const file of ["result-channel.js", "agent-messages.js", "redact.js", "execution-blocker.js", "work-check-format.js", "implementation-workspaces.js", "hpc.js", "quality.js", "research-cycle.js", "plan-format.js", "review-format.js", "channel-state.js", "runtime-identity.js"]) await writeFile(join(dir, file), await readFile(join(__dirname, file)));
    const child = spawn(process.execPath, [join(dir, "result-channel.js"), dir, "run"]);
    let stdout = "", stderr = "";
    child.stdout.on("data", c => { stdout += c; }); child.stderr.on("data", c => { stderr += c; });
    child.stdin.end([
      { id: 1, method: "tools/list" },
      { id: 2, method: "tools/call", params: { name: "get_skill", arguments: { id: "fair-benchmark" } } },
      { id: 3, method: "tools/call", params: { name: "get_instructions", arguments: {} } },
      { id: 4, method: "tools/call", params: { name: "get_skill", arguments: { id: "fair-benchmark" } } },
      { id: 5, method: "tools/call", params: { name: "get_skill", arguments: { id: "unknown" } } }
    ].map(r => JSON.stringify({ jsonrpc: "2.0", ...r })).join("\n") + "\n");
    assert.equal(await new Promise(resolve => child.on("close", resolve)), 0, stderr);
    const responses = stdout.trim().split("\n").map(s => JSON.parse(s));
    assert.ok(responses[0].result.tools.find((t: { name: string }) => t.name === "get_skill"));
    assert.equal(responses[1].result.isError, true);
    assert.equal(responses[2].result.content[0].text, "CURRENT SCOPE AND CATALOG");
    assert.equal(responses[3].result.content[0].text, skills.find(s => s.id === "fair-benchmark")!.content);
    assert.equal(responses[4].result.isError, true);
    const usage = (await readSkillUsage(dir, "run"))!;
    assert.equal(usage.reads.length, 1); assert.equal(usage.reads[0].id, "fair-benchmark"); assert.equal(usage.reads[0].calls, 1);
    await assert.rejects(readFile(join(dir, "handoff.json")), "reading skills cannot complete a run");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
