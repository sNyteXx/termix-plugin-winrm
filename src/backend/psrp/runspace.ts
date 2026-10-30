import { WinrmError } from "../winrm/errors.js";
import {
  ACTION,
  SIGNAL,
  WsManFault,
  checkFault,
  commandBody,
  createShellBody,
  envelope,
  parseReceive,
  receiveBody,
  sendBody,
  signalBody,
} from "../winrm/wsman.js";
import {
  type PsValue,
  propNumber,
  propString,
  prop,
  readClixml,
} from "./clixml.js";
import {
  type CreatePipelineOptions,
  Defragmenter,
  Fragmenter,
  MessageType,
  PipelineState,
  PsrpError,
  RunspacePoolState,
  createPipelineXml,
  encodeMessage,
  initRunspacePoolXml,
  newGuid,
  sessionCapabilityXml,
} from "./messages.js";

/*
 * A PSRP runspace pool on one WinRM shell, with one runspace, so state
 * (variables, location, history) lives across pipelines like a console.
 * Two channels: `control` creates, sends, signals and deletes; `poll` carries
 * the long-polling Receive, so a stop signal never waits behind it.
 */

export interface SoapChannel {
  readonly url: string;
  send(soap: string, timeoutMs: number): Promise<string>;
  close(): void;
}

export interface PipelineEvents {
  output?: (value: PsValue) => void;
  error?: (record: PsValue) => void;
  warning?: (record: PsValue) => void;
  verbose?: (record: PsValue) => void;
  debug?: (record: PsValue) => void;
  information?: (record: PsValue) => void;
  progress?: (record: PsValue) => void;
}

export interface PipelineResult {
  state: number;
  /** The terminating error when state is Failed. */
  error: PsValue | null;
}

export interface PipelineHandle {
  id: string;
  done: Promise<PipelineResult>;
  /** Best effort: asks PowerShell to stop, like Ctrl+C. */
  stop(): Promise<void>;
}

export interface RunspacePoolOptions {
  control: SoapChannel;
  poll: SoapChannel;
  /** WinRM OperationTimeout for Receive, seconds. */
  operationTimeoutSec?: number;
  /** Extra time allowed on top of a request's operation timeout. */
  requestSlackMs?: number;
  newId?: () => string;
}

const CONTROL_TIMEOUT_MS = 60_000;

export class RunspacePool {
  readonly id: string;
  private readonly sessionId: string;
  private readonly fragmenter = new Fragmenter();
  private readonly operationTimeoutSec: number;
  private readonly slackMs: number;
  private readonly newId: () => string;
  private state: number = RunspacePoolState.BeforeOpen;
  private running: string | null = null;
  psVersion: string | null = null;

  constructor(private readonly options: RunspacePoolOptions) {
    this.newId = options.newId ?? newGuid;
    this.id = this.newId();
    this.sessionId = this.newId();
    this.operationTimeoutSec = options.operationTimeoutSec ?? 20;
    this.slackMs = options.requestSlackMs ?? 30_000;
  }

  get opened(): boolean {
    return this.state === RunspacePoolState.Opened;
  }

  get busy(): boolean {
    return this.running !== null;
  }

  private soap(
    action: string,
    body: string,
    extra: {
      options?: Array<{ name: string; value: string; mustComply?: boolean }>;
      shell?: boolean;
    } = {},
  ): string {
    return envelope({
      action,
      to: this.options.control.url,
      sessionId: this.sessionId,
      shellId: extra.shell === false ? undefined : this.id,
      operationTimeoutSec: this.operationTimeoutSec,
      options: extra.options,
      body,
    });
  }

  async open(): Promise<void> {
    if (this.state !== RunspacePoolState.BeforeOpen)
      throw new PsrpError("The runspace pool was already opened");
    this.state = RunspacePoolState.Opening;
    const creation = Buffer.concat([
      ...this.fragmenter.fragment(
        encodeMessage(
          MessageType.SESSION_CAPABILITY,
          this.id,
          null,
          sessionCapabilityXml(),
        ),
      ),
      ...this.fragmenter.fragment(
        encodeMessage(
          MessageType.INIT_RUNSPACEPOOL,
          this.id,
          null,
          initRunspacePoolXml(),
        ),
      ),
    ]);
    await this.call(
      this.soap(
        ACTION.create,
        createShellBody(this.id, creation.toString("base64")),
        {
          shell: false,
          options: [
            { name: "protocolversion", value: "2.3", mustComply: true },
          ],
        },
      ),
    );

    const defragmenter = new Defragmenter();
    const deadline = Date.now() + CONTROL_TIMEOUT_MS;
    while (this.state !== RunspacePoolState.Opened) {
      if (Date.now() > deadline)
        throw new WinrmError(
          "timeout",
          "PowerShell did not open the session in time.",
        );
      const result = await this.receive(null, this.options.poll);
      for (const chunk of result.streams) {
        for (const message of defragmenter.push(chunk)) {
          if (message.type === MessageType.RUNSPACEPOOL_STATE) {
            const value = readClixml(message.data);
            const state = propNumber(value, "RunspaceState") ?? -1;
            if (
              state === RunspacePoolState.Broken ||
              state === RunspacePoolState.Closed
            ) {
              this.state = state;
              const reason =
                propString(value, "ExceptionAsErrorRecord") ??
                "PowerShell refused to open the session.";
              throw new WinrmError("remote", reason);
            }
            this.state = state;
          } else if (message.type === MessageType.APPLICATION_PRIVATE_DATA) {
            this.psVersion = findPsVersion(readClixml(message.data));
          }
        }
      }
      if (result.done && this.state !== RunspacePoolState.Opened) {
        throw new WinrmError(
          "remote",
          "The PowerShell session ended while opening.",
        );
      }
    }
  }

  /** A Receive that treats WinRM's "nothing yet" timeout as an empty result. */
  private async receive(
    commandId: string | null,
    channel: SoapChannel,
  ): Promise<{ streams: Buffer[]; done: boolean }> {
    const response = await channel.send(
      this.soap(ACTION.receive, receiveBody(commandId), {
        options: [{ name: "WSMAN_CMDSHELL_OPTION_KEEPALIVE", value: "True" }],
      }),
      this.operationTimeoutSec * 1000 + this.slackMs,
    );
    try {
      return parseReceive(response);
    } catch (error) {
      if (error instanceof WsManFault && error.isOperationTimeout)
        return { streams: [], done: false };
      throw this.mapFault(error);
    }
  }

  invoke(
    options: CreatePipelineOptions,
    events: PipelineEvents,
  ): PipelineHandle {
    if (!this.opened) throw new PsrpError("The runspace pool is not open");
    if (this.running) throw new PsrpError("A command is already running");
    const pipelineId = this.newId();
    this.running = pipelineId;
    let stopRequested = false;

    const done = (async (): Promise<PipelineResult> => {
      try {
        const fragments = this.fragmenter.fragment(
          encodeMessage(
            MessageType.CREATE_PIPELINE,
            this.id,
            pipelineId,
            createPipelineXml(options),
          ),
        );
        await this.call(
          this.soap(
            ACTION.command,
            commandBody(pipelineId, fragments[0].toString("base64")),
            {
              options: [{ name: "WINRS_SKIP_CMD_SHELL", value: "False" }],
            },
          ),
        );
        for (const fragment of fragments.slice(1)) {
          await this.call(
            this.soap(
              ACTION.send,
              sendBody(pipelineId, fragment.toString("base64")),
            ),
          );
        }

        const defragmenter = new Defragmenter();
        let result: PipelineResult | null = null;
        while (!result) {
          const received = await this.receive(pipelineId, this.options.poll);
          for (const chunk of received.streams) {
            for (const message of defragmenter.push(chunk)) {
              result = dispatch(message.type, message.data, events) ?? result;
            }
          }
          if (!result && received.done) {
            result = {
              state: stopRequested
                ? PipelineState.Stopped
                : PipelineState.Completed,
              error: null,
            };
          }
        }
        await this.signal(pipelineId, SIGNAL.terminate).catch(() => undefined);
        return result;
      } finally {
        this.running = null;
      }
    })();

    return {
      id: pipelineId,
      done,
      stop: async () => {
        if (stopRequested || this.running !== pipelineId) return;
        stopRequested = true;
        await this.signal(pipelineId, SIGNAL.psCtrlC);
      },
    };
  }

  private async signal(commandId: string, code: string): Promise<void> {
    await this.call(this.soap(ACTION.signal, signalBody(commandId, code)));
  }

  /** A control request; faults become WinrmErrors the session can act on. */
  private async call(soap: string): Promise<string> {
    const response = await this.options.control.send(soap, CONTROL_TIMEOUT_MS);
    try {
      checkFault(response);
    } catch (error) {
      throw this.mapFault(error);
    }
    return response;
  }

  private mapFault(error: unknown): unknown {
    if (!(error instanceof WsManFault)) return error;
    if (error.isShellGone) {
      this.state = RunspacePoolState.Broken;
      return new WinrmError(
        "shell-gone",
        "The remote PowerShell session no longer exists.",
      );
    }
    return new WinrmError("remote", `WinRM: ${error.message}`);
  }

  /** Deletes the shell (best effort, bounded) and closes both channels. */
  async close(timeoutMs = 10_000): Promise<void> {
    const wasOpen =
      this.state === RunspacePoolState.Opened ||
      this.state === RunspacePoolState.Opening;
    this.state = RunspacePoolState.Closed;
    try {
      if (wasOpen) {
        // The poll channel may be stuck in a Receive; dropping it first frees the shell.
        this.options.poll.close();
        await this.options.control.send(
          this.soap(ACTION.delete, ""),
          timeoutMs,
        );
      }
    } catch {
      // The shell times out on the server on its own if this fails.
    } finally {
      this.options.poll.close();
      this.options.control.close();
    }
  }
}

function dispatch(
  type: number,
  data: string,
  events: PipelineEvents,
): PipelineResult | null {
  switch (type) {
    case MessageType.PIPELINE_OUTPUT:
      events.output?.(readClixml(data));
      return null;
    case MessageType.ERROR_RECORD:
      events.error?.(readClixml(data));
      return null;
    case MessageType.WARNING_RECORD:
      events.warning?.(readClixml(data));
      return null;
    case MessageType.VERBOSE_RECORD:
      events.verbose?.(readClixml(data));
      return null;
    case MessageType.DEBUG_RECORD:
      events.debug?.(readClixml(data));
      return null;
    case MessageType.INFORMATION_RECORD:
      events.information?.(readClixml(data));
      return null;
    case MessageType.PROGRESS_RECORD:
      events.progress?.(readClixml(data));
      return null;
    case MessageType.PIPELINE_STATE: {
      const value = readClixml(data);
      const state = propNumber(value, "PipelineState") ?? -1;
      if (
        state === PipelineState.Completed ||
        state === PipelineState.Failed ||
        state === PipelineState.Stopped
      ) {
        return { state, error: prop(value, "ExceptionAsErrorRecord") ?? null };
      }
      return null;
    }
    default:
      // Host calls cannot arrive (no host is offered); anything else is informational.
      return null;
  }
}

function findPsVersion(value: PsValue): string | null {
  const data = prop(value, "ApplicationPrivateData");
  const entries =
    typeof data === "object" && data && !Array.isArray(data)
      ? data.dict
      : undefined;
  const table = entries?.find(([key]) => key === "PSVersionTable")?.[1];
  const inner =
    typeof table === "object" && table && !Array.isArray(table)
      ? table.dict
      : undefined;
  const version = inner?.find(([key]) => key === "PSVersion")?.[1];
  return typeof version === "string" ? version : null;
}
