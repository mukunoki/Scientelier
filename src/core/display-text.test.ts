import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { AgentOutputFormatter } from "./agent-output";

async function formatter(): Promise<{ humanOutput: (s: string) => string; historyOutput: (s?: string, error?: string) => string }> {
  const source = await readFile("dist/renderer/display-text.js", "utf8");
  return runInNewContext(`${source}\n({humanOutput, historyOutput})`);
}
test("readable text removes full terminal protocols, preserves Unicode and handles truncated control strings", async () => {
  const { humanOutput } = await formatter();
  const protocols = ["\x1b]10;?\x07", "\x1bP+q4d73\x1b\\", "\x1b_Gi=31337;AAAA\x1b\\", "\x1b]1337;Capabilities\x1b\\", "\x1b^private\x1b\\", "\x1bXprivate\x1b\\", "\x9dtitle\x9c", "\x90data\x9c", "\x1b[?2027h", "\x1b(B"];
  for (const control of protocols) assert.equal(humanOutput(`日本語${control}English 🧪\n完了`), "日本語English 🧪\n完了");
  for (const tail of ["\x1b", "\x1b[?202", "\x1b]4;0;?", "\x1bPpartial", "\x1b_Gpayload"]) assert.equal(humanOutput(`本文${tail}`), "本文");
  assert.equal(humanOutput("\x1b[31m失敗\x1b[0m\r\n\t条件\x00\x07"), "失敗\n\t条件");
  assert.equal(humanOutput(`<work-check>${JSON.stringify({summary:"\x1b[32m検証済み\x1b[0m"})}</work-check>`), "進捗確認\n検証済み");
});
test("history separates native TUI recordings from reports while retaining stop reasons and source data", async () => {
  const { historyOutput } = await formatter();
  const raw = "\x1b[?2031h\x1b]10;?\x07\x1bP+q4d73\x1b\\\x1b_Gi=31337;AAAA\x1b\\old frame\x1b[Hnew frame";
  const unit = { output: raw, error: "\x1b[31mAPIへの接続に失敗しました\x1b[0m" };
  const rendered = historyOutput(unit.output, unit.error);
  assert.match(rendered, /CLI原画面/); assert.match(rendered, /「実行」/);
  assert.match(rendered, /APIへの接続に失敗しました/);
  assert.doesNotMatch(rendered, /\x1b|AAAA|4d73|old frame|new frame/);
  assert.equal(unit.output, raw);
  assert.equal(historyOutput("\x1b[32m通常の作業報告\x1b[0m"), "通常の作業報告");
  assert.equal(historyOutput(undefined, "停止理由"), "停止理由");
  assert.equal(historyOutput(""), "未実行");
  assert.equal(historyOutput('設定例: {"port":8080}'), '設定例: {"port":8080}');
});
test("management logs become prose without changing ordinary JSON deliverables or original records", async () => {
  const { humanOutput } = await formatter();
  for (const tag of ["goal-draft", "goal-evaluation", "execution-plan", "work-plan", "work-check", "editorial-check"]) {
    const raw = `<${tag}>${JSON.stringify({ summary: "Reviewed actual files", criteria: [{ criterionId: "report", status: "fail", detail: "Reference unresolved" }], concerns: ["Fix citation"] })}</${tag}>`;
    const output = humanOutput(`Before\n${raw}\nAfter`);
    assert.match(output, /Before/); assert.match(output, /After/); assert.match(output, /Reviewed actual files/); assert.match(output, /要修正.*Reference unresolved/); assert.match(output, /Fix citation/);
    assert.doesNotMatch(output, /"summary"|"criteria"|<goal|<work|<editorial/);
    assert.match(raw, /"summary"/, "source records remain untouched");
  }
  assert.equal(humanOutput('Example configuration: {"port": 8080}'), 'Example configuration: {"port": 8080}');
  assert.doesNotMatch(humanOutput('<work-check>{"status":"rea'), /"status"/);
  assert.doesNotMatch(humanOutput('<work-check>bad JSON</work-check>'), /bad JSON/);
});
test("legacy readable tool results no longer repeat their structured payload", () => {
  const output = new AgentOutputFormatter("claude").push("stdout", JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: '{"title":"Hidden payload","items":[1,2]}' }] } }) + "\n");
  assert.match(output, /structured data/); assert.doesNotMatch(output, /Hidden payload|"title"/);
});
