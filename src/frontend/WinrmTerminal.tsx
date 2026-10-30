import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import {
  invokeAction,
  useTheme,
  useTranslation,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  ConnectionScreen,
  type ConnectionStatus,
} from "@termix-ssh/plugin-sdk/ui";
import { type EditorEffect, LineEditor } from "./line-editor";
import { type QuickConnectRequest, getApp } from "./host-form";

export interface WinrmTerminalHandle {
  disconnect(): void;
  refresh(): void;
}

interface Props {
  /** A saved host: the backend looks up address and login itself. */
  hostId?: number;
  /** A quick connect: the login the user typed, sent once when opening. */
  quick?: QuickConnectRequest | null;
  label: string;
  isVisible: boolean;
  inSplit?: boolean;
}

interface TerminalLook {
  colors: Record<string, string | undefined>;
  fontFamily: string;
  fontSize: number;
}

const FALLBACK_COLORS = {
  background: "#0c0d0b",
  foreground: "#fafafa",
  cursor: "#fafafa",
  cursorAccent: "#0c0d0b",
};
const FALLBACK_FONT =
  '"Cascadia Mono", Consolas, "SF Mono", "Liberation Mono", monospace';

type ServerMessage =
  | {
      type: "status";
      state: "connecting" | "connected";
      computer?: string;
      psVersion?: string | null;
    }
  | { type: "output"; data: string }
  | { type: "prompt"; text: string }
  | { type: "incomplete" }
  | { type: "clear" }
  | { type: "error"; message: string; kind: string; fatal: boolean };

export const WinrmTerminal = forwardRef<WinrmTerminalHandle, Props>(
  function WinrmTerminal({ hostId, quick, label, isVisible, inSplit }, ref) {
    const { t } = useTranslation();
    const { theme: appTheme } = useTheme();
    const containerRef = useRef<HTMLDivElement | null>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const fitRef = useRef<FitAddon | null>(null);
    const socketRef = useRef<WebSocket | null>(null);
    const editorRef = useRef(new LineEditor());
    const [status, setStatus] = useState<ConnectionStatus>("connecting");
    const [failure, setFailure] = useState<string | null>(null);
    const [generation, setGeneration] = useState(0);
    const quickRef = useRef(quick);
    quickRef.current = quick;
    const labelRef = useRef(label);
    labelRef.current = label;
    const tRef = useRef(t);
    tRef.current = t;

    const apply = useCallback((effects: EditorEffect[]) => {
      const terminal = terminalRef.current;
      for (const effect of effects) {
        switch (effect.type) {
          case "write":
            terminal?.write(effect.data);
            break;
          case "submit":
            send({ type: "submit", text: effect.text, force: effect.force });
            break;
          case "interrupt":
            send({ type: "stop" });
            break;
          case "clear":
            terminal?.clear();
            terminal?.write("\x1b[2J\x1b[H");
            break;
          case "copy":
            break;
        }
      }
    }, []);

    function send(message: Record<string, unknown>) {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify(message));
    }

    // The terminal itself, once.
    useEffect(() => {
      if (!containerRef.current) return;
      const terminal = new Terminal({
        cursorBlink: true,
        scrollback: 10_000,
        convertEol: false,
        fontFamily: FALLBACK_FONT,
        fontSize: 14,
        theme: { ...FALLBACK_COLORS },
        allowProposedApi: false,
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(containerRef.current);
      terminalRef.current = terminal;
      fitRef.current = fit;
      try {
        fit.fit();
      } catch {
        // Not laid out yet.
      }
      editorRef.current.cols = terminal.cols;

      // Ctrl+C copies when text is selected; Ctrl+V and Ctrl+Shift+V paste.
      terminal.attachCustomKeyEventHandler((event) => {
        if (event.type !== "keydown") return true;
        const key = event.key.toLowerCase();
        if (
          (event.ctrlKey || event.metaKey) &&
          key === "c" &&
          (event.shiftKey || terminal.hasSelection())
        ) {
          const selection = terminal.getSelection();
          if (selection)
            void navigator.clipboard
              ?.writeText(selection)
              .catch(() => undefined);
          terminal.clearSelection();
          return false;
        }
        if ((event.ctrlKey || event.metaKey) && key === "v") return false; // Browser paste event follows.
        return true;
      });

      const data = terminal.onData((input) =>
        apply(editorRef.current.handle(input)),
      );
      const resize = terminal.onResize(({ cols }) => {
        apply(editorRef.current.resize(cols));
        send({ type: "resize", cols });
      });
      const observer = new ResizeObserver(() => {
        try {
          fit.fit();
        } catch {
          // Hidden.
        }
      });
      observer.observe(containerRef.current);

      return () => {
        observer.disconnect();
        data.dispose();
        resize.dispose();
        terminal.dispose();
        terminalRef.current = null;
      };
    }, [apply]);

    // The user's terminal look, from the SSH terminal plugin when it runs.
    useEffect(() => {
      let active = true;
      void invokeAction("terminal.resolveTheme", { appTheme })
        .then((look) => {
          const resolved = look as TerminalLook | undefined;
          const terminal = terminalRef.current;
          if (!active || !resolved || !terminal) return;
          terminal.options.theme = { ...resolved.colors };
          terminal.options.fontFamily = resolved.fontFamily;
          terminal.options.fontSize = resolved.fontSize;
          fitRef.current?.fit();
        })
        .catch(() => undefined);
      return () => {
        active = false;
      };
    }, [appTheme]);

    // The session: one socket per connect attempt.
    useEffect(() => {
      let disposed = false;
      let own: WebSocket | null = null;
      const t = tRef.current;
      const editor = editorRef.current;
      editor.mode = "connecting";
      setStatus("connecting");
      setFailure(null);

      void (async () => {
        const target = await getApp()?.wsUrl("/terminal");
        if (disposed) return;
        if (!target) {
          setFailure(t("terminal.noServer"));
          setStatus("error");
          return;
        }
        const socket = new WebSocket(target.url, target.protocols);
        own = socket;
        socketRef.current = socket;
        let connected = false;

        socket.onopen = () => {
          const cols = terminalRef.current?.cols ?? 120;
          socket.send(
            JSON.stringify(
              quickRef.current
                ? { type: "open", quick: quickRef.current, cols }
                : { type: "open", hostId, cols },
            ),
          );
        };
        socket.onmessage = (event) => {
          // A socket from an earlier attempt must not touch this terminal.
          if (disposed) return;
          let message: ServerMessage;
          try {
            message = JSON.parse(String(event.data)) as ServerMessage;
          } catch {
            return;
          }
          const terminal = terminalRef.current;
          switch (message.type) {
            case "status":
              if (message.state === "connected") {
                connected = true;
                setStatus("connected");
                terminal?.write(
                  `\x1b[90m${t("terminal.connected", {
                    computer: message.computer || labelRef.current,
                    version: message.psVersion ?? "?",
                  })}\x1b[0m\r\n`,
                );
                terminal?.focus();
              }
              break;
            case "output":
              editor.markRunning();
              terminal?.write(message.data);
              break;
            case "prompt":
              apply(editor.showPrompt(message.text));
              break;
            case "incomplete":
              apply(editor.showContinuation());
              break;
            case "clear":
              terminal?.clear();
              terminal?.write("\x1b[2J\x1b[H");
              break;
            case "error":
              if (message.fatal) {
                editor.mode = "closed";
                setFailure(message.message);
                if (connected) {
                  terminal?.write(`\r\n\x1b[91m${message.message}\x1b[0m\r\n`);
                  setStatus("disconnected");
                } else setStatus("error");
              } else {
                terminal?.write(`\x1b[91m${message.message}\x1b[0m\r\n`);
              }
              break;
          }
        };
        socket.onclose = () => {
          if (disposed) return;
          editor.mode = "closed";
          setStatus((current) =>
            current === "error"
              ? current
              : connected
                ? "disconnected"
                : "error",
          );
        };
      })();

      return () => {
        disposed = true;
        const socket = own;
        if (socketRef.current === socket) socketRef.current = null;
        if (socket) {
          socket.onclose = null;
          socket.onmessage = null;
          socket.onopen = null;
          if (socket.readyState === WebSocket.OPEN)
            socket.send(JSON.stringify({ type: "close" }));
          socket.close();
        }
      };
    }, [hostId, generation, apply]);

    // Fit and focus when the tab comes to the front.
    useEffect(() => {
      if (!isVisible) return;
      try {
        fitRef.current?.fit();
      } catch {
        // Hidden.
      }
      if (!inSplit) terminalRef.current?.focus();
    }, [isVisible, inSplit]);

    useImperativeHandle(ref, () => ({
      disconnect: () => {
        send({ type: "close" });
        socketRef.current?.close();
      },
      refresh: () => {
        terminalRef.current?.reset();
        editorRef.current = new LineEditor();
        editorRef.current.cols = terminalRef.current?.cols ?? 80;
        setGeneration((g) => g + 1);
      },
    }));

    const retry = () => {
      terminalRef.current?.reset();
      editorRef.current = new LineEditor();
      editorRef.current.cols = terminalRef.current?.cols ?? 80;
      setGeneration((g) => g + 1);
    };

    return (
      <div className="relative flex h-full w-full flex-col">
        <div
          ref={containerRef}
          className="h-full w-full flex-1 overflow-hidden p-1"
        />
        {status !== "connected" ? (
          <div className="absolute inset-0">
            <ConnectionScreen
              status={status}
              message={t("terminal.connecting")}
              detail={label}
              errorDetail={failure}
              disconnectedMessage={t("terminal.disconnected")}
              onManualRetry={retry}
            />
          </div>
        ) : null}
      </div>
    );
  },
);
