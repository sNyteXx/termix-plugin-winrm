import { describe, expect, it } from "vitest";
import { PowerShellSession } from "../../src/backend/session/powershell-session.js";
import { FakePowerShell } from "../support/fake-powershell.js";

async function open() {
  const fake = new FakePowerShell();
  const session = await PowerShellSession.open(fake.channel(), fake.channel());
  return { fake, session };
}

async function run(session: PowerShellSession, text: string, width = 120) {
  let output = "";
  const result = await session.run(text, width, (chunk) => (output += chunk))
    .done;
  return { output, result };
}

describe("PowerShellSession", () => {
  it("opens and builds an Enter-PSSession style prompt", async () => {
    const { session } = await open();
    expect(session.computerName).toBe("SRV01");
    expect(session.psVersion).toBe("5.1.26100.1");
    expect(await session.prompt()).toBe(
      "[SRV01]: PS C:\\Users\\Administrator> ",
    );
  });

  it("runs user input in the session scope so variables and the location persist", async () => {
    const { fake, session } = await open();
    await run(session, "$service = 'Running'");
    const { output } = await run(session, "$service");
    expect(output).toBe("Running\r\n");
    await run(session, "Set-Location C:\\Windows");
    expect(await session.prompt()).toContain("PS C:\\Windows> ");

    const user = fake.pipelines.find((p) => p.history === "$service")!;
    expect(user.addToHistory).toBe(true);
    expect(user.commands[0]).toMatchObject({
      command: "$service",
      isScript: true,
      useLocalScope: false,
    });
    expect(user.commands[1].command).toBe("Out-String");
    expect(user.commands[1].args).toEqual([
      ["Stream", true],
      ["Width", 120],
    ]);
  });

  it("keeps helper pipelines out of history and out of the user's scope", async () => {
    const { fake, session } = await open();
    await session.prompt();
    await session.isIncomplete("if ($true) {");
    for (const pipeline of fake.pipelines.filter((p) => p.history === null)) {
      expect(pipeline.addToHistory).toBe(false);
      expect(pipeline.commands[0].useLocalScope).toBe(true);
    }
  });

  it("passes the parse check's input as a parameter, never inside the script", async () => {
    const { fake, session } = await open();
    const hostile = "'; Remove-Item C:\\ -Recurse; '{";
    expect(await session.isIncomplete(hostile)).toBe(true);
    const check = fake.pipelines.at(-1)!;
    expect(check.commands[0].command).not.toContain("Remove-Item");
    expect(check.commands[0].args).toEqual([["s", hostile]]);
  });

  it("skips the server round trip for plainly complete lines", async () => {
    const { fake, session } = await open();
    const before = fake.pipelines.length;
    expect(await session.isIncomplete("Get-Service WinRM")).toBe(false);
    expect(fake.pipelines.length).toBe(before);
  });

  it("clamps the output width", async () => {
    const { fake, session } = await open();
    await run(session, "echo x", 5);
    expect(fake.pipelines.at(-1)!.commands[1].args).toContainEqual([
      "Width",
      40,
    ]);
    await run(session, "echo x", 100_000);
    expect(fake.pipelines.at(-1)!.commands[1].args).toContainEqual([
      "Width",
      500,
    ]);
  });

  it("prints errors and warnings in colour, PowerShell style", async () => {
    const { session } = await open();
    const { output, result } = await run(
      session,
      "Write-Warning Achtung\nWrite-Error kaputt",
    );
    expect(result.state).toBe("completed");
    expect(output).toContain("\x1b[93mWARNING: Achtung\x1b[0m");
    expect(output).toContain("\x1b[91mkaputt\x1b[0m");
    expect(output).toContain(
      "+ FullyQualifiedErrorId : Microsoft.PowerShell.Commands.WriteErrorException",
    );
  });

  it("reports a terminating error", async () => {
    const { session } = await open();
    const { output, result } = await run(
      session,
      "throw 'Dienst nicht gefunden'",
    );
    expect(result.state).toBe("failed");
    expect(output).toContain("Dienst nicht gefunden");
  });

  it("renders Write-Host colours and -NoNewline", async () => {
    const { session } = await open();
    const { output } = await run(
      session,
      "Write-Host 'Fortschritt: ' -NoNewline\nWrite-Host 'fertig'",
    );
    expect(output).toBe(
      "\x1b[92mFortschritt: \x1b[0m\x1b[92mfertig\x1b[0m\r\n",
    );
  });

  it("keeps umlauts and other Unicode intact", async () => {
    const { session } = await open();
    const { output } = await run(
      session,
      "echo Grüße aus Lüdinghausen – ß € 😀",
    );
    expect(output).toBe("Grüße aus Lüdinghausen – ß € 😀\r\n");
  });

  it("removes terminal control sequences a remote string could abuse", async () => {
    const { session } = await open();
    const { output } = await run(
      session,
      "echo \x1b]0;evil title\x07safe\x1b]52;c;ZXZpbA==\x07",
    );
    expect(output).toBe("safe\r\n");
  });

  it("stops a running command with Ctrl+C", async () => {
    const { fake, session } = await open();
    let output = "";
    const handle = session.run(
      "Start-Sleep 600",
      120,
      (chunk) => (output += chunk),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(session.busy).toBe(true);
    await handle.stop();
    const result = await handle.done;
    expect(result.state).toBe("stopped");
    expect(fake.signals).toContain("crtl_c");
    expect(output).toContain("The pipeline has been stopped.");
    expect(session.busy).toBe(false);
  });

  it("keeps working after Ctrl+C, when Windows already dropped the stopped command", async () => {
    const { session } = await open();
    await run(session, "$service = 'Running'");
    const handle = session.run("Start-Sleep 600", 120, () => undefined);
    await new Promise((r) => setTimeout(r, 20));
    await handle.stop();
    expect((await handle.done).state).toBe("stopped");
    expect(await session.prompt()).toContain("PS C:\\Users\\Administrator> ");
    const { output } = await run(session, "$service");
    expect(output).toBe("Running\r\n");
  });

  it("deletes the shell on close", async () => {
    const { fake, session } = await open();
    await session.close();
    expect(fake.deleted).toBe(true);
    expect(session.isClosed).toBe(true);
  });

  it("notices a shell that disappeared", async () => {
    const { fake, session } = await open();
    fake.shellGone = true;
    await expect(session.ping()).rejects.toThrow(/no longer exists|shell/i);
  });
});
