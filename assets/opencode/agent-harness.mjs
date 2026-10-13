import { readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";

// Per-run, local plugin. No terminal scraping, model calls, credential access,
// shell interpolation, or changes to OpenCode's global configuration.
export default async function AgentHarness({ client }) {
  const config = JSON.parse(await readFile(new URL("./completion-command.json", import.meta.url), "utf8"));
  const pending = new Set();
  const repairedMessages = new Set();
  let repairs = 0, lastRepairPrompt;
  let delivered = false;
  const readControl = async name => {
    const url = new URL(`./${name}`, import.meta.url);
    if ((await stat(url)).size > 256000) throw new Error("Control file too large");
    return JSON.parse(await readFile(url, "utf8"));
  };
  return {
    event: async ({ event }) => {
      if (delivered || !["session.idle", "session.error"].includes(event.type)) return;
      const id = event.properties?.sessionID;
      if (typeof id !== "string" || pending.has(id)) return;
      pending.add(id);
      try {
        const session = await client.session.get({ path: { id } });
        if (!session.data || session.data.parentID || session.data.time?.created < config.startedAt) return;
        const result = await client.session.messages({ path: { id } });
        if (!Array.isArray(result.data)) return;
        // Never accept an unrelated top-level session or any inner subagent.
        if (!result.data.some(m => m.info?.role === "user" && m.parts?.some(p => p.type === "text" && p.text?.includes(config.token)))) return;
        let payload;
        if (event.type === "session.error") {
          const e = event.properties?.error;
          const code = e?.data?.statusCode;
          const connection = ["UnknownError", "FetchError"].includes(e?.name) && /ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed/i.test(e?.data?.message ?? "");
          const error = code === 429 ? "rate_limit" : code === 401 ? "authentication_failed" : code === 503 ? "capacity_error" : connection ? "connection_error" : "cli_error";
          payload = { type: "session.error", error, error_details: typeof e?.data?.message === "string" ? e.data.message.slice(0, 16000) : "OpenCode reported a session error." };
        } else {
          const last = result.data.filter(m => m.info?.role === "assistant").sort((a, b) => (b.info.time?.created ?? 0) - (a.info.time?.created ?? 0))[0];
          if (!last?.info.time?.completed || last.info.finish === "tool-calls") return;
          const response = (last.parts ?? []).filter(p => p.type === "text" && !p.synthetic && !p.ignored).map(p => p.text).join("\n");
          // A completed reasoning-only/length-limited turn is still terminal.
          // Do not leave its TUI alive forever, inspect reasoning, or invent success.
          if (last.info.finish === "length") {
            payload = { type: "session.error", error: "output_limit", error_details: "OpenCodeの応答が出力トークン上限で中断されました。完了通知は受領していません。" };
          } else if (last.info.error || !response.trim()) {
            payload = { type: "session.error", error: last.info.error ? "cli_error" : "empty_response",
              error_details: last.info.error?.data?.message || "OpenCodeの応答は終了しましたが、有効な回答本文がありません。" };
          } else {
            const messageKey = last.info.id ?? `${last.info.time.created}:${response}`;
            if (repairedMessages.has(messageKey)) return; // duplicate idle for the previous turn
            const marker = response.trimEnd().split(/\r?\n/).at(-1)?.trim();
            const validMarker = ["completed", "blocked", "rate-limited"].some(s => marker === `[[HARNESS_HANDOFF:${config.token}:${s}]]`);
            // Repair only a RECEIVED review's transport, never infer success from
            // prose, repair a rejected review, or restart an aborted/user-led turn.
            if (!validMarker && repairs < 2 && !last.info.error && last.info.finish === "stop" && typeof client.session.promptAsync === "function") {
              try {
                const [channel, receipt, contract] = await Promise.all([
                  readControl("channel-state.json"), readControl("structured-result-goal-evaluation.json"), readControl("review-contract.json")
                ]);
                const users = result.data.filter(m => m.info?.role === "user");
                const latestUser = users.at(-1)?.parts?.filter(p => p.type === "text").map(p => p.text).join("\n");
                const originalUser = users.find(m => m.parts?.some(p => p.type === "text" && p.text?.includes(config.token)));
                const ownedTurn = users.at(-1) === originalUser || latestUser === lastRepairPrompt;
                if (ownedTurn && channel.token === config.token && channel.phase === "instructions-read"
                  && contract.token === config.token && receipt.token === config.token && !receipt.rejected
                  && typeof receipt.structured === "string" && receipt.structured.startsWith("<goal-evaluation>")) {
                  repairs++;
                  lastRepairPrompt = `Scientelier：レビュー結果は受領済みですが、この工程の完了通知がありません（通知修正 ${repairs}/2）。レビュー・実験・ビルドをやり直さず、提出済みの判定・指摘を変更しないでください。短い結果要約を通常の日本語で述べ、最終行を次の文字列だけにしてください。これはレビュー工程の終了通知であり、成果物の合格を意味しません。\n[[HARNESS_HANDOFF:${config.token}:completed]]`;
                  repairedMessages.add(messageKey);
                  const sent = await client.session.promptAsync({ path: { id }, body: {
                    ...(last.info.agent ? { agent: last.info.agent } : {}),
                    ...(last.info.providerID && last.info.modelID ? { model: { providerID: last.info.providerID, modelID: last.info.modelID } } : {}),
                    parts: [{ type: "text", text: lastRepairPrompt }]
                  }, throwOnError: true });
                  if (sent?.error) throw new Error("Notification repair could not be sent");
                  return;
                }
              } catch { repairedMessages.delete(messageKey); /* Preserve the normal blocked notification on repair failure. */ }
            }
            payload = { type: "session.idle", response };
          }
        }
        // Session-scoped native usage; cached input is part of total input.
        const billed = result.data.filter(m => m.info?.role === "assistant" && m.info.time?.created >= config.startedAt);
        // Native primary-session metadata only, never requested configuration
        // or an inner agent's response. Model switches stay explicit.
        const identifier = v => typeof v === "string" && /^[a-zA-Z0-9_.:/-]{1,256}$/.test(v);
        const observed = billed.filter(m => identifier(m.info.providerID) && identifier(m.info.modelID));
        const models = [...new Set(observed.map(m => `${m.info.providerID}/${m.info.modelID}`))];
        const providers = [...new Set(observed.map(m => m.info.providerID))];
        const at = Math.max(...observed.map(m => m.info.time.completed ?? m.info.time.created));
        if (identifier(id) && models.length > 0 && models.length <= 8 && models.every(identifier) && Number.isFinite(at))
          payload.identity = {source:"native-session",sessionId:id,models,observedAt:new Date(at).toISOString(),...(providers.length === 1 ? {provider:providers[0]} : {})};
        const unique = [...new Map(billed.map(m => [m.info.id, m.info.tokens])).values()];
        const count = v => Number.isSafeInteger(v) && v >= 0;
        if (unique.length && billed.every(m => typeof m.info.id === "string") && unique.every(t => count(t?.input) && count(t?.output))) payload.usage = unique.reduce((a,t) => ({
          source:"reported",inputTokens:a.inputTokens+t.input+(count(t.cache?.read)?t.cache.read:0)+(count(t.cache?.write)?t.cache.write:0),
          outputTokens:a.outputTokens+t.output,cachedInputTokens:a.cachedInputTokens+(count(t.cache?.read)?t.cache.read:0)
        }),{source:"reported",inputTokens:0,outputTokens:0,cachedInputTokens:0});
        const code = await new Promise((resolve, reject) => {
          const child = spawn(config.command[0], config.command.slice(1), { stdio: ["pipe", "ignore", "ignore"] });
          child.on("error", reject); child.on("exit", resolve);
          child.stdin.on("error", () => {});
          child.stdin.end(JSON.stringify(payload));
        });
        if (code === 0) {
          // Hook exit alone is not a receipt (e.g. a missing control file).
          const receipt = await readControl("handoff.json");
          delivered = receipt.token === config.token && ["completed", "blocked", "rate-limited"].includes(receipt.status)
            && typeof receipt.summary === "string" && !!receipt.summary.trim();
        }
      } catch { /* Failed notification never advances the workflow. */ }
      finally { pending.delete(id); }
    }
  };
}
