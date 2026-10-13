const { join } = require("node:path");
const { ReportService } = require("../dist/core/report-service.js");

const task = {
  id: "pdf-smoke-test",
  title: "キュー実行とPDF報告機能の動作確認",
  prompt: "複数の待機タスクを順番に実行し、各タスクの終了後にTeXからPDFレポートを生成する。記号の確認: 100% & task_id。",
  cwd: process.cwd(),
  strategy: "balanced",
  allowedAgentIds: ["codex", "claude"],
  modelOverrides: {},
  workUnits: [
    { id: "plan", role: "planner", title: "Plan", instructions: "Plan", mode: "read", state: "completed", dependsOn: [], assignedAgentId: "codex", attemptedAgentIds: ["codex"] },
    { id: "execute", role: "worker", title: "Execute", instructions: "Execute", mode: "write", state: "completed", dependsOn: ["plan"], assignedAgentId: "claude", attemptedAgentIds: ["claude"] },
    { id: "review", role: "reviewer", title: "Review", instructions: "Review", mode: "read", state: "completed", dependsOn: ["execute"], assignedAgentId: "codex", attemptedAgentIds: ["codex"] },
    { id: "report", role: "reporter", title: "Report", instructions: "Report", mode: "local", state: "completed", dependsOn: ["review"], attemptedAgentIds: [] }
  ],
  runs: [
    { id: "run-plan", workUnitId: "plan", role: "planner", agentId: "codex", providerKey: "openai-default", model: "default", state: "completed", output: "Plan complete", startedAt: "2026-09-11T09:00:00.000Z", completedAt: "2026-09-11T09:01:00.000Z" },
    { id: "run-execute", workUnitId: "execute", role: "worker", agentId: "claude", providerKey: "anthropic-default", model: "default", state: "completed", output: "Execution complete", startedAt: "2026-09-11T09:01:00.000Z", completedAt: "2026-09-11T09:02:00.000Z" },
    { id: "run-review", workUnitId: "review", role: "reviewer", agentId: "codex", providerKey: "openai-default", model: "default", state: "completed", output: "Review complete", startedAt: "2026-09-11T09:02:00.000Z", completedAt: "2026-09-11T09:03:00.000Z" }
  ],
  state: "completed",
  output: "Queue: first -> second -> third\nTeX environment: ready\nPlot environment: Python 3\n",
  usage: {
    inputTokens: 1200,
    cachedInputTokens: 600,
    outputTokens: 420,
    source: "reported"
  },
  createdAt: "2026-09-11T09:00:00.000Z",
  updatedAt: "2026-09-11T09:03:00.000Z"
};

const settings = {
  texCommand: "/Library/TeX/texbin/latexmk",
  texArgs: ["-g", "-lualatex", "-interaction=nonstopmode", "-halt-on-error"],
  plotCommand: "/usr/bin/python3",
  plotCheckArgs: ["--version"],
  outputDirectory: join(process.cwd(), "output", "pdf")
};

new ReportService().generate(task, settings).then((report) => {
  process.stdout.write(`${report.pdfPath}\n`);
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
