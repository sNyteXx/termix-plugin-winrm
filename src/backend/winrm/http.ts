import type { Duplex } from "node:stream";

/*
 * A small HTTP/1.1 client over one already-open stream. WinRM binds its NTLM
 * context to a single TCP connection, so this deliberately never opens or
 * swaps connections itself: one HttpConnection is one socket, one request at
 * a time, and a closed socket stays closed. Bodies are capped so a broken or
 * hostile server cannot exhaust memory.
 */

export interface HttpResponse {
  status: number;
  statusText: string;
  /** Lower-case names. Repeated headers are joined with ", ". */
  headers: Record<string, string>;
  body: Buffer;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly code: "timeout" | "closed" | "protocol" | "too-large" | "busy",
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** WinRM's own envelope limit is 500 KB by default; 16 MB leaves room for any setting. */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;

interface Pending {
  resolve: (response: HttpResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  headRequest: boolean;
}

export class HttpConnection {
  private buffer: Buffer = Buffer.alloc(0);
  private pending: Pending | null = null;
  private closedReason: Error | null = null;
  private readonly closeListeners = new Set<(error: Error) => void>();

  constructor(
    private readonly stream: Duplex,
    private readonly hostHeader: string,
  ) {
    stream.on("data", (chunk: Buffer) => this.onData(chunk));
    stream.on("error", (error: Error) => this.fail(error));
    stream.on("close", () =>
      this.fail(new HttpError("The connection was closed", "closed")),
    );
    stream.on("end", () => {
      // The server may delimit a body without a length by closing.
      this.tryFinishOnEnd();
      this.fail(new HttpError("The server closed the connection", "closed"));
    });
  }

  get closed(): boolean {
    return this.closedReason !== null;
  }

  onClose(listener: (error: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  request(
    method: string,
    path: string,
    headers: Record<string, string>,
    body: Buffer,
    timeoutMs: number,
  ): Promise<HttpResponse> {
    if (this.closedReason) return Promise.reject(this.closedReason);
    if (this.pending) {
      return Promise.reject(
        new HttpError("A request is already in flight", "busy"),
      );
    }
    return new Promise<HttpResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(
          new HttpError(
            `No response within ${Math.round(timeoutMs / 1000)} s`,
            "timeout",
          ),
        );
      }, timeoutMs);
      this.pending = { resolve, reject, timer, headRequest: method === "HEAD" };
      const lines = [`${method} ${path} HTTP/1.1`, `Host: ${this.hostHeader}`];
      const all: Record<string, string> = {
        Connection: "Keep-Alive",
        "Content-Length": String(body.length),
        ...headers,
      };
      for (const [name, value] of Object.entries(all)) {
        if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
          this.settle(
            new HttpError("Header contains a line break", "protocol"),
          );
          return;
        }
        lines.push(`${name}: ${value}`);
      }
      const head = Buffer.from(lines.join("\r\n") + "\r\n\r\n", "latin1");
      this.stream.write(body.length > 0 ? Buffer.concat([head, body]) : head);
    });
  }

  close(): void {
    this.fail(new HttpError("The connection was closed", "closed"));
    this.stream.destroy();
  }

  private onData(chunk: Buffer): void {
    if (!this.pending) {
      // Nothing was asked; a server talking out of turn is broken.
      this.fail(new HttpError("Unexpected data from the server", "protocol"));
      this.stream.destroy();
      return;
    }
    this.buffer =
      this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_RESPONSE_BYTES + MAX_HEADER_BYTES) {
      this.settle(new HttpError("The response is too large", "too-large"));
      this.stream.destroy();
      return;
    }
    try {
      const parsed = parseResponse(
        this.buffer,
        this.pending.headRequest,
        false,
      );
      if (parsed) {
        this.buffer = this.buffer.subarray(parsed.consumed);
        this.settle(null, parsed.response);
      }
    } catch (error) {
      this.settle(error as Error);
      this.stream.destroy();
    }
  }

  private tryFinishOnEnd(): void {
    if (!this.pending) return;
    try {
      const parsed = parseResponse(this.buffer, this.pending.headRequest, true);
      if (parsed) this.settle(null, parsed.response);
    } catch (error) {
      this.settle(error as Error);
    }
  }

  private settle(error: Error | null, response?: HttpResponse): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(response as HttpResponse);
  }

  private fail(error: Error): void {
    if (this.closedReason) return;
    this.closedReason = error;
    this.settle(error);
    for (const listener of this.closeListeners) listener(error);
    this.closeListeners.clear();
    this.stream.destroy();
  }
}

/**
 * One response from the front of `data`, or null when more bytes are needed.
 * `ended` means the stream closed, which ends a body that has no length.
 */
export function parseResponse(
  data: Buffer,
  headRequest: boolean,
  ended: boolean,
): { response: HttpResponse; consumed: number } | null {
  const headEnd = data.indexOf("\r\n\r\n");
  if (headEnd < 0) {
    if (data.length > MAX_HEADER_BYTES) {
      throw new HttpError("Response headers are too large", "too-large");
    }
    return null;
  }
  const lines = data.subarray(0, headEnd).toString("latin1").split("\r\n");
  const statusLine = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(lines[0] ?? "");
  if (!statusLine)
    throw new HttpError("The server did not answer with HTTP", "protocol");
  const status = Number(statusLine[1]);
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
  }
  const bodyStart = headEnd + 4;
  const response = (body: Buffer, consumed: number) => ({
    response: { status, statusText: statusLine[2] ?? "", headers, body },
    consumed,
  });

  if (
    headRequest ||
    status === 204 ||
    status === 304 ||
    (status >= 100 && status < 200)
  ) {
    return response(Buffer.alloc(0), bodyStart);
  }

  if (/\bchunked\b/i.test(headers["transfer-encoding"] ?? "")) {
    const chunks: Buffer[] = [];
    let size = 0;
    let cursor = bodyStart;
    for (;;) {
      const lineEnd = data.indexOf("\r\n", cursor);
      if (lineEnd < 0) return null;
      const length = parseInt(
        data.subarray(cursor, lineEnd).toString("latin1").split(";")[0],
        16,
      );
      if (!Number.isFinite(length) || length < 0) {
        throw new HttpError("Malformed chunked body", "protocol");
      }
      cursor = lineEnd + 2;
      if (length === 0) {
        // Trailers end with an empty line.
        const trailerEnd = data.indexOf("\r\n", cursor);
        if (trailerEnd < 0) return null;
        if (trailerEnd === cursor)
          return response(Buffer.concat(chunks), cursor + 2);
        const end = data.indexOf("\r\n\r\n", cursor);
        if (end < 0) return null;
        return response(Buffer.concat(chunks), end + 4);
      }
      size += length;
      if (size > MAX_RESPONSE_BYTES)
        throw new HttpError("The response is too large", "too-large");
      if (cursor + length + 2 > data.length) return null;
      chunks.push(data.subarray(cursor, cursor + length));
      cursor += length + 2;
    }
  }

  const lengthHeader = headers["content-length"];
  if (lengthHeader !== undefined) {
    const length = Number(lengthHeader);
    if (!Number.isInteger(length) || length < 0) {
      throw new HttpError("Invalid Content-Length", "protocol");
    }
    if (length > MAX_RESPONSE_BYTES)
      throw new HttpError("The response is too large", "too-large");
    if (data.length < bodyStart + length) return null;
    return response(
      Buffer.from(data.subarray(bodyStart, bodyStart + length)),
      bodyStart + length,
    );
  }

  // No length: the body runs until the server closes the connection.
  if (!ended) return null;
  return response(Buffer.from(data.subarray(bodyStart)), data.length);
}
