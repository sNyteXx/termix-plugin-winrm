import { randomUUID } from "node:crypto";
import { escapeXml, findAll, findFirst, parseXml, textOf } from "./xml.js";

/* WS-Management envelopes for the WinRM shell operations PSRP rides on (MS-WSMV). */

const NS = {
  s: "http://www.w3.org/2003/05/soap-envelope",
  wsa: "http://schemas.xmlsoap.org/ws/2004/08/addressing",
  wsman: "http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd",
  wsmv: "http://schemas.microsoft.com/wbem/wsman/1/wsman.xsd",
  rsp: "http://schemas.microsoft.com/wbem/wsman/1/windows/shell",
};

export const ACTION = {
  create: "http://schemas.xmlsoap.org/ws/2004/09/transfer/Create",
  delete: "http://schemas.xmlsoap.org/ws/2004/09/transfer/Delete",
  command: "http://schemas.microsoft.com/wbem/wsman/1/windows/shell/Command",
  send: "http://schemas.microsoft.com/wbem/wsman/1/windows/shell/Send",
  receive: "http://schemas.microsoft.com/wbem/wsman/1/windows/shell/Receive",
  signal: "http://schemas.microsoft.com/wbem/wsman/1/windows/shell/Signal",
};

export const SIGNAL = {
  terminate:
    "http://schemas.microsoft.com/wbem/wsman/1/windows/shell/signal/Terminate",
  /** Sic: the PSRP stop signal is spelled "crtl_c". */
  psCtrlC: "http://schemas.microsoft.com/powershell/signal/crtl_c",
};

export const POWERSHELL_RESOURCE =
  "http://schemas.microsoft.com/powershell/Microsoft.PowerShell";
export const MAX_ENVELOPE_SIZE = 153600;

/** WinRM's "operation timed out" fault for a Receive with nothing new. */
export const FAULT_OPERATION_TIMEOUT = 2150858793;
/** The shell is gone (closed, idle timeout, service restart). */
export const FAULT_SHELL_NOT_FOUND = [2150858843, 2150858752];

export class WsManFault extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly subcode: string | null,
  ) {
    super(message);
    this.name = "WsManFault";
  }

  get isOperationTimeout(): boolean {
    return this.code === FAULT_OPERATION_TIMEOUT;
  }

  get isShellGone(): boolean {
    return this.code !== null && FAULT_SHELL_NOT_FOUND.includes(this.code);
  }
}

export interface EnvelopeOptions {
  action: string;
  to: string;
  sessionId: string;
  shellId?: string;
  operationTimeoutSec?: number;
  options?: Array<{ name: string; value: string; mustComply?: boolean }>;
  body: string;
  /** For tests: a fixed message id. */
  messageId?: string;
}

export function envelope(options: EnvelopeOptions): string {
  const optionSet = options.options?.length
    ? `<wsman:OptionSet s:mustUnderstand="true">${options.options
        .map(
          (o) =>
            `<wsman:Option${o.mustComply ? ' MustComply="true"' : ""} Name="${escapeXml(o.name)}">${escapeXml(o.value)}</wsman:Option>`,
        )
        .join("")}</wsman:OptionSet>`
    : "";
  const selector = options.shellId
    ? `<wsman:SelectorSet><wsman:Selector Name="ShellId">${escapeXml(options.shellId)}</wsman:Selector></wsman:SelectorSet>`
    : "";
  return (
    `<s:Envelope xmlns:s="${NS.s}" xmlns:wsa="${NS.wsa}" xmlns:wsman="${NS.wsman}" xmlns:wsmv="${NS.wsmv}" xmlns:rsp="${NS.rsp}">` +
    "<s:Header>" +
    `<wsa:Action s:mustUnderstand="true">${options.action}</wsa:Action>` +
    '<wsmv:DataLocale s:mustUnderstand="false" xml:lang="en-US" />' +
    '<wsman:Locale s:mustUnderstand="false" xml:lang="en-US" />' +
    `<wsman:MaxEnvelopeSize s:mustUnderstand="true">${MAX_ENVELOPE_SIZE}</wsman:MaxEnvelopeSize>` +
    `<wsa:MessageID>uuid:${options.messageId ?? randomUUID().toUpperCase()}</wsa:MessageID>` +
    `<wsman:OperationTimeout>PT${options.operationTimeoutSec ?? 20}S</wsman:OperationTimeout>` +
    '<wsa:ReplyTo><wsa:Address s:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</wsa:Address></wsa:ReplyTo>' +
    `<wsman:ResourceURI s:mustUnderstand="true">${POWERSHELL_RESOURCE}</wsman:ResourceURI>` +
    `<wsmv:SessionId s:mustUnderstand="false">uuid:${options.sessionId}</wsmv:SessionId>` +
    `<wsa:To>${escapeXml(options.to)}</wsa:To>` +
    optionSet +
    selector +
    "</s:Header>" +
    `<s:Body>${options.body}</s:Body></s:Envelope>`
  );
}

export function createShellBody(
  shellId: string,
  creationXmlBase64: string,
): string {
  return (
    `<rsp:Shell ShellId="${escapeXml(shellId)}"><rsp:InputStreams>stdin pr</rsp:InputStreams>` +
    "<rsp:OutputStreams>stdout</rsp:OutputStreams>" +
    `<creationXml xmlns="http://schemas.microsoft.com/powershell">${creationXmlBase64}</creationXml></rsp:Shell>`
  );
}

export function commandBody(
  commandId: string,
  argumentsBase64: string,
): string {
  return (
    `<rsp:CommandLine CommandId="${escapeXml(commandId)}"><rsp:Command />` +
    `<rsp:Arguments>${argumentsBase64}</rsp:Arguments></rsp:CommandLine>`
  );
}

export function sendBody(commandId: string | null, dataBase64: string): string {
  const command = commandId ? ` CommandId="${escapeXml(commandId)}"` : "";
  return `<rsp:Send><rsp:Stream Name="stdin"${command}>${dataBase64}</rsp:Stream></rsp:Send>`;
}

export function receiveBody(commandId: string | null): string {
  const command = commandId ? ` CommandId="${escapeXml(commandId)}"` : "";
  return `<rsp:Receive><rsp:DesiredStream${command}>stdout</rsp:DesiredStream></rsp:Receive>`;
}

export function signalBody(commandId: string, code: string): string {
  return `<rsp:Signal CommandId="${escapeXml(commandId)}"><rsp:Code>${code}</rsp:Code></rsp:Signal>`;
}

export interface ReceiveResult {
  /** Decoded stdout chunks, in order. */
  streams: Buffer[];
  /** True once the server reports the command as done. */
  done: boolean;
}

/** Throws a WsManFault when the response is a SOAP fault. */
export function checkFault(xml: string): void {
  if (!xml.includes("Fault")) return;
  const doc = parseXml(xml);
  const fault = findFirst(doc, "Fault");
  if (!fault) return;
  const wsmanFault = findFirst(fault, "WSManFault");
  const codeAttr = wsmanFault?.getAttribute("Code");
  const code = codeAttr && /^\d+$/.test(codeAttr) ? Number(codeAttr) : null;
  const subcode =
    textOf(findFirst(findFirst(fault, "Subcode") ?? fault, "Value")) || null;
  const message =
    textOf(findFirst(wsmanFault ?? fault, "Message")).trim() ||
    textOf(findFirst(fault, "Text")).trim() ||
    "WinRM returned a fault";
  throw new WsManFault(message.replace(/\s+/g, " "), code, subcode);
}

export function parseReceive(xml: string): ReceiveResult {
  checkFault(xml);
  const doc = parseXml(xml);
  const streams = findAll(doc, "Stream")
    .filter((s) => (s.getAttribute("Name") ?? "stdout") === "stdout")
    .map((s) => Buffer.from(textOf(s).trim(), "base64"))
    .filter((b) => b.length > 0);
  const state = findFirst(doc, "CommandState")?.getAttribute("State") ?? "";
  return { streams, done: state.endsWith("/Done") };
}

/** The shell's id as the server confirms it in a Create response. */
export function parseCreatedShellId(xml: string): string | null {
  checkFault(xml);
  const doc = parseXml(xml);
  return textOf(findFirst(doc, "ShellId")).trim() || null;
}
