import "@xterm/xterm/css/xterm.css";
import type { Ref } from "react";
import { SquareTerminal } from "lucide-react";
import type { TabProps, TermixApp } from "@termix-ssh/plugin-sdk/frontend";
import { WinrmHostEditorSection } from "./HostEditorSection";
import { WinrmTerminal, type WinrmTerminalHandle } from "./WinrmTerminal";
import {
  PROTOCOL_ID,
  isQuickConnectHost,
  quickConnectRequest,
  setApp,
  winrmEnabled,
} from "./host-form";

function WinrmTab({ host, label, isVisible, inSplit, handleRef }: TabProps) {
  const quick =
    host && isQuickConnectHost(host) ? quickConnectRequest(host) : null;
  const hostId = host && !quick ? Number(host.id) : undefined;
  return (
    <WinrmTerminal
      ref={handleRef as Ref<WinrmTerminalHandle>}
      hostId={Number.isInteger(hostId) ? hostId : undefined}
      quick={quick}
      label={host?.name || host?.ip || label}
      isVisible={isVisible}
      inSplit={inSplit}
    />
  );
}

export function activate(app: TermixApp): void {
  setApp(app);
  app.onDispose(() => setApp(null));

  app.registerHostProtocol({
    id: PROTOCOL_ID,
    settingKey: "enableWinrm",
    portKey: "winrmPort",
    defaultPort: 5985,
    titleKey: "protocol.title",
    descriptionKey: "protocol.description",
    icon: SquareTerminal,
    order: 130,
    quickConnect: { showDomain: true },
  });

  app.registerTab("winrm", WinrmTab, {
    icon: SquareTerminal,
    titleKey: "tab.title",
    requiresHost: true,
    session: true,
    multiInstance: true,
  });

  app.registerHostAction({
    id: "winrm",
    titleKey: "tab.title",
    icon: SquareTerminal,
    kind: "connect",
    priority: 45,
    order: 130,
    tabType: "winrm",
    when: winrmEnabled,
  });

  app.registerPaletteEntry({
    id: "winrm.connect",
    titleKey: "palette.connect",
    icon: SquareTerminal,
    keywords: ["winrm", "powershell", "windows"],
    scope: "host",
    when: (host) => !!host && winrmEnabled(host),
    run: (shell, host) => {
      if (host) shell.openTab(host, "winrm");
    },
  });

  app.registerHostEditorSection({
    id: "winrm",
    group: "top",
    titleKey: "protocol.title",
    icon: SquareTerminal,
    order: 26,
    visible: (protocols) => !!protocols.enableWinrm,
    component: WinrmHostEditorSection,
  });
}
