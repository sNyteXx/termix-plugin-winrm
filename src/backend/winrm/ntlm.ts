import { randomBytes, timingSafeEqual } from "node:crypto";
import { Rc4, hmacMd5, md4, md5, rc4 } from "./crypto.js";

/*
 * NTLMv2 client with extended session security, key exchange and 128-bit
 * sealing, as WinRM needs it for message encryption over HTTP (MS-NLMP).
 * Only the client side lives here; tests drive it against a server written
 * from the same spec and against the spec's own test vectors.
 */

const SIGNATURE = Buffer.from("NTLMSSP\0", "latin1");

export const NegotiateFlags = {
  UNICODE: 0x00000001,
  OEM: 0x00000002,
  REQUEST_TARGET: 0x00000004,
  SIGN: 0x00000010,
  SEAL: 0x00000020,
  NTLM: 0x00000200,
  ALWAYS_SIGN: 0x00008000,
  EXTENDED_SESSIONSECURITY: 0x00080000,
  TARGET_INFO: 0x00800000,
  VERSION: 0x02000000,
  NEGOTIATE_128: 0x20000000,
  KEY_EXCH: 0x40000000,
  NEGOTIATE_56: 0x80000000,
} as const;

const CLIENT_FLAGS =
  (NegotiateFlags.UNICODE |
    NegotiateFlags.OEM |
    NegotiateFlags.REQUEST_TARGET |
    NegotiateFlags.SIGN |
    NegotiateFlags.SEAL |
    NegotiateFlags.NTLM |
    NegotiateFlags.ALWAYS_SIGN |
    NegotiateFlags.EXTENDED_SESSIONSECURITY |
    NegotiateFlags.VERSION |
    NegotiateFlags.NEGOTIATE_128 |
    NegotiateFlags.KEY_EXCH |
    NegotiateFlags.NEGOTIATE_56) >>>
  0;

/** Flags the server must accept, or the context is too weak to seal with. */
const REQUIRED_FLAGS =
  (NegotiateFlags.SIGN |
    NegotiateFlags.SEAL |
    NegotiateFlags.EXTENDED_SESSIONSECURITY |
    NegotiateFlags.NEGOTIATE_128 |
    NegotiateFlags.KEY_EXCH) >>>
  0;

export const AvId = {
  EOL: 0,
  NbComputerName: 1,
  NbDomainName: 2,
  DnsComputerName: 3,
  DnsDomainName: 4,
  DnsTreeName: 5,
  Flags: 6,
  Timestamp: 7,
  SingleHost: 8,
  TargetName: 9,
  ChannelBindings: 10,
} as const;

/** MsvAvFlags bit: the AUTHENTICATE message carries a MIC. */
const AV_FLAG_MIC_PRESENT = 0x2;

/** Windows 10, build 19041, NTLM revision 15. Informational only. */
const CLIENT_VERSION = Buffer.from([10, 0, 0x61, 0x4a, 0, 0, 0, 0x0f]);

export class NtlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NtlmError";
  }
}

export interface NtlmCredentials {
  username: string;
  /** NetBIOS or DNS domain, or the computer name for a local account. Empty is allowed. */
  domain: string;
  password: string;
  workstation?: string;
}

export interface NtlmOptions {
  /**
   * Application data of the channel binding, "tls-server-end-point:" plus the
   * certificate hash, when the connection runs over TLS (Extended Protection).
   */
  channelBindings?: Buffer;
  /** Service principal name sent as MsvAvTargetName, like HTTP/server. */
  targetSpn?: string;
  /** Test seams. */
  random?: (size: number) => Buffer;
  now?: () => Date;
}

export interface AvPair {
  id: number;
  value: Buffer;
}

export interface ChallengeMessage {
  flags: number;
  serverChallenge: Buffer;
  targetName: string;
  targetInfo: AvPair[];
  raw: Buffer;
}

function utf16(value: string): Buffer {
  return Buffer.from(value, "utf16le");
}

function readField(message: Buffer, offset: number): Buffer {
  const length = message.readUInt16LE(offset);
  const start = message.readUInt32LE(offset + 4);
  if (start + length > message.length) {
    throw new NtlmError("NTLM message field points outside the message");
  }
  return message.subarray(start, start + length);
}

export function parseAvPairs(data: Buffer): AvPair[] {
  const pairs: AvPair[] = [];
  let offset = 0;
  while (offset + 4 <= data.length) {
    const id = data.readUInt16LE(offset);
    const length = data.readUInt16LE(offset + 2);
    offset += 4;
    if (id === AvId.EOL) return pairs;
    if (offset + length > data.length) {
      throw new NtlmError("NTLM target info is truncated");
    }
    pairs.push({
      id,
      value: Buffer.from(data.subarray(offset, offset + length)),
    });
    offset += length;
  }
  throw new NtlmError("NTLM target info has no end marker");
}

export function encodeAvPairs(pairs: AvPair[]): Buffer {
  const parts: Buffer[] = [];
  for (const pair of pairs) {
    const header = Buffer.alloc(4);
    header.writeUInt16LE(pair.id, 0);
    header.writeUInt16LE(pair.value.length, 2);
    parts.push(header, pair.value);
  }
  parts.push(Buffer.alloc(4)); // MsvAvEOL
  return Buffer.concat(parts);
}

export function parseChallenge(message: Buffer): ChallengeMessage {
  if (message.length < 48 || !message.subarray(0, 8).equals(SIGNATURE)) {
    throw new NtlmError("The server did not send an NTLM challenge");
  }
  if (message.readUInt32LE(8) !== 2) {
    throw new NtlmError("Expected an NTLM CHALLENGE message");
  }
  const flags = message.readUInt32LE(20);
  const targetName = readField(message, 12);
  const targetInfo =
    flags & NegotiateFlags.TARGET_INFO
      ? readField(message, 40)
      : Buffer.alloc(0);
  return {
    flags,
    serverChallenge: Buffer.from(message.subarray(24, 32)),
    targetName:
      flags & NegotiateFlags.UNICODE
        ? targetName.toString("utf16le")
        : targetName.toString("latin1"),
    targetInfo: targetInfo.length > 0 ? parseAvPairs(targetInfo) : [],
    raw: Buffer.from(message),
  };
}

/** NTOWFv2: the NTLMv2 response key from user, domain and password. */
export function ntowfv2(credentials: NtlmCredentials): Buffer {
  const ntHash = md4(utf16(credentials.password));
  return hmacMd5(
    ntHash,
    utf16(credentials.username.toUpperCase() + credentials.domain),
  );
}

/** The MD5 of a gss_channel_bindings_struct with only application data set. */
export function channelBindingsHash(applicationData: Buffer): Buffer {
  const struct = Buffer.alloc(20 + applicationData.length);
  // initiator addrtype/address and acceptor addrtype/address stay zero.
  struct.writeUInt32LE(applicationData.length, 16);
  applicationData.copy(struct, 20);
  return md5(struct);
}

function filetime(date: Date): Buffer {
  // 100 ns intervals since 1601-01-01.
  const ticks = (BigInt(date.getTime()) + 11644473600000n) * 10000n;
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(ticks);
  return out;
}

function securityKey(key: Buffer, magic: string): Buffer {
  return md5(key, Buffer.from(magic + "\0", "latin1"));
}

/** Signing and sealing keys for both directions (MS-NLMP 3.4.5.2, 3.4.5.3). */
export function deriveSessionKeys(exportedSessionKey: Buffer): {
  clientSign: Buffer;
  clientSeal: Buffer;
  serverSign: Buffer;
  serverSeal: Buffer;
} {
  return {
    clientSign: securityKey(
      exportedSessionKey,
      "session key to client-to-server signing key magic constant",
    ),
    clientSeal: securityKey(
      exportedSessionKey,
      "session key to client-to-server sealing key magic constant",
    ),
    serverSign: securityKey(
      exportedSessionKey,
      "session key to server-to-client signing key magic constant",
    ),
    serverSeal: securityKey(
      exportedSessionKey,
      "session key to server-to-client sealing key magic constant",
    ),
  };
}

/**
 * Seals and signs like one direction of an established context, for tests
 * that check against MS-NLMP's published vectors.
 */
export class NtlmSealer {
  private readonly direction: Direction;
  constructor(signKey: Buffer, sealKey: Buffer) {
    this.direction = { signKey, seal: new Rc4(sealKey), sequence: 0 };
  }
  seal(data: Buffer): { signature: Buffer; sealed: Buffer } {
    const sealed = this.direction.seal.update(data);
    return { signature: sign(this.direction, data), sealed };
  }
  unseal(signature: Buffer, sealed: Buffer): Buffer {
    const data = this.direction.seal.update(sealed);
    const expected = sign(this.direction, data);
    if (signature.length !== 16 || !timingSafeEqual(expected, signature)) {
      throw new NtlmError("The message signature does not match");
    }
    return data;
  }
}

interface Direction {
  signKey: Buffer;
  seal: Rc4;
  sequence: number;
}

/**
 * One NTLM security context: negotiate, authenticate, then wrap and unwrap
 * messages. It is bound to one TCP connection, like WinRM binds it.
 */
export class NtlmClient {
  private negotiateMessage: Buffer | null = null;
  private outbound: Direction | null = null;
  private inbound: Direction | null = null;
  private readonly random: (size: number) => Buffer;
  private readonly now: () => Date;

  constructor(
    private readonly credentials: NtlmCredentials,
    private readonly options: NtlmOptions = {},
  ) {
    this.random = options.random ?? randomBytes;
    this.now = options.now ?? (() => new Date());
  }

  get established(): boolean {
    return this.outbound !== null;
  }

  /** NEGOTIATE (type 1). */
  negotiate(): Buffer {
    const message = Buffer.alloc(40);
    SIGNATURE.copy(message, 0);
    message.writeUInt32LE(1, 8);
    message.writeUInt32LE(CLIENT_FLAGS, 12);
    // Domain and workstation fields stay empty; offsets point at the end.
    message.writeUInt32LE(40, 20);
    message.writeUInt32LE(40, 28);
    CLIENT_VERSION.copy(message, 32);
    this.negotiateMessage = message;
    return Buffer.from(message);
  }

  /** AUTHENTICATE (type 3) for the server's CHALLENGE. Sets up sealing. */
  authenticate(challengeBytes: Buffer): Buffer {
    if (!this.negotiateMessage) {
      throw new NtlmError("negotiate() must run before authenticate()");
    }
    const challenge = parseChallenge(challengeBytes);
    const flags = (CLIENT_FLAGS & challenge.flags) >>> 0;
    if ((flags & REQUIRED_FLAGS) !== REQUIRED_FLAGS) {
      throw new NtlmError(
        "The server does not offer NTLM signing, sealing and 128-bit key exchange",
      );
    }
    if (challenge.targetInfo.length === 0) {
      throw new NtlmError("The server did not offer NTLMv2 (no target info)");
    }

    const serverTimestamp = challenge.targetInfo.find(
      (p) => p.id === AvId.Timestamp,
    );
    const timestamp = serverTimestamp?.value ?? filetime(this.now());
    const clientChallenge = this.random(8);

    // A MIC is only sent when the server sent a timestamp (MS-NLMP 3.1.5.1.2).
    const withMic = serverTimestamp !== undefined;
    const pairs = challenge.targetInfo.filter(
      (p) =>
        p.id !== AvId.Flags &&
        p.id !== AvId.ChannelBindings &&
        p.id !== AvId.TargetName,
    );
    const existingFlags = challenge.targetInfo.find((p) => p.id === AvId.Flags);
    const flagValue =
      ((existingFlags?.value.readUInt32LE(0) ?? 0) |
        (withMic ? AV_FLAG_MIC_PRESENT : 0)) >>>
      0;
    if (flagValue !== 0) {
      const avFlags = Buffer.alloc(4);
      avFlags.writeUInt32LE(flagValue);
      pairs.push({ id: AvId.Flags, value: avFlags });
    }
    pairs.push({
      id: AvId.ChannelBindings,
      value: this.options.channelBindings
        ? channelBindingsHash(this.options.channelBindings)
        : Buffer.alloc(16),
    });
    if (this.options.targetSpn) {
      pairs.push({ id: AvId.TargetName, value: utf16(this.options.targetSpn) });
    }

    const temp = Buffer.concat([
      Buffer.from([1, 1, 0, 0, 0, 0, 0, 0]),
      timestamp,
      clientChallenge,
      Buffer.alloc(4),
      encodeAvPairs(pairs),
      Buffer.alloc(4),
    ]);

    const responseKey = ntowfv2(this.credentials);
    const ntProof = hmacMd5(responseKey, challenge.serverChallenge, temp);
    const ntResponse = Buffer.concat([ntProof, temp]);
    const lmResponse = serverTimestamp
      ? Buffer.alloc(24)
      : Buffer.concat([
          hmacMd5(responseKey, challenge.serverChallenge, clientChallenge),
          clientChallenge,
        ]);

    const sessionBaseKey = hmacMd5(responseKey, ntProof);
    const exportedSessionKey = this.random(16);
    const encryptedSessionKey = rc4(sessionBaseKey, exportedSessionKey);

    const domain = utf16(this.credentials.domain);
    const user = utf16(this.credentials.username);
    const workstation = utf16(this.credentials.workstation ?? "");

    const payloads = [
      lmResponse,
      ntResponse,
      domain,
      user,
      workstation,
      encryptedSessionKey,
    ];
    const headerLength = 88;
    const message = Buffer.alloc(
      headerLength + payloads.reduce((sum, p) => sum + p.length, 0),
    );
    SIGNATURE.copy(message, 0);
    message.writeUInt32LE(3, 8);
    // Field order in the header differs from payload order.
    const fieldOffsets = [12, 20, 28, 36, 44, 52];
    let cursor = headerLength;
    payloads.forEach((payload, index) => {
      const at = fieldOffsets[index];
      message.writeUInt16LE(payload.length, at);
      message.writeUInt16LE(payload.length, at + 2);
      message.writeUInt32LE(cursor, at + 4);
      payload.copy(message, cursor);
      cursor += payload.length;
    });
    message.writeUInt32LE(flags, 60);
    CLIENT_VERSION.copy(message, 64);
    if (withMic) {
      // MIC (offset 72) is computed over all three messages with itself zeroed.
      const mic = hmacMd5(
        exportedSessionKey,
        this.negotiateMessage,
        challenge.raw,
        message,
      );
      mic.copy(message, 72);
    }

    const keys = deriveSessionKeys(exportedSessionKey);
    this.outbound = {
      signKey: keys.clientSign,
      seal: new Rc4(keys.clientSeal),
      sequence: 0,
    };
    this.inbound = {
      signKey: keys.serverSign,
      seal: new Rc4(keys.serverSeal),
      sequence: 0,
    };
    return message;
  }

  /** Seals a message. Returns the 16 byte signature and the sealed bytes. */
  wrap(data: Buffer): { signature: Buffer; sealed: Buffer } {
    const direction = this.outbound;
    if (!direction) throw new NtlmError("The NTLM context is not established");
    const sealed = direction.seal.update(data);
    const signature = sign(direction, data);
    return { signature, sealed };
  }

  /** Unseals and verifies a message from the server. */
  unwrap(signature: Buffer, sealed: Buffer): Buffer {
    const direction = this.inbound;
    if (!direction) throw new NtlmError("The NTLM context is not established");
    if (signature.length !== 16)
      throw new NtlmError("Invalid NTLM signature length");
    const data = direction.seal.update(sealed);
    const expected = sign(direction, data);
    if (!timingSafeEqual(expected, signature)) {
      throw new NtlmError("The server's message signature does not match");
    }
    return data;
  }
}

function sign(direction: Direction, data: Buffer): Buffer {
  const sequence = Buffer.alloc(4);
  sequence.writeUInt32LE(direction.sequence);
  direction.sequence = (direction.sequence + 1) >>> 0;
  const checksum = direction.seal.update(
    hmacMd5(direction.signKey, sequence, data).subarray(0, 8),
  );
  return Buffer.concat([Buffer.from([1, 0, 0, 0]), checksum, sequence]);
}

/** Splits a "DOMAIN\user" or "user@domain" login into its parts. */
export function splitLogin(
  username: string,
  domain: string,
): { username: string; domain: string } {
  const trimmedDomain = domain.trim();
  const backslash = username.indexOf("\\");
  if (backslash > 0) {
    return {
      domain: trimmedDomain || username.slice(0, backslash),
      username: username.slice(backslash + 1),
    };
  }
  // A UPN goes to the server as typed with an empty domain; Windows
  // resolves it.
  return { username, domain: trimmedDomain };
}
