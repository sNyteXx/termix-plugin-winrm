import { X509Certificate, createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import {
  ENCRYPTED_CONTENT_TYPE,
  decryptBody,
  encryptBody,
  isEncryptedContentType,
} from "./encryption.js";
import { WinrmError, describeSocketError } from "./errors.js";
import { HttpConnection, HttpError, type HttpResponse } from "./http.js";
import { NtlmClient, NtlmError, type NtlmCredentials } from "./ntlm.js";

/*
 * One authenticated WinRM connection. Over HTTP every body is sealed with the
 * NTLM context (never sent in the clear); over HTTPS TLS protects it and the
 * NTLM login is bound to the certificate. Requests are queued, one at a time,
 * because both the HTTP connection and the NTLM sequence numbers are serial.
 */

export type StreamOpener = () => Promise<Duplex>;

export type TlsVerification =
  { mode: "ca"; ca?: string } | { mode: "fingerprint"; sha256: string };

export interface ChannelOptions {
  host: string;
  port: number;
  https: boolean;
  /** Opens the raw TCP stream, directly or through a jump host. */
  open: StreamOpener;
  credentials: NtlmCredentials;
  tls?: TlsVerification;
  connectTimeoutMs: number;
}

const SOAP_CONTENT_TYPE = "application/soap+xml;charset=UTF-8";

export function endpointUrl(
  host: string,
  port: number,
  https: boolean,
): string {
  const name = isIP(host) === 6 ? `[${host}]` : host;
  return `${https ? "https" : "http"}://${name}:${port}/wsman`;
}

export function normalizeFingerprint(value: string): string {
  return value.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
}

/** RFC 5929 tls-server-end-point: the certificate hashed with its signature hash, at least SHA-256. */
export function tlsServerEndPoint(raw: Buffer): Buffer {
  let algorithm = "sha256";
  try {
    const cert = new X509Certificate(raw) as X509Certificate & {
      signatureAlgorithm?: string;
    };
    const signature = (cert.signatureAlgorithm ?? "").toLowerCase();
    if (signature.includes("384")) algorithm = "sha384";
    else if (signature.includes("512")) algorithm = "sha512";
  } catch {
    // Older Node: SHA-256 covers the common case.
  }
  return Buffer.concat([
    Buffer.from("tls-server-end-point:", "latin1"),
    createHash(algorithm).update(raw).digest(),
  ]);
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class WinrmChannel {
  private connection: HttpConnection | null = null;
  private ntlm: NtlmClient | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  readonly url: string;
  private readonly target: string;

  constructor(private readonly options: ChannelOptions) {
    this.url = endpointUrl(options.host, options.port, options.https);
    this.target = `${options.host}:${options.port}`;
  }

  /** Sends one SOAP message and returns the response text. Faults come back as text. */
  send(soap: string, timeoutMs: number): Promise<string> {
    const run = this.queue.then(() => this.sendNow(soap, timeoutMs));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Connects and logs in without sending anything, to surface errors early. */
  async connect(): Promise<void> {
    const run = this.queue.then(() => this.ensureConnected());
    this.queue = run.catch(() => undefined);
    await run;
  }

  close(): void {
    this.disposed = true;
    this.connection?.close();
    this.connection = null;
    this.ntlm = null;
  }

  private async sendNow(soap: string, timeoutMs: number): Promise<string> {
    if (this.disposed)
      throw new WinrmError("closed", "The session was closed.");
    await this.ensureConnected();
    const connection = this.connection as HttpConnection;
    const ntlm = this.ntlm as NtlmClient;
    const plain = Buffer.from(soap, "utf8");
    const body = this.options.https ? plain : encryptBody(ntlm, plain);
    const contentType = this.options.https
      ? SOAP_CONTENT_TYPE
      : ENCRYPTED_CONTENT_TYPE;

    let response: HttpResponse;
    try {
      response = await connection.request(
        "POST",
        "/wsman",
        { "Content-Type": contentType, "User-Agent": "Termix WinRM" },
        body,
        timeoutMs,
      );
    } catch (error) {
      this.dropConnection();
      throw this.mapHttpError(error);
    }

    if (response.status === 401) {
      this.dropConnection();
      throw new WinrmError("auth", "WinRM refused the login for this request.");
    }

    const responseType = response.headers["content-type"];
    let text = "";
    if (response.body.length > 0) {
      if (isEncryptedContentType(responseType)) {
        try {
          text = decryptBody(
            ntlm,
            response.body,
            responseType as string,
          ).toString("utf8");
        } catch (error) {
          this.dropConnection();
          throw new WinrmError(
            "protocol",
            `Could not decrypt the WinRM response: ${(error as Error).message}`,
          );
        }
      } else if (this.options.https) {
        text = response.body.toString("utf8");
      } else if (response.status === 200) {
        // A server that answers in the clear over HTTP is not to be trusted.
        this.dropConnection();
        throw new WinrmError(
          "protocol",
          "The server answered without encryption over HTTP; refused.",
        );
      } else {
        text = response.body.toString("utf8");
      }
    }

    if (response.status === 200) return text;
    if (response.status === 500 && text.includes("Fault")) return text;
    throw new WinrmError(
      "http",
      `WinRM answered HTTP ${response.status} ${response.statusText}`.trim(),
      text.slice(0, 500),
    );
  }

  private dropConnection(): void {
    this.connection?.close();
    this.connection = null;
    this.ntlm = null;
  }

  private mapHttpError(error: unknown): WinrmError {
    if (error instanceof WinrmError) return error;
    if (error instanceof HttpError) {
      if (error.code === "timeout")
        return new WinrmError("timeout", `${this.target}: ${error.message}`);
      if (error.code === "closed")
        return new WinrmError(
          "closed",
          `${this.target} closed the connection.`,
        );
      return new WinrmError("protocol", `${this.target}: ${error.message}`);
    }
    return describeSocketError(error, this.target);
  }

  private async ensureConnected(): Promise<void> {
    if (this.disposed)
      throw new WinrmError("closed", "The session was closed.");
    if (this.connection && !this.connection.closed && this.ntlm?.established)
      return;
    this.dropConnection();

    const timeout = this.options.connectTimeoutMs;
    let stream: Duplex;
    try {
      stream = await withTimeout(
        this.options.open(),
        timeout,
        () =>
          new WinrmError(
            "timeout",
            `${this.target} did not accept a connection within ${Math.round(timeout / 1000)} s.`,
          ),
      );
    } catch (error) {
      throw describeSocketError(error, this.target);
    }

    let channelBindings: Buffer | undefined;
    if (this.options.https) {
      const secured = await this.startTls(stream);
      stream = secured.socket;
      channelBindings = secured.channelBindings;
    }

    const connection = new HttpConnection(stream, this.hostHeader());
    const ntlm = new NtlmClient(this.options.credentials, {
      channelBindings,
      targetSpn: `HTTP/${this.options.host}`,
    });
    try {
      await this.authenticate(connection, ntlm, timeout);
    } catch (error) {
      connection.close();
      throw error;
    }
    this.connection = connection;
    this.ntlm = ntlm;
  }

  private hostHeader(): string {
    const name =
      isIP(this.options.host) === 6
        ? `[${this.options.host}]`
        : this.options.host;
    return `${name}:${this.options.port}`;
  }

  private async authenticate(
    connection: HttpConnection,
    ntlm: NtlmClient,
    timeout: number,
  ): Promise<void> {
    const headers = (token: Buffer) => ({
      Authorization: `Negotiate ${token.toString("base64")}`,
      "Content-Type": SOAP_CONTENT_TYPE,
      "User-Agent": "Termix WinRM",
    });
    let challenge: HttpResponse;
    try {
      challenge = await connection.request(
        "POST",
        "/wsman",
        headers(ntlm.negotiate()),
        Buffer.alloc(0),
        timeout,
      );
    } catch (error) {
      if (error instanceof HttpError && error.code === "closed") {
        // Through a jump host a closed port looks like this: the tunnel opens, then drops.
        throw new WinrmError(
          "connect",
          `${this.target} closed the connection before answering. Is WinRM listening on this port, and does the firewall allow the Termix server or jump host?`,
        );
      }
      throw this.mapHttpError(error);
    }
    if (challenge.status !== 401) {
      throw new WinrmError(
        "protocol",
        `${this.target} answered HTTP ${challenge.status} instead of a login challenge. Is this a WinRM endpoint?`,
      );
    }
    const offered = challenge.headers["www-authenticate"] ?? "";
    const match = /(?:^|,\s*)Negotiate\s+([A-Za-z0-9+/=]+)/i.exec(offered);
    if (!match) {
      const schemes = offered
        .split(",")
        .map((s) => s.trim().split(" ")[0])
        .filter(Boolean);
      throw new WinrmError(
        "auth",
        schemes.length && !schemes.some((s) => /^negotiate$/i.test(s))
          ? `${this.target} does not offer Negotiate (offered: ${schemes.join(", ")}). Enable Negotiate authentication for WinRM.`
          : `${this.target} rejected the NTLM negotiation.`,
      );
    }

    let authenticate: Buffer;
    try {
      authenticate = ntlm.authenticate(Buffer.from(match[1], "base64"));
    } catch (error) {
      throw new WinrmError(
        "protocol",
        error instanceof NtlmError
          ? error.message
          : "The NTLM challenge could not be read.",
      );
    }

    let result: HttpResponse;
    try {
      result = await connection.request(
        "POST",
        "/wsman",
        headers(authenticate),
        Buffer.alloc(0),
        timeout,
      );
    } catch (error) {
      throw this.mapHttpError(error);
    }
    if (result.status === 401) {
      throw new WinrmError(
        "auth",
        "Login failed: wrong user name, password or domain, or the account may not use WinRM (Administrators or Remote Management Users).",
      );
    }
  }

  private startTls(
    raw: Duplex,
  ): Promise<{ socket: tls.TLSSocket; channelBindings: Buffer }> {
    const verification = this.options.tls ?? { mode: "ca" as const };
    const host = this.options.host;
    return new Promise((resolve, reject) => {
      const socket = tls.connect({
        socket: raw,
        servername: isIP(host) ? undefined : host,
        minVersion: "TLSv1.2",
        ca:
          verification.mode === "ca" && verification.ca
            ? [verification.ca]
            : undefined,
        // A pinned certificate is checked below against its exact fingerprint
        // instead of a CA chain; there is no mode that skips the check.
        rejectUnauthorized: verification.mode === "ca",
        checkServerIdentity:
          verification.mode === "ca" ? undefined : () => undefined,
      });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          new WinrmError(
            "timeout",
            `TLS handshake with ${this.target} timed out.`,
          ),
        );
      }, this.options.connectTimeoutMs);
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(describeSocketError(error, this.target));
      });
      socket.once("secureConnect", () => {
        clearTimeout(timer);
        const peer = socket.getPeerCertificate();
        const raw = peer?.raw;
        if (!raw) {
          socket.destroy();
          reject(new WinrmError("tls", `${this.target} sent no certificate.`));
          return;
        }
        if (verification.mode === "fingerprint") {
          const actual = Buffer.from(
            createHash("sha256").update(raw).digest("hex").toUpperCase(),
          );
          const expected = Buffer.from(
            normalizeFingerprint(verification.sha256),
          );
          if (
            expected.length !== actual.length ||
            !timingSafeEqual(actual, expected)
          ) {
            socket.destroy();
            reject(
              new WinrmError(
                "tls",
                `The certificate of ${this.target} does not match the pinned SHA-256 fingerprint.`,
                `Server fingerprint: ${actual.toString()}`,
              ),
            );
            return;
          }
        }
        resolve({ socket, channelBindings: tlsServerEndPoint(raw) });
      });
    });
  }
}
