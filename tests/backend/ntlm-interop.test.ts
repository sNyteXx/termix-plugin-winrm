import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NtlmClient } from "../../src/backend/winrm/ntlm.js";

/*
 * Interop against an independent NTLM server (pyspnego). Runs only when
 * WINRM_ORACLE_PYTHON names a Python with pyspnego, so CI without it skips.
 */
const python = process.env.WINRM_ORACLE_PYTHON;
const script = fileURLToPath(
  new URL("../../scripts/oracle/ntlm_server.py", import.meta.url),
);

describe.skipIf(!python)("NTLM interop with pyspnego", () => {
  let oracle: ChildProcessWithoutNullStreams;
  let ask: (
    request: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;

  beforeAll(() => {
    oracle = spawn(python as string, [script], {
      env: {
        ...process.env,
        ORACLE_DOMAIN: "CONTOSO",
        ORACLE_USER: "Administrator",
        ORACLE_PASSWORD: "Grüße-ß€!",
      },
    });
    const lines = createInterface({ input: oracle.stdout });
    const waiting: Array<(value: Record<string, unknown>) => void> = [];
    lines.on("line", (line) => waiting.shift()?.(JSON.parse(line)));
    ask = (request) =>
      new Promise((resolve) => {
        waiting.push(resolve);
        oracle.stdin.write(JSON.stringify(request) + "\n");
      });
  });

  afterAll(() => oracle?.kill());

  it("authenticates and seals both ways", async () => {
    const client = new NtlmClient({
      username: "Administrator",
      domain: "CONTOSO",
      password: "Grüße-ß€!",
    });
    const challenge = await ask({
      op: "step",
      token: client.negotiate().toString("base64"),
    });
    expect(challenge.error).toBeUndefined();
    const type3 = client.authenticate(
      Buffer.from(challenge.token as string, "base64"),
    );
    const done = await ask({ op: "step", token: type3.toString("base64") });
    expect(done.error).toBeUndefined();
    expect(done.complete).toBe(true);

    for (const text of ["<s:Envelope>Grüße</s:Envelope>", "zweite Nachricht"]) {
      const { signature, sealed } = client.wrap(Buffer.from(text));
      const plain = await ask({
        op: "unwrap",
        data: Buffer.concat([signature, sealed]).toString("base64"),
      });
      expect(plain.error).toBeUndefined();
      expect(Buffer.from(plain.data as string, "base64").toString()).toBe(text);

      const reply = await ask({
        op: "wrap",
        data: Buffer.from(`re: ${text}`).toString("base64"),
      });
      const bytes = Buffer.from(reply.data as string, "base64");
      expect(
        client.unwrap(bytes.subarray(0, 16), bytes.subarray(16)).toString(),
      ).toBe(`re: ${text}`);
    }
  });

  it("is refused with the wrong password", async () => {
    const fresh = spawn(python as string, [script], {
      env: {
        ...process.env,
        ORACLE_DOMAIN: "CONTOSO",
        ORACLE_USER: "Administrator",
        ORACLE_PASSWORD: "right",
      },
    });
    const lines = createInterface({ input: fresh.stdout });
    const next = () =>
      new Promise<Record<string, unknown>>((r) =>
        lines.once("line", (l) => r(JSON.parse(l))),
      );
    const client = new NtlmClient({
      username: "Administrator",
      domain: "CONTOSO",
      password: "wrong",
    });
    fresh.stdin.write(
      JSON.stringify({
        op: "step",
        token: client.negotiate().toString("base64"),
      }) + "\n",
    );
    const challenge = await next();
    const type3 = client.authenticate(
      Buffer.from(challenge.token as string, "base64"),
    );
    fresh.stdin.write(
      JSON.stringify({ op: "step", token: type3.toString("base64") }) + "\n",
    );
    const result = await next();
    fresh.kill();
    expect(String(result.error)).toMatch(/fail|invalid|password|logon/i);
  });
});
