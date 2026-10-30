/**
 * Every failure the user can see ends up as one of these kinds, with a message
 * that never contains a password, a token or a message body.
 */
export type WinrmErrorKind =
  | "auth"
  | "tls"
  | "timeout"
  | "connect"
  | "closed"
  | "http"
  | "protocol"
  | "shell-gone"
  | "remote";

export class WinrmError extends Error {
  constructor(
    readonly kind: WinrmErrorKind,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "WinrmError";
  }
}

/** Maps Node socket errors to messages a Windows admin can act on. */
export function describeSocketError(
  error: unknown,
  target: string,
): WinrmError {
  if (error instanceof WinrmError) return error;
  const code = (error as { code?: string })?.code ?? "";
  const message = error instanceof Error ? error.message : String(error);
  switch (code) {
    case "ECONNREFUSED":
      return new WinrmError(
        "connect",
        `${target} refused the connection. Is WinRM listening on this port (winrm quickconfig, firewall rule)?`,
      );
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return new WinrmError(
        "connect",
        `The name of ${target} could not be resolved.`,
      );
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return new WinrmError(
        "connect",
        `${target} is not reachable from the Termix server.`,
      );
    case "ETIMEDOUT":
      return new WinrmError("timeout", `${target} did not answer in time.`);
    case "ECONNRESET":
    case "EPIPE":
      return new WinrmError("closed", `${target} closed the connection.`);
    default:
      if (
        /certificate|self[- ]signed|unable to verify|altnames|CERT_/i.test(
          message + code,
        )
      ) {
        return new WinrmError(
          "tls",
          `The HTTPS certificate of ${target} was not accepted: ${message}`,
        );
      }
      return new WinrmError(
        "connect",
        `Could not connect to ${target}: ${message}`,
      );
  }
}
