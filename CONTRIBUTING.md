# Contributing to WinRM PowerShell

## Development

```bash
npm run build      # build into dist/
npm run test       # run this plugin's tests
npm run typecheck  # type-check this plugin
npm run validate   # check manifest.json
npm run pack       # pack dist/ into a .tmxplug
npm run format     # format the code with Prettier
```

### Protocol oracle tests

Some tests check the WinRM stack against an independent implementation (pyspnego) and run only when
`WINRM_ORACLE_PYTHON` points at a Python that has it:

```bash
python3 -m venv /tmp/winrm-oracle && /tmp/winrm-oracle/bin/pip install pyspnego pyyaml
WINRM_ORACLE_PYTHON=/tmp/winrm-oracle/bin/python npm test
```

The scripts in `scripts/oracle/` are development aids only and are not part of the package.

### Rules for this plugin

- Never log or return a password, an NTLM token or a message body. Tests check this; keep them passing.
- Never add an option that skips certificate checks or sends WinRM bodies unencrypted over HTTP.
- User input reaches PowerShell only as a script or a parameter value, never spliced into helper code.
- Do not run integration tests against production Windows hosts.

## Docs

The docs for this plugin are in [docs/](docs/), and `docs` in `manifest.json` links to them. Settings, permissions and environment variables are made from `manifest.json`, so keep those up to date instead of writing them by hand. See [writing docs](https://docs.termix.site/develop/docs).
