/*
 * WinRM message encryption over HTTP (MS-WSMV 2.2.9.1): each SOAP body is
 * sealed with the authentication context and sent as multipart/encrypted.
 * The sealed bytes are exactly as long as the plaintext (RC4), so a part is
 * read by length rather than by searching for the closing boundary inside
 * binary data.
 */

export const SPNEGO_ENCRYPTED = "application/HTTP-SPNEGO-session-encrypted";
const BOUNDARY = "Encrypted Boundary";
export const ENCRYPTED_CONTENT_TYPE = `multipart/encrypted;protocol="${SPNEGO_ENCRYPTED}";boundary="${BOUNDARY}"`;

export interface SealingContext {
  wrap(data: Buffer): { signature: Buffer; sealed: Buffer };
  unwrap(signature: Buffer, sealed: Buffer): Buffer;
}

export class EncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptionError";
  }
}

/** The request body for one SOAP message. */
export function encryptBody(context: SealingContext, soap: Buffer): Buffer {
  const { signature, sealed } = context.wrap(soap);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(signature.length);
  const head = [
    `--${BOUNDARY}`,
    `\tContent-Type: ${SPNEGO_ENCRYPTED}`,
    `\tOriginalContent: type=application/soap+xml;charset=UTF-8;Length=${soap.length}`,
    `--${BOUNDARY}`,
    "\tContent-Type: application/octet-stream",
    "",
  ].join("\r\n");
  return Buffer.concat([
    Buffer.from(head, "latin1"),
    length,
    signature,
    sealed,
    Buffer.from(`--${BOUNDARY}--\r\n`, "latin1"),
  ]);
}

export function isEncryptedContentType(
  contentType: string | undefined,
): boolean {
  return (
    !!contentType &&
    /^multipart\/encrypted/i.test(contentType) &&
    contentType.toLowerCase().includes(SPNEGO_ENCRYPTED.toLowerCase())
  );
}

function boundaryOf(contentType: string): string {
  const match = /boundary="?([^";]+)"?/i.exec(contentType);
  return match ? match[1] : BOUNDARY;
}

/** The SOAP body from an encrypted response. Throws on any framing or signature problem. */
export function decryptBody(
  context: SealingContext,
  body: Buffer,
  contentType: string,
): Buffer {
  const marker = Buffer.from(`--${boundaryOf(contentType)}`, "latin1");
  const octetHeader = Buffer.from(
    "Content-Type: application/octet-stream\r\n",
    "latin1",
  );
  const out: Buffer[] = [];
  let offset = 0;

  for (;;) {
    const partStart = body.indexOf(marker, offset);
    if (partStart < 0) break;
    const afterMarker = partStart + marker.length;
    if (body.subarray(afterMarker, afterMarker + 2).toString("latin1") === "--")
      break;

    const lengthMatch = /Length=(\d+)/.exec(
      body
        .subarray(afterMarker, Math.min(body.length, afterMarker + 512))
        .toString("latin1"),
    );
    if (!lengthMatch)
      throw new EncryptionError("Encrypted part without an original length");
    const expected = Number(lengthMatch[1]);

    const octet = body.indexOf(octetHeader, afterMarker);
    if (octet < 0) throw new EncryptionError("Encrypted part without its data");
    let cursor = octet + octetHeader.length;
    if (cursor + 4 > body.length)
      throw new EncryptionError("Encrypted part is truncated");
    const signatureLength = body.readUInt32LE(cursor);
    cursor += 4;
    if (
      signatureLength > 1024 ||
      cursor + signatureLength + expected > body.length
    ) {
      throw new EncryptionError("Encrypted part is truncated");
    }
    const signature = body.subarray(cursor, cursor + signatureLength);
    cursor += signatureLength;
    const sealed = body.subarray(cursor, cursor + expected);
    cursor += expected;
    out.push(context.unwrap(Buffer.from(signature), Buffer.from(sealed)));
    offset = cursor;
  }

  if (out.length === 0)
    throw new EncryptionError("The encrypted response had no parts");
  return Buffer.concat(out);
}
