# WinRM PowerShell

Opens a PowerShell session on a Windows server over WinRM, in a normal Termix tab. The session stays open
while the tab is open: variables, the current folder and `Get-History` carry over from one command to the
next, like in `Enter-PSSession`.

## Prepare the Windows server

WinRM is on by default on Windows Server. Check it in an elevated PowerShell on the server:

```powershell
Test-WSMan -ComputerName localhost
winrm enumerate winrm/config/listener
```

If there is no listener, run `winrm quickconfig`. That opens HTTP on port 5985 for domain and private
networks.

You do **not** need `AllowUnencrypted`, Basic authentication or `TrustedHosts` for this plugin: over HTTP it
encrypts every message with NTLM, which is WinRM's default.

The account needs to be in **Administrators** or **Remote Management Users** on the server.

### HTTPS (recommended on networks you do not control)

Create an HTTPS listener with a certificate whose name matches the address Termix uses:

```powershell
$cert = Get-ChildItem Cert:\LocalMachine\My | Where-Object Subject -eq "CN=server.example.local"
New-Item -Path WSMan:\localhost\Listener -Transport HTTPS -Address * -CertificateThumbPrint $cert.Thumbprint -Force
New-NetFirewallRule -DisplayName "WinRM HTTPS" -Direction Inbound -Protocol TCP -LocalPort 5986 -Action Allow
```

A certificate from your own CA works when you paste the CA certificate into the host's WinRM tab. A
self-signed certificate works with its SHA-256 fingerprint pinned:

```powershell
(Get-ChildItem Cert:\LocalMachine\My\<thumbprint>).GetCertHashString('SHA256')
```

## Set up a host in Termix

1. Open the host in the host editor and turn on **WinRM** under connection protocols.
2. In the **WinRM** tab, pick the transport, check the port (5985 for HTTP, 5986 for HTTPS) and set the
   login: user name and password, or a saved credential, and the domain. For a domain account use
   `CONTOSO\Administrator`, or `Administrator` with `CONTOSO` as domain. For a local account use the computer
   name as domain or leave it empty.
3. If the server sits behind a jump host, set the jump host in the host's SSH settings as usual. WinRM goes
   through it.
4. Save. The host now has a **PowerShell (WinRM)** button.

Quick Connect also offers WinRM. Port 5986 there means HTTPS with a certificate trusted by the Termix server.

## Use the terminal

- Type a command and press Enter. Output is formatted by PowerShell at the width of the terminal.
- Up and Down walk the command history, Left/Right, Home/End, Ctrl+Left/Right edit the line.
- An unfinished statement (an open `{`, a here-string) shows a `>>` prompt. An empty line runs it.
- Ctrl+C stops a running command. With text selected it copies instead. Ctrl+V pastes. A pasted block
  runs line by line.
- `cls` clears the screen. Ctrl+L too.
- Closing the tab ends the session on the server.

## What does not work

PowerShell remoting has no terminal like SSH has. These need a console and do not work, the same as in
`Enter-PSSession`:

- Full-screen and interactive programs: `diskpart`, interactive `netsh`, `edit`, `vim`, `ssh`.
- Prompts: `Read-Host`, `Get-Credential`, `-Confirm` questions and "Are you sure?" prompts fail with an
  error instead of asking. Use `-Confirm:$false` or `-Force` where it is safe.
- Progress bars are not shown.
- Tab completion is not available yet (Tab inserts spaces).
- Kerberos is not supported, only NTLM. If your domain restricts NTLM, the plugin cannot sign in.

## Scripts through the API

Scripts can also run without a terminal, through `POST /plugin-api/winrm/run` or the `winrm.run` service, for
MCP servers and automations. That needs the permission **Run WinRM scripts**. See [API and MCP](api.md).

## Admin settings

Under the plugin's settings: how many sessions one user and the whole server may have open, and after how
many idle minutes a session closes.

## Troubleshooting

| Message                                        | What to check                                                                          |
| ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| refused the connection                         | WinRM listener and firewall on the server; the port in the WinRM tab                   |
| does not offer Negotiate                       | `winrm get winrm/config/service/auth`: Negotiate must be `true`                        |
| Login failed                                   | User, password, domain; group Administrators or Remote Management Users                |
| certificate was not accepted                   | The name in the certificate matches the address; the CA certificate or the fingerprint |
| The jump host could not reach                  | The jump host can reach the server's WinRM port                                        |
| The remote PowerShell session no longer exists | The server restarted WinRM or closed the shell after its own idle timeout              |
