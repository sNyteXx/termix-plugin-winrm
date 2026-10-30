import { isIP } from "node:net";
import { normalizeFingerprint, type TlsVerification } from "./winrm/channel.js";
import { splitLogin, type NtlmCredentials } from "./winrm/ntlm.js";

/* Turns host settings and a resolved login into a validated connection target. */

export const PROTOCOL_ID = "winrm";

export const HOST_KEYS = {
  enable: "enableWinrm",
  port: "winrmPort",
  transport: "winrmTransport",
  tlsMode: "winrmTlsMode",
  caCert: "winrmCaCert",
  fingerprint: "winrmFingerprint",
  connectTimeout: "winrmConnectTimeout",
} as const;

export interface WinrmHostSettings {
  enabled: boolean;
  port: number;
  transport: "http" | "https";
  tlsMode: "ca" | "fingerprint";
  caCert: string;
  fingerprint: string;
  connectTimeoutSec: number;
}

export interface WinrmTarget {
  /** Null for a quick connect. */
  hostId: number | null;
  label: string;
  address: string;
  port: number;
  https: boolean;
  tls: TlsVerification;
  connectTimeoutMs: number;
  credentials: NtlmCredentials;
  jumpHosts: Array<{ hostId: number }>;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** A DNS name or an IP address, nothing that could smuggle text into a request. */
export function validAddress(address: string): boolean {
  if (!address || address.length > 253) return false;
  if (isIP(address)) return true;
  return /^(?=.{1,253}$)([A-Za-z0-9_]([A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?)(\.[A-Za-z0-9_]([A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?)*\.?$/.test(
    address,
  );
}

function num(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function readHostSettings(
  raw: Record<string, unknown>,
): WinrmHostSettings {
  const transport = raw[HOST_KEYS.transport] === "https" ? "https" : "http";
  return {
    enabled: raw[HOST_KEYS.enable] === true,
    port: num(
      raw[HOST_KEYS.port],
      transport === "https" ? 5986 : 5985,
      1,
      65535,
    ),
    transport,
    tlsMode: raw[HOST_KEYS.tlsMode] === "fingerprint" ? "fingerprint" : "ca",
    caCert:
      typeof raw[HOST_KEYS.caCert] === "string"
        ? (raw[HOST_KEYS.caCert] as string).trim()
        : "",
    fingerprint:
      typeof raw[HOST_KEYS.fingerprint] === "string"
        ? (raw[HOST_KEYS.fingerprint] as string)
        : "",
    connectTimeoutSec: num(raw[HOST_KEYS.connectTimeout], 15, 3, 120),
  };
}

export function tlsVerification(settings: WinrmHostSettings): TlsVerification {
  if (settings.tlsMode === "fingerprint") {
    const sha256 = normalizeFingerprint(settings.fingerprint);
    if (sha256.length !== 64) {
      throw new ConfigError(
        "The pinned certificate fingerprint must be a SHA-256 hash (64 hex digits).",
      );
    }
    return { mode: "fingerprint", sha256 };
  }
  if (
    settings.caCert &&
    !settings.caCert.includes("-----BEGIN CERTIFICATE-----")
  ) {
    throw new ConfigError("The CA certificate must be in PEM format.");
  }
  return { mode: "ca", ca: settings.caCert || undefined };
}

export interface LoginInput {
  username: string;
  password: string;
  domain: string;
}

export function credentialsFrom(login: LoginInput): NtlmCredentials {
  const username = login.username.trim();
  if (!username)
    throw new ConfigError("No user name is set for WinRM on this host.");
  if (!login.password)
    throw new ConfigError("No password is set for WinRM on this host.");
  if (
    username.length > 256 ||
    login.domain.length > 256 ||
    login.password.length > 1024
  ) {
    throw new ConfigError("The login is too long.");
  }
  const split = splitLogin(username, login.domain);
  return {
    username: split.username,
    domain: split.domain,
    password: login.password,
  };
}

export function buildTarget(input: {
  hostId: number | null;
  label: string;
  address: string;
  settings: WinrmHostSettings;
  login: LoginInput;
  jumpHosts: Array<{ hostId: number }>;
}): WinrmTarget {
  const address = input.address.trim();
  if (!validAddress(address))
    throw new ConfigError(
      "The host address is not a valid name or IP address.",
    );
  const https = input.settings.transport === "https";
  return {
    hostId: input.hostId,
    label: input.label || address,
    address,
    port: input.settings.port,
    https,
    tls: https ? tlsVerification(input.settings) : { mode: "ca" },
    connectTimeoutMs: input.settings.connectTimeoutSec * 1000,
    credentials: credentialsFrom(input.login),
    jumpHosts: input.jumpHosts.filter(
      (hop) => Number.isInteger(hop.hostId) && hop.hostId > 0,
    ),
  };
}
