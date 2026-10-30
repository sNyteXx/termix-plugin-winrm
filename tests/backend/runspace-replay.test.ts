import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type PsValue, psToString } from "../../src/backend/psrp/clixml.js";
import { PipelineState } from "../../src/backend/psrp/messages.js";
import {
  renderErrorRecord,
  renderInformational,
} from "../../src/backend/psrp/render.js";
import {
  RunspacePool,
  type SoapChannel,
} from "../../src/backend/psrp/runspace.js";
import { WinrmError } from "../../src/backend/winrm/errors.js";

/*
 * Replays WinRM conversations recorded against real Windows servers (from
 * pypsrp's test suite, MIT licence). Each request this client sends must use
 * the action the recording expects next; the recorded response comes back.
 */

interface Pair {
  action: string;
  request: string;
  response: string;
}

function load(name: string): Pair[] {
  return JSON.parse(
    readFileSync(
      new URL(`../fixtures/pypsrp/${name}.json`, import.meta.url),
      "utf8",
    ),
  ) as Pair[];
}

const SIGNAL_RESPONSE =
  '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:rsp="http://schemas.microsoft.com/wbem/wsman/1/windows/shell"><s:Body><rsp:SignalResponse/></s:Body></s:Envelope>';

function replay(name: string) {
  const pairs = load(name);
  let cursor = 0;
  const sent: string[] = [];
  const actionOf = (soap: string) =>
    /<wsa:Action[^>]*>([^<]+)</.exec(soap)?.[1] ?? "";
  const channel = (): SoapChannel => ({
    url: "http://srv01:5985/wsman",
    close: () => undefined,
    send: async (soap) => {
      const action = actionOf(soap);
      sent.push(action.split("/").pop() as string);
      const expected = pairs[cursor];
      // Older recordings do not send the Terminate signal after a pipeline.
      if (
        action.endsWith("/Signal") &&
        (!expected || !expected.action.endsWith("/Signal"))
      ) {
        return SIGNAL_RESPONSE;
      }
      if (!expected) throw new Error(`Unexpected extra request ${action}`);
      expect(action).toBe(expected.action);
      cursor++;
      return expected.response;
    },
  });
  const pool = new RunspacePool({ control: channel(), poll: channel() });
  return { pool, sent, remaining: () => pairs.length - cursor };
}

function collect() {
  const seen = {
    output: [] as string[],
    errors: [] as PsValue[],
    warnings: [] as string[],
    verbose: [] as string[],
    debug: [] as string[],
    information: [] as string[],
  };
  return {
    seen,
    events: {
      output: (v: PsValue) => seen.output.push(psToString(v)),
      error: (v: PsValue) => seen.errors.push(v),
      warning: (v: PsValue) =>
        seen.warnings.push(renderInformational("WARNING", v)),
      verbose: (v: PsValue) =>
        seen.verbose.push(renderInformational("VERBOSE", v)),
      debug: (v: PsValue) => seen.debug.push(renderInformational("DEBUG", v)),
      information: (v: PsValue) => seen.information.push(psToString(v)),
    },
  };
}

const script = (command: string) => ({
  commands: [{ command, isScript: true }],
  addToHistory: false,
});

describe("RunspacePool against recorded Windows conversations", () => {
  it("opens, runs two pipelines and closes", async () => {
    const { pool, remaining } = replay("multiple_invocations");
    await pool.open();
    expect(pool.opened).toBe(true);
    expect(pool.psVersion).toMatch(/^5\.1/);

    for (let i = 0; i < 2; i++) {
      const { seen, events } = collect();
      const result = await pool.invoke(script("1 + 1"), events).done;
      expect(result.state).toBe(PipelineState.Completed);
      expect(seen.output).toEqual(["2"]);
    }
    await pool.close();
    expect(remaining()).toBe(0);
  });

  it("delivers every stream", async () => {
    const { pool } = replay("stream_output_invocation");
    await pool.open();
    const { seen, events } = collect();
    const result = await pool.invoke(script("streams"), events).done;
    expect(result.state).toBe(PipelineState.Completed);
    expect(seen.output).toEqual(["output stream"]);
    expect(seen.warnings).toEqual(["WARNING: warning stream"]);
    expect(seen.verbose).toEqual(["VERBOSE: verbose stream"]);
    expect(seen.debug).toEqual(["DEBUG: debug stream"]);
    expect(seen.errors).toHaveLength(1);
    expect(renderErrorRecord(seen.errors[0])).toContain("error stream");
    expect(renderErrorRecord(seen.errors[0])).toContain(
      "+ FullyQualifiedErrorId",
    );
    await pool.close();
  });

  it("reports a terminating error", async () => {
    const { pool } = replay("error_failed");
    await pool.open();
    const { seen, events } = collect();
    const result = await pool.invoke(script("fail"), events).done;
    expect(seen.output).toEqual(["before"]);
    expect(result.state).toBe(PipelineState.Failed);
    const text = renderErrorRecord(result.error);
    expect(text).toContain("error");
    expect(text).toContain(
      "NotSpecified: (:) [Write-Error], WriteErrorException",
    );
    await pool.close();
  });

  it("keeps polling through WinRM's operation timeouts", async () => {
    const { pool, sent } = replay("long_running_cmdlet");
    await pool.open();
    const { seen, events } = collect();
    const result = await pool.invoke(script("Start-Sleep 50; 'hi'"), events)
      .done;
    expect(result.state).toBe(PipelineState.Completed);
    expect(seen.output).toEqual(["hi"]);
    expect(sent.filter((a) => a === "Receive").length).toBeGreaterThanOrEqual(
      5,
    );
    await pool.close();
  });

  it("reads history objects from an earlier pipeline", async () => {
    const { pool } = replay("with_history");
    await pool.open();
    const first = collect();
    await pool.invoke(
      { ...script("Write-Output 1; Write-Output 2"), addToHistory: true },
      first.events,
    ).done;
    expect(first.seen.output).toEqual(["1", "2"]);
    const second = collect();
    await pool.invoke(script("Get-History"), second.events).done;
    expect(second.seen.output).toEqual(["Write-Output 1; Write-Output 2"]);
    await pool.close();
  });

  it("reports a shell that disappeared", async () => {
    const { pool } = replay("receive_failure");
    await pool.open();
    // The recording's third Receive fails with "invalid selectors" (shell gone).
    const handle = pool.invoke(script("x"), {});
    await expect(handle.done).rejects.toThrow();
    await pool.close();
  });

  it("refuses a second pipeline while one runs", async () => {
    const { pool } = replay("multiple_invocations");
    await pool.open();
    const first = pool.invoke(script("1 + 1"), {});
    expect(() => pool.invoke(script("1 + 1"), {})).toThrow(/already running/);
    await first.done;
  });
});

describe("WinrmError", () => {
  it("is what a vanished shell becomes", () => {
    expect(new WinrmError("shell-gone", "x").kind).toBe("shell-gone");
  });
});
