import { antigravitySettingsSummary } from "./remote-bridge";

export function assertAntigravityAccountMode(value: Awaited<ReturnType<typeof antigravitySettingsSummary>>, task = false): void {
  if (!value?.valid) throw new Error("Antigravityの設定を読み取れません。課金方式を確認できないため起動しません。");
  if (value.provider !== "account") throw new Error("AntigravityがAPIキー方式または不明な接続先に設定されています。この連携はGoogleアカウント方式専用です。既存設定は変更していません。");
  if (task && value.creditsEnabled) throw new Error("Antigravityで追加AIクレジットの利用（useG1Credits）が有効です。サブスク枠のみで実行するため、CLIの /settings で無効にしてから再開してください。");
}

export async function readAntigravityLoginStatus(executable: string | undefined, home: string) {
  const base = { installed: Boolean(executable), checkedAt: new Date().toISOString(), checkSupported: false };
  if (!executable) return { ...base, state: "cli-missing", launchBlocked: true, detail: "Antigravity CLI（agy）が見つかりません。公式CLIを導入して検出を更新してください。" };
  const settings = await antigravitySettingsSummary(home);
  try { assertAntigravityAccountMode(settings); }
  catch (error) { return { ...base, state: settings.valid ? "api-configured" : "settings-error", launchBlocked: true, detail: (error as Error).message }; }
  return { ...base, state: "unverified", authMethod: "Googleアカウント", launchBlocked: false,
    detail: `CLI検出済み。ログインの有効性・契約はCLI画面で確認してください（キーチェーンは読み取りません）。${settings.creditsEnabled ? "追加クレジット利用が有効なため、タスク開始前に /settings で無効にしてください。" : "APIキー方式・追加クレジット利用は設定されていません。"}` };
}
