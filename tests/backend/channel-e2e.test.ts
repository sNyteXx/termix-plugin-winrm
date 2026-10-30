import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { psToString } from "../../src/backend/psrp/clixml.js";
import { PipelineState } from "../../src/backend/psrp/messages.js";
import { RunspacePool } from "../../src/backend/psrp/runspace.js";
import { WinrmChannel } from "../../src/backend/winrm/channel.js";
import { WinrmError } from "../../src/backend/winrm/errors.js";

/*
 * The whole stack over real TCP: HTTP, Negotiate/NTLM login per connection,
 * sealed bodies both ways, PSRP on top. The server is an independent NTLM
 * implementation (pyspnego) replaying responses recorded from Windows.
 * Runs when WINRM_ORACLE_PYTHON names a Python with pyspnego.
 */
const python = process.env.WINRM_ORACLE_PYTHON;
const script = fileURLToPath(
  new URL("../../scripts/oracle/winrm_server.py", import.meta.url),
);
const PASSWORD = "Wässerchen-2026!";

let server: ChildProcess | null = null;
afterEach(() => {
  server?.kill();
  server = null;
});

async function startServer(recording: string): Promise<number> {
  server = spawn(
    python as string,
    [
      script,
      fileURLToPath(
        new URL(`../fixtures/pypsrp/${recording}.json`, import.meta.url),
      ),
    ],
    {
      env: {
        ...process.env,
        ORACLE_DOMAIN: "CONTOSO",
        ORACLE_USER: "Administrator",
        ORACLE_PASSWORD: PASSWORD,
      },
    },
  );
  const lines = createInterface({ input: server.stdout! });
  return new Promise((resolve) =>
    lines.once("line", (line) => resolve(Number(line))),
  );
}

function channel(port: number, password = PASSWORD) {
  return new WinrmChannel({
    host: "127.0.0.1",
    port,
    https: false,
    open: () =>
      new Promise((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1", () => resolve(socket));
        socket.once("error", reject);
      }),
    credentials: { username: "Administrator", domain: "CONTOSO", password },
    connectTimeoutMs: 5000,
  });
}

describe.skipIf(!python)(
  "WinRM over HTTP with message encryption (pyspnego server)",
  () => {
    it("opens a session and runs commands end to end", async () => {
      const port = await startServer("multiple_invocations");
      const pool = new RunspacePool({
        control: channel(port),
        poll: channel(port),
      });
      await pool.open();
      const output: string[] = [];
      const result = await pool.invoke(
        {
          commands: [{ command: "1 + 1", isScript: true }],
          addToHistory: false,
        },
        { output: (v) => output.push(psToString(v)) },
      ).done;
      expect(result.state).toBe(PipelineState.Completed);
      expect(output).toEqual(["2"]);
      await pool.close();
    });

    it("reports a wrong password as an auth error", async () => {
      const port = await startServer("multiple_invocations");
      const bad = channel(port, "falsch");
      const error = await bad.connect().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(WinrmError);
      expect((error as WinrmError).kind).toBe("auth");
      expect(String((error as Error).message)).not.toContain("falsch");
      bad.close();
    });

    it("reports a closed port as a connect error", async () => {
      const probe = net.createServer();
      await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
      const port = (probe.address() as net.AddressInfo).port;
      await new Promise<void>((r) => probe.close(() => r()));
      const dead = channel(port);
      const error = await dead.connect().catch((e: unknown) => e);
      expect((error as WinrmError).kind).toBe("connect");
      dead.close();
    });
  },
);

describe("timeouts", () => {
  it("gives up on a server that never answers", async () => {
    const silent = net.createServer(() => undefined);
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", () => r()));
    const port = (silent.address() as net.AddressInfo).port;
    const ch = new WinrmChannel({
      host: "127.0.0.1",
      port,
      https: false,
      open: () =>
        new Promise((resolve) => {
          const socket = net.connect(port, "127.0.0.1", () => resolve(socket));
        }),
      credentials: { username: "a", domain: "", password: "b" },
      connectTimeoutMs: 300,
    });
    const error = await ch.connect().catch((e: unknown) => e);
    expect((error as WinrmError).kind).toBe("timeout");
    ch.close();
    silent.close();
  });

  it("refuses an HTTP server that is not WinRM", async () => {
    const web = net.createServer((socket) =>
      socket.on("data", () =>
        socket.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"),
      ),
    );
    await new Promise<void>((r) => web.listen(0, "127.0.0.1", () => r()));
    const port = (web.address() as net.AddressInfo).port;
    const ch = new WinrmChannel({
      host: "127.0.0.1",
      port,
      https: false,
      open: () =>
        new Promise((resolve) => {
          const socket = net.connect(port, "127.0.0.1", () => resolve(socket));
        }),
      credentials: { username: "a", domain: "", password: "b" },
      connectTimeoutMs: 2000,
    });
    const error = await ch.connect().catch((e: unknown) => e);
    expect((error as WinrmError).kind).toBe("protocol");
    ch.close();
    web.close();
  });
});
