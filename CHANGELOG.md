# Changelog

## 0.1.0

### Added

- WinRM as a connection protocol next to SSH: a switch, port and login in the host editor, a filter in the host list and an entry in Quick Connect
- A PowerShell terminal tab that keeps one session open, so variables, the current folder and `Get-History` carry over between commands
- WinRM over HTTP with every message encrypted by NTLM (no `AllowUnencrypted`), or over HTTPS with a trusted CA, your own CA or a pinned certificate fingerprint
- Local and Active Directory accounts with NTLM, using the host's saved Termix login, a saved credential, or the login typed into Quick Connect
- Hosts behind jump hosts, through Termix's SSH pipeline
- Errors, warnings, verbose, debug and `Write-Host` output in PowerShell's colours, formatted by PowerShell at the terminal's width
- Line editing, command history, multi-line input with `>>` continuation, paste, `cls`, and Ctrl+C to stop a running command
- Limits for sessions per user and in total, an idle timeout, and a keepalive that notices a lost session
