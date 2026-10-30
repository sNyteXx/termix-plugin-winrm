import { describe, expect, it } from "vitest";
import { hmacMd5, md4, rc4 } from "../../src/backend/winrm/crypto.js";
import {
  AvId,
  NegotiateFlags,
  NtlmClient,
  NtlmSealer,
  deriveSessionKeys,
  encodeAvPairs,
  ntowfv2,
  parseChallenge,
  splitLogin,
} from "../../src/backend/winrm/ntlm.js";

const hex = (value: string) => Buffer.from(value.replace(/\s+/g, ""), "hex");

// MS-NLMP 4.2.1 and 4.2.4: the published NTLMv2 example.
const SPEC = {
  user: "User",
  domain: "Domain",
  password: "Password",
  serverChallenge: hex("0123456789abcdef"),
  clientChallenge: hex("aaaaaaaaaaaaaaaa"),
  randomSessionKey: hex("55555555555555555555555555555555"),
  time: Buffer.alloc(8),
};

describe("crypto primitives", () => {
  it("computes MD4 per RFC 1320", () => {
    expect(md4(Buffer.from("")).toString("hex")).toBe(
      "31d6cfe0d16ae931b73c59d7e0c089c0",
    );
    expect(md4(Buffer.from("abc")).toString("hex")).toBe(
      "a448017aaf21d8525fc10ae87aa6729d",
    );
    expect(md4(Buffer.from("message digest")).toString("hex")).toBe(
      "d9130a8164549fe818874806e1c7014b",
    );
    expect(
      md4(
        Buffer.from(
          "12345678901234567890123456789012345678901234567890123456789012345678901234567890",
        ),
      ).toString("hex"),
    ).toBe("e33b4ddc9c38f2199c3e7b164fcc0536");
  });

  it("computes RC4 like the RFC 6229 vectors", () => {
    const key = hex("0102030405");
    expect(rc4(key, Buffer.alloc(16)).toString("hex")).toBe(
      "b2396305f03dc027ccc3524a0a1118a8",
    );
  });
});

describe("NTLMv2 per MS-NLMP 4.2.4", () => {
  it("derives the response key", () => {
    expect(
      ntowfv2({
        username: SPEC.user,
        domain: SPEC.domain,
        password: SPEC.password,
      }),
    ).toEqual(hex("0c868a403bfd7a93a3001ef22ef02e3f"));
  });

  it("computes NTProofStr, the session base key and the encrypted session key", () => {
    const responseKey = ntowfv2({
      username: SPEC.user,
      domain: SPEC.domain,
      password: SPEC.password,
    });
    const targetInfo = encodeAvPairs([
      { id: AvId.NbDomainName, value: Buffer.from("Domain", "utf16le") },
      { id: AvId.NbComputerName, value: Buffer.from("Server", "utf16le") },
    ]);
    const temp = Buffer.concat([
      hex("0101000000000000"),
      SPEC.time,
      SPEC.clientChallenge,
      Buffer.alloc(4),
      targetInfo,
      Buffer.alloc(4),
    ]);
    const ntProof = hmacMd5(responseKey, SPEC.serverChallenge, temp);
    expect(ntProof).toEqual(hex("68cd0ab851e51c96aabc927bebef6a1c"));
    const sessionBaseKey = hmacMd5(responseKey, ntProof);
    expect(sessionBaseKey).toEqual(hex("8de40ccadbc14a82f15cb0ad0de95ca3"));
    expect(rc4(sessionBaseKey, SPEC.randomSessionKey)).toEqual(
      hex("c5dad2544fc9799094ce1ce90bc9d03e"),
    );
  });

  it("seals and signs the spec's plaintext", () => {
    const keys = deriveSessionKeys(SPEC.randomSessionKey);
    const sealer = new NtlmSealer(keys.clientSign, keys.clientSeal);
    const { sealed, signature } = sealer.seal(
      Buffer.from("Plaintext", "utf16le"),
    );
    expect(sealed).toEqual(hex("54e50165bf1936dc996020c1811b0f06fb5f"));
    expect(signature).toEqual(hex("010000007fb38ec5c55d497600000000"));
  });
});

/** A CHALLENGE message the way a Windows server sends one. */
function challengeMessage(flags: number, withTimestamp = true): Buffer {
  const targetName = Buffer.from("CONTOSO", "utf16le");
  const pairs: Array<{ id: number; value: Buffer }> = [
    { id: AvId.NbDomainName, value: Buffer.from("CONTOSO", "utf16le") },
    { id: AvId.NbComputerName, value: Buffer.from("SRV01", "utf16le") },
    {
      id: AvId.DnsComputerName,
      value: Buffer.from("srv01.contoso.local", "utf16le"),
    },
  ];
  if (withTimestamp)
    pairs.push({ id: AvId.Timestamp, value: hex("0090d336b734c301") });
  const targetInfo = encodeAvPairs(pairs);
  const header = Buffer.alloc(56);
  header.write("NTLMSSP\0", 0, "latin1");
  header.writeUInt32LE(2, 8);
  header.writeUInt16LE(targetName.length, 12);
  header.writeUInt16LE(targetName.length, 14);
  header.writeUInt32LE(56, 16);
  header.writeUInt32LE(flags, 20);
  SPEC.serverChallenge.copy(header, 24);
  header.writeUInt16LE(targetInfo.length, 40);
  header.writeUInt16LE(targetInfo.length, 42);
  header.writeUInt32LE(56 + targetName.length, 44);
  return Buffer.concat([header, targetName, targetInfo]);
}

const SERVER_FLAGS =
  (NegotiateFlags.UNICODE |
    NegotiateFlags.REQUEST_TARGET |
    NegotiateFlags.SIGN |
    NegotiateFlags.SEAL |
    NegotiateFlags.NTLM |
    NegotiateFlags.ALWAYS_SIGN |
    NegotiateFlags.EXTENDED_SESSIONSECURITY |
    NegotiateFlags.TARGET_INFO |
    NegotiateFlags.VERSION |
    NegotiateFlags.NEGOTIATE_128 |
    NegotiateFlags.KEY_EXCH |
    NegotiateFlags.NEGOTIATE_56) >>>
  0;

describe("NtlmClient", () => {
  const credentials = {
    username: "Administrator",
    domain: "CONTOSO",
    password: "Pässwörd!",
  };

  it("parses a challenge", () => {
    const parsed = parseChallenge(challengeMessage(SERVER_FLAGS));
    expect(parsed.targetName).toBe("CONTOSO");
    expect(parsed.serverChallenge).toEqual(SPEC.serverChallenge);
    expect(parsed.targetInfo.map((p) => p.id)).toContain(AvId.Timestamp);
  });

  it("builds an AUTHENTICATE message with a MIC and the user's names", () => {
    const client = new NtlmClient(credentials, {
      random: (n) => Buffer.alloc(n, 0x11),
    });
    const type1 = client.negotiate();
    expect(type1.subarray(0, 8).toString("latin1")).toBe("NTLMSSP\0");
    const type3 = client.authenticate(challengeMessage(SERVER_FLAGS));
    expect(type3.readUInt32LE(8)).toBe(3);
    const field = (offset: number) =>
      type3.subarray(
        type3.readUInt32LE(offset + 4),
        type3.readUInt32LE(offset + 4) + type3.readUInt16LE(offset),
      );
    expect(field(28).toString("utf16le")).toBe("CONTOSO");
    expect(field(36).toString("utf16le")).toBe("Administrator");
    expect(type3.subarray(72, 88).equals(Buffer.alloc(16))).toBe(false);
    expect(client.established).toBe(true);
    // The password never appears in the message, in any encoding.
    expect(type3.includes(Buffer.from(credentials.password, "utf16le"))).toBe(
      false,
    );
    expect(type3.includes(Buffer.from(credentials.password, "utf8"))).toBe(
      false,
    );
  });

  it("leaves the MIC out without a server timestamp", () => {
    const client = new NtlmClient(credentials);
    client.negotiate();
    const type3 = client.authenticate(challengeMessage(SERVER_FLAGS, false));
    expect(type3.subarray(72, 88).equals(Buffer.alloc(16))).toBe(true);
  });

  it("refuses a server that will not seal", () => {
    const client = new NtlmClient(credentials);
    client.negotiate();
    const weak = (SERVER_FLAGS & ~NegotiateFlags.SEAL) >>> 0;
    expect(() => client.authenticate(challengeMessage(weak))).toThrow(
      /sealing/,
    );
  });

  it("refuses an authenticate before negotiate", () => {
    const client = new NtlmClient(credentials);
    expect(() => client.authenticate(challengeMessage(SERVER_FLAGS))).toThrow(
      /negotiate/,
    );
  });

  it("refuses garbage instead of a challenge", () => {
    const client = new NtlmClient(credentials);
    client.negotiate();
    expect(() =>
      client.authenticate(Buffer.from("not ntlm at all, really not")),
    ).toThrow();
  });

  it("detects a tampered message from the server", () => {
    const keys = deriveSessionKeys(Buffer.alloc(16, 7));
    const server = new NtlmSealer(keys.serverSign, keys.serverSeal);
    const client = new NtlmSealer(keys.serverSign, keys.serverSeal);
    const { sealed, signature } = server.seal(Buffer.from("<s:Envelope/>"));
    sealed[0] ^= 0xff;
    expect(() => client.unseal(signature, sealed)).toThrow(/signature/);
  });
});

describe("splitLogin", () => {
  it("splits DOMAIN\\user", () => {
    expect(splitLogin("CONTOSO\\Administrator", "")).toEqual({
      username: "Administrator",
      domain: "CONTOSO",
    });
  });
  it("prefers an explicit domain", () => {
    expect(splitLogin("CONTOSO\\Administrator", "OTHER")).toEqual({
      username: "Administrator",
      domain: "OTHER",
    });
  });
  it("passes a UPN through with an empty domain", () => {
    expect(splitLogin("admin@contoso.local", "")).toEqual({
      username: "admin@contoso.local",
      domain: "",
    });
  });
  it("keeps a local account with the computer name as domain", () => {
    expect(splitLogin("Admin", "WIN11-OFFICE")).toEqual({
      username: "Admin",
      domain: "WIN11-OFFICE",
    });
  });
});
