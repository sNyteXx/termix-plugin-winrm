# AGENTS.md

This repo is a [Termix](https://github.com/Termix-SSH/Termix) plugin. These notes are for AI coding tools.

## Read first

Before changing anything, read `node_modules/@termix-ssh/plugin-sdk/PLUGIN-GUIDE.md`. It covers the
manifest, backend, database, frontend, UI, testing, releasing and submitting to the community registry,
and it matches the SDK version installed here. If it is missing, run `npm install`. If it is still missing,
the SDK is older than 1.0.6: run `npm install -D @termix-ssh/plugin-sdk@latest` or read
https://docs.termix.site/develop instead.

If the guide and the SDK's TypeScript types disagree, the types are right.

## Commands

```bash
npm run build        # bundle into dist/
npm test             # run the tests
npm run typecheck    # type check
npm run validate     # check manifest.json, migrations, changelog and docs
npm run pack         # write <id>-<version>.tmxplug
npm run format       # format with Prettier
```

`npx termix-plugin dev --server <url> --key <tmx_...>` installs the plugin on a Termix server with
developer mode on and reinstalls it on every save. Don't start it unless the user asks.

## Layouts and themes

A plugin can also be a layout (`contributes.layouts`, capability `ui:layout`, `app.registerLayout` in the
frontend, shell state from `useShell()`) or add themes (`contributes.themes`, capability `ui:theme`, one CSS
file per theme scoped under `.<id>`). A theme only plugin has no `src/`: just `manifest.json`, `themes/*.css`,
`locales/` and a test that runs `validateThemeCss()`. The guide's "Layouts and themes" section has the rules.

## Done means

- `npm test`, `npm run typecheck`, `npm run validate`, `npm run build` and `npm run format:check` pass
- `npx termix-plugin migrations --check` passes
- New UI text is in `locales/en.json`, new routes have an `@openapi` block and a test
- `docs/` and the section below still match what the plugin does
- User facing changes are in `CHANGELOG.md` under the version they ship in

## About this plugin

Keep this section current when the plugin changes.

- What it does: WinRM as a Termix connection protocol, with a PowerShell terminal tab backed by one
  persistent PSRP runspace pool per tab.
- Layers: `src/backend/winrm` (MD4/RC4, NTLMv2 with sealing, HTTP/1.1 client, multipart/encrypted,
  WS-Man), `src/backend/psrp` (fragments, messages, CLIXML, runspace pool, rendering),
  `src/backend/session` (console behaviour, WebSocket protocol, limits), `src/backend/connect.ts` (host
  resolution and jump hosts). Frontend: `line-editor.ts` (pure, tested), `WinrmTerminal.tsx` (xterm.js),
  `HostEditorSection.tsx`.
- Decisions: own TypeScript PSRP because no Node library does persistent sessions or HTTP message
  encryption; no PSHost (Read-Host etc. fail cleanly); output formatted on the server with
  `Out-String -Stream -Width`; two WinRM connections per session so Ctrl+C is not stuck behind a
  long-polling Receive; NTLM only, Kerberos documented as not supported (docs/architecture.md).
- Security rules: no "skip certificate check", never send bodies unencrypted over HTTP, never log
  secrets, user input only as script text or parameter value.
- Bitten before: the NTLM context belongs to one TCP connection, so `http.ts` never reconnects by
  itself; a Python socket cannot hold attributes (test oracle); WinRM's Receive timeout fault
  2150858793 is normal and means "poll again".
- Target: Termix >= 26.10.2 (SDK 1.0.11, API 1.3). Do not use SDK APIs newer than API 1.3.
