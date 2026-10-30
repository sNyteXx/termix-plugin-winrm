import { randomUUID } from "node:crypto";
import { ClixmlWriter, bool, i32, str } from "./clixml.js";

/* PSRP framing (MS-PSRP 2.2.1 and 2.2.4) and the client's own messages. */

export const MessageType = {
  SESSION_CAPABILITY: 0x00010002,
  INIT_RUNSPACEPOOL: 0x00010004,
  PUBLIC_KEY: 0x00010005,
  ENCRYPTED_SESSION_KEY: 0x00010006,
  PUBLIC_KEY_REQUEST: 0x00010007,
  SET_MAX_RUNSPACES: 0x00021002,
  SET_MIN_RUNSPACES: 0x00021003,
  RUNSPACE_AVAILABILITY: 0x00021004,
  RUNSPACEPOOL_STATE: 0x00021005,
  CREATE_PIPELINE: 0x00021006,
  USER_EVENT: 0x00021008,
  APPLICATION_PRIVATE_DATA: 0x00021009,
  RUNSPACEPOOL_HOST_CALL: 0x00021100,
  PIPELINE_INPUT: 0x00041002,
  END_OF_PIPELINE_INPUT: 0x00041003,
  PIPELINE_OUTPUT: 0x00041004,
  ERROR_RECORD: 0x00041005,
  PIPELINE_STATE: 0x00041006,
  DEBUG_RECORD: 0x00041007,
  VERBOSE_RECORD: 0x00041008,
  WARNING_RECORD: 0x00041009,
  PROGRESS_RECORD: 0x00041010,
  INFORMATION_RECORD: 0x00041011,
  PIPELINE_HOST_CALL: 0x00041100,
} as const;

export const RunspacePoolState = {
  BeforeOpen: 0,
  Opening: 1,
  Opened: 2,
  Closed: 3,
  Closing: 4,
  Broken: 5,
  NegotiationSent: 6,
  NegotiationSucceeded: 7,
  Connecting: 8,
  Disconnected: 9,
} as const;

export const PipelineState = {
  NotStarted: 0,
  Running: 1,
  Stopping: 2,
  Stopped: 3,
  Completed: 4,
  Failed: 5,
  Disconnected: 6,
} as const;

const DESTINATION_SERVER = 0x2;
const EMPTY_GUID = "00000000-0000-0000-0000-000000000000";

export class PsrpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PsrpError";
  }
}

export function newGuid(): string {
  return randomUUID().toUpperCase();
}

/** A GUID in .NET's byte order (the first three fields little endian). */
export function guidToBytes(guid: string): Buffer {
  const hex = guid.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex))
    throw new PsrpError(`Invalid GUID ${guid}`);
  const raw = Buffer.from(hex, "hex");
  return Buffer.concat([
    Buffer.from(raw.subarray(0, 4)).reverse(),
    Buffer.from(raw.subarray(4, 6)).reverse(),
    Buffer.from(raw.subarray(6, 8)).reverse(),
    raw.subarray(8),
  ]);
}

export function bytesToGuid(bytes: Buffer): string {
  const raw = Buffer.concat([
    Buffer.from(bytes.subarray(0, 4)).reverse(),
    Buffer.from(bytes.subarray(4, 6)).reverse(),
    Buffer.from(bytes.subarray(6, 8)).reverse(),
    bytes.subarray(8, 16),
  ]).toString("hex");
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`.toUpperCase();
}

export interface PsrpMessage {
  destination: number;
  type: number;
  runspacePoolId: string;
  pipelineId: string;
  /** The UTF-8 CLIXML, BOM removed. */
  data: string;
}

export function encodeMessage(
  type: number,
  runspacePoolId: string,
  pipelineId: string | null,
  data: string,
): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(DESTINATION_SERVER, 0);
  header.writeUInt32LE(type, 4);
  return Buffer.concat([
    header,
    guidToBytes(runspacePoolId),
    guidToBytes(pipelineId ?? EMPTY_GUID),
    Buffer.from(data, "utf8"),
  ]);
}

export function decodeMessage(bytes: Buffer): PsrpMessage {
  if (bytes.length < 40) throw new PsrpError("PSRP message is too short");
  let data = bytes.subarray(40);
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf)
    data = data.subarray(3);
  return {
    destination: bytes.readUInt32LE(0),
    type: bytes.readUInt32LE(4),
    runspacePoolId: bytesToGuid(bytes.subarray(8, 24)),
    pipelineId: bytesToGuid(bytes.subarray(24, 40)),
    data: data.toString("utf8"),
  };
}

// ---------------------------------------------------------------- fragments

const FRAGMENT_HEADER = 21;
/** Keeps every Base64 fragment well under the 150 KB envelope limit. */
export const MAX_FRAGMENT_BLOB = 64 * 1024 - FRAGMENT_HEADER;
/** A defragmented message larger than this is refused. */
export const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

/** Splits messages into fragments, each one returned as its own buffer. */
export class Fragmenter {
  private objectId = 1n;

  fragment(message: Buffer, maxBlob = MAX_FRAGMENT_BLOB): Buffer[] {
    const objectId = this.objectId++;
    const out: Buffer[] = [];
    const count = Math.max(1, Math.ceil(message.length / maxBlob));
    for (let i = 0; i < count; i++) {
      const blob = message.subarray(i * maxBlob, (i + 1) * maxBlob);
      const header = Buffer.alloc(FRAGMENT_HEADER);
      header.writeBigUInt64BE(objectId, 0);
      header.writeBigUInt64BE(BigInt(i), 8);
      header.writeUInt8((i === 0 ? 0x1 : 0) | (i === count - 1 ? 0x2 : 0), 16);
      header.writeUInt32BE(blob.length, 17);
      out.push(Buffer.concat([header, blob]));
    }
    return out;
  }
}

/** Reassembles fragments from any number of stream chunks into whole messages. */
export class Defragmenter {
  private readonly partial = new Map<
    bigint,
    { next: bigint; parts: Buffer[]; size: number }
  >();

  push(data: Buffer): PsrpMessage[] {
    const messages: PsrpMessage[] = [];
    let offset = 0;
    while (offset < data.length) {
      if (offset + FRAGMENT_HEADER > data.length)
        throw new PsrpError("Truncated PSRP fragment");
      const objectId = data.readBigUInt64BE(offset);
      const fragmentId = data.readBigUInt64BE(offset + 8);
      const flags = data.readUInt8(offset + 16);
      const length = data.readUInt32BE(offset + 17);
      const start = offset + FRAGMENT_HEADER;
      if (start + length > data.length)
        throw new PsrpError("Truncated PSRP fragment");
      const blob = data.subarray(start, start + length);
      offset = start + length;

      const isStart = (flags & 0x1) !== 0;
      const isEnd = (flags & 0x2) !== 0;
      if (isStart && isEnd) {
        messages.push(decodeMessage(Buffer.from(blob)));
        continue;
      }
      if (isStart) {
        this.partial.set(objectId, {
          next: 1n,
          parts: [Buffer.from(blob)],
          size: length,
        });
        continue;
      }
      const pending = this.partial.get(objectId);
      if (!pending || pending.next !== fragmentId) {
        throw new PsrpError("PSRP fragments arrived out of order");
      }
      pending.parts.push(Buffer.from(blob));
      pending.size += length;
      pending.next++;
      if (pending.size > MAX_MESSAGE_BYTES)
        throw new PsrpError("PSRP message is too large");
      if (isEnd) {
        this.partial.delete(objectId);
        messages.push(decodeMessage(Buffer.concat(pending.parts)));
      }
    }
    return messages;
  }
}

// ---------------------------------------------------------------- client messages

export function sessionCapabilityXml(): string {
  return (
    '<Obj RefId="0"><MS><Version N="protocolversion">2.3</Version>' +
    '<Version N="PSVersion">2.0</Version>' +
    '<Version N="SerializationVersion">1.1.0.1</Version></MS></Obj>'
  );
}

function hostInfoXml(writer: ClixmlWriter): string {
  // No PSHost: Write-Host arrives as information records, Read-Host fails cleanly.
  return (
    `<Obj N="HostInfo" RefId="${writer.nextRef()}"><MS>` +
    '<B N="_isHostNull">true</B><B N="_isHostUINull">true</B>' +
    '<B N="_isHostRawUINull">true</B><B N="_useRunspaceHost">true</B></MS></Obj>'
  );
}

export function initRunspacePoolXml(): string {
  const w = new ClixmlWriter();
  const root = w.nextRef();
  return (
    `<Obj RefId="${root}"><MS>${i32("MinRunspaces", 1)}${i32("MaxRunspaces", 1)}` +
    w.enumObj(
      "PSThreadOptions",
      "System.Management.Automation.Runspaces.PSThreadOptions",
      "Default",
      0,
    ) +
    w.enumObj(
      "ApartmentState",
      "System.Management.Automation.Runspaces.ApartmentState",
      "UNKNOWN",
      2,
    ) +
    hostInfoXml(w) +
    '<Nil N="ApplicationArguments" /></MS></Obj>'
  );
}

export type PsArgumentValue = string | boolean | number | null;

export interface PsCommand {
  /** A script, or a command name when isScript is false. */
  command: string;
  isScript: boolean;
  /** For scripts: false runs in the caller's scope, so variables persist. */
  useLocalScope?: boolean;
  /** Named parameters; a null name passes the value positionally. */
  args?: Array<{ name: string | null; value: PsArgumentValue }>;
}

export interface CreatePipelineOptions {
  commands: PsCommand[];
  addToHistory: boolean;
  /** The line Get-History shows for this pipeline. */
  history?: string | null;
}

const PIPELINE_RESULT =
  "System.Management.Automation.Runspaces.PipelineResultTypes";
const PS_OBJECT_LIST =
  "System.Collections.Generic.List`1[[System.Management.Automation.PSObject, System.Management.Automation, Version=1.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35]]";

function argumentXml(value: PsArgumentValue): string {
  if (value === null) return '<Nil N="V" />';
  if (typeof value === "boolean") return bool("V", value);
  if (typeof value === "number") return i32("V", value);
  return str("V", value);
}

export function createPipelineXml(options: CreatePipelineOptions): string {
  const w = new ClixmlWriter();
  const root = w.nextRef();
  let xml =
    `<Obj RefId="${root}"><MS><B N="NoInput">true</B>` +
    w.enumObj(
      "ApartmentState",
      "System.Management.Automation.Runspaces.ApartmentState",
      "UNKNOWN",
      2,
    ) +
    w.enumObj(
      "RemoteStreamOptions",
      "System.Management.Automation.Runspaces.RemoteStreamOptions",
      "AddInvocationInfo",
      15,
    ) +
    bool("AddToHistory", options.addToHistory) +
    hostInfoXml(w);

  xml += `<Obj N="PowerShell" RefId="${w.nextRef()}"><MS><B N="IsNested">false</B><Nil N="ExtraCmds" />`;
  xml += `<Obj N="Cmds" RefId="${w.nextRef()}">${w.typeNames([PS_OBJECT_LIST, "System.Object"])}<LST>`;
  for (const command of options.commands) {
    xml += `<Obj RefId="${w.nextRef()}"><MS>${str("Cmd", command.command)}${bool("IsScript", command.isScript)}`;
    xml += command.isScript
      ? bool("UseLocalScope", command.useLocalScope ?? false)
      : '<Nil N="UseLocalScope" />';
    xml += w.enumObj("MergeMyResult", PIPELINE_RESULT, "None", 0);
    xml += w.enumObj("MergeToResult", PIPELINE_RESULT, "None", 0);
    xml += w.enumObj("MergePreviousResults", PIPELINE_RESULT, "None", 0);
    xml += `<Obj N="Args" RefId="${w.nextRef()}">${w.typeNames([PS_OBJECT_LIST, "System.Object"])}`;
    const args = command.args ?? [];
    if (args.length === 0) xml += "<LST />";
    else {
      xml += "<LST>";
      for (const arg of args) {
        xml += `<Obj RefId="${w.nextRef()}"><MS>${str("N", arg.name)}${argumentXml(arg.value)}</MS></Obj>`;
      }
      xml += "</LST>";
    }
    xml += "</Obj>";
    for (const stream of [
      "MergeError",
      "MergeWarning",
      "MergeVerbose",
      "MergeDebug",
      "MergeInformation",
    ]) {
      xml += w.enumObj(stream, PIPELINE_RESULT, "None", 0);
    }
    xml += "</MS></Obj>";
  }
  xml += "</LST></Obj>";
  xml += str("History", options.history ?? null);
  xml += '<B N="RedirectShellErrorOutputPipe">false</B></MS></Obj>';
  xml += '<B N="IsNested">false</B></MS></Obj>';
  return xml;
}
