import type { ReactNode } from "react";
import { Globe, KeyRound, ShieldCheck } from "lucide-react";
import {
  HOST_PROTOCOL_SECRET_KEPT,
  useTranslation,
  type HostEditorSectionProps,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  Input,
  PasswordInput,
  SectionCard,
  Select2,
  Textarea,
} from "@termix-ssh/plugin-sdk/ui";
import {
  type LoginPart,
  type TlsMode,
  type Transport,
  type WinrmOptions,
  PLUGIN_ID,
  loginOf,
  optionsOf,
  patchLogin,
  patchOption,
} from "./host-form";

const LABEL =
  "text-[10px] font-bold uppercase tracking-widest text-muted-foreground";
const SELECT =
  "flex h-9 w-full border border-border bg-background px-3 py-1 text-xs outline-none focus:ring-1 focus:ring-ring";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className={LABEL}>{label}</label>
      {children}
      {hint ? (
        <p className="text-[10px] text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

interface CredentialOption {
  id: string | number;
  name: string;
  username?: string | null;
}

/** The host editor's WinRM tab: connection, certificate checks and the login. */
export function WinrmHostEditorSection({
  form,
  updateForm,
  credentials,
}: HostEditorSectionProps) {
  const { t } = useTranslation();
  const values = (form ?? {}) as Record<string, unknown>;
  const options = optionsOf(
    (
      values.pluginSettings as
        Record<string, Record<string, unknown>> | undefined
    )?.[PLUGIN_ID],
  );
  const login = loginOf(values);
  const savedCredentials = (credentials ?? []) as CredentialOption[];

  const setOption = <K extends keyof WinrmOptions>(
    key: K,
    value: WinrmOptions[K],
  ) => updateForm((current) => patchOption(current, key, value));
  const setLogin = (part: LoginPart, value: string) =>
    updateForm((current) => patchLogin(current, part, value));
  const passwordKept = login.password === HOST_PROTOCOL_SECRET_KEPT;
  const authModes =
    savedCredentials.length > 0
      ? (["direct", "credential"] as const)
      : (["direct"] as const);

  return (
    <>
      <SectionCard
        title={t("editor.connection")}
        icon={<Globe className="size-3.5" />}
      >
        <div className="grid grid-cols-1 gap-4 py-3 md:grid-cols-3">
          <Field label={t("editor.transport")}>
            <Select2
              className={SELECT}
              value={options.winrmTransport}
              onChange={(e) =>
                setOption("winrmTransport", e.target.value as Transport)
              }
            >
              <option value="http">{t("editor.transportHttp")}</option>
              <option value="https">{t("editor.transportHttps")}</option>
            </Select2>
          </Field>
          <Field label={t("editor.port")}>
            <Input
              type="number"
              min={1}
              max={65535}
              value={options.winrmPort}
              onChange={(e) =>
                setOption("winrmPort", Number(e.target.value) || 0)
              }
            />
          </Field>
          <Field label={t("editor.connectTimeout")}>
            <Input
              type="number"
              min={3}
              max={120}
              value={options.winrmConnectTimeout}
              onChange={(e) =>
                setOption("winrmConnectTimeout", Number(e.target.value) || 15)
              }
            />
          </Field>
        </div>
        <p className="pb-3 text-[10px] text-muted-foreground">
          {options.winrmTransport === "http"
            ? t("editor.httpNote")
            : t("editor.httpsNote")}
        </p>
      </SectionCard>

      {options.winrmTransport === "https" ? (
        <SectionCard
          title={t("editor.certificate")}
          icon={<ShieldCheck className="size-3.5" />}
        >
          <div className="flex flex-col gap-4 py-3">
            <Field label={t("editor.tlsMode")}>
              <Select2
                className={SELECT}
                value={options.winrmTlsMode}
                onChange={(e) =>
                  setOption("winrmTlsMode", e.target.value as TlsMode)
                }
              >
                <option value="ca">{t("editor.tlsModeCa")}</option>
                <option value="fingerprint">
                  {t("editor.tlsModeFingerprint")}
                </option>
              </Select2>
            </Field>
            {options.winrmTlsMode === "ca" ? (
              <Field label={t("editor.caCert")} hint={t("editor.caCertHint")}>
                <Textarea
                  rows={4}
                  className="font-mono text-[11px]"
                  placeholder="-----BEGIN CERTIFICATE-----"
                  value={options.winrmCaCert}
                  onChange={(e) => setOption("winrmCaCert", e.target.value)}
                />
              </Field>
            ) : (
              <Field
                label={t("editor.fingerprint")}
                hint={t("editor.fingerprintHint")}
              >
                <Input
                  className="font-mono text-[11px]"
                  placeholder="AB:CD:…"
                  value={options.winrmFingerprint}
                  onChange={(e) =>
                    setOption("winrmFingerprint", e.target.value)
                  }
                />
              </Field>
            )}
          </div>
        </SectionCard>
      ) : null}

      <SectionCard
        title={t("editor.login")}
        icon={<KeyRound className="size-3.5" />}
      >
        <div className="flex flex-col gap-4 py-3">
          {authModes.length > 1 ? (
            <div className="flex gap-2">
              {authModes.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setLogin("authType", mode)}
                  className={`border px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest transition-colors ${
                    login.authType === mode
                      ? "border-accent-brand/40 bg-accent-brand/10 text-accent-brand"
                      : "border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t(
                    mode === "direct"
                      ? "editor.authDirect"
                      : "editor.authCredential",
                  )}
                </button>
              ))}
            </div>
          ) : null}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {login.authType === "credential" && savedCredentials.length > 0 ? (
              <div className="col-span-full">
                <Field label={t("editor.credential")}>
                  <Select2
                    className={SELECT}
                    value={String(login.credentialId ?? "")}
                    onChange={(e) => setLogin("credentialId", e.target.value)}
                  >
                    <option value="">{t("editor.selectCredential")}</option>
                    {savedCredentials.map((c) => (
                      <option key={c.id} value={String(c.id)}>
                        {c.username ? `${c.name} (${c.username})` : c.name}
                      </option>
                    ))}
                  </Select2>
                </Field>
              </div>
            ) : (
              <>
                <Field
                  label={t("editor.username")}
                  hint={t("editor.usernameHint")}
                >
                  <Input
                    placeholder="Administrator"
                    autoComplete="off"
                    value={login.username}
                    onChange={(e) => setLogin("username", e.target.value)}
                  />
                </Field>
                <Field label={t("editor.password")}>
                  <PasswordInput
                    className="h-8 pr-8 text-xs"
                    autoComplete="new-password"
                    placeholder={
                      passwordKept ? t("editor.passwordSaved") : "••••••••"
                    }
                    value={passwordKept ? "" : login.password}
                    // Focusing alone keeps the saved password; only typing replaces it.
                    onChange={(e) => setLogin("password", e.target.value)}
                  />
                </Field>
              </>
            )}
            <Field label={t("editor.domain")} hint={t("editor.domainHint")}>
              <Input
                placeholder="CONTOSO"
                value={login.fields.domain ?? ""}
                onChange={(e) => setLogin("domain", e.target.value)}
              />
            </Field>
          </div>
        </div>
      </SectionCard>
    </>
  );
}
