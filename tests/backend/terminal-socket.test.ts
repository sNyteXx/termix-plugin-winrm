import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  ConfigError,
  buildTarget,
  readHostSettings,
  type WinrmTarget,
} from "../../src/backend/config.js";
import { quickConnectTarget } from "../../src/backend/connect.js";
import { SessionManager } from "../../src/backend/session/manager.js";
import { PowerShellSession } from "../../src/backend/session/powershell-session.js";
import {
  handleTerminalSocket,
  parseIncoming,
  type TerminalDeps,
} from "../../src/backend/session/terminal-socket.js";
import { WinrmError } from "../../src/backend/winrm/errors.js";
import { FakePowerShell } from "../support/fake-powershell.js";

const SECRET = "S3cr3t-Pässwort!";

class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: Array<Record<string, unknown>> = [];
  closedWith: [number?, string?] | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code?: number, reason?: string) {
    this.readyState = 3;
    this.closedWith = [code, reason];
  }
  client(message: Record<string, unknown>) {
    this.emit("message", Buffer.from(JSON.stringify(message)), false);
  }
  of(type: string) {
    return this.sent.filter((m) => m.type === type);
  }
}

function savedTarget(hostId: number): WinrmTarget {
  return buildTarget({
    hostId,
    label: "SRV01",
    address: "192.0.2.10",
    settings: readHostSettings({ enableWinrm: true }),
    login: { username: "CONTOSO\\Administrator", password: SECRET, domain: "" },
    jumpHosts: [{ hostId: 3 }],
  });
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function setup(overrides: Partial<TerminalDeps> = {}, userId = "user-1") {
  const fake = new FakePowerShell();
  const socket = new FakeSocket();
  const manager = new SessionManager();
  const disposed = vi.fn();
  const audits: Array<{ action: string; success: boolean }> = [];
  const logs: string[] = [];
  const deps: TerminalDeps = {
    manager,
    canUse: async () => true,
    limits: async () => ({ perUser: 2, total: 10, idleMs: 60_000 }),
    resolveSaved: async (hostId) => (hostId === 7 ? savedTarget(7) : null),
    quickTarget: quickConnectTarget,
    connect: async () => ({
      backend: await PowerShellSession.open(fake.channel(), fake.channel()),
      dispose: disposed,
    }),
    audit: (entry) => audits.push(entry),
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    ...overrides,
  };
  handleTerminalSocket(socket as never, userId, () => true, deps);
  return { fake, socket, manager, disposed, audits, logs, deps };
}

describe("parseIncoming", () => {
  it("accepts the documented messages", () => {
    expect(parseIncoming('{"type":"open","hostId":7,"cols":100}')).toEqual({
      type: "open",
      hostId: 7,
      cols: 100,
    });
    expect(parseIncoming('{"type":"submit","text":"Get-Service"}')).toEqual({
      type: "submit",
      text: "Get-Service",
      force: false,
    });
    expect(parseIncoming('{"type":"stop"}')).toEqual({ type: "stop" });
  });
  it("refuses everything else", () => {
    for (const raw of [
      "",
      "null",
      "[]",
      "{",
      '{"type":"exec"}',
      '{"type":"open","hostId":-1}',
      '{"type":"open","hostId":"7"}',
      '{"type":"submit","text":5}',
    ]) {
      expect(parseIncoming(raw)).toBeNull();
    }
    expect(
      parseIncoming(
        JSON.stringify({ type: "submit", text: "x".repeat(600_000) }),
      ),
    ).toBeNull();
  });
});

describe("terminal socket", () => {
  it("opens a saved host and shows the prompt, without credentials on the wire", async () => {
    const { socket, audits } = setup();
    socket.client({ type: "open", hostId: 7, cols: 120 });
    await tick();
    expect(socket.of("status").map((m) => m.state)).toEqual([
      "connecting",
      "connected",
    ]);
    expect(socket.of("prompt")[0].text).toBe(
      "[SRV01]: PS C:\\Users\\Administrator> ",
    );
    expect(audits).toEqual([
      expect.objectContaining({ action: "winrm_session_open", success: true }),
    ]);
    expect(JSON.stringify(socket.sent)).not.toContain(SECRET);
  });

  it("runs commands and keeps state between them", async () => {
    const { socket } = setup();
    socket.client({ type: "open", hostId: 7, cols: 120 });
    await tick();
    socket.client({ type: "submit", text: "$service = 'Running'" });
    await tick();
    socket.client({ type: "submit", text: "$service" });
    await tick();
    expect(
      socket
        .of("output")
        .map((m) => m.data)
        .join(""),
    ).toContain("Running\r\n");
    expect(socket.of("prompt")).toHaveLength(3);
  });

  it("asks for more lines on unfinished input, then runs it when forced", async () => {
    const { socket, fake } = setup();
    socket.client({ type: "open", hostId: 7, cols: 120 });
    await tick();
    socket.client({ type: "submit", text: "foreach ($i in 1..3) {" });
    await tick();
    expect(socket.of("incomplete")).toHaveLength(1);
    socket.client({
      type: "submit",
      text: "foreach ($i in 1..3) {\necho $i\n}",
    });
    await tick();
    expect(
      fake.pipelines.some(
        (p) => p.history === "foreach ($i in 1..3) {\necho $i\n}",
      ),
    ).toBe(true);
  });

  it("clears the screen locally for cls", async () => {
    const { socket, fake } = setup();
    socket.client({ type: "open", hostId: 7, cols: 120 });
    await tick();
    const before = fake.pipelines.filter((p) => p.addToHistory).length;
    socket.client({ type: "submit", text: "cls" });
    await tick();
    expect(socket.of("clear")).toHaveLength(1);
    expect(fake.pipelines.filter((p) => p.addToHistory).length).toBe(before);
  });

  it("stops a running command", async () => {
    const { socket, fake } = setup();
    socket.client({ type: "open", hostId: 7, cols: 120 });
    await tick();
    socket.client({ type: "submit", text: "Start-Sleep 600" });
    await tick();
    socket.client({ type: "stop" });
    await tick();
    expect(fake.signals).toContain("crtl_c");
    expect(
      socket
        .of("output")
        .map((m) => m.data)
        .join(""),
    ).toContain("stopped");
    expect(socket.of("prompt")).toHaveLength(2);
  });

  it("refuses a host the user may not reach", async () => {
    const { socket } = setup();
    socket.client({ type: "open", hostId: 99, cols: 120 });
    await tick();
    expect(socket.of("error")[0]).toMatchObject({
      fatal: true,
      kind: "config",
    });
    expect(socket.closedWith).not.toBeNull();
  });

  it("refuses a user without the permission", async () => {
    const connect = vi.fn();
    const { socket } = setup({ canUse: async () => false, connect });
    socket.client({ type: "open", hostId: 7, cols: 120 });
    await tick();
    expect(socket.of("error")[0].message).toMatch(/permission/);
    expect(connect).not.toHaveBeenCalled();
  });

  it("enforces the per-user session limit", async () => {
    const manager = new SessionManager();
    const sockets = [1, 2, 3].map(() => setup({ manager }).socket);
    for (const socket of sockets)
      socket.client({ type: "open", hostId: 7, cols: 120 });
    await tick(60);
    expect(sockets[2].of("error")[0]).toMatchObject({ kind: "limit" });
    expect(manager.size).toBe(2);
  });

  it("cleans up when the tab closes", async () => {
    const { socket, fake, manager, disposed } = setup();
    socket.client({ type: "open", hostId: 7, cols: 120 });
    await tick();
    socket.emit("close");
    await tick();
    expect(fake.deleted).toBe(true);
    expect(disposed).toHaveBeenCalled();
    expect(manager.size).toBe(0);
  });

  it("closes the plugin's sessions on disable", async () => {
    const { socket, fake, manager } = setup();
    socket.client({ type: "open", hostId: 7, cols: 120 });
    await tick();
    await manager.closeAll("plugin disabled");
    expect(fake.deleted).toBe(true);
    expect(socket.closedWith).not.toBeNull();
  });

  it("closes an idle session", async () => {
    const { socket, fake } = setup({
      limits: async () => ({ perUser: 2, total: 10, idleMs: 40 }),
    });
    socket.client({ type: "open", hostId: 7, cols: 120 });
    await tick(120);
    expect(
      socket
        .of("output")
        .map((m) => m.data)
        .join(""),
    ).toContain("idle");
    expect(fake.deleted).toBe(true);
  });

  it("detects a lost session through the keepalive", async () => {
    const { socket, fake } = setup({ keepaliveMs: 20 });
    socket.client({ type: "open", hostId: 7, cols: 120 });
    await tick();
    fake.shellGone = true;
    await tick(80);
    expect(socket.of("error")[0]).toMatchObject({
      fatal: true,
      kind: "shell-gone",
    });
  });

  it("drops a socket that never says what to open", async () => {
    const { socket } = setup({ openTimeoutMs: 20 });
    await tick(50);
    expect(socket.closedWith).not.toBeNull();
  });

  it("drops malformed and binary messages", async () => {
    const first = setup().socket;
    first.emit("message", Buffer.from("not json"), false);
    const second = setup().socket;
    second.emit("message", Buffer.from([1, 2, 3]), true);
    await tick();
    expect(first.closedWith).not.toBeNull();
    expect(second.closedWith).not.toBeNull();
  });

  it("refuses saved logins once the user's data key is locked", async () => {
    const fake = new FakePowerShell();
    const socket = new FakeSocket();
    const resolveSaved = vi.fn();
    handleTerminalSocket(socket as never, "user-1", () => false, {
      manager: new SessionManager(),
      canUse: async () => true,
      limits: async () => ({ perUser: 2, total: 10, idleMs: 60_000 }),
      resolveSaved,
      quickTarget: quickConnectTarget,
      connect: async () => ({
        backend: await PowerShellSession.open(fake.channel(), fake.channel()),
        dispose: () => undefined,
      }),
      audit: () => undefined,
      log: { info: () => undefined, warn: () => undefined },
    });
    socket.client({ type: "open", hostId: 7, cols: 120 });
    await tick();
    expect(resolveSaved).not.toHaveBeenCalled();
    expect(socket.of("error")[0].message).toMatch(/Sign in again/);
  });

  it("reports connect failures without the password", async () => {
    const { socket, logs } = setup({
      connect: async () => {
        throw new WinrmError(
          "auth",
          "Login failed: wrong user name, password or domain.",
        );
      },
    });
    socket.client({
      type: "open",
      quick: {
        address: "192.0.2.10",
        port: 5985,
        username: "Admin",
        password: SECRET,
        domain: "WIN11-OFFICE",
      },
      cols: 80,
    });
    await tick();
    expect(socket.of("error")[0]).toMatchObject({ kind: "auth", fatal: true });
    expect(JSON.stringify(socket.sent)).not.toContain(SECRET);
    expect(logs.join("\n")).not.toContain(SECRET);
  });

  it("refuses an invalid quick connect address", async () => {
    const { socket } = setup();
    socket.client({
      type: "open",
      quick: {
        address: "evil host\r\nX: y",
        port: 5985,
        username: "a",
        password: "b",
      },
      cols: 80,
    });
    await tick();
    expect(socket.of("error")[0]).toMatchObject({ kind: "config" });
  });
});

describe("config", () => {
  it("refuses a malformed fingerprint", () => {
    expect(() =>
      buildTarget({
        hostId: 1,
        label: "x",
        address: "srv.contoso.local",
        settings: readHostSettings({
          winrmTransport: "https",
          winrmTlsMode: "fingerprint",
          winrmFingerprint: "abc",
        }),
        login: { username: "a", password: "b", domain: "" },
        jumpHosts: [],
      }),
    ).toThrow(ConfigError);
  });

  it("defaults HTTPS to 5986 and HTTP to 5985", () => {
    expect(readHostSettings({ winrmTransport: "https" }).port).toBe(5986);
    expect(readHostSettings({}).port).toBe(5985);
  });

  it("requires a login", () => {
    expect(() =>
      buildTarget({
        hostId: 1,
        label: "x",
        address: "srv",
        settings: readHostSettings({}),
        login: { username: "", password: "x", domain: "" },
        jumpHosts: [],
      }),
    ).toThrow(/user name/);
  });
});
