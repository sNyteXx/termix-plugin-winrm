import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { ConfigError, type WinrmTarget } from "../config.js";
import type { QuickConnectInput } from "../connect.js";
import { WinrmError } from "../winrm/errors.js";
import { LimitError, type SessionManager } from "./manager.js";
import type { RunHandle } from "./powershell-session.js";

/*
 * The terminal's WebSocket protocol. The browser sends lines, never
 * credentials for a saved host: the backend resolves the login itself. Only a
 * quick connect carries the login the user just typed, once, in the opening
 * message. Messages are JSON, size-capped and validated field by field.
 *
 * client -> server
 *   { type: "open", hostId?: number, quick?: QuickConnectInput, cols: number }
 *   { type: "submit", text: string, force?: boolean }
 *   { type: "stop" } | { type: "resize", cols: number } | { type: "close" }
 * server -> client
 *   { type: "status", state: "connecting" | "connected", computer?, psVersion? }
 *   { type: "output", data } | { type: "prompt", text } | { type: "incomplete" }
 *   { type: "clear" } | { type: "error", message, kind, fatal }
 */

export interface TerminalBackend {
  readonly computerName: string;
  readonly psVersion: string | null;
  readonly busy: boolean;
  prompt(): Promise<string>;
  isIncomplete(text: string): Promise<boolean>;
  run(text: string, width: number, write: (chunk: string) => void): RunHandle;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface SocketLike {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(
    event: "message",
    listener: (data: unknown, isBinary: boolean) => void,
  ): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface TerminalDeps {
  manager: SessionManager;
  canUse(): Promise<boolean>;
  limits(): Promise<{ perUser: number; total: number; idleMs: number }>;
  resolveSaved(hostId: number): Promise<WinrmTarget | null>;
  quickTarget(input: QuickConnectInput): WinrmTarget;
  connect(
    target: WinrmTarget,
  ): Promise<{ backend: TerminalBackend; dispose: () => void }>;
  audit(entry: {
    action: string;
    target: WinrmTarget;
    success: boolean;
    error?: string;
  }): void;
  log: { info(message: string): void; warn(message: string): void };
  /** Test seams. */
  openTimeoutMs?: number;
  keepaliveMs?: number;
}

export const MAX_MESSAGE_CHARS = 512 * 1024;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const OPEN = 1;
const CLEAR_COMMANDS = /^\s*(cls|clear|clear-host)\s*;?\s*$/i;

type Incoming =
  | { type: "open"; hostId?: number; quick?: QuickConnectInput; cols: number }
  | { type: "submit"; text: string; force: boolean }
  | { type: "stop" }
  | { type: "resize"; cols: number }
  | { type: "close" };

function str(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length <= max ? value : null;
}

/** Validates one client message; null when it is malformed. */
export function parseIncoming(raw: string): Incoming | null {
  if (raw.length > MAX_MESSAGE_CHARS) return null;
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return null;
    data = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const cols =
    typeof data.cols === "number" && Number.isFinite(data.cols)
      ? data.cols
      : 120;
  switch (data.type) {
    case "open": {
      if (
        typeof data.hostId === "number" &&
        Number.isInteger(data.hostId) &&
        data.hostId > 0
      ) {
        return { type: "open", hostId: data.hostId, cols };
      }
      const q = data.quick as Record<string, unknown> | undefined;
      if (q && typeof q === "object") {
        const address = str(q.address, 253);
        const username = str(q.username, 256);
        const password = str(q.password, 1024);
        const domain = str(q.domain ?? "", 256);
        const port =
          typeof q.port === "number" &&
          Number.isInteger(q.port) &&
          q.port > 0 &&
          q.port < 65536
            ? q.port
            : null;
        if (
          address === null ||
          username === null ||
          password === null ||
          domain === null
        )
          return null;
        const https = q.https === true;
        return {
          type: "open",
          quick: {
            address,
            username,
            password,
            domain,
            https,
            port: port ?? (https ? 5986 : 5985),
          },
          cols,
        };
      }
      return null;
    }
    case "submit": {
      const text = str(data.text, MAX_MESSAGE_CHARS);
      return text === null
        ? null
        : { type: "submit", text, force: data.force === true };
    }
    case "stop":
    case "close":
      return { type: data.type };
    case "resize":
      return { type: "resize", cols };
    default:
      return null;
  }
}

function describe(error: unknown): { message: string; kind: string } {
  if (error instanceof WinrmError)
    return { message: error.message, kind: error.kind };
  if (error instanceof ConfigError)
    return { message: error.message, kind: "config" };
  if (error instanceof LimitError)
    return { message: error.message, kind: "limit" };
  return {
    message: "An unexpected error ended the session.",
    kind: "internal",
  };
}

/** Errors after which the session cannot be trusted to work any more. */
function isFatal(error: unknown): boolean {
  if (!(error instanceof WinrmError)) return true;
  return [
    "closed",
    "connect",
    "timeout",
    "shell-gone",
    "auth",
    "protocol",
    "tls",
  ].includes(error.kind);
}

export function handleTerminalSocket(
  socket: SocketLike,
  userId: string,
  isDataUnlocked: () => boolean,
  deps: TerminalDeps,
): void {
  // Keep the caller's identity for work that starts from later socket events.
  const asCaller = AsyncLocalStorage.snapshot();
  const id = randomUUID();
  let backend: TerminalBackend | null = null;
  let dispose: (() => void) | null = null;
  let release: (() => void) | null = null;
  let target: WinrmTarget | null = null;
  let running: RunHandle | null = null;
  let checking = false;
  let opening = false;
  let closed = false;
  let cols = 120;
  let idleMs = 30 * 60_000;
  let idleTimer: NodeJS.Timeout | null = null;
  let keepaliveTimer: NodeJS.Timeout | null = null;

  const send = (message: Record<string, unknown>) => {
    if (socket.readyState === OPEN) socket.send(JSON.stringify(message));
  };

  const shutdown = async (
    reason: string,
    error?: { message: string; kind: string },
  ) => {
    if (closed) return;
    closed = true;
    if (idleTimer) clearTimeout(idleTimer);
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    if (error)
      send({
        type: "error",
        message: error.message,
        kind: error.kind,
        fatal: true,
      });
    const current = backend;
    backend = null;
    try {
      if (running) await running.stop().catch(() => undefined);
      await current?.close();
    } catch {
      // Best effort: the server drops the shell after its own idle timeout.
    } finally {
      dispose?.();
      release?.();
      if (target)
        deps.log.info(`WinRM session to ${target.label} closed (${reason})`);
      if (socket.readyState === OPEN) socket.close(1000, reason.slice(0, 100));
    }
  };

  const managed = { id, userId, close: (reason: string) => shutdown(reason) };

  const touch = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      send({
        type: "output",
        data: "\r\n\x1b[90m[Session closed after being idle.]\x1b[0m\r\n",
      });
      void shutdown("idle");
    }, idleMs);
  };

  const sendPrompt = async () => {
    if (!backend) return;
    send({ type: "prompt", text: await backend.prompt() });
  };

  const fail = (error: unknown) => {
    if (isFatal(error)) void shutdown("error", describe(error));
    else send({ type: "error", ...describe(error), fatal: false });
  };

  const open = async (message: Extract<Incoming, { type: "open" }>) => {
    if (opening || backend) return;
    opening = true;
    cols = message.cols;
    try {
      if (!(await deps.canUse()))
        throw new ConfigError(
          "You do not have permission to open WinRM sessions.",
        );
      const limits = await deps.limits();
      idleMs = limits.idleMs;
      if (message.hostId !== undefined) {
        if (!isDataUnlocked())
          throw new ConfigError(
            "Your session expired. Sign in again to use saved logins.",
          );
        target = await deps.resolveSaved(message.hostId);
        if (!target)
          throw new ConfigError(
            "Host not found, or you may not connect to it.",
          );
      } else if (message.quick) {
        target = deps.quickTarget(message.quick);
      } else {
        throw new ConfigError("Nothing to connect to.");
      }
      release = deps.manager.admit(managed, limits);
      send({ type: "status", state: "connecting" });
      const connected = await deps.connect(target);
      if (closed) {
        await connected.backend.close().catch(() => undefined);
        connected.dispose();
        return;
      }
      backend = connected.backend;
      dispose = connected.dispose;
      deps.audit({ action: "winrm_session_open", target, success: true });
      deps.log.info(`WinRM session to ${target.label} opened`);
      send({
        type: "status",
        state: "connected",
        computer: backend.computerName,
        psVersion: backend.psVersion,
      });
      touch();
      keepaliveTimer = setInterval(() => {
        if (!backend || backend.busy || running || checking) return;
        void asCaller(() => backend?.ping()).catch((error: unknown) =>
          fail(error),
        );
      }, deps.keepaliveMs ?? 60_000);
      await sendPrompt();
    } catch (error) {
      if (target)
        deps.audit({
          action: "winrm_session_open",
          target,
          success: false,
          error: describe(error).message,
        });
      await shutdown("open failed", describe(error));
    } finally {
      opening = false;
    }
  };

  const submit = async (message: Extract<Incoming, { type: "submit" }>) => {
    if (!backend || running || checking) return;
    touch();
    if (CLEAR_COMMANDS.test(message.text)) {
      send({ type: "clear" });
      await sendPrompt();
      return;
    }
    if (!message.text.trim()) {
      await sendPrompt();
      return;
    }
    try {
      if (!message.force) {
        checking = true;
        const incomplete = await backend
          .isIncomplete(message.text)
          .finally(() => (checking = false));
        if (incomplete) {
          send({ type: "incomplete" });
          return;
        }
      }
      let dropped = false;
      let buffer = "";
      let flushTimer: NodeJS.Timeout | null = null;
      const flush = () => {
        flushTimer = null;
        if (!buffer) return;
        send({ type: "output", data: buffer });
        buffer = "";
      };
      const handle = backend.run(message.text, cols, (chunk) => {
        if (dropped) return;
        if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
          // The browser cannot keep up; stop rather than buffer without bound.
          dropped = true;
          void handle.stop().catch(() => undefined);
          return;
        }
        buffer += chunk;
        if (buffer.length > 64 * 1024) flush();
        else flushTimer ??= setTimeout(flush, 15);
      });
      running = handle;
      await handle.done.finally(() => {
        running = null;
        if (flushTimer) clearTimeout(flushTimer);
        flush();
      });
      if (dropped)
        send({
          type: "output",
          data: "\x1b[93m[Output stopped: too much for the terminal to keep up.]\x1b[0m\r\n",
        });
      touch();
      await sendPrompt();
    } catch (error) {
      fail(error);
      if (!closed) await sendPrompt().catch(() => undefined);
    }
  };

  const openTimer = setTimeout(() => {
    if (!backend && !opening) void shutdown("no open message");
  }, deps.openTimeoutMs ?? 15_000);

  socket.on("message", (data: unknown, isBinary: boolean) => {
    if (closed) return;
    if (isBinary)
      return void shutdown("binary frame", {
        message: "Unexpected binary message.",
        kind: "protocol",
      });
    const raw =
      typeof data === "string"
        ? data
        : Buffer.isBuffer(data)
          ? data.toString("utf8")
          : String(data);
    const message = parseIncoming(raw);
    if (!message)
      return void shutdown("bad message", {
        message: "Malformed message.",
        kind: "protocol",
      });
    asCaller(() => {
      switch (message.type) {
        case "open":
          clearTimeout(openTimer);
          void open(message);
          break;
        case "submit":
          void submit(message);
          break;
        case "stop":
          void running?.stop().catch(() => undefined);
          break;
        case "resize":
          cols = message.cols;
          break;
        case "close":
          void shutdown("closed by user");
          break;
      }
    });
  });
  socket.on("close", () => {
    clearTimeout(openTimer);
    void shutdown("tab closed");
  });
  socket.on("error", () => void shutdown("socket error"));
}
