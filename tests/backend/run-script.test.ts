import { describe, expect, it } from "vitest";
import { runScript } from "../../src/backend/session/run-script.js";
import { FakePowerShell } from "../support/fake-powershell.js";

function run(
  script: string,
  options: { timeoutMs?: number; maxOutputChars?: number } = {},
) {
  const fake = new FakePowerShell();
  const done = runScript(fake.channel(), fake.channel(), {
    script,
    timeoutMs: options.timeoutMs ?? 5000,
    width: 160,
    maxOutputChars: options.maxOutputChars,
  });
  return { fake, done };
}

describe("runScript", () => {
  it("returns output and every stream as data", async () => {
    const { fake, done } = run(
      "echo Grüße – ß €\nWrite-Warning Achtung\nWrite-Error kaputt\nWrite-Host 'hallo'",
    );
    const result = await done;
    expect(result.state).toBe("completed");
    expect(result.computerName).toBe("SRV01");
    expect(result.output).toBe("Grüße – ß €");
    expect(result.warnings).toEqual(["Achtung"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("kaputt");
    expect(result.errors[0]).not.toContain("\x1b[");
    expect(result.information).toEqual(["hallo"]);
    expect(result.truncated).toBe(false);
    expect(fake.deleted).toBe(true);
  });

  it("formats with Out-String at the given width and keeps the script out of history", async () => {
    const { fake, done } = run("echo x");
    await done;
    const pipeline = fake.pipelines.find(
      (p) => p.commands[0].command === "echo x",
    )!;
    expect(pipeline.addToHistory).toBe(false);
    expect(pipeline.commands[1].command).toBe("Out-String");
    expect(pipeline.commands[1].args).toContainEqual(["Width", 160]);
  });

  it("reports a terminating error as failed", async () => {
    const { done } = run("throw 'Dienst fehlt'");
    const result = await done;
    expect(result.state).toBe("failed");
    expect(result.errors.join("\n")).toContain("Dienst fehlt");
  });

  it("stops a script that runs too long and still deletes the session", async () => {
    const { fake, done } = run("Start-Sleep 600", { timeoutMs: 100 });
    const result = await done;
    expect(result.state).toBe("timeout");
    expect(fake.signals).toContain("crtl_c");
    expect(fake.deleted).toBe(true);
  });

  it("cuts output off at the limit", async () => {
    const script = Array.from(
      { length: 50 },
      (_, i) => `echo Zeile-${i}-${"x".repeat(20)}`,
    ).join("\n");
    const { done } = run(script, { maxOutputChars: 200 });
    const result = await done;
    expect(result.truncated).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(200);
  });
});
