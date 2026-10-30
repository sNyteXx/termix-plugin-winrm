# WinRM PowerShell for Termix

A [Termix](https://github.com/Termix-SSH/Termix) plugin that opens PowerShell sessions on Windows servers
over WinRM, in a normal Termix terminal tab, next to SSH and RDP.

- One persistent PowerShell remoting (PSRP) session per tab: variables, the current folder and history
  carry over between commands.
- WinRM over HTTP with every message encrypted by NTLM (no `AllowUnencrypted`), or over HTTPS with
  verified certificates.
- Local and Active Directory accounts, saved Termix logins and credentials, jump hosts.
- An HTTP API and a `winrm.run` service that run a script and return its output as data, for MCP servers
  and automations.
- Implemented in TypeScript without Python, PowerShell or native binaries on the Termix server, so it
  runs in the stock Linux Termix Docker image.

Needs Termix 26.10.2 or newer.

## Install

From the sNyteXx registry (signed, with updates):

1. In Termix: **Plugins → Registries → Add registry**, paste
   `https://raw.githubusercontent.com/sNyteXx/termix-registry/main/snytexx/index.json`, check that the key id is
   `dbd4cfde7466862c`, then **Trust and add**.
2. **Plugins → Browse → WinRM PowerShell → Install**, and approve the capabilities.

To build it yourself: `npm ci && npm run build && npm run pack`, then **Plugins → Install from file** with
developer mode on.

## Docs

- [Setup and use](docs/index.md)
- [API, service and MCP](docs/api.md)
- [Architecture, security assessment and decisions](docs/architecture.md)
- [Roadmap](docs/roadmap.md)

## Licence

Apache-2.0. See [NOTICE](NOTICE) for third-party notices.
