"""A fake WinRM endpoint for end-to-end tests of the plugin's transport.

Development oracle only (needs pyspnego). It does what a Windows server does
on port 5985: Negotiate/NTLM login per TCP connection, then every body sealed
with that connection's context (multipart/encrypted). The SOAP responses are
replayed from a recorded conversation (tests/fixtures/pypsrp/*.json).

Usage: winrm_server.py <recording.json>   (prints the port, then serves)
Env:   ORACLE_DOMAIN, ORACLE_USER, ORACLE_PASSWORD
       ORACLE_BIND (default 127.0.0.1), ORACLE_PORT (default random)
       ORACLE_UPSTREAM: instead of replaying, POST each decrypted SOAP request
       to this plain-HTTP URL and seal its answer (tests/support/fake-powershell-http.ts)
"""

import base64
import json
import os
import re
import struct
import sys
import tempfile
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import spnego

user_file = tempfile.NamedTemporaryFile("w", delete=False, suffix=".txt")
user_file.write("%s:%s:%s\n" % (os.environ["ORACLE_DOMAIN"], os.environ["ORACLE_USER"], os.environ["ORACLE_PASSWORD"]))
user_file.close()
os.environ["NTLM_USER_FILE"] = user_file.name

UPSTREAM = os.environ.get("ORACLE_UPSTREAM")
PAIRS = []
if not UPSTREAM:
    with open(sys.argv[1]) as handle:
        PAIRS = json.load(handle)
LOCK = threading.Lock()
CONTEXTS = {}
STATE = {"cursor": 0, "requests": []}
BOUNDARY = b"--Encrypted Boundary"
PROTOCOL = "application/HTTP-SPNEGO-session-encrypted"
SIGNAL_RESPONSE = ('<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" '
                   'xmlns:rsp="http://schemas.microsoft.com/wbem/wsman/1/windows/shell">'
                   '<s:Body><rsp:SignalResponse/></s:Body></s:Envelope>')


def next_response(request_xml):
    if UPSTREAM:
        with urllib.request.urlopen(urllib.request.Request(UPSTREAM, data=request_xml.encode("utf-8"), method="POST")) as answer:
            return answer.read().decode("utf-8")
    action = re.search(r"<wsa:Action[^>]*>([^<]+)<", request_xml).group(1)
    with LOCK:
        STATE["requests"].append(action.rsplit("/", 1)[-1])
        expected = PAIRS[STATE["cursor"]] if STATE["cursor"] < len(PAIRS) else None
        if action.endswith("/Signal") and (expected is None or not expected["action"].endswith("/Signal")):
            return SIGNAL_RESPONSE
        if expected is None or expected["action"] != action:
            return None
        STATE["cursor"] += 1
        return expected["response"]


def decrypt(ctx, body):
    header, rest = body.split(b"application/octet-stream\r\n", 1)
    length = int(re.search(rb"Length=(\d+)", header).group(1))
    sig_len = struct.unpack("<I", rest[:4])[0]
    signature = rest[4:4 + sig_len]
    sealed = rest[4 + sig_len:4 + sig_len + length]
    return ctx.unwrap_winrm(signature, sealed)


def encrypt(ctx, data):
    header, sealed, _ = ctx.wrap_winrm(data)
    return (b"\r\n".join([BOUNDARY, b"\tContent-Type: " + PROTOCOL.encode(),
                          b"\tOriginalContent: type=application/soap+xml;charset=UTF-8;Length=%d" % len(data),
                          BOUNDARY, b"\tContent-Type: application/octet-stream", b""])
            + struct.pack("<I", len(header)) + header + sealed + BOUNDARY + b"--\r\n")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def reply(self, status, body=b"", headers=None):
        self.send_response(status)
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        auth = self.headers.get("Authorization", "")
        if auth.startswith("Negotiate "):
            token = base64.b64decode(auth[10:])
            # A NEGOTIATE message always starts a new login (socket ids get reused).
            if id(self.connection) not in CONTEXTS or token[8:12] == b"\x01\x00\x00\x00":
                CONTEXTS[id(self.connection)] = spnego.server(protocol="ntlm")
            try:
                out = CONTEXTS[id(self.connection)].step(token)
            except Exception:
                del CONTEXTS[id(self.connection)]
                return self.reply(401, headers={"WWW-Authenticate": "Negotiate"})
            if not CONTEXTS[id(self.connection)].complete:
                return self.reply(401, headers={"WWW-Authenticate": "Negotiate " + base64.b64encode(out).decode()})
            if not body:
                return self.reply(200)
        ctx = CONTEXTS.get(id(self.connection))
        if ctx is None or not ctx.complete:
            return self.reply(401, headers={"WWW-Authenticate": "Negotiate, Kerberos"})
        if not self.headers.get("Content-Type", "").startswith("multipart/encrypted"):
            return self.reply(400, b"unencrypted request refused")
        response = next_response(decrypt(ctx, body).decode("utf-8"))
        if response is None:
            return self.reply(400, b"unexpected request")
        status = 500 if "<s:Fault" in response else 200
        self.reply(status, encrypt(ctx, response.encode("utf-8")), {
            "Content-Type": 'multipart/encrypted;protocol="%s";boundary="Encrypted Boundary"' % PROTOCOL})


server = ThreadingHTTPServer((os.environ.get("ORACLE_BIND", "127.0.0.1"), int(os.environ.get("ORACLE_PORT", "0"))), Handler)
print(server.server_address[1], flush=True)
try:
    server.serve_forever()
finally:
    os.unlink(user_file.name)
