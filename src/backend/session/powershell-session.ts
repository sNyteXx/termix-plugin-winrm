import { type PsValue, psToString } from "../psrp/clixml.js";
import { PipelineState, type PsCommand } from "../psrp/messages.js";
import {
  COLORS,
  colored,
  renderErrorRecord,
  renderInformation,
  renderInformational,
  renderTerminatingError,
  sanitize,
  toTerminal,
} from "../psrp/render.js";
import {
  type PipelineHandle,
  RunspacePool,
  type SoapChannel,
} from "../psrp/runspace.js";

/*
 * A console-like PowerShell session on one runspace. Each line the user
 * submits runs as a script in the session's own scope (so variables and the
 * location persist), piped through Out-String so PowerShell itself formats
 * the objects at the terminal's width. Helper pipelines (prompt, the parse
 * check, the liveness probe) run in a local scope and stay out of history.
 */

export interface RunResult {
  state: "completed" | "failed" | "stopped";
}

export interface RunHandle {
  done: Promise<RunResult>;
  stop(): Promise<void>;
}

const PARSE_CHECK = [
  "param([string]$s)",
  "$e = $null",
  "$null = [System.Management.Automation.Language.Parser]::ParseInput($s, [ref]$null, [ref]$e)",
  "[bool]($e | Where-Object { $_.IncompleteInput })",
].join("\n");

/** Characters that can leave a statement open. Without any, the line is complete. */
const MAY_CONTINUE = /[{}()[\]"'`@]|\|\s*$/;

export const MIN_WIDTH = 40;
export const MAX_WIDTH = 500;

export class PowerShellSession {
  computerName = "";
  private closed = false;

  private constructor(private readonly pool: RunspacePool) {}

  static async open(
    control: SoapChannel,
    poll: SoapChannel,
  ): Promise<PowerShellSession> {
    const pool = new RunspacePool({ control, poll });
    try {
      await pool.open();
      const session = new PowerShellSession(pool);
      session.computerName = (await session.helper("$env:COMPUTERNAME")).trim();
      return session;
    } catch (error) {
      await pool.close().catch(() => undefined);
      throw error;
    }
  }

  get psVersion(): string | null {
    return this.pool.psVersion;
  }

  get busy(): boolean {
    return this.pool.busy;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Runs a helper script and returns its output as text. */
  private async helper(
    script: string,
    args: PsCommand["args"] = [],
  ): Promise<string> {
    const out: string[] = [];
    const result = await this.pool.invoke(
      {
        commands: [
          { command: script, isScript: true, useLocalScope: true, args },
        ],
        addToHistory: false,
      },
      { output: (value) => out.push(psToString(value)) },
    ).done;
    if (result.state !== PipelineState.Completed) return "";
    return out.join("\n");
  }

  /** The prompt as Enter-PSSession shows it: "[COMPUTER]: PS C:\path> ". */
  async prompt(): Promise<string> {
    const text = sanitize(await this.helper("prompt")).replace(/\r?\n/g, " ");
    const base = text || "PS> ";
    return this.computerName ? `[${this.computerName}]: ${base}` : base;
  }

  /** Whether the input is an unfinished statement that wants more lines. */
  async isIncomplete(text: string): Promise<boolean> {
    if (!MAY_CONTINUE.test(text)) return false;
    return (
      (await this.helper(PARSE_CHECK, [{ name: "s", value: text }]))
        .trim()
        .toLowerCase() === "true"
    );
  }

  /** A cheap round trip that proves the session still exists. */
  async ping(): Promise<void> {
    await this.helper("$null");
  }

  /** Runs one submitted input. `write` gets terminal text (CRLF, ANSI colours). */
  run(text: string, width: number, write: (chunk: string) => void): RunHandle {
    const columns = Math.min(
      MAX_WIDTH,
      Math.max(MIN_WIDTH, Math.trunc(width) || 120),
    );
    let pendingNoNewLine = false;
    const line = (value: string) => {
      write(toTerminal(sanitize(value)) + "\r\n");
      pendingNoNewLine = false;
    };
    const block = (color: string, value: string) => {
      if (pendingNoNewLine) write("\r\n");
      line(colored(color, value));
    };

    const handle: PipelineHandle = this.pool.invoke(
      {
        commands: [
          { command: text, isScript: true, useLocalScope: false },
          {
            command: "Out-String",
            isScript: false,
            args: [
              { name: "Stream", value: true },
              { name: "Width", value: columns },
            ],
          },
        ],
        addToHistory: true,
        history: text,
      },
      {
        output: (value: PsValue) => line(psToString(value)),
        error: (record) => block(COLORS.error, renderErrorRecord(record)),
        warning: (record) =>
          block(COLORS.warning, renderInformational("WARNING", record)),
        verbose: (record) =>
          block(COLORS.verbose, renderInformational("VERBOSE", record)),
        debug: (record) =>
          block(COLORS.debug, renderInformational("DEBUG", record)),
        information: (record) => {
          const info = renderInformation(record);
          if (info.noNewLine) {
            write(toTerminal(sanitize(info.text)));
            pendingNoNewLine = true;
          } else line(info.text);
        },
      },
    );

    const done = handle.done.then((result): RunResult => {
      if (pendingNoNewLine) write("\r\n");
      if (result.state === PipelineState.Failed) {
        line(
          colored(COLORS.error, renderTerminatingError(result.error, false)),
        );
        return { state: "failed" };
      }
      if (result.state === PipelineState.Stopped) {
        line(colored(COLORS.error, renderTerminatingError(null, true)));
        return { state: "stopped" };
      }
      return { state: "completed" };
    });

    return { done, stop: () => handle.stop() };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.close();
  }
}
