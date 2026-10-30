import { describe, expect, it } from "vitest";
import {
  type EditorEffect,
  LineEditor,
  stringWidth,
  visibleWidth,
} from "../../src/frontend/line-editor.js";

const PROMPT = "[SRV01]: PS C:\\> ";

function editor() {
  const e = new LineEditor();
  e.cols = 80;
  e.showPrompt(PROMPT);
  return e;
}

function type(e: LineEditor, text: string): EditorEffect[] {
  return [...text].flatMap((ch) => e.handle(ch));
}

const submits = (effects: EditorEffect[]) =>
  effects.filter((x) => x.type === "submit");

describe("widths", () => {
  it("counts umlauts as one cell and CJK and emoji as two", () => {
    expect(stringWidth("Grüße")).toBe(5);
    expect(stringWidth("日本")).toBe(4);
    expect(stringWidth("😀")).toBe(2);
    expect(visibleWidth("\x1b[92mPS\x1b[0m> ")).toBe(4);
  });
});

describe("LineEditor", () => {
  it("types and submits a line", () => {
    const e = editor();
    type(e, "Get-Service WinRM");
    const effects = e.handle("\r");
    expect(submits(effects)).toEqual([
      { type: "submit", text: "Get-Service WinRM", force: false },
    ]);
    expect(e.mode).toBe("waiting");
  });

  it("edits in the middle of the line", () => {
    const e = editor();
    type(e, "Get-Srvice");
    for (let i = 0; i < 5; i++) e.handle("\x1b[D");
    type(e, "e");
    expect(e.text).toBe("Get-Service");
    e.handle("\x01");
    e.handle("\x1b[3~");
    expect(e.text).toBe("et-Service");
    e.handle("\x05");
    e.handle("\x7f");
    expect(e.text).toBe("et-Servic");
  });

  it("deletes whole code points, never half a surrogate pair", () => {
    const e = editor();
    type(e, "a😀");
    e.handle("\x7f");
    expect(e.text).toBe("a");
  });

  it("walks the history and restores the draft", () => {
    const e = editor();
    type(e, "$service = Get-Service WinRM");
    e.handle("\r");
    e.showPrompt(PROMPT);
    type(e, "$service.Status");
    e.handle("\r");
    e.showPrompt(PROMPT);
    type(e, "draft");
    e.handle("\x1b[A");
    expect(e.text).toBe("$service.Status");
    e.handle("\x1b[A");
    expect(e.text).toBe("$service = Get-Service WinRM");
    e.handle("\x1b[A");
    expect(e.text).toBe("$service = Get-Service WinRM");
    e.handle("\x1b[B");
    e.handle("\x1b[B");
    expect(e.text).toBe("draft");
  });

  it("does not record blank lines or repeats", () => {
    const e = editor();
    for (const line of ["dir", "dir", "  "]) {
      type(e, line);
      e.handle("\r");
      e.showPrompt(PROMPT);
    }
    expect(e.historyEntries).toEqual(["dir"]);
  });

  it("collects continuation lines and forces the run on an empty line", () => {
    const e = editor();
    type(e, "foreach ($i in 1..3) {");
    e.handle("\r");
    const shown = e.showContinuation();
    expect(JSON.stringify(shown)).toContain(">> ");
    type(e, "  $i * 2");
    expect(submits(e.handle("\r"))[0]).toMatchObject({
      text: "foreach ($i in 1..3) {\n  $i * 2",
      force: false,
    });
    e.showContinuation();
    type(e, "}");
    expect(submits(e.handle("\r"))[0]).toMatchObject({
      text: "foreach ($i in 1..3) {\n  $i * 2\n}",
    });
    e.showContinuation();
    expect(submits(e.handle("\r"))[0]).toMatchObject({
      force: true,
      text: "foreach ($i in 1..3) {\n  $i * 2\n}",
    });
  });

  it("sends Ctrl+C as an interrupt while a command runs", () => {
    const e = editor();
    type(e, "Start-Sleep 600");
    e.handle("\r");
    e.markRunning();
    expect(e.handle("\x03")).toContainEqual({ type: "interrupt" });
    expect(e.handle("x")).toEqual([]);
  });

  it("drops the line on Ctrl+C while editing", () => {
    const e = editor();
    type(e, "Remove-Item C:\\Temp");
    const effects = e.handle("\x03");
    expect(effects.some((x) => x.type === "interrupt")).toBe(false);
    expect(e.text).toBe("");
  });

  it("submits a pasted block line by line", () => {
    const e = editor();
    const first = e.handle("$a = 1\r\n$b = 2\r\n$a + $b");
    expect(submits(first)).toEqual([
      { type: "submit", text: "$a = 1", force: false },
    ]);
    const second = e.showPrompt(PROMPT);
    expect(submits(second)).toEqual([
      { type: "submit", text: "$b = 2", force: false },
    ]);
    e.showPrompt(PROMPT);
    expect(e.text).toBe("$a + $b");
  });

  it("strips control characters from a paste", () => {
    const e = editor();
    e.handle("abc\x1b[31mdef\x07");
    expect(e.text).not.toContain("\x07");
  });

  it("ignores input until connected and after closing", () => {
    const e = new LineEditor();
    expect(e.handle("x")).toEqual([]);
    e.mode = "closed";
    expect(e.handle("x")).toEqual([]);
  });

  it("redraws wrapped lines from their first row", () => {
    const e = new LineEditor();
    e.cols = 20;
    e.showPrompt("PS> ");
    type(e, "x".repeat(30));
    const last = e.handle("y").at(-1) as { type: "write"; data: string };
    // The input now spans two rows: the redraw moves up one row first.
    expect(last.data.startsWith("\x1b[1A\r\x1b[J")).toBe(true);
  });

  it("keeps xterm out of the pending-wrap state at an exact row end", () => {
    const e = new LineEditor();
    e.cols = 20;
    e.showPrompt("PS> ");
    const out = type(e, "x".repeat(16)).at(-1) as {
      type: "write";
      data: string;
    };
    expect(out.data).toContain("x".repeat(16) + "\r\n");
  });
});
