import { describe, expect, it } from "vitest";
import { renderWithApp } from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";
import * as plugin from "../../src/frontend/index.js";
import {
  isQuickConnectHost,
  loginOf,
  patchLogin,
  patchOption,
  quickConnectRequest,
  winrmEnabled,
} from "../../src/frontend/host-form.js";

describe("frontend registration", () => {
  it("registers the tab and survives disable then enable", async () => {
    const manifest = manifestJson as unknown as PluginManifest;
    const first = await renderWithApp(plugin, { manifest, locales });
    expect(first.registered.tabs()).toEqual(["winrm"]);
    await first.deactivate();
    const second = await renderWithApp(plugin, { manifest, locales });
    expect(second.registered.tabs()).toEqual(["winrm"]);
    await second.deactivate();
  });
});

describe("host form helpers", () => {
  it("only offers WinRM on hosts that turned it on", () => {
    expect(
      winrmEnabled({
        id: "1",
        name: "a",
        ip: "x",
        port: 22,
        pluginSettings: { winrm: { enableWinrm: true } },
      } as never),
    ).toBe(true);
    expect(
      winrmEnabled({ id: "1", name: "a", ip: "x", port: 22 } as never),
    ).toBe(false);
  });

  it("moves the default port with the transport", () => {
    const https = patchOption({}, "winrmTransport", "https") as {
      pluginSettings: { winrm: Record<string, unknown> };
    };
    expect(https.pluginSettings.winrm.winrmPort).toBe(5986);
    const custom = patchOption(
      { pluginSettings: { winrm: { winrmPort: 15985 } } },
      "winrmTransport",
      "https",
    ) as {
      pluginSettings: { winrm: Record<string, unknown> };
    };
    expect(custom.pluginSettings.winrm.winrmPort).toBe(15985);
  });

  it("keeps other plugins' settings untouched", () => {
    const patched = patchOption(
      { pluginSettings: { "remote-desktop": { enableRdp: true } } },
      "enableWinrm",
      true,
    ) as {
      pluginSettings: Record<string, Record<string, unknown>>;
    };
    expect(patched.pluginSettings["remote-desktop"]).toEqual({
      enableRdp: true,
    });
  });

  it("edits the protocol login under protocolAuth.winrm", () => {
    let form: Record<string, unknown> = {
      protocolAuth: { rdp: { authType: "direct", username: "x" } },
    };
    form = {
      ...form,
      ...patchLogin(form, "username", "CONTOSO\\Administrator"),
    };
    form = { ...form, ...patchLogin(form, "domain", "CONTOSO") };
    expect(loginOf(form)).toMatchObject({
      username: "CONTOSO\\Administrator",
      fields: { domain: "CONTOSO" },
    });
    expect((form.protocolAuth as Record<string, unknown>).rdp).toEqual({
      authType: "direct",
      username: "x",
    });
  });

  it("builds a quick connect request and picks HTTPS on 5986", () => {
    const host = {
      id: "quick-connect-1",
      name: "",
      ip: "192.0.2.10",
      port: 22,
      pluginSettings: { winrm: { enableWinrm: true, winrmPort: 5986 } },
      quickConnectLogin: {
        protocol: "winrm",
        username: "Admin",
        password: "pw",
        fields: { domain: "WIN11" },
      },
    };
    expect(isQuickConnectHost(host)).toBe(true);
    expect(quickConnectRequest(host as never)).toEqual({
      address: "192.0.2.10",
      port: 5986,
      https: true,
      username: "Admin",
      password: "pw",
      domain: "WIN11",
    });
  });
});
