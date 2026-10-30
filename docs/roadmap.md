---
title: Roadmap
order: 4
---

# Roadmap

Ordered by value and risk. Nothing here is implemented yet.

## Before production use

1. **Live test on an approved Windows test host** (not a production SCADA system): HTTP + NTLM through
   the jump host, HTTPS with a real listener and CA, wrong password, firewall closed, WinRM restart
   during a session, long-running output, umlauts from native programs (`ipconfig`, `net user`).
2. Install the `.tmxplug` on a Termix test instance of the same version as production (26.10.2) and
   check the host editor, Quick Connect, split view and theme.

## Next features

| Feature                           | Effort | Notes                                                                                |
| --------------------------------- | ------ | ------------------------------------------------------------------------------------ |
| Tab completion                    | M      | `TabExpansion2` over a helper pipeline, results shown inline                         |
| Prompts (`Read-Host`, `-Confirm`) | L      | Offer a minimal PSHost and answer host calls from the terminal; needs careful UX     |
| Progress display                  | S      | Show the latest progress record in a status line                                     |
| Reconnect after a network blip    | M      | PSRP disconnect/reconnect (protocol 2.2+) so a session survives a dropped connection |
| Kerberos over HTTPS               | L      | Optional native `kerberos` package + krb5 in a custom image; see architecture page   |
| Session sharing / recording       | M      | Via the session-recording plugin's service, like the remote desktop plugin           |

## Integrations (after the terminal is proven)

| Integration          | How                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| Snippets             | Read snippets through the snippets service and insert them into the line editor                 |
| Automations / Fleets | Offer a `winrm.run` service (script in, output and errors out) that other plugins call per host |
| Windows services     | A panel: `Get-Service` as data, start/stop/restart with confirmation                            |
| Event logs           | A panel: `Get-WinEvent` with filters, as data instead of text                                   |
| Host metrics         | CPU, memory, disk from `Get-CimInstance`, fed to the host metrics card                          |

The service and panels reuse the same backend: a runspace pool per call, output taken as objects
(no `Out-String`), and the same permission and audit path.

## Upstream (Termix)

- A transport-agnostic `terminal.view` so protocol plugins get the SSH terminal's history panel, macros
  and broadcast input (details on the architecture page).
