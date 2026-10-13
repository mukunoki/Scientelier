import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FinishingSkillStore, WritingRulesStore, WRITING_RULE_SECTIONS, finishingPrompt, writingRulesPrompt, validateFinishingCheck } from "./finishing-skill";
import { resultPermissionDecision, validateStructuredResult } from "./result-channel";
import type { TaskRecord } from "./types";
import { applyWritingRulesUpdate } from "./writing-rules-update";
import { createHash } from "node:crypto";

const builtin = join(process.cwd(), "assets", "finishing-skills", "de-ai-style", "SKILL.md");
test("writing rules travel once in six independently editable sections, including preserved style examples", async () => {
  const root = await mkdtemp(join(tmpdir(), "writing-expression-"));
  try {
    const assets = join(process.cwd(), "assets", "finishing-skills");
    const store = new WritingRulesStore(assets, root);
    assert.deepEqual(WRITING_RULE_SECTIONS, ["common", "style", "verification", "paper", "poster", "slides"]);
    const overrides = new Map<string, string>();
    for (const section of WRITING_RULE_SECTIONS) {
      const current = await store.get(section);
      const custom = await store.save(current.current.revision, current.current.rules + `\n既存の独自指示:${section}`, section);
      overrides.set(current.userPath, custom.rules);
    }
    const common = await store.get("common");
    const rules = common.current.rules;
    const snapshot = await store.capture();
    for (const phrase of ["二段階推敲", "日本語", "English", "日英両版がある場合だけ", "変更箇所の再確認", "全文・生成物の最終確認", "採用／不採用／保留", "禁止語リストや自動一括置換にしない", "分子・分母", "独立・敵対レビュー", "AI利用開示は保持"]) assert.ok(snapshot.rules.includes(phrase), phrase);
    assert.doesNotMatch(snapshot.rules, /humanizer_academic|writing_deodorize_kit|公開資料から追加|調査出典|https?:\/\//, "source bookkeeping is not delivered as writing instructions");
    const style = (await store.get("style")).current.rules;
    assert.equal(style.split("\n").filter(line => /^\|/.test(line)).length - 2, 19, "all existing replacement examples are retained");
    assert.deepEqual([...snapshot.rules.matchAll(/^## .+ \[(.+)\]$/gm)].map(m => m[1]), WRITING_RULE_SECTIONS);
    assert.equal(snapshot.rules.split(rules).length, 2, "common checks occur once, not once per source kit");
    assert.doesNotMatch(snapshot.rules, /name: report-writing-(expression|academic)/);
    assert.ok(writingRulesPrompt(snapshot).includes(rules));
    assert.ok(finishingPrompt({} as TaskRecord, snapshot).includes(rules));
    const deferred = writingRulesPrompt(snapshot, true);
    assert.ok(!deferred.includes(rules), "deferred delivery retrieves the pinned content instead of bloating the terminal prompt");
    assert.ok(deferred.includes(snapshot.revision));
    for (const [path, content] of overrides) assert.equal(await readFile(path, "utf8"), content);
    const updated = await store.save(common.current.revision, rules + "\n統合後の追加指示", "common");
    assert.doesNotMatch(snapshot.rules, /統合後の追加指示/);
    assert.equal((await new WritingRulesStore(assets, root).get("common")).current.revision, updated.revision);
    const old = await new FinishingSkillStore(join(assets, "report-writing-academic", "SKILL.md"), join(root, "old-reader")).capture();
    assert.ok(writingRulesPrompt(old).includes(old.rules), "historical snapshots still use their exact captured content");
    await assert.rejects(store.get("academic" as any), /種類/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("reviewed consolidation backs up customized sections, checks every revision and never rewrites pinned instructions", async () => {
  const root = await mkdtemp(join(tmpdir(), "writing-update-"));
  try {
    const assets = join(process.cwd(), "assets", "finishing-skills");
    const store = new WritingRulesStore(assets, root);
    const originals = new Map<string, string>();
    const plan = [];
    for (const section of ["common", "style", "verification", "paper"] as const) {
      const current = await store.get(section);
      const old = await store.save(current.current.revision, current.current.rules + `\n旧独自指示:${section}`, section);
      originals.set(section, old.rules);
      plan.push({ section, before: old.revision, after: createHash("sha256").update(current.defaultRules).digest("hex") });
    }
    const pinned = await store.capture();
    // A stale second item must not reset the first one, nor create backups.
    await assert.rejects(applyWritingRulesUpdate(assets, root, [plan[0], {...plan[1], before: "0".repeat(64)}]), /確認後/);
    assert.equal((await store.capture()).revision, pinned.revision);
    assert.equal((await readdir(root)).filter(p => p.startsWith("before-consolidation-")).length, 0);
    const result = await applyWritingRulesUpdate(assets, root, plan);
    assert.deepEqual(result.saved, ["common", "style", "verification", "paper"]);
    for (const item of plan) {
      assert.equal(await readFile(join(result.backupDirectory, `${item.section}.SKILL.md`), "utf8"), originals.get(item.section));
      assert.equal((await store.get(item.section)).current.revision, item.after);
    }
    assert.match(pinned.rules, /旧独自指示:common/);
    assert.doesNotMatch((await store.capture()).rules, /旧独自指示:/);
    // Unknown supplement overrides must be reviewed, never silently discarded.
    await mkdir(join(root, "report-writing-academic"));
    await writeFile(join(root, "report-writing-academic", "SKILL.md"), "custom");
    await assert.rejects(applyWritingRulesUpdate(assets, root, plan), /カスタム指示/);
    await assert.rejects(applyWritingRulesUpdate(assets, root, [plan[0], plan[0]]), /計画が不正/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("common writing rules verify related-work content rather than bibliography alone", async () => {
  const root = await mkdtemp(join(tmpdir(), "writing-related-research-"));
  try {
    const store = new WritingRulesStore(join(process.cwd(), "assets", "finishing-skills"), root);
    const captured = await store.capture();
    for (const phrase of ["関連研究の内容忠実性チェック", "書誌情報が正しくても", "主要な主張を全件対象", "原論文本文・図表・数式・実験設定・補足資料", "各担当", "クロスレビュー", "fail/unverified", "読み取り専用制約を破らない", "後続レビューの待機だけでレポーター工程を止めず"]) {
      assert.ok(writingRulesPrompt(captured).includes(phrase), phrase);
      assert.ok(finishingPrompt({} as TaskRecord, captured).includes(phrase), phrase);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("result prose interprets figures and tables without duplicating their numeric listings, while retaining essential evidence",async()=>{
  const root=await mkdtemp(join(tmpdir(),"writing-result-interpretation-"));
  try {
    const store=new WritingRulesStore(join(process.cwd(),"assets","finishing-skills"),root);
    const verification=(await store.get("verification")).current;
    const snapshot=await store.capture();
    for(const rule of ["図表の数値を順に読み上げず","主要な傾向・比較・例外","そこから分かること","観測結果と区別", "議論に必要なものに絞り",
      "数値を一切書かない規則や固定件数のノルマにはしない","重要な未達やばらつきを隠したりしない","日本語・英語の両方", "独立／敵対レビュー", "数字を削るだけで済ませず"]) {
      assert.ok(verification.rules.includes(rule),rule);
      assert.equal(snapshot.rules.split(rule).length,2,`${rule}: one canonical rule, not duplicated per medium`);
      assert.ok(writingRulesPrompt(snapshot).includes(rule));
      assert.ok(finishingPrompt({} as TaskRecord,snapshot).includes(rule));
    }
    for(const section of ["paper","poster","slides"] as const)assert.ok((await store.get(section)).current.rules.includes("共通ルール"));
    const deferred=writingRulesPrompt(snapshot,true);
    assert.match(deferred,/get_skill/);assert.ok(deferred.includes(snapshot.revision));
    assert.ok(!deferred.includes(verification.rules),"deferred users retrieve the same pinned rules, not another copy");
  } finally {await rm(root,{recursive:true,force:true});}
});
test("common bibliography rules require two different AIs, primary-source metadata and unabridged authors for every medium", async () => {
  const root = await mkdtemp(join(tmpdir(), "writing-bibliography-"));
  try {
    const store = new WritingRulesStore(join(process.cwd(), "assets", "finishing-skills"), root);
    const verification = (await store.get("verification")).current;
    for (const text of ["文献情報の一次ソース二重チェック", "異なる2種類のAI", "実際に異なるモデル系統", "相手の判定を根拠にせず", "著者全員の氏名と順序", "掲載論文誌・会議／論文集", "開始／終了ページ", "出版年・公開年", "一次ソースを実際に開いて", "生成されたPDF", "et al.", "頭文字から推測して展開しない", "変更文献を両AIで再確認", "後続レビューの待機だけでレポーター工程を止めず"]) assert.ok(verification.rules.includes(text), text);
    const captured = await store.capture();
    assert.ok(captured.rules.includes(verification.rules), "all document media share the same bibliography rules");
    assert.ok(writingRulesPrompt(captured).includes(verification.rules));
    assert.match(writingRulesPrompt(captured), /Planning\/coordinating roles/);
    assert.ok(finishingPrompt({} as TaskRecord, captured).includes(verification.rules));
    const workCommon = await readFile(join(process.cwd(), "assets/work-presets/common.md"), "utf8");
    assert.match(workCommon, /異なる2種類のAI/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("shared defaults own explanation order and whole-document review; media retain only their specific layout rules", async () => {
  const root = await mkdtemp(join(tmpdir(), "writing-story-"));
  try {
    const store = new WritingRulesStore(join(process.cwd(), "assets", "finishing-skills"), root);
    const common = (await store.get("common")).current.rules, snapshot = await store.capture();
    for (const rule of ["初めて使う箇所までに定義", "必要な定義・前提を後の節に先送り", "前節で分かったことが次節", "文書全体を冒頭から通読", "重複説明", "局所的な追記だけで済ませない"]) {
      assert.ok(common.includes(rule), rule);
      assert.equal(snapshot.rules.split(rule).length, 2, `${rule}: detailed requirement has one owner`);
    }
    for (const section of ["paper", "poster", "slides"] as const) assert.ok((await store.get(section)).current.rules.includes("共通ルール"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("writing rule sections preserve legacy overrides and independently persist into immutable combined snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "writing-sections-"));
  const assets = join(process.cwd(), "assets", "finishing-skills");
  try {
    const legacy = new FinishingSkillStore(builtin, join(root, "de-ai-style"));
    const initial = await legacy.capture();
    const old = await legacy.save(initial.revision, initial.rules + "\n既存の利用者ルールを保持");
    const store = new WritingRulesStore(assets, root);
    assert.deepEqual(await readdir(root), ["de-ai-style"]);
    assert.equal((await store.get()).current.rules, old.rules);
    assert.equal((await store.get()).current.revision, old.revision);
    const captured = await store.capture();
    for (const section of WRITING_RULE_SECTIONS) {
      const original = await store.get(section);
      assert.equal(original.section, section);
      assert.ok(captured.rules.includes(original.current.rules));
      if (section === "common") continue;
      const saved = await store.save(original.current.revision, original.current.rules + `\n固有テスト:${section}`, section);
      await assert.rejects(store.save(original.current.revision, original.current.rules, section), /変更/);
      assert.equal((await store.get()).current.revision, old.revision, "media edits do not change common rules");
      assert.equal((await new WritingRulesStore(assets, root).get(section)).current.revision, saved.revision);
      assert.ok(!(await store.get("common")).current.rules.includes(`固有テスト:${section}`));
      assert.ok((await store.capture()).rules.includes(`固有テスト:${section}`));
    }
    const combined = await store.capture();
    assert.notEqual(combined.revision, captured.revision);
    assert.doesNotMatch(captured.rules, /固有テスト:/, "saved run snapshots never change");
    assert.equal((await new WritingRulesStore(assets, root).capture()).revision, combined.revision);
    assert.match(writingRulesPrompt(combined), /文書ごとに共通ルール/);
    assert.match(finishingPrompt({} as TaskRecord, combined), /他の媒体のルールは適用しない/);
    await assert.rejects(store.get("../../escape" as any), /種類/);
    assert.throws(() => store.save(old.revision, old.rules, "constructor" as any), /種類/);
    const poster = await store.get("poster");
    await writeFile(poster.userPath, "broken external edit");
    await assert.rejects(store.capture(), /SKILL.md/, "broken media rules cannot silently be skipped");
    await rm(poster.userPath); await symlink(builtin, poster.userPath);
    await assert.rejects(store.capture(), /通常/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("legacy custom writing rules retain their exact content and revision across the rename", async () => {
  const root = await mkdtemp(join(tmpdir(),"writing-compat-"));
  try {
    const store = new FinishingSkillStore(builtin,join(root,"de-ai-style"));
    const current = await store.capture();
    const custom = current.rules.replace("name: report-writing", "name: de-ai-style") + "\n利用者固有の執筆方針";
    const saved = await store.save(current.revision,custom);
    assert.equal((await store.capture()).rules,custom);
    assert.equal((await store.capture()).revision,saved.revision);
    assert.ok(writingRulesPrompt(saved).includes(custom));
    assert.ok(!writingRulesPrompt(saved).includes('<editorial-check>'));
    assert.equal(await readFile(store.userPath,"utf8"),custom);
    const renamed = await store.save(saved.revision,custom.replace("name: de-ai-style","name: report-writing"));
    assert.match(renamed.rules,/name: report-writing/);
  } finally {await rm(root,{recursive:true,force:true});}
});
test("finishing skill supports isolated editable snapshots, stale-save protection and validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-finishing-"));
  try {
    const store = new FinishingSkillStore(builtin, join(root, "skill"));
    const original = await store.get();
    assert.equal(original.current.rules, await readFile(builtin, "utf8"));
    assert.deepEqual(await readdir(root), [], "reading bundled defaults does not create files");
    const saved = await store.save(original.current.revision, original.current.rules + "\n追加の編集方針");
    assert.notEqual(saved.revision, original.current.revision);
    assert.doesNotMatch(original.current.rules, /追加の編集方針/);
    assert.equal((await new FinishingSkillStore(builtin, join(root, "skill")).capture()).revision, saved.revision);
    await assert.rejects(store.save(original.current.revision, original.current.rules), /変更/);
    for (const invalid of ["", "missing frontmatter", saved.rules + "\0", saved.rules + "x".repeat(16001)]) await assert.rejects(store.save(saved.revision, invalid));
    assert.equal((await store.capture()).revision, saved.revision);
    const results = await Promise.allSettled([store.save(saved.revision, saved.rules + "\nFirst"), store.save(saved.revision, saved.rules + "\nSecond")]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.deepEqual(await readdir(join(root, "skill")), ["SKILL.md"]);
    await writeFile(store.userPath, "broken external edit");
    await assert.rejects(store.capture(), /SKILL.md/, "broken overrides cannot silently fall back and skip user rules");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("finishing skill refuses symlink overrides and symlink directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-finishing-link-"));
  try {
    const directory = join(root, "skill"); await mkdir(directory);
    await symlink(builtin, join(directory, "SKILL.md"));
    await assert.rejects(new FinishingSkillStore(builtin, directory).capture(), /通常/);
    await symlink(directory, join(root, "linked"));
    await assert.rejects(new FinishingSkillStore(builtin, join(root, "linked")).capture(), /通常/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("finishing receipt gates completion on revision, all registered sources and in-scope real files", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-editorial-check-"));
  try {
    const cwd = join(root, "work"), reports = join(root, "reports");
    await mkdir(cwd); await mkdir(reports);
    const texPath = join(reports, "report.tex"), poster = join(reports, "poster.tex"), slides = join(cwd, "slides.tex"), outside = join(root, "outside.txt");
    for (const path of [texPath, poster, slides, outside]) await writeFile(path, "Subject content");
    const task = { cwd, report: { state: "building", texPath, documents: { poster: { state: "building", texPath: poster } } } } as TaskRecord;
    const skill = await new FinishingSkillStore(builtin, join(root, "skill")).capture();
    const data = { revision: skill.revision, status: "completed", summary: "Edited repetition and checked all figures", sources: [texPath, poster, slides], concerns: [] };
    const block = (v: unknown) => `<editorial-check>${JSON.stringify(v)}</editorial-check>`;
    const valid = await validateFinishingCheck(task, skill, block(data));
    const prerequisites=await validateFinishingCheck(task,skill,block({...data,prerequisites:["刊行本文の独立照合は未確認"]}));
    assert.equal(prerequisites.status,"completed","editorial completion is not source verification");
    assert.deepEqual(prerequisites.prerequisites,["刊行本文の独立照合は未確認"]);
    for(const invalid of ["text",[""],[1]])await assert.rejects(validateFinishingCheck(task,skill,block({...data,prerequisites:invalid})),/前提確認事項/);
    const partial = await validateFinishingCheck(task, skill, block({...data,status:"blocked",concerns:["Independent source evidence missing"]}), true);
    assert.equal(partial.status,"blocked");
    assert.deepEqual(partial.concerns,["Independent source evidence missing"]);
    await assert.rejects(validateFinishingCheck(task, skill, block({...data,status:"blocked",revision:"wrong"}),true), /版が一致/);
    await assert.rejects(validateFinishingCheck(task, skill, block({...data,status:"blocked",sources:[texPath]}),true), /必要な文書/);
    await assert.rejects(validateFinishingCheck(task, skill, block({ ...data, status: "blocked", concerns: ["latexmk: command not found。PDF生成と全ページ確認が未実施。"] })), /latexmk: command not found/);
    await assert.rejects(validateFinishingCheck(task, skill, block({ ...data, revision: "old" })), /ルールの版が一致しません/);
    await assert.rejects(validateFinishingCheck(task, skill, block({ ...data, status: "blocked", concerns: [] })), /Edited repetition/);
    assert.equal(valid.sources.length, 3);
    assert.equal(validateStructuredResult(block(data)), block(data));
    assert.equal((resultPermissionDecision({ hook_event_name: "PreToolUse", tool_name: "mcp__agent_harness__submit_result", tool_input: { result: block(data) } }) as any).hookSpecificOutput.permissionDecision, "allow");
    for (const v of [{ ...data, revision: "old" }, { ...data, status: "blocked" }, { ...data, concerns: ["Unsupported result"] }, { ...data, sources: [texPath] }, { ...data, sources: [...data.sources, outside] }, { ...data, sources: [...data.sources, reports] }]) await assert.rejects(validateFinishingCheck(task, skill, block(v)));
    await assert.rejects(validateFinishingCheck(task, skill, "Done"), /完了確認/);
    await assert.rejects(validateFinishingCheck(task, skill, block(data) + block(data)), /完了確認/);
    await assert.rejects(validateFinishingCheck(task, undefined, block(data)), /完了確認/);
    await symlink(outside, join(cwd, "escape.tex"));
    await assert.rejects(validateFinishingCheck(task, skill, block({ ...data, sources: [...data.sources, join(cwd, "escape.tex")] })), /範囲外/);
    const prompt = finishingPrompt(task, skill);
    assert.ok(prompt.includes(skill.rules)); assert.ok(prompt.includes(skill.revision));
    assert.ok(prompt.includes(texPath)); assert.ok(prompt.includes(poster));
    assert.match(prompt, /slides.*speaker notes/); assert.match(prompt, /LAST editorial stage/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
