import {
  type PsValue,
  isPsObject,
  prop,
  propBool,
  propNumber,
  propString,
  psToString,
} from "./clixml.js";

/*
 * Turns PowerShell's records into terminal text the way powershell.exe 5.1
 * prints them, with ANSI colours. Output itself is already text: the
 * pipeline ends in Out-String on the server, so formatting is PowerShell's.
 */

const ESC = "\x1b[";
export const RESET = `${ESC}0m`;

export const COLORS = {
  error: `${ESC}91m`,
  warning: `${ESC}93m`,
  verbose: `${ESC}93m`,
  debug: `${ESC}93m`,
  dim: `${ESC}90m`,
};

/** System.ConsoleColor (0 Black … 15 White) to ANSI SGR foreground codes. */
const CONSOLE_COLOR_SGR = [
  30, 34, 32, 36, 31, 35, 33, 37, 90, 94, 92, 96, 91, 95, 93, 97,
];

/** Removes control sequences a remote string could use to rewrite the terminal. */
export function sanitize(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC (titles, hyperlinks, clipboard)
    .replace(/\x1b[P^_][^\x1b]*\x1b\\/g, "") // DCS, PM, APC
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g, "");
}

/** Terminal line endings: xterm needs CRLF. */
export function toTerminal(text: string): string {
  return text.replace(/\r?\n/g, "\r\n");
}

export function colored(color: string, text: string): string {
  if (!text) return text;
  return text
    .split("\n")
    .map((line) => (line ? `${color}${line}${RESET}` : line))
    .join("\n");
}

export function renderErrorRecord(record: PsValue): string {
  const message =
    propString(record, "ErrorDetails_Message") ??
    (isPsObject(record) && record.toString !== null ? record.toString : null) ??
    propString(record, "Exception", "Message") ??
    psToString(record);
  const invocation = propString(record, "InvocationInfo_InvocationName") ?? "";
  const position = (propString(record, "InvocationInfo_PositionMessage") ?? "")
    .replace(/\r\n/g, "\n")
    .trimEnd();
  const category = propString(record, "ErrorCategory_Message");
  const fqid = propString(record, "FullyQualifiedErrorId");

  const lines: string[] = [invocation ? `${invocation} : ${message}` : message];
  if (position) lines.push(position);
  if (category) lines.push(`    + CategoryInfo          : ${category}`);
  if (fqid) lines.push(`    + FullyQualifiedErrorId : ${fqid}`);
  return lines.join("\n");
}

/** WARNING, VERBOSE and DEBUG records. */
export function renderInformational(label: string, record: PsValue): string {
  const message =
    propString(record, "InformationalRecord_Message") ?? psToString(record);
  return `${label}: ${message}`;
}

export interface RenderedInformation {
  text: string;
  noNewLine: boolean;
}

/** Write-Host and Write-Information output, colours included. */
export function renderInformation(record: PsValue): RenderedInformation {
  const data = prop(record, "MessageData");
  const message = propString(data, "Message");
  if (message === null)
    return { text: psToString(data ?? null), noNewLine: false };

  const noNewLine = propBool(data, "NoNewLine") ?? false;
  const fg = colorIndex(prop(data, "ForegroundColor"));
  const bg = colorIndex(prop(data, "BackgroundColor"));
  if (fg === null && bg === null) return { text: message, noNewLine };
  const codes = [
    ...(fg !== null ? [CONSOLE_COLOR_SGR[fg]] : []),
    ...(bg !== null ? [CONSOLE_COLOR_SGR[bg] + 10] : []),
  ];
  return { text: colored(`${ESC}${codes.join(";")}m`, message), noNewLine };
}

function colorIndex(value: PsValue | undefined): number | null {
  if (value === undefined || value === null) return null;
  const index =
    typeof value === "number"
      ? value
      : isPsObject(value)
        ? (propNumber(value) ??
          (typeof value.value === "number" ? value.value : null))
        : null;
  return index !== null && index >= 0 && index < 16 ? index : null;
}

/** A pipeline that failed or was stopped, as the console reports it. */
export function renderTerminatingError(
  error: PsValue | null,
  stopped: boolean,
): string {
  if (stopped) return "The pipeline has been stopped.";
  return error ? renderErrorRecord(error) : "The command failed.";
}
