# WinRM PowerShell for Termix

A [Termix](https://github.com/Termix-SSH/Termix) plugin that opens PowerShell sessions on Windows servers
over WinRM, in a normal Termix terminal tab, next to SSH and RDP.

- One persistent PowerShell remoting (PSRP) session per tab: variables, the current folder and history
  carry over between commands.
- WinRM over HTTP with every message encrypted by NTLM (no `AllowUnencrypted`), or over HTTPS with
  verified certificates.
- Local and Active Directory accounts, saved Termix logins and credentials, jump hosts.
- Implemented in TypeScript without Python, PowerShell or native binaries on the Termix server, so it
  runs in the stock Linux Termix Docker image.

Needs Termix 26.10.2 or newer.

## Install

```bash
npm ci
npm run build
npm run pack        # writes winrm-0.1.0.tmxplug
```

In Termix: **Plugins → Install from file**, pick `winrm-0.1.0.tmxplug`, and approve the capabilities.

## Docs

- [Setup and use](docs/index.md)
- [Architecture, security assessment and decisions](docs/architecture.md)
- [Roadmap](docs/roadmap.md)

## Licence

Apache-2.0. See [NOTICE](NOTICE) for third-party notices.
