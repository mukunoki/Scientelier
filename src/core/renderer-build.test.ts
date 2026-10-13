import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

test("Scientelier branding retains legacy data and encryption identity", async () => {
  const html = await readFile("src/renderer/index.html", "utf8");
  const main = await readFile("src/main.ts", "utf8");
  const packageInfo = JSON.parse(await readFile("package.json", "utf8"));
  const lockInfo = JSON.parse(await readFile("package-lock.json", "utf8"));
  assert.equal(packageInfo.name, "scientelier");
  assert.equal(packageInfo.productName, "Scientelier");
  assert.equal(lockInfo.name, packageInfo.name);
  assert.equal(lockInfo.packages[""].name, packageInfo.name);
  assert.match(html, /<title>Scientelier<\/title>/);
  assert.match(html, /class="brand-name">Scientelier</);
  assert.match(html, /class="brand-mark">Sc</);
  assert.match(main, /app\.setName\("agent-harness"\)/);
  assert.match(main, /runtimePaths\(app\.getPath\("appData"\), app\.getPath\("documents"\), projectRoot/);
  assert.match(main, /app\.setPath\("userData", runtime\.userData\)/);
  const paths = await readFile("src/core/runtime-paths.ts", "utf8");
  assert.match(paths, /join\(appData, "agent-harness"\)/);
  assert.ok(main.indexOf("app.setName") < main.indexOf("requestSingleInstanceLock"));
  assert.match(main, /title: "Scientelier"/);
  assert.match(main, /applicationName: "Scientelier"/);
  assert.doesNotMatch(main, /app\.getAppPath\(\)/);
});

test("renderer bundle is browser-safe", async () => {
  const html = await readFile("src/renderer/index.html", "utf8");
  const scripts = [...html.matchAll(/src="\.\.\/\.\.\/(dist\/renderer\/[^\"]+\.js)"/g)].map(match => match[1]);
  assert.ok(scripts.includes("dist/renderer/cli-login.js"));
  assert.ok(scripts.includes("dist/renderer/terminal-logs.js"));
  assert.ok(scripts.includes("dist/renderer/reports.js"));
  assert.ok(scripts.includes("dist/renderer/task-state.js"));
  assert.ok(!scripts.includes("dist/renderer/claude-login.js"));
  assert.equal(scripts.length, new Set(scripts).size, "each global renderer script loads only once");
  const sources = (await readdir("src/renderer")).filter(name => name.endsWith(".ts") && !name.endsWith(".d.ts"));
  assert.deepEqual(scripts.map(path => path.replace("dist/renderer/", "").replace(/\.js$/, ".ts")).sort(), sources.sort(), "no renderer module is compiled but unreachable from the app");
  for (const path of scripts) {
    const output = await readFile(path, "utf8");
    assert.doesNotMatch(output, /\bexports\b/, path);
    assert.doesNotMatch(output, /\brequire\s*\(/, path);
  }
});

test("dispatch is a separate sidebar view from the task workspace", async () => {
  const html = await readFile(join(process.cwd(), "src", "renderer", "index.html"), "utf8");
  const output = await readFile(join(process.cwd(), "dist", "renderer", "index.js"), "utf8");
  assert.match(html, /id="nav-dispatch"/);
  assert.match(html, /id="dispatch-view" class="view hidden"/);
  assert.match(html, /id="tasks-view" class="view"/);
  assert.doesNotMatch(html, /id="global-status"/);
  assert.match(html, /id="resource-summary" class="resource-summary[^\"]*"/);
  assert.match(html, /id="resource-usage-dialog" class="resource-usage-dialog"/);
  assert.doesNotMatch(html, /task-console-layout/);
  assert.match(output, /"概要"/);
  assert.match(output, /"実行"/);
  assert.match(output, /"成果・検証"/);
  assert.match(output, /"履歴"/);
  assert.match(output, /renderResourceSummary/);
  assert.doesNotMatch(html, /id="task-workflow-mode"/);
  assert.match(output, /buildExecutionMetrics/);
  assert.match(output, /showView\("tasks"\)/);
});

test("interactive terminals have no monitor, history or clear controls", async () => {
  const output = await readFile("dist/renderer/terminals.js", "utf8");
  const preload = await readFile("dist/preload.js", "utf8");
  assert.doesNotMatch(output, /screenHistoryPane|historyMode|originalMode|terminalScreen|terminalHistory|画面モニター|画面履歴|表示クリア/);
  assert.doesNotMatch(preload, /terminal:screen|terminal:history/);
  assert.match(output, /pane.append\(view.notice, view.host\)/);
  assert.match(output, /notice.textContent = snapshot.startupIssue \?\? snapshot.notificationIssue/);
  assert.match(output, /notice.dataset.kind = snapshot.startupIssue \? "startup" : "notification"/);
});

test("Resources owns the only CLI editor rather than duplicating system settings", async () => {
  const layout = await readFile("dist/renderer/settings-layout.js", "utf8");
  const main = await readFile("dist/renderer/index.js", "utf8");
  const html = await readFile("src/renderer/index.html", "utf8");
  assert.match(layout, /byId\("resource-grid"\)\.append\(byId\("settings-models"\)\)/);
  assert.doesNotMatch(main, /expandedResources|unified-service-card/);
  assert.doesNotMatch(html, /id="open-routing-settings"/);
  assert.match(main, /view === "usage"[\s\S]{0,100}services-shown/);
});
