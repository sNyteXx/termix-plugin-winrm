import type {
  HostProtocolAuthForm,
  PluginHostRecord,
  TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";

/* Host editor form helpers and the few things the tab needs from a host record. */

export const PLUGIN_ID = "winrm";
export const PROTOCOL_ID = "winrm";
const QUICK_CONNECT_PREFIX = "quick-connect-";

export type Transport = "http" | "https";
export type TlsMode = "ca" | "fingerprint";

export interface WinrmOptions {
  enableWinrm: boolean;
  winrmPort: number;
  winrmTransport: Transport;
  winrmTlsMode: TlsMode;
  winrmCaCert: string;
  winrmFingerprint: string;
  winrmConnectTimeout: number;
}

export const DEFAULT_OPTIONS: WinrmOptions = {
  enableWinrm: false,
  winrmPort: 5985,
  winrmTransport: "http",
  winrmTlsMode: "ca",
  winrmCaCert: "",
  winrmFingerprint: "",
  winrmConnectTimeout: 15,
};

type SettingsBag = Record<string, Record<string, unknown>>;

export function optionsOf(
  bag: Record<string, unknown> | undefined,
): WinrmOptions {
  const raw = bag ?? {};
  return {
    enableWinrm: raw.enableWinrm === true,
    winrmPort:
      typeof raw.winrmPort === "number"
        ? raw.winrmPort
        : DEFAULT_OPTIONS.winrmPort,
    winrmTransport: raw.winrmTransport === "https" ? "https" : "http",
    winrmTlsMode: raw.winrmTlsMode === "fingerprint" ? "fingerprint" : "ca",
    winrmCaCert: typeof raw.winrmCaCert === "string" ? raw.winrmCaCert : "",
    winrmFingerprint:
      typeof raw.winrmFingerprint === "string" ? raw.winrmFingerprint : "",
    winrmConnectTimeout:
      typeof raw.winrmConnectTimeout === "number"
        ? raw.winrmConnectTimeout
        : DEFAULT_OPTIONS.winrmConnectTimeout,
  };
}

export function hostOptions(
  host: { pluginSettings?: SettingsBag } | null | undefined,
): WinrmOptions {
  return optionsOf(host?.pluginSettings?.[PLUGIN_ID]);
}

export function winrmEnabled(
  host: PluginHostRecord | null | undefined,
): boolean {
  return hostOptions(host as { pluginSettings?: SettingsBag }).enableWinrm;
}

export function isQuickConnectHost(
  host: { id?: unknown } | null | undefined,
): boolean {
  return String(host?.id ?? "").startsWith(QUICK_CONNECT_PREFIX);
}

/** The form patch that sets one of this plugin's host settings. */
export function patchOption<K extends keyof WinrmOptions>(
  form: Record<string, unknown>,
  key: K,
  value: WinrmOptions[K],
): Record<string, unknown> {
  const bag = (form.pluginSettings as SettingsBag | undefined) ?? {};
  const mine = bag[PLUGIN_ID] ?? {};
  const next: Record<string, unknown> = { ...mine, [key]: value };
  // Switching the transport moves a default port along with it.
  if (key === "winrmTransport") {
    const port = mine.winrmPort;
    if (value === "https" && (port === undefined || port === 5985))
      next.winrmPort = 5986;
    if (value === "http" && (port === undefined || port === 5986))
      next.winrmPort = 5985;
  }
  return { pluginSettings: { ...bag, [PLUGIN_ID]: next } };
}

const EMPTY_LOGIN: HostProtocolAuthForm = {
  authType: "direct",
  credentialId: "",
  username: "",
  password: "",
  fields: {},
};

export function loginOf(form: Record<string, unknown>): HostProtocolAuthForm {
  const login = (
    form.protocolAuth as Record<string, HostProtocolAuthForm> | undefined
  )?.[PROTOCOL_ID];
  return login
    ? { ...EMPTY_LOGIN, ...login, fields: { ...login.fields } }
    : EMPTY_LOGIN;
}

export type LoginPart =
  "authType" | "credentialId" | "username" | "password" | "domain";

export function patchLogin(
  form: Record<string, unknown>,
  part: LoginPart,
  value: string,
): Record<string, unknown> {
  const bag =
    (form.protocolAuth as Record<string, HostProtocolAuthForm> | undefined) ??
    {};
  const login = loginOf(form);
  const next: HostProtocolAuthForm =
    part === "domain"
      ? { ...login, fields: { ...login.fields, domain: value } }
      : ({ ...login, [part]: value } as HostProtocolAuthForm);
  return { protocolAuth: { ...bag, [PROTOCOL_ID]: next } };
}

/** What a quick-connect tab sends to open its session. */
export interface QuickConnectRequest {
  address: string;
  port: number;
  https: boolean;
  username: string;
  password: string;
  domain: string;
}

export function quickConnectRequest(
  host: PluginHostRecord,
): QuickConnectRequest | null {
  const login =
    host.quickConnectLogin?.protocol === PROTOCOL_ID
      ? host.quickConnectLogin
      : undefined;
  if (!login) return null;
  const options = hostOptions(host as { pluginSettings?: SettingsBag });
  const port = options.winrmPort;
  return {
    address: host.ip,
    port,
    // Quick Connect has no transport field: 5986 is WinRM's HTTPS port.
    https: options.winrmTransport === "https" || port === 5986,
    username: login.username ?? "",
    password: login.password ?? "",
    domain: login.fields?.domain ?? "",
  };
}

/** The live app object, for components defined outside activate(). */
let currentApp: TermixApp | null = null;

export function setApp(app: TermixApp | null): void {
  currentApp = app;
}

export function getApp(): TermixApp | null {
  return currentApp;
}
