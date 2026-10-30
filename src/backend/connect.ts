import net from "node:net";
import type { Duplex } from "node:stream";
import type { Client } from "ssh2";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import {
  ConfigError,
  HOST_KEYS,
  PROTOCOL_ID,
  buildTarget,
  readHostSettings,
  type WinrmTarget,
} from "./config.js";
import { WinrmChannel, type StreamOpener } from "./winrm/channel.js";
import { WinrmError } from "./winrm/errors.js";

/* Resolving a host to a target, and opening TCP streams to it. */

export interface QuickConnectInput {
  address: string;
  port: number;
  https: boolean;
  username: string;
  password: string;
  domain: string;
}

/** The saved host's WinRM target, as the acting user may use it. Null: no access. */
export async function resolveSavedTarget(
  ctx: PluginContext,
  hostId: number,
): Promise<WinrmTarget | null> {
  const resolved = await ctx.credentials.resolveHostProtocol(
    hostId,
    PROTOCOL_ID,
  );
  if (!resolved) return null;
  const raw: Record<string, unknown> = {};
  for (const key of Object.values(HOST_KEYS))
    raw[key] = await ctx.settings.getHost(hostId, key);
  const settings = readHostSettings(raw);
  if (!settings.enabled)
    throw new ConfigError("WinRM is not turned on for this host.");
  if (resolved.auth.authType === "none") {
    throw new ConfigError(
      "This host has no WinRM login. Set one in the host editor's WinRM tab.",
    );
  }
  return buildTarget({
    hostId,
    label: resolved.host.name || resolved.host.ip,
    address: resolved.host.ip,
    settings,
    login: {
      username: resolved.auth.username,
      password: resolved.auth.password,
      domain: resolved.auth.fields.domain ?? "",
    },
    jumpHosts: resolved.host.jumpHosts,
  });
}

export function quickConnectTarget(input: QuickConnectInput): WinrmTarget {
  return buildTarget({
    hostId: null,
    label: input.address,
    address: input.address,
    settings: readHostSettings({
      enableWinrm: true,
      winrmPort: input.port,
      winrmTransport: input.https ? "https" : "http",
      winrmTlsMode: "ca",
    }),
    login: {
      username: input.username,
      password: input.password,
      domain: input.domain,
    },
    jumpHosts: [],
  });
}

function directOpener(address: string, port: number): StreamOpener {
  return () =>
    new Promise<Duplex>((resolve, reject) => {
      const socket = net.connect({ host: address, port });
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 30_000);
      socket.once("connect", () => {
        socket.removeListener("error", reject);
        resolve(socket);
      });
      socket.once("error", reject);
    });
}

export interface Route {
  open: StreamOpener;
  dispose: () => void;
}

/** A way to reach the target: straight from the Termix server, or forwarded through its jump hosts. */
export async function openRoute(
  ctx: PluginContext,
  target: WinrmTarget,
): Promise<Route> {
  if (target.jumpHosts.length === 0) {
    return {
      open: directOpener(target.address, target.port),
      dispose: () => undefined,
    };
  }
  let chain;
  try {
    chain = await ctx.ssh.jumpChain<Client>(target.jumpHosts);
  } catch (error) {
    throw new WinrmError(
      "connect",
      `Could not connect through the jump host: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const client = chain.client;
  return {
    open: () =>
      new Promise<Duplex>((resolve, reject) => {
        client.forwardOut(
          "127.0.0.1",
          0,
          target.address,
          target.port,
          (error, stream) => {
            if (error) {
              reject(
                new WinrmError(
                  "connect",
                  `The jump host could not reach ${target.address}:${target.port}: ${error.message}`,
                ),
              );
              return;
            }
            resolve(stream as unknown as Duplex);
          },
        );
      }),
    dispose: () => chain.dispose(),
  };
}

/** The two channels a session uses: one for control, one for the long-polling receive. */
export function channelsFor(
  target: WinrmTarget,
  route: Route,
): { control: WinrmChannel; poll: WinrmChannel } {
  const make = () =>
    new WinrmChannel({
      host: target.address,
      port: target.port,
      https: target.https,
      open: route.open,
      credentials: target.credentials,
      tls: target.tls,
      connectTimeoutMs: target.connectTimeoutMs,
    });
  return { control: make(), poll: make() };
}
