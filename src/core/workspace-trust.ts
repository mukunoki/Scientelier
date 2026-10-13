export type WorkspaceTrustAgent = "claude" | "antigravity";
export type WorkspaceTrustAction = "\x1b[A" | "\x1b[B" | "\r" | { cols: number };

/** Only the native startup folder dialog for this assignment may receive keys.
 * No config/credential file edits, general permission responder or retry loop.
 * The input is the rendered current frame, never logs or old scrollback. */
export class WorkspaceTrust {
  private phase: "initial" | "selecting" | "done" = "initial";
  private bytes = 0;
  private widened = false;
  constructor(readonly agent: WorkspaceTrustAgent, readonly directory: string) {
    if (!["claude", "antigravity"].includes(agent) || !directory.startsWith("/")
      || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(directory)) this.disable();
  }
  get finished(): boolean { return this.phase === "done"; }
  get waitingForSelection(): boolean { return this.phase === "selecting"; }
  disable(): void { this.phase = "done"; }
  observeData(data: string): void {
    this.bytes += Buffer.byteLength(data);
    if (this.bytes > 128000) this.disable();
  }
  inspect(screen: string, columns = 100): WorkspaceTrustAction | undefined {
    if (this.finished) return;
    const lines = dialogLines(screen);
    if (lines[0] !== "Accessing workspace:") {
      // Once work or the ordinary prompt appears, never answer a later dialog.
      if (((this.widened || this.waitingForSelection) && lines.length)
        || /bypass permissions on|get_instructions|Welcome to Claude|Claude Code v|\? for shortcuts|Login required|Sign in|Authentication required|OAuth/.test(screen)) this.disable();
      return;
    }
    const question = lines.findIndex(line => this.agent === "claude"
      ? line.startsWith("Quick safety check:") : line.startsWith("Do you trust"));
    const choiceStart = lines.findIndex(line => /^(?:[❯>]\s*)?(?:\d+\.\s*)?(?:No, exit|Yes, I trust)/.test(line));
    const footer = lines.findIndex(line => this.agent === "claude"
      ? line.startsWith("Enter to confirm") : /^↑\/↓\s+Navigate/.test(line));
    if (question < 2 || choiceStart <= question || footer <= choiceStart) return;
    const prose = lines.slice(question, choiceStart).join(" ").replace(/\s+/g, " ").trim();
    const claudeQuestion = "Quick safety check: Is this a project you created or one you trust?";
    const claudeExplanation = " (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.";
    const descriptions = this.agent === "claude" ? ["", claudeExplanation].flatMap(explanation => ["", " Security guide"].map(guide =>
      claudeQuestion + explanation + " Claude Code'll be able to read, edit, and execute files here." + guide))
      : ["Do you trust the contents of this project? Antigravity CLI requires permission to read, edit, and execute files here."];
    // Unknown project-declared permissions/MCP grants are not the basic dialog.
    if (!descriptions.includes(prose)) return;
    const footerText = lines.slice(footer).join(" ").replace(/\s+/g, " ").trim();
    if (this.agent === "claude" ? footerText !== "Enter to confirm · Esc to cancel"
      : !/^↑\/↓ Navigate · [Ee]nter Confirm(?: accept-edits(?: · [\w. /()-]+)?(?: · (?:low|medium|high|max))?)?$/.test(footerText)) return;
    const choiceText = lines.slice(choiceStart, footer).join(" ");
    const optionPattern = this.agent === "claude"
      ? /(?:❯\s*)?(?:\d+\.\s*)?(?:No, exit|Yes, I trust this folder)/g
      : /(?:>\s*)?(?:\d+\.\s*)?(?:No, exit|Yes, I trust this folder)/g;
    const options = choiceText.match(optionPattern) ?? [];
    if (choiceText.replace(optionPattern, "").trim()) return;
    const yes = options.findIndex(line => /Yes, I trust this folder$/.test(line));
    const no = options.findIndex(line => /No, exit$/.test(line));
    const marker = this.agent === "claude" ? "❯" : ">";
    if (options.length !== 2 || yes < 0 || no < 0 || options.filter(line => line.startsWith(marker)).length !== 1) return;

    const path = lines.slice(1, question);
    if (path.length !== 1) {
      // A native hard wrap may either insert or replace a space. Guessing that
      // boundary would also trust a different path ("a b" versus "ab"). ONLY
      // request a wider redraw here; approval still requires one exact line.
      const couldBeWrapped = path.length <= 32 && path.join("").replace(/ /g, "") === this.directory.replace(/ /g, "");
      const cols = Math.min(500, Math.max(180, [...this.directory].length * 2 + 8));
      if (couldBeWrapped && !this.widened && columns < cols) {
        this.widened = true;
        return { cols };
      }
      return;
    }
    if (path[0] !== this.directory) { this.disable(); return; }
    if (options[yes].startsWith(marker)) { this.disable(); return "\r"; }
    if (this.phase === "initial" && options[no].startsWith(marker)) {
      this.phase = "selecting";
      return yes > no ? "\x1b[B" : "\x1b[A";
    }
    // An arrow is sent once. Enter requires a NEW rendered Yes selection.
  }
}

function dialogLines(screen: string): string[] {
  // Remove native indentation, not trailing path characters. The terminal
  // renderer already trims unused padding cells on non-wrapped lines.
  return screen.split("\n").map(line => line.trimStart()).filter(line => line.trim() && !/^[─━\-]+\s*$/.test(line));
}

/** Feedback only. Unknown variants remain user-operated; this grants nothing. */
export function isWorkspaceTrustPrompt(screen: string): boolean {
  return dialogLines(screen)[0] === "Accessing workspace:"
    && /Enter\s+to\s+confirm|[Ee]nter\s+Confirm/.test(screen);
}
