import test from "node:test";
import assert from "node:assert/strict";
import { WorkspaceTrust, type WorkspaceTrustAgent } from "./workspace-trust";

function trustScreen(agent: WorkspaceTrustAgent, path: string, yes = false): string {
  return `\n────────────────────────────────────────────────────\nAccessing workspace:\n\n${path}\n\n${agent === "claude"
    ? "Quick safety check: Is this a project you created or one you trust?\nClaude Code'll be able to read, edit, and execute files here.\nSecurity guide"
    : "Do you trust the contents of this project?\nAntigravity CLI requires permission to read, edit, and execute files here."}\n\n${yes ? "" : agent === "claude" ? "❯ " : "> "}No, exit\n${yes ? agent === "claude" ? "❯ " : "> " : ""}Yes, I trust this folder\n\n${agent === "claude" ? "Enter to confirm · Esc to cancel" : "↑/↓ Navigate · enter Confirm"}\n`;
}

for (const agent of ["claude", "antigravity"] as const) {
  test(`${agent} trusts only the exact launch folder, once, after a selected-Yes redraw`, () => {
    const guard = new WorkspaceTrust(agent, "/home/example");
    const no = trustScreen(agent, "/home/example"), yes = trustScreen(agent, "/home/example", true);
    assert.equal(guard.inspect("Accessing workspace:\n/home/ex"), undefined);
    assert.equal(guard.inspect(no.slice(0, 110)), undefined);
    assert.equal(guard.inspect(no), "\x1b[B");
    assert.equal(guard.inspect(no), undefined);
    assert.equal(guard.inspect(yes), "\r");
    assert.equal(guard.inspect(yes), undefined);
    for (const path of ["/home/other", "/home/example/subdir", "/home/examples", "/home/example ", "/home/ex ample"])
      assert.equal(new WorkspaceTrust(agent, "/home/example").inspect(trustScreen(agent, path, true)), undefined);
  });

  test(`${agent} ignores log quotes, login, extra grants, ambiguous options and foreign CLI dialogs`, () => {
    const yes = trustScreen(agent, "/home/example", true);
    for (const screen of ["Allow reading /home/example?", "Login required", "MCP server trust?", "Tool output:\n" + yes,
      yes.replace("Yes, I trust this folder", "Yes, allow all"), yes.replace("No, exit", "No, continue without these permissions"),
      yes.replace("Accessing workspace:", "Moving to a new directory:"),
      yes.replace("files here.", "files here.\nAllow an additional directory /home/other?"),
      yes.replace("No, exit", (agent === "claude" ? "❯ " : "> ") + "No, exit"),
      yes.replace("Yes, I trust this folder", "Yes, trust it and apply them"),
      trustScreen(agent === "claude" ? "antigravity" : "claude", "/home/example", true)]) {
      assert.equal(new WorkspaceTrust(agent, "/home/example").inspect(screen), undefined);
    }
    for (const stop of [(g: WorkspaceTrust) => g.disable(), (g: WorkspaceTrust) => g.observeData("x".repeat(128001)),
      (g: WorkspaceTrust) => g.inspect("get_instructions"), (g: WorkspaceTrust) => g.inspect("? for shortcuts")]) {
      const guard = new WorkspaceTrust(agent, "/home/example"); stop(guard);
      assert.equal(guard.inspect(yes), undefined);
    }
  });

  test(`${agent} hard-wrapped paths only request a redraw, never guess missing spaces`, () => {
    const directory = "/Users/example/Library/Application Support/a project/my-work";
    const wrapped = trustScreen(agent, directory, true).replace(directory, "/Users/example/Library/Application Su\npport/a\n project/my-work");
    const guard = new WorkspaceTrust(agent, directory);
    const action = guard.inspect(wrapped, 60);
    assert.ok(typeof action === "object" && action.cols >= 180);
    assert.equal(guard.inspect(wrapped, 180), undefined, "a second width request or Enter is forbidden");
    assert.equal(guard.inspect(trustScreen(agent, directory, true), 180), "\r");

    // "a b" and "ab" can look identical at a native line break. Both may ask
    // for a non-privileged redraw; only the exact unwrapped path can get Enter.
    const ambiguous = trustScreen(agent, "/tmp/a\nb", true);
    for (const expected of ["/tmp/a b", "/tmp/ab"]) {
      const g = new WorkspaceTrust(agent, expected);
      assert.equal(typeof g.inspect(ambiguous, 40), "object");
      assert.equal(g.inspect(trustScreen(agent, expected === "/tmp/ab" ? "/tmp/a b" : "/tmp/ab", true), 180), undefined);
      assert.equal(g.inspect(trustScreen(agent, expected, true), 180), undefined, "a mismatched redraw permanently disables approval");
    }
    assert.equal(new WorkspaceTrust(agent, directory).inspect(wrapped.replace("pport/a", "pport/other"), 60), undefined);
  });

  test(`${agent} accepts native word-wrapped descriptions/choices but no extra permission text`, () => {
    const directory = "/tmp/project";
    const wrapped = trustScreen(agent, directory, true)
      .replace("read, edit, and execute", "read, edit,\n and execute")
      .replace("Yes, I trust this folder", "Yes, I trust this\n folder");
    assert.equal(new WorkspaceTrust(agent, directory).inspect(wrapped), "\r");
    assert.equal(new WorkspaceTrust(agent, directory).inspect(wrapped.replace("\n\nNo, exit", "\nAllow outside /tmp?\n\nNo, exit")), undefined);
  });
}

test("Claude supports the full native safety explanation and reversed numbered choices", () => {
  const screen = trustScreen("claude", "/tmp/project")
    .replace("you trust?", "you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.")
    .replace("❯ No, exit\nYes, I trust this folder", "1. Yes, I trust this folder\n❯ 2. No, exit");
  const guard = new WorkspaceTrust("claude", "/tmp/project");
  assert.equal(guard.inspect(screen), "\x1b[A");
  assert.equal(guard.inspect(screen), undefined);
  assert.equal(guard.inspect(screen.replace("1. Yes", "❯ 1. Yes").replace("❯ 2. No", "2. No")), "\r");
});

test("Antigravity's default Yes-first layout and native status footer are supported", () => {
  const screen = trustScreen("antigravity", "/tmp/project", true)
    .replace("No, exit\n> Yes, I trust this folder", "> Yes, I trust this folder\nNo, exit")
    .trimEnd() + "\naccept-edits · Gemini 3.8 Flash · high";
  assert.equal(new WorkspaceTrust("antigravity", "/tmp/project").inspect(screen), "\r");
  assert.equal(new WorkspaceTrust("antigravity", "/tmp/project").inspect(screen + "\nAllow shell access?"), undefined);
});

test("invalid/control-character directories never enable startup automation", () => {
  for (const path of ["relative/path", "/tmp/line\nnext", "/tmp/bidi\u202eproject", "/tmp/nul\0project"]) {
    const guard = new WorkspaceTrust("claude", path);
    assert.equal(guard.finished, true);
    assert.equal(guard.inspect(trustScreen("claude", path, true)), undefined);
  }
});
