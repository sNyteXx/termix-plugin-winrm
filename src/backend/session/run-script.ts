import { type PsValue, propString, psToString } from "../psrp/clixml.js";
import { PipelineState } from "../psrp/messages.js";
import { renderErrorRecord, renderTerminatingError } from "../psrp/render.js";
import { RunspacePool, type SoapChannel } from "../psrp/runspace.js";

/*
 * Runs one script in a fresh PowerShell session and returns what it produced
 * as data, for the HTTP API, the winrm.run service and tools like an MCP
 * server. The session is opened for the call and always deleted afterwards.
 */

export interface RunScriptOptions {
  script: string;
  /** Overall limit, connecting included. */
  timeoutMs: number;
  /** Width Out-String formats tables at. */
  width: number;
  /** Output beyond this many characters is cut off and the script stopped. */
  maxOutputChars?: number;
}

export interface RunScriptResult {
  /** "timeout" means the time ran out and the script was stopped. */
  state: "completed" | "failed" | "stopped" | "timeout";
  computerName: string;
  /** Output as PowerShell formats it (Out-String), lines joined with \n. */
  output: string;
  errors: string[];
  warnings: string[];
  verbose: string[];
  information: string[];
  truncated: boolean;
  durationMs: number;
}

export const DEFAULT_MAX_OUTPUT_CHARS = 1024 * 1024;
const MAX_RECORDS = 500;

/** The message of a warning or verbose record. */
function informationalText(record: PsValue): string {
  return (
    propString(record, "InformationalRecord_Message") ?? psToString(record)
  );
}

/** Plain text of an information record (Write-Host, Write-Information), colours dropped. */
function informationText(record: PsValue): string {
  const data = (record as { props?: Record<string, PsValue> })?.props
    ?.MessageData;
  return propString(data, "Message") ?? psToString(data ?? null);
}

export async function runScript(
  control: SoapChannel,
  poll: SoapChannel,
  options: RunScriptOptions,
): Promise<RunScriptResult> {
  const started = Date.now();
  const maxChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const result: RunScriptResult = {
    state: "completed",
    computerName: "",
    output: "",
    errors: [],
    warnings: [],
    verbose: [],
    information: [],
    truncated: false,
    durationMs: 0,
  };
  const lines: string[] = [];
  let outputChars = 0;
  const pool = new RunspacePool({ control, poll });

  let timedOut = false;
  let stop: (() => Promise<void>) | null = null;
  let rejectTimeout: (error: Error) => void = () => undefined;
  const timeout = new Promise<never>((_, reject) => (rejectTimeout = reject));
  const timer = setTimeout(() => {
    timedOut = true;
    if (stop) void stop().catch(() => undefined);
    else rejectTimeout(new RunTimeoutError());
  }, options.timeoutMs);

  const push = (list: string[], text: string) => {
    if (list.length < MAX_RECORDS) list.push(text);
    else result.truncated = true;
  };

  try {
    await Promise.race([pool.open(), timeout]);
    const handle = pool.invoke(
      {
        commands: [
          // The caller's script runs in the session scope, like typed into a console.
          { command: options.script, isScript: true, useLocalScope: false },
          {
            command: "Out-String",
            isScript: false,
            args: [
              { name: "Stream", value: true },
              { name: "Width", value: options.width },
            ],
          },
        ],
        addToHistory: false,
      },
      {
        output: (value) => {
          if (result.truncated) return;
          const line = psToString(value);
          outputChars += line.length + 1;
          if (outputChars > maxChars) {
            result.truncated = true;
            void handle.stop().catch(() => undefined);
            return;
          }
          lines.push(line);
        },
        error: (record) => push(result.errors, renderErrorRecord(record)),
        warning: (record) => push(result.warnings, informationalText(record)),
        verbose: (record) => push(result.verbose, informationalText(record)),
        information: (record) =>
          push(result.information, informationText(record)),
      },
    );
    stop = () => handle.stop();
    if (timedOut) void handle.stop().catch(() => undefined);

    const finished = await handle.done;
    if (finished.state === PipelineState.Failed) {
      result.state = "failed";
      result.errors.push(renderTerminatingError(finished.error, false));
    } else if (finished.state === PipelineState.Stopped) {
      result.state = timedOut ? "timeout" : "stopped";
    }
    if (timedOut) result.state = "timeout";
    // A truncated run was stopped on purpose; report what ran, not "stopped".
    if (result.truncated && result.state === "stopped")
      result.state = "completed";
    result.computerName = await computerName(pool).catch(() => "");
  } catch (error) {
    if (error instanceof RunTimeoutError) result.state = "timeout";
    else throw error;
  } finally {
    clearTimeout(timer);
    await pool.close().catch(() => undefined);
  }

  // Tables start with an empty line on the console; data does not need it.
  result.output = lines
    .join("\n")
    .replace(/^(?:[ \t]*\n)+/, "")
    .replace(/\s+$/, "");
  result.durationMs = Date.now() - started;
  return result;
}

async function computerName(pool: RunspacePool): Promise<string> {
  let name = "";
  await pool.invoke(
    {
      commands: [
        { command: "$env:COMPUTERNAME", isScript: true, useLocalScope: true },
      ],
      addToHistory: false,
    },
    { output: (value) => (name = psToString(value)) },
  ).done;
  return name.trim();
}

export class RunTimeoutError extends Error {
  constructor() {
    super("The run did not finish in time.");
    this.name = "RunTimeoutError";
  }
}
