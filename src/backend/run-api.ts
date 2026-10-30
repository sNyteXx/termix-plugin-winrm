import { createHash, randomUUID } from "node:crypto";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { ConfigError, type WinrmTarget } from "./config.js";
import { channelsFor, openRoute, resolveSavedTarget } from "./connect.js";
import { LimitError, type SessionManager } from "./session/manager.js";
import { type RunScriptResult, runScript } from "./session/run-script.js";
import { WinrmError } from "./winrm/errors.js";

/*
 * One script on one saved host, as data. Shared by POST /plugin-api/winrm/run
 * and the winrm.run service. The caller is the acting user: their permission,
 * host access and saved login apply.
 */

export const MAX_SCRIPT_CHARS = 256 * 1024;
export const DEFAULT_TIMEOUT_SEC = 60;
export const MAX_TIMEOUT_SEC = 600;
export const DEFAULT_WIDTH = 160;

export interface RunInput {
  hostId: number;
  script: string;
  timeoutSec?: number;
  width?: number;
}

export type RunOutcome =
  | { ok: true; result: RunScriptResult }
  | { ok: false; status: number; error: string; kind: string };

/** Validates untrusted input; returns a message for the first problem. */
export function validateRunInput(
  body: unknown,
): { input: RunInput } | { error: string } {
  const data = (body ?? {}) as Record<string, unknown>;
  const hostId = data.hostId;
  if (typeof hostId !== "number" || !Number.isInteger(hostId) || hostId <= 0) {
    return { error: "hostId must be a positive integer" };
  }
  if (typeof data.script !== "string" || !data.script.trim()) {
    return { error: "script must be a non-empty string" };
  }
  if (data.script.length > MAX_SCRIPT_CHARS) {
    return { error: `script is longer than ${MAX_SCRIPT_CHARS} characters` };
  }
  const timeoutSec = data.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  if (
    typeof timeoutSec !== "number" ||
    !Number.isFinite(timeoutSec) ||
    timeoutSec < 1 ||
    timeoutSec > MAX_TIMEOUT_SEC
  ) {
    return { error: `timeoutSec must be between 1 and ${MAX_TIMEOUT_SEC}` };
  }
  const width = data.width ?? DEFAULT_WIDTH;
  if (
    typeof width !== "number" ||
    !Number.isInteger(width) ||
    width < 40 ||
    width > 500
  ) {
    return { error: "width must be an integer between 40 and 500" };
  }
  return { input: { hostId, script: data.script, timeoutSec, width } };
}

export interface RunDeps {
  ctx: PluginContext;
  manager: SessionManager;
  limits: () => Promise<{ perUser: number; total: number }>;
  /** Test seam: replaces resolving, routing and the WinRM connection. */
  execute?: (
    target: WinrmTarget,
    input: Required<RunInput>,
  ) => Promise<RunScriptResult>;
}

async function connectAndRun(
  ctx: PluginContext,
  target: WinrmTarget,
  input: Required<RunInput>,
): Promise<RunScriptResult> {
  const route = await openRoute(ctx, target);
  try {
    const { control, poll } = channelsFor(target, route);
    return await runScript(control, poll, {
      script: input.script,
      timeoutMs: input.timeoutSec * 1000,
      width: input.width,
    });
  } finally {
    route.dispose();
  }
}

export async function runOnHost(
  deps: RunDeps,
  input: RunInput,
): Promise<RunOutcome> {
  const { ctx, manager } = deps;
  const userId = ctx.currentActor();
  if (!userId)
    return { ok: false, status: 401, error: "Not signed in", kind: "auth" };
  if (!(await ctx.rbac.has("run"))) {
    return {
      ok: false,
      status: 403,
      error: "Running WinRM scripts needs the winrm.run permission",
      kind: "permission",
    };
  }
  const full: Required<RunInput> = {
    hostId: input.hostId,
    script: input.script,
    timeoutSec: input.timeoutSec ?? DEFAULT_TIMEOUT_SEC,
    width: input.width ?? DEFAULT_WIDTH,
  };

  let target: WinrmTarget | null;
  try {
    target = await resolveSavedTarget(ctx, full.hostId);
  } catch (error) {
    if (error instanceof ConfigError)
      return { ok: false, status: 400, error: error.message, kind: "config" };
    throw error;
  }
  if (!target)
    return {
      ok: false,
      status: 404,
      error: "Host not found, or you may not connect to it",
      kind: "not-found",
    };

  let release: () => void;
  try {
    release = manager.admit(
      { id: randomUUID(), userId, close: async () => undefined },
      await deps.limits(),
    );
  } catch (error) {
    if (error instanceof LimitError)
      return { ok: false, status: 429, error: error.message, kind: "limit" };
    throw error;
  }

  const scriptHash = createHash("sha256").update(full.script).digest("hex");
  const audit = (success: boolean, detail: string, errorMessage?: string) =>
    void Promise.resolve(
      ctx.audit.record({
        action: "winrm_run",
        resourceType: "host",
        resourceId: String(full.hostId),
        resourceName: target?.label,
        // The script itself is not logged: it may carry secrets. Its hash identifies it.
        details: `script sha256=${scriptHash} length=${full.script.length}; ${detail}`,
        success,
        errorMessage,
      }),
    ).catch(() => undefined);

  try {
    const result = await (deps.execute ?? ((t, i) => connectAndRun(ctx, t, i)))(
      target,
      full,
    );
    audit(
      result.state === "completed",
      `state=${result.state} duration=${result.durationMs}ms`,
    );
    return { ok: true, result };
  } catch (error) {
    if (error instanceof WinrmError) {
      audit(false, `kind=${error.kind}`, error.message);
      // 502 even for a refused Windows login: a 401 would read as an expired Termix session.
      return { ok: false, status: 502, error: error.message, kind: error.kind };
    }
    audit(false, "kind=internal", "Unexpected error");
    ctx.log.error(
      "WinRM run failed",
      error instanceof Error ? error : new Error(String(error)),
    );
    return {
      ok: false,
      status: 500,
      error: "The run failed unexpectedly",
      kind: "internal",
    };
  } finally {
    release();
  }
}
