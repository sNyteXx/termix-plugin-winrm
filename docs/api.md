---
title: API and MCP
order: 2
---

# API and MCP

Besides the terminal, the plugin runs single scripts on a host and returns what they produced as data.
That is what an MCP server, a script or another plugin uses.

## Permission

Running scripts needs the permission **Run WinRM scripts** (`winrm.run`). Only admins have it by default.
Give it to other roles in Admin settings → Roles only if they should run commands without a terminal.

Every run writes an audit line `winrm_run` with the host, the result and the script's **sha256** and length.
The script itself is never logged, because it may contain passwords.

## HTTP

`POST /plugin-api/winrm/run`, signed in or with an API key (`Authorization: Bearer tmx_…`):

```json
{
  "hostId": 6,
  "script": "Get-Service WinRM | Select-Object Name, Status",
  "timeoutSec": 60
}
```

| Field        | Default | Notes                                                     |
| ------------ | ------- | --------------------------------------------------------- |
| `hostId`     |         | A saved host with WinRM turned on and a WinRM login       |
| `script`     |         | PowerShell, up to 256 KB                                  |
| `timeoutSec` | 60      | 1 to 600, connecting included; the script is then stopped |
| `width`      | 160     | Width PowerShell formats tables at                        |

Answer (200):

```json
{
  "state": "completed",
  "computerName": "WIN11-OFFICE",
  "output": "Name  Status\n----  ------\nWinRM Running",
  "errors": [],
  "warnings": [],
  "verbose": [],
  "information": [],
  "truncated": false,
  "durationMs": 1923
}
```

- `state`: `completed`, `failed` (a terminating error, see `errors`), `stopped` or `timeout`.
- `output` is formatted by PowerShell (`Out-String`). For machine-readable data, end the script with
  `| ConvertTo-Json -Depth 4` and parse `output`.
- Non-terminating errors are in `errors` while the state stays `completed`, like on the console.
- Output over 1 MB is cut off, the script is stopped and `truncated` is `true`.
- Each run opens its own PowerShell session and deletes it afterwards; nothing carries over between runs.
  Runs count towards the session limits in the plugin settings.

Errors: `400` invalid input or WinRM not set up on the host, `403` no `winrm.run`, `404` host not found or
no access, `429` session limit reached, `502` the host could not be reached or refused the login
(`kind` says which: `connect`, `timeout`, `auth`, `tls`, …).

## Service for plugins

Another plugin declares `"requires": [{ "service": "winrm.run", "versionRange": "^1.0.0" }]` and calls

```ts
const winrm = ctx.services.get<{
  run(
    hostId: number,
    script: string,
    options?: { timeoutSec?: number; width?: number },
  ): Promise<unknown>;
}>("winrm.run");
const result = await winrm.run(6, "Get-Service WinRM");
```

It runs as the acting user, with the same permission check, limits and audit as the HTTP route, and throws
with the error message where the route would answer an error status.

## MCP

An MCP server with a Termix API key calls the HTTP route. The Termix MCP (`termix-mcp-server`) offers this as
the tool `winrm_execute`.
