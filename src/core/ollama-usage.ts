import type { RateLimitObservation } from "./usage-tracker";
import type { UsageLimitWindow } from "./types";

export const OLLAMA_USAGE_URL = "https://ollama.com/settings";
export function isOllamaUsagePage(value: string): boolean {
  try { const u = new URL(value); return !u.username && !u.password && u.origin === "https://ollama.com" && /^\/settings\/?$/.test(u.pathname); } catch { return false; }
}
export function isOllamaLoginNavigation(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password && !u.port
      && ["ollama.com", "signin.ollama.com", "api.workos.com", "accounts.google.com", "github.com"].includes(u.hostname);
  } catch { return false; }
}

export interface OllamaUsageBlock { label: string; text: string; reset?: string; percent?: number }
export interface OllamaUsagePage { blocks: OllamaUsageBlock[] }

// Runs in an isolated world on the exact settings page only. No cookies, form
// values, scripts, network responses or account/profile fields are returned.
export function extractOllamaUsagePage(): OllamaUsagePage {
  const label = /^(?:(?:current\s+)?(?:session|weekly|monthly|daily)(?:\s+(?:usage|limit|credits))?|(?:included|monthly included|extra|purchased)\s+(?:usage|credits|balance)|credit balance|usage credits|remaining credits)$/i;
  const blocks: OllamaUsageBlock[] = [];
  const elements = Array.from(document.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6,p,span,div,dt"));
  for (const heading of elements) {
    const name = heading.textContent?.trim() ?? "";
    if (!label.test(name) || !heading.getClientRects().length || heading.children.length && !/^H[1-6]$/.test(heading.tagName)) continue;
    let container: HTMLElement | null = heading.parentElement;
    let candidate: OllamaUsageBlock | undefined;
    for (let level = 0; container && level < 5; level++, container = container.parentElement) {
      const text = container.innerText?.trim() ?? "";
      if (text.length > 2400 || container.tagName === "MAIN" || container.tagName === "BODY" || container.querySelector('input,textarea,form')) break;
      // Never combine separate quota cards and confuse their percentages.
      const other = elements.some(e => e !== heading && container!.contains(e) && label.test(e.textContent?.trim() ?? "") && e.getClientRects().length && !(e.contains(heading) || heading.contains(e)));
      if (other) break;
      const progress = container.querySelector('[role="progressbar"][aria-valuenow]');
      const raw = progress?.getAttribute("aria-valuenow");
      const max = progress?.getAttribute("aria-valuemax");
      const percent = raw !== null && raw !== undefined && raw.trim() && (!max || max === "100") ? Number(raw) : undefined;
      if (!/%|\$\s*\d/.test(text) && percent === undefined) continue;
      const time = container.querySelector('time[datetime],[data-reset-at],[data-reset]');
      const reset = time?.getAttribute("datetime") ?? time?.getAttribute("data-reset-at") ?? time?.getAttribute("data-reset") ?? undefined;
      candidate = { label: name, text: text.slice(0, 2400), reset: reset ?? candidate?.reset, ...(Number.isFinite(percent) ? { percent: Number(percent) } : candidate?.percent !== undefined ? { percent: candidate.percent } : {}) };
    }
    if (candidate) blocks.push(candidate);
    if (blocks.length >= 16) break;
  }
  return { blocks };
}

function isoReset(value?: string): string | undefined {
  // Do not guess a timezone, month/day order, or a date from a countdown.
  if (!value || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return;
  const time = Date.parse(value); return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

export function parseOllamaUsagePage(page: OllamaUsagePage): RateLimitObservation {
  if (!Array.isArray(page?.blocks) || page.blocks.length > 16) throw new Error("Ollama Usageの画面形式を確認できません。ログイン・Usage画面を開いて確認してください。");
  const windows: UsageLimitWindow[] = [];
  const balances: string[] = [];
  const seen = new Set<string>();
  for (const block of page.blocks) {
    if (typeof block?.label !== "string" || typeof block.text !== "string" || block.text.length > 2400) continue;
    const key = block.label.toLowerCase().trim().replace(/^current\s+/, "");
    const period = /^(session|weekly|monthly|daily)(?:\s+(?:usage|limit|credits))?$/.exec(key)?.[1];
    const included = /^(included|monthly included) (usage|credits|balance)$/.test(key);
    const balance = /^(extra|purchased) (usage|credits|balance)$|^credit balance$|^usage credits$|^remaining credits$/.test(key);
    if (!period && !included && !balance) continue;
    const id = `ollama-${period ?? (included ? "included" : key.replaceAll(" ", "-"))}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const percents = [...block.text.matchAll(/(\d+(?:\.\d+)?)\s*%\s*(used|remaining|left)?/gi)];
    let percent = percents.length === 1 ? Number(percents[0][1]) : undefined;
    if (percent !== undefined && /remaining|left/i.test(percents[0][2] ?? "")) percent = 100 - percent;
    // A bare percentage inside a usage card is used%; multiple model shares
    // are deliberately not treated as the account's total utilization.
    if (percent === undefined && typeof block.percent === "number") percent = block.percent;
    const ratio = /\$\s*([\d,]+(?:\.\d+)?)\s*(?:\/|of)\s*\$\s*([\d,]+(?:\.\d+)?)/i.exec(block.text);
    let detail: string | undefined;
    if (ratio) {
      const first = Number(ratio[1].replaceAll(",", "")), total = Number(ratio[2].replaceAll(",", ""));
      const remaining = /remaining|left/i.test(block.text);
      if (Number.isFinite(first) && Number.isFinite(total) && total > 0 && first >= 0 && first <= total) {
        if (percent === undefined) percent = (remaining ? total - first : first) / total * 100;
        detail = `${remaining ? "残り" : "使用"} $${first.toFixed(2)} / $${total.toFixed(2)}`;
      }
    }
    if (balance && !ratio) {
      const dollars = [...block.text.matchAll(/\$\s*([\d,]+(?:\.\d+)?)/g)];
      if (dollars.length === 1) {
        const value = Number(dollars[0][1].replaceAll(",", ""));
        if (Number.isFinite(value)) balances.push(`${key}: $${value.toFixed(2)}`);
      }
    }
    if ((period || included) && (percent === undefined || !Number.isFinite(percent) || percent < 0 || percent > 100)) throw new Error("Ollama Usageの一部の数値を読み取れません。画面の読み込み完了後に再取得してください。");
    if ((period || included) && percent !== undefined) {
      const resetLine = block.text.split(/\n/).map(s => s.trim()).find(s => /^resets?\b|^next reset\b/i.test(s));
      windows.push({ id, label: period === "session" ? "Session" : period === "weekly" ? "Weekly" : period === "monthly" ? "Monthly" : period === "daily" ? "Daily" : "Included usage",
        usedPercent: percent, scope: "shared", resetAt: isoReset(block.reset),
        resetText: resetLine && resetLine.length <= 160 ? resetLine : undefined, detail });
    }
  }
  if (!windows.length && !balances.length) throw new Error("Ollama Usageの数値を読み取れません。未ログイン、画面変更、または表示の読み込み中です。ログイン・Usage画面を確認してください。");
  return { limited: false, replaceQuota: true, windows,
    usedPercent: windows.length ? Math.max(...windows.map(w => w.usedPercent)) : undefined,
    creditBalance: balances.length ? balances.join(" · ") : undefined };
}
