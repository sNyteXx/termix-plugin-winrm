import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Router } from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createMockCtx } from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import manifestJson from "../../manifest.json";
import { buildTarget, readHostSettings } from "../../src/backend/config.js";
import { registerRoutes } from "../../src/backend/routes.js";
import type { RunDeps } from "../../src/backend/run-api.js";
import { SessionManager } from "../../src/backend/session/manager.js";
import type { RunScriptResult } from "../../src/backend/session/run-script.js";
import { WinrmError } from "../../src/backend/winrm/errors.js";

const manifest = manifestJson as unknown as PluginManifest;
const SECRET_SCRIPT = "$pw = 'Geheim-123!'; Get-Service WinRM";

let server: http.Server | null = null;
afterEach(async () => {
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

const okResult: RunScriptResult = {
  state: "completed",
  computerName: "SRV01",
  output: "Running",
  errors: [],
  warnings: [],
  verbose: [],
  information: [],
  truncated: false,
  durationMs: 42,
};

async function start(
  options: {
    permissions?: string[];
    execute?: RunDeps["execute"];
    limits?: { perUser: number; total: number };
    enableWinrm?: boolean;
  } = {},
) {
  let router: Router | null = null;
  const mock = createMockCtx({
    pluginId: manifest.id,
    manifest,
    capabilities: manifest.capabilities,
    router: () => (router = express.Router()),
    permissions: options.permissions ?? ["winrm.run", "winrm.sessions"],
  } as never);
  const ctx = mock.ctx as unknown as RunDeps["ctx"];
  const audits: Array<Record<string, unknown>> = [];
  // The parts of ctx a run touches, filled with fakes.
  Object.assign(ctx, {
    audit: {
      record: async (entry: Record<string, unknown>) => void audits.push(entry),
    },
    credentials: {
      ...(ctx as { credentials?: object }).credentials,
      resolveHostProtocol: async (hostId: number) =>
        hostId === 6
          ? {
              host: {
                id: 6,
                name: "Office",
                ip: "192.0.2.13",
                port: 22,
                ownerUserId: "user-1",
                jumpHosts: [{ hostId: 3 }],
              },
              shared: false,
              auth: {
                authType: "direct",
                username: "Admin",
                password: "pw",
                fields: { domain: "WIN11" },
              },
            }
          : null,
    },
    settings: {
      ...(ctx as { settings?: object }).settings,
      getHost: async (_hostId: number, key: string) =>
        key === "enableWinrm" ? (options.enableWinrm ?? true) : undefined,
    },
  });
  const executed: Array<{ target: unknown; input: unknown }> = [];
  registerRoutes((ctx.http.router as () => Router)(), {
    ctx,
    manager: new SessionManager(),
    limits: async () => options.limits ?? { perUser: 5, total: 50 },
    execute:
      options.execute ??
      (async (target, input) => {
        executed.push({ target, input });
        return okResult;
      }),
  });
  const app = express();
  // Termix parses JSON bodies up to 2 MB before a plugin route runs.
  app.use(express.json({ limit: "2mb" }));
  app.use((_req, _res, next) => {
    mock.setActor("user-1");
    next();
  });
  app.use((req, res, next) => router!(req, res, next));
  server = http.createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const post = async (body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  };
  return { post, audits, executed };
}

describe("POST /plugin-api/winrm/run", () => {
  it("runs the script on the host and returns the result", async () => {
    const { post, executed } = await start();
    const res = await post({
      hostId: 6,
      script: "Get-Service WinRM",
      timeoutSec: 30,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      state: "completed",
      output: "Running",
      computerName: "SRV01",
    });
    expect(executed[0].input).toMatchObject({
      hostId: 6,
      script: "Get-Service WinRM",
      timeoutSec: 30,
      width: 160,
    });
    expect(executed[0].target).toMatchObject({
      address: "192.0.2.13",
      jumpHosts: [{ hostId: 3 }],
    });
  });

  it("refuses a user without winrm.run", async () => {
    const { post, executed } = await start({ permissions: ["winrm.sessions"] });
    const res = await post({ hostId: 6, script: "Get-Service" });
    expect(res.status).toBe(403);
    expect(executed).toHaveLength(0);
  });

  it("validates the input", async () => {
    const { post } = await start();
    for (const body of [
      {},
      { hostId: "6", script: "x" },
      { hostId: 6, script: "   " },
      { hostId: 6, script: "x", timeoutSec: 0 },
      { hostId: 6, script: "x", timeoutSec: 601 },
      { hostId: 6, script: "x", width: 10 },
      { hostId: 6, script: "x".repeat(300_000) },
    ]) {
      expect((await post(body)).status).toBe(400);
    }
  });

  it("answers 404 for a host the user cannot reach", async () => {
    const { post } = await start();
    expect((await post({ hostId: 99, script: "x" })).status).toBe(404);
  });

  it("answers 400 when WinRM is off on the host", async () => {
    const { post } = await start({ enableWinrm: false });
    const res = await post({ hostId: 6, script: "x" });
    expect(res.status).toBe(400);
    expect(res.body.kind).toBe("config");
  });

  it("answers 502 when Windows refuses the login, without throwing", async () => {
    const { post } = await start({
      execute: async () => {
        throw new WinrmError(
          "auth",
          "Login failed: wrong user name, password or domain.",
        );
      },
    });
    const res = await post({ hostId: 6, script: "x" });
    expect(res.status).toBe(502);
    expect(res.body.kind).toBe("auth");
  });

  it("enforces the session limit", async () => {
    const { post } = await start({ limits: { perUser: 0, total: 50 } });
    expect((await post({ hostId: 6, script: "x" })).status).toBe(429);
  });

  it("audits every run with the script's hash, never the script", async () => {
    const { post, audits } = await start();
    await post({ hostId: 6, script: SECRET_SCRIPT });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "winrm_run",
      resourceId: "6",
      success: true,
    });
    expect(JSON.stringify(audits)).not.toContain("Geheim-123!");
    expect(String(audits[0].details)).toMatch(/sha256=[0-9a-f]{64}/);
  });
});

describe("buildTarget for runs", () => {
  it("keeps the jump hosts", () => {
    const target = buildTarget({
      hostId: 6,
      label: "x",
      address: "192.0.2.13",
      settings: readHostSettings({ enableWinrm: true }),
      login: { username: "Admin", password: "pw", domain: "WIN11" },
      jumpHosts: [{ hostId: 3 }],
    });
    expect(target.jumpHosts).toEqual([{ hostId: 3 }]);
  });
});
