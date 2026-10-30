---
title: Architecture and decisions
order: 3
---

# Architecture and decisions

This page is the technical report behind the plugin: what Termix offers, which WinRM options exist for
Node.js, what was chosen and why, and what is knowingly left out.

## 1. Termix as found (October 2026)

- Termix 26.10.6 is current; the target instance runs **26.10.2** with plugin SDK **1.0.11 / Plugin API 1.3**.
  The plugin declares `"termix": ">=26.10.2", "api": "^1.3"` and is type checked against both SDK 1.0.11
  and 1.0.22, and its manifest passes both validators.
- Everything in Termix, the SSH terminal included, is a plugin. A plugin has a backend (`activate(ctx)` in
  the Termix server process) and a frontend (`activate(app)` in the browser).
- What a connection protocol gets from the SDK, all present in API 1.3:

| SDK piece                                | Used for                                                                                     |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| `contributes.protocols`                  | Declares `winrm` with a `domain` credential field and SSH login fallback                     |
| `app.registerHostProtocol`               | WinRM switch and port in the host editor, host list filter, Quick Connect entry              |
| `app.registerHostEditorSection`          | The WinRM tab: transport, certificate check, login                                           |
| `app.registerTab` / `registerHostAction` | The PowerShell tab, opened from the host list, context menu and palette; tabs and split view |
| `ctx.credentials.resolveHostProtocol`    | The host's WinRM login, decrypted on the server for the acting user (sharing respected)      |
| `ctx.ssh.jumpChain` + `forwardOut`       | Reaching hosts behind jump hosts through Termix's own SSH pipeline                           |
| `ctx.ws.route`                           | The terminal socket, authenticated by core, run as the signed-in user                        |
| `ctx.rbac`, `ctx.settings`, `ctx.audit`  | Permission `winrm.sessions`, limits and host settings, audit lines for session opens         |
| `invokeAction("terminal.resolveTheme")`  | The SSH terminal's colours and font, when that plugin runs                                   |

### What the SDK does not offer

- **No generic terminal component.** `terminal.view` from the SSH terminal plugin is bound to an SSH
  socket. A non-SSH terminal (Serial, Docker, and this plugin) brings its own xterm.js and only borrows
  the theme. So the SSH terminal's history panel, macros and "send to all terminals" do not reach a WinRM
  tab. _Minimal upstream proposal:_ let `terminal.view` take a transport object
  (`{ write(data), onData(cb), onResize(cb) }`) and expose `terminal.sendToSession` for registered
  third-party sessions. That would give every protocol plugin the full terminal feature set without core
  changes.
- No Kerberos support in core; authentication beyond what a plugin implements itself is not available.

No Termix core change and no change to the SSH plugin were needed.

## 2. WinRM, WS-Man and PSRP libraries for Node.js

| Option                            | Persistent session     | Encryption over HTTP 5985     | Verdict                                                                         |
| --------------------------------- | ---------------------- | ----------------------------- | ------------------------------------------------------------------------------- |
| `winrm-client` (npm)              | No (WinRS per command) | No (needs `AllowUnencrypted`) | Variables do not survive a command; would force weakening every server          |
| Other npm `winrm*` packages       | No                     | No                            | Unmaintained, WinRS only                                                        |
| pypsrp / psrpcore (Python)        | Yes (PSRP)             | Yes                           | Reference quality, but needs Python in the Termix container: a bridge           |
| PowerShell 7 on Linux (`pwsh`)    | Yes                    | Partly (gss-ntlmssp)          | Needs `pwsh` + extra packages in the container; a bridge, not a plugin          |
| Go/Rust tools                     | Varies                 | Varies                        | Native binaries per platform: a bridge                                          |
| **Own TypeScript implementation** | **Yes (PSRP)**         | **Yes (NTLM sealing)**        | **Chosen**: no runtime dependency, works in the stock Linux Termix Docker image |

The only runtime dependency is `@xmldom/xmldom` (MIT, actively maintained, 0.9.x with the 2025 security
fixes); `@xterm/xterm`, `@xterm/addon-fit` and `lucide-react` are bundled in the frontend.

## 3. How it is built

```
browser                         Termix server (plugin backend)                         Windows
xterm.js + line editor  ──ws──▶ terminal-socket ─▶ PowerShellSession ─▶ RunspacePool ─▶ WS-Man ─▶ WinRM
  (lines, Ctrl+C)               (limits, idle,       (prompt, Out-String,  (PSRP msgs,    (HTTP or HTTPS,
                                 permission, audit)    parse check)         fragments)     NTLM, sealing)
                                                                   ▲
                                                 jump host: ctx.ssh.jumpChain + forwardOut
```

| Layer            | Files                                  | What it does                                                                                                     |
| ---------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Crypto, NTLM     | `winrm/crypto.ts`, `winrm/ntlm.ts`     | MD4/RC4 (absent from OpenSSL 3's default provider), NTLMv2 with ESS, MIC, key exchange, sealing, channel binding |
| HTTP, encryption | `winrm/http.ts`, `winrm/encryption.ts` | One HTTP/1.1 connection per NTLM context, bounded responses; multipart/encrypted bodies                          |
| Channel          | `winrm/channel.ts`                     | Login, TLS with CA or pinned fingerprint, error classification, request queue                                    |
| WS-Man           | `winrm/wsman.ts`                       | Create, Command, Send, Receive, Signal, Delete; SOAP faults                                                      |
| PSRP             | `psrp/*.ts`                            | Fragments, messages, CLIXML reader/writer, runspace pool, record rendering                                       |
| Session          | `session/*.ts`                         | Console behaviour, WebSocket protocol, limits, idle timeout, keepalive                                           |
| Termix glue      | `index.ts`, `connect.ts`, `config.ts`  | Host resolution, jump hosts, settings, audit                                                                     |
| Frontend         | `src/frontend/*`                       | Protocol, host editor tab, terminal tab, local line editor                                                       |

### The interactive model

PSRP has no pseudo terminal. The plugin does what `Enter-PSSession` does:

- One runspace pool with one runspace per tab. Each submitted input runs as a script with
  `UseLocalScope = false`, so it runs in the session's scope: **variables, functions, the current folder
  and `$Error` persist**. `AddToHistory` is on and the history line is the user's own text, so
  `Get-History` shows what was typed.
- The pipeline is `<input> | Out-String -Stream -Width <terminal columns>`: PowerShell formats the
  objects itself, exactly as on the console, and lines stream back as they come.
- Errors, warnings, verbose, debug and information records arrive on their own streams and are printed
  like powershell.exe 5.1 does, in colour. `Write-Host` keeps its colours and `-NoNewline`.
- Multi-line input: the backend asks PowerShell's own parser whether the input is incomplete (input
  passed as a parameter, never spliced into code). Then the terminal shows `>>` and an empty line runs it.
- Ctrl+C sends PSRP's stop signal on a second connection while the first one waits in `Receive`.
- Editing, history and paste happen in the browser, the way `Enter-PSSession` edits locally.

What this model cannot do (by protocol, not by implementation): full-screen or interactive console
programs (`diskpart`, `netsh` interactively, editors), `Read-Host`, `Get-Credential` and `-Confirm`
prompts (no PSHost is offered, so they fail with a clear error instead of hanging), and progress bars
(dropped).

## 4. Authentication

| Method                         | Status        | Notes                                                                                |
| ------------------------------ | ------------- | ------------------------------------------------------------------------------------ |
| NTLMv2 (via `Negotiate`)       | Supported     | Local and domain accounts. `DOMAIN\user`, `user@domain` or user + domain field       |
| NTLM message encryption (HTTP) | Supported     | Always on over HTTP. An unencrypted answer is refused                                |
| HTTPS + NTLM                   | Supported     | Channel binding (`tls-server-end-point`), works with `CbtHardeningLevel = Strict`    |
| Kerberos                       | Not supported | See below                                                                            |
| Basic                          | Not offered   | Deliberately: plaintext password, needs `AllowUnencrypted` or HTTPS + local accounts |
| CredSSP                        | Not offered   | Delegates credentials to the server; not needed for a console                        |

### Kerberos under Linux/Docker

Kerberos needs a GSS-API implementation. In Node that means the native `kerberos` package (libkrb5 or
Heimdal at build and run time), a `krb5.conf`, DNS/KDC reachability from the container and, for
WinRM over HTTP, **GSS wrap with IOV buffers** for the `HTTP-Kerberos-session-encrypted` format, which
that package does not expose. A pure-JS Kerberos client would be a large security-critical project.

Realistic later option: **Kerberos over HTTPS only** (TLS encrypts, Kerberos only authenticates, plain
`gss_init_sec_context` suffices), as an optional feature that is enabled when the `kerberos` package and
krb5 libraries are present in a custom Termix image. It is not part of this version.

NTLM caveat: a domain may restrict NTLM ("Network security: Restrict NTLM"). Then only Kerberos works,
and this plugin cannot connect.

## 5. Security assessment

- **Credentials** never reach the browser for saved hosts: the socket sends only a host id, the backend
  resolves the login with `resolveHostProtocol` for the acting user. Quick Connect necessarily sends the
  login the user just typed, once, over the authenticated socket. Passwords are never logged, never in
  error messages, never in audit lines (tests check this).
- **WinRM over HTTP with NTLM**: every SOAP body is sealed (RC4) and signed (HMAC-MD5) with the NTLM
  session key, per MS-WSMV; the server's signature is checked on every response. This gives
  confidentiality and integrity against passive listeners. It does **not** authenticate the server, and
  an active man in the middle could relay the NTLM login to another service. RC4 is weak by modern
  standards, but it is what Windows uses for this. Use HTTPS on networks you do not control.
- **HTTPS**: certificates are always verified (system CAs, an own CA in PEM, or an exact SHA-256 pin).
  There is no "ignore certificate" option. TLS 1.2 minimum.
- **No `TrustedHosts=*`** is needed: that is a client-side setting of Windows PowerShell; this plugin is
  the client and does not use it.
- **No `AllowUnencrypted`, no Basic** on the servers.
- **Input**: host addresses are validated as DNS names or IPs; user input travels as a PSRP script or
  parameter, never through a shell on the Termix server. Incoming socket messages are size-capped and
  validated; XML with DOCTYPE is refused; responses, messages and nesting depth are bounded.
- **Terminal escapes**: OSC/DCS sequences from the remote side (window title, clipboard writes) are
  removed before they reach xterm.js.
- **Access**: permission `winrm.sessions`, host access through `resolveHostProtocol` (connect level),
  saved logins refused once the user's data key is locked.
- **Resources**: sessions per user and in total, idle timeout, keepalive, output back-pressure, a 15 s
  window to send the open message, and cleanup (stop, delete the shell, close tunnels) on every exit path
  including plugin disable.

## 6. How it was verified

There was no approved Windows test host, and the reachable AKL servers are production systems. So:

- NTLM is checked against the published MS-NLMP test vectors and against an independent NTLM server
  (pyspnego): login, MIC, sealing both ways, wrong password.
- The PSRP client messages are byte-identical to what pypsrp sent to real Windows servers, and the
  client is replayed against conversations recorded from Windows Server (pypsrp's test suite, MIT).
- End-to-end over real TCP: HTTP, Negotiate, sealed bodies and PSRP against a fake WinRM endpoint with a
  pyspnego NTLM server replaying the recorded responses.
- Session and terminal behaviour with a scripted PowerShell double.

**Live test (October 2026):** a Windows 11 workstation (Windows PowerShell 5.1.26100), local account,
WinRM over HTTP with NTLM message encryption, reached from a Termix 26.10.2 test instance through a
Windows OpenSSH jump host. Checked: login and a refused wrong password (same answer as Windows' own
WinRM client), persistent variables and location, `Get-Process`, `Get-WinEvent`, native programs
(`ipconfig`, `whoami`), umlauts and emoji, warnings, `Write-Host` colours, non-terminating and
terminating errors, multi-line input, Ctrl+C on a long `Start-Sleep` with the session usable afterwards,
`Get-History`, three parallel sessions with separate state, shells deleted on the server on close, and
about 150 ms per command through the jump host. The live test found and fixed one bug: after Ctrl+C the
session used to end on the next command.

Still open: Windows Server, domain accounts, HTTPS with a real listener and CA, and a WinRM service
restart during a session.
