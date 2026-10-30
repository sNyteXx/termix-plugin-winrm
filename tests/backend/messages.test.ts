import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  decodePsString,
  encodePsString,
  propString,
  psToString,
  readClixml,
} from "../../src/backend/psrp/clixml.js";
import {
  Defragmenter,
  Fragmenter,
  MessageType,
  bytesToGuid,
  createPipelineXml,
  encodeMessage,
  guidToBytes,
  initRunspacePoolXml,
  sessionCapabilityXml,
} from "../../src/backend/psrp/messages.js";

interface Pair {
  action: string;
  request: string;
}

/** The PSRP messages inside a recorded request, decoded. */
function recordedMessages(name: string, index: number) {
  const pairs = JSON.parse(
    readFileSync(
      new URL(`../fixtures/pypsrp/${name}.json`, import.meta.url),
      "utf8",
    ),
  ) as Pair[];
  const blob =
    /<(?:creationXml[^>]*|rsp:Arguments)>([^<]+)</.exec(
      pairs[index].request,
    )?.[1] ?? "";
  return new Defragmenter().push(Buffer.from(blob, "base64"));
}

describe("client messages match what pypsrp sent to real servers", () => {
  it("SESSION_CAPABILITY and INIT_RUNSPACEPOOL", () => {
    const [capability, init] = recordedMessages("with_history", 0);
    expect(capability.type).toBe(MessageType.SESSION_CAPABILITY);
    expect(sessionCapabilityXml()).toBe(capability.data);
    expect(init.type).toBe(MessageType.INIT_RUNSPACEPOOL);
    expect(initRunspacePoolXml()).toBe(init.data);
  });

  it("CREATE_PIPELINE for a script", () => {
    const [create] = recordedMessages("with_history", 3);
    expect(create.type).toBe(MessageType.CREATE_PIPELINE);
    const mine = createPipelineXml({
      commands: [{ command: "Write-Output 1; Write-Output 2", isScript: true }],
      addToHistory: true,
    }).replace('<B N="UseLocalScope">false</B>', '<Nil N="UseLocalScope" />');
    expect(mine).toBe(create.data);
  });

  it("CREATE_PIPELINE with parameters reads back", () => {
    const xml = createPipelineXml({
      commands: [
        {
          command: "param($s) $s",
          isScript: true,
          useLocalScope: true,
          args: [{ name: "s", value: 'a<b>&"ä' }],
        },
        {
          command: "Out-String",
          isScript: false,
          args: [
            { name: "Width", value: 120 },
            { name: "Stream", value: true },
          ],
        },
      ],
      addToHistory: true,
      history: "Get-Service | Sort-Object",
    });
    const parsed = readClixml(xml);
    expect(propString(parsed, "PowerShell", "History")).toBe(
      "Get-Service | Sort-Object",
    );
    expect(xml).toContain("a&lt;b&gt;&amp;&quot;ä");
  });
});

describe("framing", () => {
  it("writes GUIDs in .NET byte order", () => {
    const guid = "76056A84-51DC-4F24-9262-CA2A55464B2B";
    expect(guidToBytes(guid).toString("hex")).toBe(
      "846a0576dc51244f9262ca2a55464b2b",
    );
    expect(bytesToGuid(guidToBytes(guid))).toBe(guid);
  });

  it("fragments and reassembles a large message", () => {
    const data = "x".repeat(200_000) + "ü";
    const message = encodeMessage(
      MessageType.CREATE_PIPELINE,
      "76056A84-51DC-4F24-9262-CA2A55464B2B",
      null,
      data,
    );
    const fragments = new Fragmenter().fragment(message, 1000);
    expect(fragments.length).toBeGreaterThan(100);
    const defragmenter = new Defragmenter();
    const out = fragments.flatMap((f) => defragmenter.push(f));
    expect(out).toHaveLength(1);
    expect(out[0].data).toBe(data);
  });

  it("refuses fragments out of order", () => {
    const message = encodeMessage(
      MessageType.CREATE_PIPELINE,
      "76056A84-51DC-4F24-9262-CA2A55464B2B",
      null,
      "y".repeat(5000),
    );
    const fragments = new Fragmenter().fragment(message, 1000);
    const defragmenter = new Defragmenter();
    defragmenter.push(fragments[0]);
    expect(() => defragmenter.push(fragments[2])).toThrow(/order/);
  });
});

describe("CLIXML strings", () => {
  it("round-trips umlauts, control characters, emoji and underscores", () => {
    const value = "Grüße\täöü ß €\r\n😀 _x0041_ C:\\Temp";
    const encoded = encodePsString(value);
    expect(encoded).toContain("_x000D__x000A_");
    expect(encoded).toContain("_xD83D__xDE00_");
    expect(encoded).toContain("_x005F_x0041_");
    expect(psToString(readClixml(`<S>${encoded}</S>`))).toBe(value);
  });

  it("decodes what PowerShell sends", () => {
    expect(decodePsString("Zeile 1_x000A_Zeile 2")).toBe("Zeile 1\nZeile 2");
  });

  it("refuses DOCTYPEs", () => {
    expect(() =>
      readClixml('<!DOCTYPE x [<!ENTITY a "b">]><S>&a;</S>'),
    ).toThrow(/DOCTYPE/);
  });

  it("follows Ref and TNRef", () => {
    const value = readClixml(
      '<Obj RefId="0"><TN RefId="0"><T>A</T></TN><MS><Obj N="x" RefId="1"><TNRef RefId="0" /><ToString>inner</ToString></Obj><Ref N="y" RefId="1" /></MS></Obj>',
    );
    expect(propString(value, "y")).toBe("inner");
  });
});
