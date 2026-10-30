import {
  type PsValue,
  encodePsString,
  isPsObject,
  prop,
  propBool,
  propString,
  readClixml,
} from "../../src/backend/psrp/clixml.js";
import {
  Defragmenter,
  Fragmenter,
  MessageType,
  encodeMessage,
} from "../../src/backend/psrp/messages.js";
import type { SoapChannel } from "../../src/backend/psrp/runspace.js";

/*
 * A fake WinRM endpoint with a toy PowerShell behind it: enough to drive the
 * session and terminal logic (scopes, streams, stop, history) without a
 * Windows host. It answers the real WS-Man and PSRP messages the client sends.
 */

export interface SentCommand {
  command: string;
  isScript: boolean;
  useLocalScope: boolean | null;
  args: Array<[string | null, PsValue]>;
}

export interface SentPipeline {
  commands: SentCommand[];
  addToHistory: boolean;
  history: string | null;
}

const ENVELOPE_START =
  '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:rsp="http://schemas.microsoft.com/wbem/wsman/1/windows/shell" xmlns:w="http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd"><s:Body>';
const ENVELOPE_END = "</s:Body></s:Envelope>";
const TIMEOUT_FAULT =
  '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><s:Fault><s:Code><s:Value>s:Receiver</s:Value></s:Code><s:Reason><s:Text>timeout</s:Text></s:Reason><s:Detail><f:WSManFault xmlns:f="http://schemas.microsoft.com/wbem/wsman/1/wsmanfault" Code="2150858793"><f:Message>timeout</f:Message></f:WSManFault></s:Detail></s:Fault></s:Body></s:Envelope>';
const GONE_FAULT =
  '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><s:Fault><s:Code><s:Value>s:Sender</s:Value></s:Code><s:Reason><s:Text>gone</s:Text></s:Reason><s:Detail><f:WSManFault xmlns:f="http://schemas.microsoft.com/wbem/wsman/1/wsmanfault" Code="2150858843"><f:Message>The shell was not found.</f:Message></f:WSManFault></s:Detail></s:Fault></s:Body></s:Envelope>';

function errorRecordXml(message: string, fqid: string): string {
  return (
    '<Obj RefId="0"><TN RefId="0"><T>System.Management.Automation.ErrorRecord</T><T>System.Object</T></TN>' +
    `<ToString>${encodePsString(message)}</ToString><MS>` +
    `<S N="ErrorCategory_Message">${encodePsString(`NotSpecified: (:) [], ${fqid}`)}</S>` +
    `<S N="FullyQualifiedErrorId">${encodePsString(fqid)}</S></MS></Obj>`
  );
}

export class FakePowerShell {
  readonly pipelines: SentPipeline[] = [];
  readonly signals: string[] = [];
  readonly variables = new Map<string, string>();
  location = "C:\\Users\\Administrator";
  deleted = false;
  shellGone = false;
  private readonly fragmenter = new Fragmenter();
  private poolQueue: Buffer[] = [];
  private readonly commands = new Map<
    string,
    { queue: Buffer[]; done: boolean; hang: boolean }
  >();
  private readonly defrag = new Defragmenter();
  private poolId = "";

  channel(url = "http://srv01:5985/wsman"): SoapChannel {
    return { url, close: () => undefined, send: (soap) => this.handle(soap) };
  }

  private message(
    type: number,
    pipelineId: string | null,
    xml: string,
  ): Buffer {
    return Buffer.concat(
      this.fragmenter.fragment(
        encodeMessage(type, this.poolId, pipelineId, xml),
      ),
    );
  }

  private async handle(soap: string): Promise<string> {
    const action = /<wsa:Action[^>]*>([^<]+)</.exec(soap)?.[1] ?? "";
    const commandId = /CommandId="([^"]+)"/.exec(soap)?.[1] ?? null;
    if (this.shellGone && !action.endsWith("/Create")) return GONE_FAULT;

    if (action.endsWith("/Create")) {
      this.poolId = /ShellId="([^"]+)"/.exec(soap)?.[1] ?? "";
      const appData =
        '<Obj RefId="0"><MS><Obj N="ApplicationPrivateData" RefId="1"><TN RefId="0"><T>System.Management.Automation.PSPrimitiveDictionary</T></TN><DCT><En><S N="Key">PSVersionTable</S><Obj N="Value" RefId="2"><TNRef RefId="0" /><DCT><En><S N="Key">PSVersion</S><Version N="Value">5.1.26100.1</Version></En></DCT></Obj></En></DCT></Obj></MS></Obj>';
      this.poolQueue.push(
        this.message(MessageType.APPLICATION_PRIVATE_DATA, null, appData),
      );
      this.poolQueue.push(
        this.message(
          MessageType.RUNSPACEPOOL_STATE,
          null,
          '<Obj RefId="0"><MS><I32 N="RunspaceState">2</I32></MS></Obj>',
        ),
      );
      return `${ENVELOPE_START}<rsp:Shell><rsp:ShellId>${this.poolId}</rsp:ShellId></rsp:Shell>${ENVELOPE_END}`;
    }
    if (action.endsWith("/Command")) {
      const args = /<rsp:Arguments>([^<]+)</.exec(soap)?.[1] ?? "";
      const [message] = this.defrag.push(Buffer.from(args, "base64"));
      const pipeline = parsePipeline(readClixml(message.data));
      this.pipelines.push(pipeline);
      this.commands.set(
        commandId as string,
        this.execute(commandId as string, pipeline),
      );
      return `${ENVELOPE_START}<rsp:CommandResponse><rsp:CommandId>${commandId}</rsp:CommandId></rsp:CommandResponse>${ENVELOPE_END}`;
    }
    if (action.endsWith("/Receive")) {
      if (!commandId) {
        const streams = this.poolQueue
          .splice(0)
          .map(
            (b) =>
              `<rsp:Stream Name="stdout">${b.toString("base64")}</rsp:Stream>`,
          );
        return `${ENVELOPE_START}<rsp:ReceiveResponse>${streams.join("")}</rsp:ReceiveResponse>${ENVELOPE_END}`;
      }
      const command = this.commands.get(commandId);
      if (!command) return GONE_FAULT;
      if (command.hang) {
        await new Promise((r) => setTimeout(r, 5));
        return TIMEOUT_FAULT;
      }
      const streams = command.queue
        .splice(0)
        .map(
          (b) =>
            `<rsp:Stream Name="stdout" CommandId="${commandId}">${b.toString("base64")}</rsp:Stream>`,
        );
      const state = command.done
        ? `<rsp:CommandState CommandId="${commandId}" State="http://schemas.microsoft.com/wbem/wsman/1/windows/shell/CommandState/Done" />`
        : "";
      return `${ENVELOPE_START}<rsp:ReceiveResponse>${streams.join("")}${state}</rsp:ReceiveResponse>${ENVELOPE_END}`;
    }
    if (action.endsWith("/Signal")) {
      const code = /<rsp:Code>([^<]+)</.exec(soap)?.[1] ?? "";
      this.signals.push(code.split("/").pop() as string);
      const command = this.commands.get(commandId as string);
      if (command && code.endsWith("crtl_c") && command.hang) {
        command.hang = false;
        command.done = true;
        command.queue.push(
          this.message(
            MessageType.PIPELINE_STATE,
            commandId,
            '<Obj RefId="0"><MS><I32 N="PipelineState">3</I32></MS></Obj>',
          ),
        );
      }
      return `${ENVELOPE_START}<rsp:SignalResponse/>${ENVELOPE_END}`;
    }
    if (action.endsWith("/Delete")) {
      this.deleted = true;
      return `${ENVELOPE_START}${ENVELOPE_END}`;
    }
    throw new Error(`fake: unexpected action ${action}`);
  }

  /** The toy interpreter. Output strings stand for what Out-String would emit. */
  private execute(id: string, pipeline: SentPipeline) {
    const queue: Buffer[] = [];
    const out = (text: string) =>
      queue.push(
        this.message(
          MessageType.PIPELINE_OUTPUT,
          id,
          `<S>${encodePsString(text)}</S>`,
        ),
      );
    const state = (value: number, error?: string) =>
      queue.push(
        this.message(
          MessageType.PIPELINE_STATE,
          id,
          `<Obj RefId="0"><MS><I32 N="PipelineState">${value}</I32>${error ? errorRecordXml(error, "RuntimeException").replace('<Obj RefId="0">', '<Obj N="ExceptionAsErrorRecord" RefId="1">') : ""}</MS></Obj>`,
        ),
      );
    const first = pipeline.commands[0];
    const script = first.command;
    let hang = false;

    if (script === "$env:COMPUTERNAME") out("SRV01");
    else if (script === "prompt") out(`PS ${this.location}> `);
    else if (script === "$null") {
      // nothing
    } else if (script.startsWith("param([string]$s)")) {
      const text = String(first.args.find(([n]) => n === "s")?.[1] ?? "");
      const open =
        (text.match(/[{(]/g) ?? []).length - (text.match(/[})]/g) ?? []).length;
      out(open > 0 ? "True" : "False");
    } else {
      for (const statement of script
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)) {
        let match: RegExpExecArray | null;
        if ((match = /^\$(\w+)\s*=\s*'([^']*)'$/.exec(statement))) {
          if (first.useLocalScope === false)
            this.variables.set(match[1], match[2]);
        } else if ((match = /^\$(\w+)$/.exec(statement))) {
          const value = this.variables.get(match[1]);
          if (value !== undefined) out(value);
        } else if ((match = /^Set-Location\s+(.+)$/.exec(statement))) {
          if (first.useLocalScope === false) this.location = match[1];
        } else if ((match = /^Write-Error\s+(.+)$/.exec(statement))) {
          queue.push(
            this.message(
              MessageType.ERROR_RECORD,
              id,
              errorRecordXml(
                match[1],
                "Microsoft.PowerShell.Commands.WriteErrorException",
              ),
            ),
          );
        } else if ((match = /^Write-Warning\s+(.+)$/.exec(statement))) {
          queue.push(
            this.message(
              MessageType.WARNING_RECORD,
              id,
              `<Obj RefId="0"><ToString>${encodePsString(match[1])}</ToString><MS><S N="InformationalRecord_Message">${encodePsString(match[1])}</S></MS></Obj>`,
            ),
          );
        } else if (
          (match = /^Write-Host\s+'([^']*)'(\s+-NoNewline)?$/.exec(statement))
        ) {
          queue.push(
            this.message(
              MessageType.INFORMATION_RECORD,
              id,
              `<Obj RefId="0"><MS><Obj N="MessageData" RefId="1"><MS><S N="Message">${encodePsString(match[1])}</S><B N="NoNewLine">${!!match[2]}</B><Obj N="ForegroundColor" RefId="2"><ToString>Green</ToString><I32>10</I32></Obj><Nil N="BackgroundColor" /></MS></Obj></MS></Obj>`,
            ),
          );
        } else if ((match = /^throw\s+'([^']*)'$/.exec(statement))) {
          state(5, match[1]);
          return { queue, done: true, hang: false };
        } else if (/^Start-Sleep/.test(statement)) {
          hang = true;
        } else if ((match = /^echo\s+(.+)$/.exec(statement))) {
          out(match[1]);
        }
      }
    }
    if (!hang) state(4);
    return { queue, done: !hang, hang };
  }
}

function parsePipeline(value: PsValue): SentPipeline {
  const ps = prop(value, "PowerShell");
  const cmds = prop(ps, "Cmds");
  const list = isPsObject(cmds) ? (cmds.list ?? []) : [];
  return {
    addToHistory: propBool(value, "AddToHistory") ?? false,
    history: propString(ps, "History"),
    commands: list.map((cmd) => {
      const args = prop(cmd, "Args");
      return {
        command: propString(cmd, "Cmd") ?? "",
        isScript: propBool(cmd, "IsScript") ?? false,
        useLocalScope: propBool(cmd, "UseLocalScope"),
        args: (isPsObject(args) ? (args.list ?? []) : []).map(
          (a) =>
            [propString(a, "N"), prop(a, "V") ?? null] as [
              string | null,
              PsValue,
            ],
        ),
      };
    }),
  };
}
