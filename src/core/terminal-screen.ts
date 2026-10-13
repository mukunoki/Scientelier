import { Terminal } from "@xterm/headless";

// Internal recognition of native CLI prompts/errors after ANSI redraws. This
// does not replace the original PTY stream shown in the user's terminal.
export class TerminalScreen {
  private readonly term = new Terminal({ cols: 100, rows: 30, scrollback: 0, allowProposedApi: true });
  private closed = false;
  constructor(private readonly inspect: (screen: string) => void, private readonly unwrap = false) {}
  write(data: string): void {
    if (this.closed) return;
    this.term.write(data, () => {
      if (this.closed) return;
      const buffer = this.term.buffer.active;
      let screen = "";
      for (let i = 0; i < this.term.rows; i++) {
        const line = buffer.getLine(buffer.baseY + i);
        const nextWrapped = buffer.getLine(buffer.baseY + i + 1)?.isWrapped;
        let end = this.term.cols;
        // A double-width glyph can leave an empty padding cell before a wrap.
        // Drop that cell, but not real spaces or a wide glyph's continuation.
        if (this.unwrap && nextWrapped) while (end > 0 && line?.getCell(end - 1)?.getCode() === 0
          && line.getCell(end - 1)?.getWidth() === 1) end--;
        // Only terminal soft wraps are joined; explicit newlines remain. This
        // preserves the exact path, including spaces at a wrapping boundary.
        screen += (i && !(this.unwrap && line?.isWrapped) ? "\n" : "")
          + (line?.translateToString(!(this.unwrap && nextWrapped), 0, end) ?? "");
      }
      this.inspect(screen.trimEnd());
    });
  }
  resize(cols: number, rows: number): void { if (!this.closed) this.term.resize(cols, rows); }
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.term.dispose();
  }
}
