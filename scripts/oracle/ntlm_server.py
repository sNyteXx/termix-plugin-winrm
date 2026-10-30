"""NTLM server from pyspnego, driven over stdin/stdout with JSON lines.

Development oracle only: tests/backend/ntlm-interop.test.ts starts it when
WINRM_ORACLE_PYTHON points at a Python with pyspnego installed. It is never
shipped in the plugin package.

Requests: {"op": "step", "token": b64} | {"op": "unwrap", "data": b64}
          | {"op": "wrap", "data": b64}
"""

import base64
import json
import os
import sys
import tempfile

import spnego

user_file = tempfile.NamedTemporaryFile("w", delete=False, suffix=".txt")
user_file.write(
    "%s:%s:%s\n"
    % (os.environ["ORACLE_DOMAIN"], os.environ["ORACLE_USER"], os.environ["ORACLE_PASSWORD"])
)
user_file.close()
os.environ["NTLM_USER_FILE"] = user_file.name

ctx = spnego.server(protocol="ntlm")


def reply(value):
    sys.stdout.write(json.dumps(value) + "\n")
    sys.stdout.flush()


for line in sys.stdin:
    request = json.loads(line)
    try:
        if request["op"] == "step":
            out = ctx.step(base64.b64decode(request["token"]))
            reply({"token": base64.b64encode(out).decode() if out else None,
                   "complete": ctx.complete})
        elif request["op"] == "unwrap":
            data = base64.b64decode(request["data"])
            plain = ctx.unwrap_winrm(data[:16], data[16:])
            reply({"data": base64.b64encode(plain).decode()})
        elif request["op"] == "wrap":
            header, enc, _ = ctx.wrap_winrm(base64.b64decode(request["data"]))
            reply({"data": base64.b64encode(header + enc).decode()})
    except Exception as error:  # noqa: BLE001 - reported to the test
        reply({"error": "%s: %s" % (type(error).__name__, error)})

os.unlink(user_file.name)
