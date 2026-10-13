// Presentation of saved evidence only: no generated summaries or workflow mutations.
const historyDisclosureState = new Map<string, boolean>();
const historyStateLabels: Record<string, string> = {
  pending: "待機", queued: "待機", running: "実行中", planning: "計画中", reviewing: "レビュー中", reporting: "報告書作成中",
  completed: "完了", failed: "エラー", blocked: "停止", cancelled: "中断", paused: "一時停止", "awaiting-input": "確認待ち"
};
const historyRoleLabels: Record<WorkUnit["role"], string> = { planner: "計画", worker: "作業", reviewer: "レビュー", reporter: "レポート" };

function historyElement<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag); el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function historyBadge(status: string): HTMLElement {
  return historyElement("span", `history-badge history-status-${status}`, historyStateLabels[status] ?? status);
}

function workUnitTitle(unit: WorkUnit): string {
  const titles: Record<string,string> = {Report:"レポート作成",Review:"独立レビュー",Plan:"計画作成",Work:"実作業"};
  return (titles[unit.title] ?? unit.title).replace(/ · cycle (\d+)/g, " · 修正 $1 回目");
}

/** Display-only sentence splitting: never rewrite stored evidence, code or URLs. */
function reportBulletItems(text: string): string[] {
  const protectedParts: string[] = [];
  const protectedText = text.replace(/`[^`\n]*`|\*\*[^*\n]+\*\*|\[[^\]\n]*\]\([^\n)]*\)/g, part => {
    protectedParts.push(part); return `\u0000${protectedParts.length - 1}\u0000`;
  });
  return protectedText.split(/\n|(?<=。)(?![」』）】])/u).map(line => line.trim().replace(/^(?:[-*]\s+|[・•]\s*|\d+[.)]\s+)/, ""))
    .filter(Boolean).map(line => line.replace(/\u0000(\d+)\u0000/g, (_match,index:string) => protectedParts[Number(index)]));
}

// roundNumber counts instruction submissions, not phases or repair cycles.
// Historical snapshots remain immutable and must never look like live queues.
function historyInstructionLabel(number: number): string {
  return number <= 1 ? "最初の指示" : `追加指示 ${number - 1}`;
}
function historyUnitLabel(unit: WorkUnit, historical = false): string {
  const outcome = reportedWorkOutcome(unit);
  if (unit.state === "completed") {
    const label = outcome?.status === "needs-work" ? "担当終了・未完了報告" : outcome?.status === "ask-user" ? "確認を依頼" : "作業終了";
    return historical ? `当時：${label}` : label;
  }
  if (unit.state === "pending") {
    const attempted = !!(unit.startedAt || unit.completedAt || unit.error);
    return historical ? attempted ? "当時未完了" : "当時未着手" : attempted ? "再開待ち" : "未着手";
  }
  const label = historyStateLabels[unit.state] ?? unit.state;
  return historical ? `当時：${label}` : label;
}
function historyUnitTone(unit: WorkUnit, historical = false): string {
  if (historical) return "archived";
  const outcome = reportedWorkOutcome(unit);
  return outcome?.status === "ask-user" ? "awaiting-input" : outcome?.status === "needs-work" ? "needs-work" : unit.state;
}
function historicalRemainingWork(unit: WorkUnit): string | undefined {
  const outcome = reportedWorkOutcome(unit);
  if (outcome?.status !== "needs-work") return;
  return `保存時点では未完了との報告です。その後の対応状況を示すものではありません。${outcome.remainingWork ? `\n当時の残課題：${outcome.remainingWork}` : ""}`;
}
function rememberHistoryDisclosure(details: HTMLDetailsElement, key: string, initial: boolean): void {
  details.open = historyDisclosureState.get(key) ?? initial;
  details.addEventListener("toggle", () => { if (details.isConnected) historyDisclosureState.set(key, details.open); });
}
function historyInline(container: HTMLElement, text: string): void {
  // Deliberately no HTML, embedded images or active links from agent output.
  // Keep destinations visible; never navigate the app to a file or script URL.
  const pattern = /\*\*([^*\n]+)\*\*|`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\n]+)\)/g;
  let end = 0;
  for (const match of text.matchAll(pattern)) {
    container.append(document.createTextNode(text.slice(end, match.index)));
    if (match[1]) container.append(historyElement("strong", "", match[1]));
    else if (match[2]) container.append(historyElement("code", "", match[2]));
    else container.append(historyElement("span", "history-reference", `${match[3]} (${match[4]})`));
    end = match.index! + match[0].length;
  }
  container.append(document.createTextNode(text.slice(end)));
}
function historyTableCells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, "|"));
}
/** Small text-only Markdown subset. Tables are rendered only when an actual table
 * is present in the saved output; unsupported constructs remain readable text. */
function historyReportBody(text: string): HTMLElement {
  const body = historyElement("div", "history-report-body");
  const lines = text.split("\n");
  const sectionLabels = new Set(["ゴール案", "レビュー結果", "実行計画", "作業計画", "進捗確認", "仕上げ確認"]);
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) code.push(lines[i++]);
      if (i < lines.length) i++;
      const pre = historyElement("pre", "history-code"); pre.append(historyElement("code", "", code.join("\n"))); body.append(pre); continue;
    }
    const cells = historyTableCells(line), separators = historyTableCells(lines[i + 1] ?? "");
    if (cells.length > 1 && separators.length === cells.length && separators.every(c => /^:?-{3,}:?$/.test(c))) {
      const wrap = historyElement("div", "history-table-scroll"); wrap.tabIndex = 0; wrap.setAttribute("role", "region"); wrap.setAttribute("aria-label", "報告内の表（保存済みデータ）");
      const table = historyElement("table", "history-table"), head = table.createTHead().insertRow(), rows = table.createTBody();
      for (const cell of cells) { const th = document.createElement("th"); th.scope = "col"; historyInline(th, cell); head.append(th); }
      i += 2;
      while (i < lines.length && lines[i].includes("|") && historyTableCells(lines[i]).length === cells.length) {
        const row = rows.insertRow(); for (const cell of historyTableCells(lines[i++])) historyInline(row.insertCell(), cell);
      }
      wrap.append(table); body.append(wrap); continue;
    }
    const heading = line.match(/^\s*#{1,6}\s+(.+)/);
    if (heading || sectionLabels.has(line.trim())) { const h = historyElement("h5", "history-report-heading"); historyInline(h, heading?.[1] ?? line.trim()); body.append(h); i++; continue; }
    const list = line.match(/^\s*(?:([-*]\s+|[・•]\s*)|(\d+)[.)]\s+)(.*)/);
    if (list) {
      const ordered = !!list[2]; const items = document.createElement(ordered ? "ol" : "ul");
      if (ordered) (items as HTMLOListElement).start = Number(list[2]);
      while (i < lines.length) {
        const item = lines[i].match(/^\s*(?:([-*]\s+|[・•]\s*)|(\d+)[.)]\s+)(.*)/);
        if (!item || !!item[2] !== ordered) break;
        const li = document.createElement("li"); if (ordered) li.value = Number(item[2]); historyInline(li, item[3]); items.append(li); i++;
      }
      body.append(items); continue;
    }
    let items = body.lastElementChild;
    if (!(items instanceof HTMLUListElement) || !items.classList.contains("report-prose-list")) {
      items = historyElement("ul", "report-prose-list"); body.append(items);
    }
    for (const item of reportBulletItems(line)) { const li = document.createElement("li"); historyInline(li,item); items.append(li); }
    i++;
  }
  return body;
}

function buildTaskHistory(task: TaskRecord): HTMLElement {
  const section = historyElement("section", "round-history");
  const header = historyElement("header", "history-heading");
  header.append(historyElement("h3", "", "作業の記録"), historyElement("p", "", "現在の作業を先に表示し、その下に過去の指示・記録を並べます。「追加指示」の番号は指示の更新回数で、工程やフェーズの番号ではありません。"));
  if (task.resumeCount) header.append(historyElement("span", "history-meta", `途中再開 ${task.resumeCount}回 · 完了済みの作業は保持`));
  section.append(header);
  if(task.agentMessages?.length) {
    const consultation=historyElement("details","history-consultation");
    rememberHistoryDisclosure(consultation,`${task.id}:messages`,false);
    consultation.append(historyElement("summary","",`担当間の相談（${task.agentMessages.length}通）`));
    const units=[...task.workUnits,...(task.retiredWorkUnits??[]),...(task.history??[]).flatMap(r=>r.workUnits)];
    const title=(id:string)=>units.find(u=>u.id===id)?.title??"以前の担当";
    const kinds={request:"質問",answer:"回答",finding:"知見",warning:"注意"};
    const states={queued:"相手の開始・接続待ち",delivered:"配信済み",read:"取得済み",expired:"旧計画・配信終了"};
    consultation.append(historyElement("p","history-meta","相談は未検証の参考情報です。成果の証拠・承認・合格判定とは別です。"));
    for(const message of task.agentMessages.slice(-40)) {
      const card=historyElement("article",`history-message history-message-${message.kind}`);
      card.append(historyElement("div","history-meta",`${kinds[message.kind]} · ${title(message.fromUnitId)} → ${title(message.toUnitId)} · ${new Date(message.at).toLocaleString("ja-JP")} · ${states[message.state]}`));
      card.append(historyElement("p","",message.text));consultation.append(card);
    }
    section.append(consultation);
  }
  const current: TaskRound = { number: task.roundNumber ?? 1, kind: task.roundKind ?? "initial", instruction: task.instruction ?? task.prompt,
    state: task.state, workUnits: task.workUnits, finishedAt: task.updatedAt, workPreset: task.workPreset, goal: task.goal, workClosure: taskPartialClosure(task) };
  const snapshots = [...(task.history ?? []).filter(r => r.number !== current.number), ...(task.interruptedHistory ?? [])]
    .sort((a, b) => (Date.parse(b.finishedAt) || 0) - (Date.parse(a.finishedAt) || 0) || b.number - a.number);
  const rounds = [current, ...snapshots];
  rounds.forEach(round => {
    const interrupted = !!task.interruptedHistory?.includes(round);
    const historical = round !== current;
    const key = `${task.id}:${interrupted ? "interrupted" : "round"}:${round.number}:${interrupted ? round.finishedAt : ""}`;
    const entry = historyElement("details", "history-round"); rememberHistoryDisclosure(entry, key, round === current);
    const summary = document.createElement("summary");
    entry.classList.toggle("history-archived", historical);
    const title = historyElement("span", "history-round-title", `${historical ? interrupted ? "再開前の記録" : "過去の指示" : "現在の作業"} · ${historyInstructionLabel(round.number)}`);
    const status = taskDisplayStatus(task);
    const roundBadge = historyBadge(historical ? "archived" : status.tone);
    if (!historical) roundBadge.textContent = status.label;
    if (historical) roundBadge.textContent = "保存済み記録";
    summary.append(title, roundBadge);
    entry.append(summary);
    const content = historyElement("div", "history-round-content");
    if (round.workClosure?.finishedAt) content.append(historyElement("p", "history-snapshot-note", "未達・未確認事項を残して作業を終了しました。全体合格ではありません。"));
    for (const adjustment of (task.reviewAdjustments ?? []).filter(a => a.round === round.number && (!historical || a.decidedAt <= round.finishedAt))) {
      content.append(historyElement("p", "history-snapshot-note", `レビューの時間調整 · 修正サイクル${adjustment.cycle}\n${adjustment.reason}${adjustment.omittedUnits.length ? `\n未実施として省略：${adjustment.omittedUnits.map(u => u.title).join("、")}` : ""}`));
    }
    if (historical) {
      const at = Number.isFinite(Date.parse(round.finishedAt)) ? `${new Date(round.finishedAt).toLocaleString("ja-JP")} · ` : "";
      content.append(historyElement("p", "history-snapshot-note", `${at}保存時の状態：${historyStateLabels[round.state] ?? round.state}。ここにある未実行・未完了の工程は過去の計画です。現在の待機列ではなく、完了した扱いにもしていません。`));
    }
    if (round.workPreset || round.goal) content.append(historyElement("p", "history-meta", [round.workPreset?.manifest.name, round.goal ? `ゴール第${round.goal.revision}版` : ""].filter(Boolean).join(" · ")));
    const instruction = historyElement("details", "history-instruction");
    instruction.append(historyElement("summary", "", "依頼・追加指示の内容"), historyElement("p", "", round.instruction));
    rememberHistoryDisclosure(instruction, `${key}:instruction`, false); content.append(instruction);
    const answers = (task.resumeInstructions ?? []).filter(a => a.round === round.number && (!historical || a.at <= round.finishedAt));
    if (answers.length) {
      const replies = historyElement("details", "history-instruction");
      replies.append(historyElement("summary", "", `途中再開時の回答・指示（${answers.length}件）`));
      rememberHistoryDisclosure(replies, `${key}:answers`, false);
      for (const answer of answers) {
        const unit = round.workUnits.find(u => u.id === answer.unitId);
        replies.append(historyElement("p", "history-meta", `${new Date(answer.at).toLocaleString("ja-JP")} · ${unit ? workUnitTitle(unit) : "中断した工程"}`), historyReportBody(answer.instruction));
      }
      content.append(replies);
    }
    const units = round.workUnits ?? [];
    const counts = historyElement("div", "history-counts"); counts.setAttribute("aria-label", "工程の状態別件数（ゴール達成率ではありません）");
    const grouped = new Map<string, { count: number; state: string }>();
    for (const unit of units) {
      const label = historyUnitLabel(unit, historical);
      const group = grouped.get(label) ?? { count: 0, state: historyUnitTone(unit, historical) };
      group.count++; grouped.set(label, group);
    }
    for (const [label, group] of grouped) counts.append(historyElement("span", `history-count history-status-${group.state}`, `${label} ${group.count}`));
    content.append(counts);
    if (!units.length) content.append(historyElement("p", "history-empty", "まだ工程の記録はありません。"));
    const timeline = historyElement("div", "history-timeline");
    for (const [index, unit] of units.entries()) {
      const output = historyOutput(unit.output, unit.error);
      const unfinished = historical ? historicalRemainingWork(unit) : unfinishedWorkExplanation(task, unit);
      const card = historyElement("details", `history-card history-status-${historyUnitTone(unit, historical)}`);
      const cardKey = `${key}:unit:${unit.id}`;
      rememberHistoryDisclosure(card, cardKey, false);
      const top = document.createElement("summary");
      const num = String(index + 1).padStart(2, "0");
      const identity = historyElement("div", "history-card-identity");
      const badge = historyBadge(historyUnitTone(unit, historical));
      badge.textContent = historyUnitLabel(unit, historical);
      if (unfinished) { if (!historical) badge.classList.add("history-status-needs-work"); badge.title = unfinished; }
      identity.append(historyElement("span", "history-number", num), historyElement("h4", "", workUnitTitle(unit)), badge);
      const meta = historyElement("div", "history-card-meta");
      meta.append(historyElement("span", "history-role", historyRoleLabels[unit.role] ?? "作業"), historyElement("span", "", unit.assignedAgentId ? agentLabel(unit.assignedAgentId) : "担当未割当"));
      for (const [label, value] of [["実行開始", unit.startedAt], ["実行終了", unit.completedAt]]) {
        if (!value || !Number.isFinite(Date.parse(value))) continue;
        const time = historyElement("time", "", `${label} ${new Date(value).toLocaleString("ja-JP", {month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"})}`); time.dateTime = value; time.title = value; meta.append(time);
      }
      const excerpt = historyElement("ul", "history-excerpt");
      for (const text of reportBulletItems(output).filter(l => !/^#{1,6}\s|^(?:進捗確認|レビュー結果|仕上げ確認|実行計画|作業計画|ゴール案)$/.test(l)).slice(0,2)) {
        const li = document.createElement("li"); historyInline(li,text.slice(0,220)); excerpt.append(li);
      }
      top.append(identity, meta, excerpt); card.append(top);
      const body = historyReportBody(output);
      if (unfinished) { const explanation=historyReportBody(unfinished); explanation.classList.add("work-description"); body.prepend(explanation); }
      if (unit.error && unit.output && !output.includes(humanOutput(unit.error))) body.prepend(historyElement("p", "history-error", humanOutput(unit.error)));
      card.append(body); timeline.append(card);
    }
    if (units.length) content.append(timeline);
    entry.append(content); section.append(entry);
  });
  const displayed = new Set(rounds.flatMap(r => r.workUnits ?? []).map(u => u.id));
  const archived = savedTaskWorkUnits(task).filter(u => !displayed.has(u.id));
  if (archived.length) {
    const past = progressDisclosure(task, "archived-work", `再計画・修正前の工程（${archived.length}件）`);
    past.classList.add("history-round");
    for (const unit of archived) {
      const unfinished = historicalRemainingWork(unit);
      const row = progressDisclosure(task, `archived:${unit.id}`, `${unit.title} · ${historyUnitLabel(unit, true)}`);
      if (unfinished) row.append(historyElement("p", "work-outcome-explanation", unfinished));
      row.append(historyReportBody(historyOutput(unit.output, unit.error))); past.append(row);
    }
    section.append(past);
  }
  return section;
}
