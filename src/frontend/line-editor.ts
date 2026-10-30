/*
 * A local line editor for the WinRM terminal. PowerShell remoting has no
 * pseudo terminal, so (like Enter-PSSession) editing happens on the client:
 * keys edit a buffer, Enter submits the whole input, and the backend answers
 * with output and the next prompt. Pure logic, so it is tested without a DOM.
 */

export type EditorEffect =
  | { type: "write"; data: string }
  | { type: "submit"; text: string; force: boolean }
  | { type: "interrupt" }
  | { type: "clear" }
  | { type: "copy" };

export type EditorMode =
  "connecting" | "editing" | "waiting" | "running" | "closed";

const CONTINUATION_PROMPT = ">> ";
const MAX_HISTORY = 500;
const NEWLINE_GLYPH = "↵";

/** Display width of one code point in a terminal cell grid. */
export function charWidth(codePoint: number): number {
  if (codePoint === 0) return 0;
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  // Combining marks and zero-width characters.
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff)
  ) {
    return 0;
  }
  // East Asian wide and emoji ranges.
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

export function stringWidth(text: string): number {
  let width = 0;
  for (const char of text) width += charWidth(char.codePointAt(0) ?? 0);
  return width;
}

/** Visible width of text that may contain ANSI SGR sequences. */
export function visibleWidth(text: string): number {
  return stringWidth(text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""));
}

function displayOf(text: string): string {
  return text.replace(/\r?\n/g, NEWLINE_GLYPH);
}

export class LineEditor {
  mode: EditorMode = "connecting";
  cols = 80;
  private prompt = "";
  private buffer = "";
  /** Cursor as an index into `buffer` (UTF-16 units, never inside a surrogate pair). */
  private cursor = 0;
  /** Lines collected while PowerShell reports the input as unfinished. */
  private continuation: string[] = [];
  private history: string[] = [];
  private historyIndex = -1;
  private draft = "";
  /** Rows above the cursor that belong to the line being edited. */
  private cursorRow = 0;
  /** Lines from a multi-line paste waiting for the next prompt. */
  private queued: string[] = [];

  get text(): string {
    return this.buffer;
  }

  get historyEntries(): readonly string[] {
    return this.history;
  }

  /** The backend sent a prompt: start editing a fresh line. */
  showPrompt(prompt: string): EditorEffect[] {
    this.prompt = prompt;
    this.continuation = [];
    this.mode = "editing";
    this.buffer = "";
    this.cursor = 0;
    this.cursorRow = 0;
    this.historyIndex = -1;
    const effects = [this.render(true)];
    return this.drainQueue(effects);
  }

  /** The backend says the submitted input is unfinished: ask for another line. */
  showContinuation(): EditorEffect[] {
    this.mode = "editing";
    this.buffer = "";
    this.cursor = 0;
    this.cursorRow = 0;
    const effects = [this.render(true)];
    return this.drainQueue(effects);
  }

  private drainQueue(effects: EditorEffect[]): EditorEffect[] {
    if (this.queued.length === 0) return effects;
    const next = this.queued.shift() as string;
    if (this.queued.length === 0 && !next.endsWith("\n")) {
      this.insert(next);
      effects.push(this.render());
      return effects;
    }
    this.insert(next.replace(/\n$/, ""));
    effects.push(this.render());
    return [...effects, ...this.submit()];
  }

  private currentPrompt(): string {
    return this.continuation.length > 0 ? CONTINUATION_PROMPT : this.prompt;
  }

  /** Redraws the edited line and places the cursor, handling wrapped rows. */
  private render(fresh = false): EditorEffect {
    const cols = Math.max(10, this.cols);
    const prompt = this.currentPrompt();
    const display = displayOf(this.buffer);
    const before = displayOf(this.buffer.slice(0, this.cursor));
    const promptWidth = visibleWidth(prompt);
    const endPos = promptWidth + stringWidth(display);
    const cursorPos = promptWidth + stringWidth(before);

    let out = "";
    if (!fresh && this.cursorRow > 0) out += `\x1b[${this.cursorRow}A`;
    out += "\r\x1b[J" + prompt + display;
    let endRow = Math.floor(endPos / cols);
    if (endPos > 0 && endPos % cols === 0) {
      // Leave xterm's pending-wrap state so the cursor maths below holds.
      out += "\r\n";
    } else if (endPos % cols === 0) {
      endRow = 0;
    }
    const targetRow = Math.floor(cursorPos / cols);
    const targetCol = cursorPos % cols;
    if (endRow > targetRow) out += `\x1b[${endRow - targetRow}A`;
    out += "\r";
    if (targetCol > 0) out += `\x1b[${targetCol}C`;
    this.cursorRow = targetRow;
    return { type: "write", data: out };
  }

  private insert(text: string): void {
    this.buffer =
      this.buffer.slice(0, this.cursor) + text + this.buffer.slice(this.cursor);
    this.cursor += text.length;
  }

  private prevIndex(index: number): number {
    if (index <= 0) return 0;
    const code = this.buffer.charCodeAt(index - 1);
    return code >= 0xdc00 && code <= 0xdfff && index >= 2
      ? index - 2
      : index - 1;
  }

  private nextIndex(index: number): number {
    if (index >= this.buffer.length) return this.buffer.length;
    const code = this.buffer.charCodeAt(index);
    return code >= 0xd800 && code <= 0xdbff ? index + 2 : index + 1;
  }

  private wordLeft(index: number): number {
    let i = index;
    while (i > 0 && /\s/.test(this.buffer[i - 1])) i--;
    while (i > 0 && !/\s/.test(this.buffer[i - 1])) i--;
    return i;
  }

  private wordRight(index: number): number {
    let i = index;
    while (i < this.buffer.length && /\s/.test(this.buffer[i])) i++;
    while (i < this.buffer.length && !/\s/.test(this.buffer[i])) i++;
    return i;
  }

  private moveToEnd(): string {
    // Put the terminal cursor after the input before anything else prints.
    const cols = Math.max(10, this.cols);
    const promptWidth = visibleWidth(this.currentPrompt());
    const endPos = promptWidth + stringWidth(displayOf(this.buffer));
    const endRow =
      endPos > 0 && endPos % cols === 0
        ? endPos / cols
        : Math.floor(endPos / cols);
    const down = endRow - this.cursorRow;
    return (down > 0 ? `\x1b[${down}B` : "") + "\r\n";
  }

  private submit(force = false): EditorEffect[] {
    const lines = [...this.continuation, this.buffer];
    const forced =
      force || (this.continuation.length > 0 && this.buffer === "");
    const text =
      forced && this.buffer === ""
        ? this.continuation.join("\n")
        : lines.join("\n");
    const effects: EditorEffect[] = [{ type: "write", data: this.moveToEnd() }];
    if (text.trim() && this.history.at(-1) !== text) {
      this.history.push(text);
      if (this.history.length > MAX_HISTORY) this.history.shift();
    }
    this.historyIndex = -1;
    this.mode = "waiting";
    this.continuation = lines;
    effects.push({ type: "submit", text, force: forced });
    return effects;
  }

  /** The submitted input started running (no "incomplete" answer). */
  markRunning(): void {
    if (this.mode === "waiting") this.mode = "running";
  }

  /** Feeds terminal input (keys or a paste). */
  handle(data: string): EditorEffect[] {
    if (this.mode === "connecting" || this.mode === "closed") return [];
    if (this.mode === "waiting" || this.mode === "running") {
      if (data === "\x03")
        return [{ type: "write", data: "^C" }, { type: "interrupt" }];
      return [];
    }

    // A paste (or IME commit): several characters at once, not an escape sequence.
    if (data.length > 1 && !data.startsWith("\x1b")) {
      const normalized = data.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
      if (!normalized.includes("\n")) {
        this.insert(normalized.replace(/[\x00-\x1f\x7f]/g, ""));
        return [this.render()];
      }
      const parts = normalized.split("\n");
      const first = parts.shift() as string;
      this.insert(first.replace(/[\x00-\x1f\x7f]/g, ""));
      // Each further line is typed after the next prompt, the last one without Enter.
      this.queued = parts
        .map((line, i) => (i < parts.length - 1 ? `${line}\n` : line))
        .filter((l) => l !== "");
      return [this.render(), ...this.submit()];
    }

    switch (data) {
      case "\r":
      case "\n":
        return this.submit();
      case "\x7f":
      case "\b": {
        if (this.cursor === 0) return [];
        const from = this.prevIndex(this.cursor);
        this.buffer =
          this.buffer.slice(0, from) + this.buffer.slice(this.cursor);
        this.cursor = from;
        return [this.render()];
      }
      case "\x1b[3~": {
        if (this.cursor >= this.buffer.length) return [];
        this.buffer =
          this.buffer.slice(0, this.cursor) +
          this.buffer.slice(this.nextIndex(this.cursor));
        return [this.render()];
      }
      case "\x1b[D":
      case "\x02":
        this.cursor = this.prevIndex(this.cursor);
        return [this.render()];
      case "\x1b[C":
      case "\x06":
        this.cursor = this.nextIndex(this.cursor);
        return [this.render()];
      case "\x1b[1;5D":
      case "\x1bb":
        this.cursor = this.wordLeft(this.cursor);
        return [this.render()];
      case "\x1b[1;5C":
      case "\x1bf":
        this.cursor = this.wordRight(this.cursor);
        return [this.render()];
      case "\x1b[H":
      case "\x1bOH":
      case "\x1b[1~":
      case "\x01":
        this.cursor = 0;
        return [this.render()];
      case "\x1b[F":
      case "\x1bOF":
      case "\x1b[4~":
      case "\x05":
        this.cursor = this.buffer.length;
        return [this.render()];
      case "\x1b[A":
        return this.historyStep(-1);
      case "\x1b[B":
        return this.historyStep(1);
      case "\x15":
        this.buffer = this.buffer.slice(this.cursor);
        this.cursor = 0;
        return [this.render()];
      case "\x0b":
        this.buffer = this.buffer.slice(0, this.cursor);
        return [this.render()];
      case "\x17": {
        const from = this.wordLeft(this.cursor);
        this.buffer =
          this.buffer.slice(0, from) + this.buffer.slice(this.cursor);
        this.cursor = from;
        return [this.render()];
      }
      case "\x03": {
        // Ctrl+C while editing drops the line, like the PowerShell console.
        const effects: EditorEffect[] = [
          { type: "write", data: "^C" + this.moveToEnd() },
        ];
        this.continuation = [];
        this.buffer = "";
        this.cursor = 0;
        this.cursorRow = 0;
        this.queued = [];
        effects.push(this.render(true));
        return effects;
      }
      case "\x0c":
        return [{ type: "clear" }, this.render(true)];
      case "\t":
        this.insert("    ");
        return [this.render()];
      default:
        if (data.startsWith("\x1b")) return []; // Unhandled escape sequences.
        if (/^[\x00-\x1f\x7f]$/.test(data)) return [];
        this.insert(data);
        return [this.render()];
    }
  }

  private historyStep(direction: -1 | 1): EditorEffect[] {
    if (this.history.length === 0) return [];
    if (this.historyIndex === -1) {
      if (direction === 1) return [];
      this.draft = this.buffer;
      this.historyIndex = this.history.length - 1;
    } else {
      const next = this.historyIndex + direction;
      if (next < 0) return [];
      if (next >= this.history.length) {
        this.historyIndex = -1;
        this.buffer = this.draft;
        this.cursor = this.buffer.length;
        return [this.render()];
      }
      this.historyIndex = next;
    }
    this.buffer = this.history[this.historyIndex];
    this.cursor = this.buffer.length;
    return [this.render()];
  }

  /** The terminal resized: redraw in place with the new width. */
  resize(cols: number): EditorEffect[] {
    this.cols = cols;
    if (this.mode !== "editing") return [];
    return [this.render()];
  }

  /** Output arrives while editing (should not happen) or before a prompt. */
  reset(): void {
    this.buffer = "";
    this.cursor = 0;
    this.cursorRow = 0;
    this.continuation = [];
  }
}
