import { createHash, createHmac } from "node:crypto";

/*
 * NTLM needs MD4 and RC4. OpenSSL 3 only offers both through its legacy
 * provider, which Termix's Node does not load, so they are implemented here.
 * Neither is used for anything but the NTLM key schedule and NTLM sealing,
 * which the protocol fixes.
 */

function rotl(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

/** MD4 (RFC 1320). Only for the NT hash of a password. */
export function md4(input: Buffer): Buffer {
  const bitLength = input.length * 8;
  const padLength = (input.length % 64 < 56 ? 56 : 120) - (input.length % 64);
  const message = Buffer.alloc(input.length + padLength + 8);
  input.copy(message);
  message[input.length] = 0x80;
  message.writeUInt32LE(bitLength >>> 0, message.length - 8);
  message.writeUInt32LE(
    Math.floor(bitLength / 0x100000000),
    message.length - 4,
  );

  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;

  const f = (x: number, y: number, z: number) => (x & y) | (~x & z);
  const g = (x: number, y: number, z: number) => (x & y) | (x & z) | (y & z);
  const h = (x: number, y: number, z: number) => x ^ y ^ z;

  const x = new Array<number>(16);
  for (let offset = 0; offset < message.length; offset += 64) {
    for (let i = 0; i < 16; i++) x[i] = message.readUInt32LE(offset + i * 4);
    const [aa, bb, cc, dd] = [a, b, c, d];

    const r1 = (
      p: number,
      q: number,
      r: number,
      s: number,
      k: number,
      n: number,
    ) => rotl((p + f(q, r, s) + x[k]) >>> 0, n);
    for (const k of [0, 4, 8, 12]) {
      a = r1(a, b, c, d, k, 3);
      d = r1(d, a, b, c, k + 1, 7);
      c = r1(c, d, a, b, k + 2, 11);
      b = r1(b, c, d, a, k + 3, 19);
    }

    const r2 = (
      p: number,
      q: number,
      r: number,
      s: number,
      k: number,
      n: number,
    ) => rotl((p + g(q, r, s) + x[k] + 0x5a827999) >>> 0, n);
    for (const k of [0, 1, 2, 3]) {
      a = r2(a, b, c, d, k, 3);
      d = r2(d, a, b, c, k + 4, 5);
      c = r2(c, d, a, b, k + 8, 9);
      b = r2(b, c, d, a, k + 12, 13);
    }

    const r3 = (
      p: number,
      q: number,
      r: number,
      s: number,
      k: number,
      n: number,
    ) => rotl((p + h(q, r, s) + x[k] + 0x6ed9eba1) >>> 0, n);
    for (const k of [0, 2, 1, 3]) {
      a = r3(a, b, c, d, k, 3);
      d = r3(d, a, b, c, k + 8, 9);
      c = r3(c, d, a, b, k + 4, 11);
      b = r3(b, c, d, a, k + 12, 15);
    }

    a = (a + aa) >>> 0;
    b = (b + bb) >>> 0;
    c = (c + cc) >>> 0;
    d = (d + dd) >>> 0;
  }

  const out = Buffer.alloc(16);
  out.writeUInt32LE(a, 0);
  out.writeUInt32LE(b, 4);
  out.writeUInt32LE(c, 8);
  out.writeUInt32LE(d, 12);
  return out;
}

/**
 * A running RC4 keystream. NTLM keeps one per direction for the whole
 * security context, so the state must persist between calls.
 */
export class Rc4 {
  private readonly s = new Uint8Array(256);
  private i = 0;
  private j = 0;

  constructor(key: Buffer) {
    if (key.length === 0) throw new Error("RC4 key must not be empty");
    for (let n = 0; n < 256; n++) this.s[n] = n;
    let j = 0;
    for (let n = 0; n < 256; n++) {
      j = (j + this.s[n] + key[n % key.length]) & 0xff;
      [this.s[n], this.s[j]] = [this.s[j], this.s[n]];
    }
  }

  update(data: Buffer): Buffer {
    const out = Buffer.alloc(data.length);
    for (let n = 0; n < data.length; n++) {
      this.i = (this.i + 1) & 0xff;
      this.j = (this.j + this.s[this.i]) & 0xff;
      [this.s[this.i], this.s[this.j]] = [this.s[this.j], this.s[this.i]];
      out[n] = data[n] ^ this.s[(this.s[this.i] + this.s[this.j]) & 0xff];
    }
    return out;
  }
}

/** One-shot RC4, for the key exchange where no state carries over. */
export function rc4(key: Buffer, data: Buffer): Buffer {
  return new Rc4(key).update(data);
}

export function md5(...parts: Buffer[]): Buffer {
  const hash = createHash("md5");
  for (const part of parts) hash.update(part);
  return hash.digest();
}

export function hmacMd5(key: Buffer, ...parts: Buffer[]): Buffer {
  const hmac = createHmac("md5", key);
  for (const part of parts) hmac.update(part);
  return hmac.digest();
}
