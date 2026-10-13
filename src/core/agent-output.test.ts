import test from "node:test";
import assert from "node:assert/strict";
import { AgentOutputFormatter, extractAgentFailure } from "./agent-output";

test("Codex JSONL becomes a readable terminal transcript across split chunks", () => {
  const formatter = new AgentOutputFormatter("codex");
  assert.equal(formatter.push("stdout", "{\"type\":\"thread.star"), "");
  const output = formatter.push("stdout", "ted\",\"thread_id\":\"abc\"}\n{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"Review complete\"}}\n");
  assert.match(output, /Codex session started/);
  assert.match(output, /Review complete/);
  assert.doesNotMatch(output, /thread_id/);
});

test("Codex command activity and usage remain visible", () => {
  const formatter = new AgentOutputFormatter("codex");
  const output = formatter.push("stdout", [
    JSON.stringify({ type: "item.started", item: { id: "one", type: "command_execution", command: "npm test" } }),
    JSON.stringify({ type: "item.completed", item: { id: "one", type: "command_execution", command: "npm test", aggregated_output: "18 tests passed", exit_code: 0 } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 25 } }),
    ""
  ].join("\n"));
  assert.match(output, /npm test/);
  assert.match(output, /18 tests passed/);
  assert.match(output, /100 input/);
});

test("Claude stream JSON shows prose, tools, and subagents without raw JSON", () => {
  const formatter = new AgentOutputFormatter("claude");
  const output = formatter.push("stdout", `${JSON.stringify({
    type: "assistant",
    parent_tool_use_id: "parent-one",
    message: { content: [
      { type: "text", text: "I found the cause." },
      { type: "tool_use", name: "Read", input: { file_path: "/tmp/a.ts" } }
    ] }
  })}\n`);
  assert.match(output, /Subagent/);
  assert.match(output, /I found the cause/);
  assert.match(output, /Read: \/tmp\/a.ts/);
  assert.doesNotMatch(output, /parent_tool_use_id/);
});

test("Claude rate status keeps every reported quota window readable", () => {
  const formatter = new AgentOutputFormatter("claude");
  const output = formatter.push("stdout", `${JSON.stringify({
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed",
      unifiedWindows: {
        five_day: { utilization: 0.12 },
        weekly: { utilization: 0.34 },
        monthly: { utilization: 0.56 }
      }
    }
  })}\n`);
  assert.match(output, /5 day 12%/);
  assert.match(output, /weekly 34%/);
  assert.match(output, /monthly 56%/);
  assert.doesNotMatch(output, /unifiedWindows/);
});

test("structured tool results do not leak JSON into Claude readable output", () => {
  const formatter = new AgentOutputFormatter("claude");
  const output = formatter.push("stdout", `${JSON.stringify({
    type: "user",
    message: { content: [{
      type: "tool_result",
      content: "Links: [{\"title\":\"Example\",\"url\":\"https://example.com\"}]\nREMINDER: internal instruction"
    }] }
  })}\n`);
  assert.match(output, /structured data/);
  assert.doesNotMatch(output, /\{\"title\"/);
  assert.doesNotMatch(output, /REMINDER/);
});

test("agent failure extraction uses the CLI's concrete error", () => {
  const stdout = `${JSON.stringify({ type: "result", is_error: true, errors: ["Reached maximum number of turns (8)"] })}\n`;
  assert.equal(extractAgentFailure(stdout, ""), "Reached maximum number of turns (8)");
  assert.match(extractAgentFailure("", "error: invalid option") ?? "", /invalid option/);
});
