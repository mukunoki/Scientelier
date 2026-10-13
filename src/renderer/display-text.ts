// Presentation only. Never use these lossy summaries for workflow decisions or
// feed them back to an agent. Original output and PTY bytes remain untouched.
function plainTerminalText(value: string): string {
  // CSI changes the screen; OSC/DCS/APC/PM/SOS carry terminal commands or images.
  // Consume complete control strings (and incomplete trailing ones), not just ESC:
  // removing ESC alone leaks payloads such as OpenTUI/Kitty graphics into prose.
  let result = "";
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    let kind = "";
    if (c === 27) {
      if (++i >= value.length) break;
      kind = value[i];
    } else if (c === 0x9b) kind = "[";
    else if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(c)) kind = "P";
    if (kind) {
      if (kind === "[") {
        while (++i < value.length && !(value.charCodeAt(i) >= 0x40 && value.charCodeAt(i) <= 0x7e)) { /* parameters */ }
      } else if ("]PX^_".includes(kind)) {
        while (++i < value.length) {
          if (value.charCodeAt(i) === 7 || value.charCodeAt(i) === 0x9c) break;
          if (value.charCodeAt(i) === 27 && value[i + 1] === "\\") { i++; break; }
        }
      } else {
        // Other ESC sequences may have intermediate bytes, e.g. ESC ( B.
        while (i < value.length && value.charCodeAt(i) >= 0x20 && value.charCodeAt(i) <= 0x2f) i++;
      }
      continue;
    }
    if (c === 13) { if (value[i + 1] !== "\n") result += "\n"; }
    else if (c === 9 || c === 10 || (c >= 32 && !(c >= 0x7f && c <= 0x9f))) result += value[i];
  }
  return result;
}

function historyOutput(value: string | undefined, error?: string): string {
  // A TUI redraw stream is not a chronological text report. Stripping ANSI from
  // it would still interleave overwritten frames and graphics payload fragments.
  const screenStream = /(?:\x1b\[[0-?]*[ -/]*[A-HJKSTfhlrsu]|\x9b[0-?]*[ -/]*[A-HJKSTfhlrsu]|\x1b[P_X^]|[\x90\x98\x9e\x9f])/.test(value ?? "");
  if (screenStream) {
    const reason = error ? humanOutput(error).trim() : "";
    return `この工程にはCLI原画面の記録があります。画面描画用のデータは作業履歴には表示しません。「実行」の該当端末、または保存済みログで確認できます。${reason ? `\n\n停止・エラー情報：\n${reason}` : ""}`;
  }
  return humanOutput(value || error || "未実行");
}

function humanOutput(value: string): string {
  const labels: Record<string, string> = { "goal-draft": "ゴール案", "goal-evaluation": "レビュー結果", "execution-plan": "実行計画", "work-plan": "作業計画", "work-check": "進捗確認", "editorial-check": "仕上げ確認" };
  const formatted = value.replace(/<(goal-draft|goal-evaluation|execution-plan|work-plan|work-check|editorial-check)>([\s\S]*?)<\/\1>/g, (_block, tag: string, json: string) => {
    try {
      const data = JSON.parse(json);
      const lines = [labels[tag]];
      for (const key of ["objective", "summary", "primaryWork", "remainingWork", "repairInstructions"]) if (typeof data?.[key] === "string" && data[key].trim()) lines.push(data[key]);
      const statuses: Record<string, string> = { completed: "完了", blocked: "未完了", ready: "準備完了", "needs-work": "残作業あり", "report-ready": "実作業完了・PDF仕上げへ", "ask-user": "確認が必要", pass: "合格", fail: "要修正", unverified: "未検証" };
      if (typeof data?.status === "string") lines.push(`状態：${statuses[data.status] ?? data.status}`);
      if (Array.isArray(data?.criteria)) for (const item of data.criteria) {
        if (item && typeof item === "object") lines.push(`・${item.description ?? item.criterionId ?? "条件"}${item.status ? `：${statuses[item.status] ?? item.status}` : ""}${typeof item.detail === "string" ? ` — ${item.detail}` : ""}`);
      }
      for (const key of ["deliverables", "concerns", "questions"]) if (Array.isArray(data?.[key])) for (const text of data[key]) if (typeof text === "string") lines.push(`・${text}`);
      return lines.join("\n");
    } catch { return `${labels[tag]}：管理データを受信しました（詳細は元ログに保存）。`; }
  }).replace(/<(goal-draft|goal-evaluation|execution-plan|work-plan|work-check|editorial-check)>[\s\S]*$/, "管理データを受信中…")
    .replace(/\[\[HARNESS_[^\]\n]*\]\]/g, "");
  // Sanitize after parsing too: JSON strings may themselves contain escapes.
  return plainTerminalText(formatted);
}
