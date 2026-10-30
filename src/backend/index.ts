import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import {
  channelsFor,
  openRoute,
  quickConnectTarget,
  resolveSavedTarget,
} from "./connect.js";
import { SessionManager } from "./session/manager.js";
import { PowerShellSession } from "./session/powershell-session.js";
import {
  handleTerminalSocket,
  type SocketLike,
} from "./session/terminal-socket.js";

async function adminNumber(
  ctx: PluginContext,
  key: string,
  fallback: number,
  max: number,
): Promise<number> {
  const value = await ctx.settings.get<number>(key);
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.min(max, Math.trunc(value))
    : fallback;
}

export async function activate(ctx: PluginContext): Promise<void> {
  const manager = new SessionManager();
  ctx.disposables.add(() => manager.closeAll("plugin disabled"));

  ctx.ws.route("/terminal", (connection) => {
    handleTerminalSocket(
      connection.socket as SocketLike,
      connection.userId,
      connection.isDataUnlocked,
      {
        manager,
        log: ctx.log,
        canUse: () => ctx.rbac.has("sessions"),
        limits: async () => ({
          perUser: await adminNumber(ctx, "maxSessionsPerUser", 5, 50),
          total: await adminNumber(ctx, "maxSessionsTotal", 50, 500),
          idleMs:
            (await adminNumber(ctx, "idleTimeoutMinutes", 30, 1440)) * 60_000,
        }),
        resolveSaved: (hostId) => resolveSavedTarget(ctx, hostId),
        quickTarget: quickConnectTarget,
        connect: async (target) => {
          const route = await openRoute(ctx, target);
          try {
            const { control, poll } = channelsFor(target, route);
            const backend = await PowerShellSession.open(control, poll);
            return { backend, dispose: route.dispose };
          } catch (error) {
            route.dispose();
            throw error;
          }
        },
        audit: ({ action, target, success, error }) => {
          void Promise.resolve(
            ctx.audit.record({
              action,
              resourceType: "host",
              resourceId:
                target.hostId !== null ? String(target.hostId) : undefined,
              resourceName: target.label,
              details: `${target.https ? "https" : "http"}://${target.address}:${target.port}`,
              success,
              errorMessage: error,
            }),
          ).catch(() => undefined);
        },
      },
    );
  });

  ctx.log.info("WinRM terminal mounted at /plugin-ws/winrm/terminal");
}

export async function deactivate(): Promise<void> {
  // Sessions close through ctx.disposables; sockets are closed by core.
}
