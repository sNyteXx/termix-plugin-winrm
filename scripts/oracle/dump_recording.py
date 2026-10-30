"""Prints the WS-Man actions and PSRP messages of a pypsrp test recording.

Development aid only (needs pyyaml). Usage: dump_recording.py file.yml
"""

import base64
import re
import struct
import sys

import yaml

MESSAGE_TYPES = {
    0x00010002: "SESSION_CAPABILITY", 0x00010004: "INIT_RUNSPACEPOOL",
    0x00010005: "PUBLIC_KEY", 0x00010006: "ENCRYPTED_SESSION_KEY",
    0x00021002: "SET_MAX_RUNSPACES", 0x00021004: "RUNSPACE_AVAILABILITY",
    0x00021005: "RUNSPACEPOOL_STATE", 0x00021006: "CREATE_PIPELINE",
    0x00021009: "APPLICATION_PRIVATE_DATA", 0x00021100: "RUNSPACEPOOL_HOST_CALL",
    0x00041002: "PIPELINE_INPUT", 0x00041003: "END_OF_PIPELINE_INPUT",
    0x00041004: "PIPELINE_OUTPUT", 0x00041005: "ERROR_RECORD",
    0x00041006: "PIPELINE_STATE", 0x00041007: "DEBUG_RECORD",
    0x00041008: "VERBOSE_RECORD", 0x00041009: "WARNING_RECORD",
    0x00041010: "PROGRESS_RECORD", 0x00041011: "INFORMATION_RECORD",
    0x00041100: "PIPELINE_HOST_CALL",
}


def messages(blob):
    data = base64.b64decode(blob)
    while data:
        object_id, fragment_id, flags, length = struct.unpack(">QQBI", data[:21])
        payload = data[21:21 + length]
        data = data[21 + length:]
        if fragment_id == 0 and len(payload) >= 40:
            dest, mtype = struct.unpack("<II", payload[:8])
            body = payload[40:].decode("utf-8", "replace").lstrip("\ufeff")
            yield "obj=%d frag=%d flags=%d %s %s" % (
                object_id, fragment_id, flags, MESSAGE_TYPES.get(mtype, hex(mtype)), body)
        else:
            yield "obj=%d frag=%d flags=%d (continuation, %d bytes)" % (
                object_id, fragment_id, flags, length)


with open(sys.argv[1]) as handle:
    recording = yaml.safe_load(handle)

for index, pair in enumerate(recording["messages"]):
    for side in ("request", "response"):
        text = pair[side]
        action = re.search(r"<wsa?:Action[^>]*>([^<]+)<", text)
        print("== %d %s %s" % (index, side, action.group(1).rsplit("/", 1)[-1] if action else "?"))
        for blob in re.findall(r">([A-Za-z0-9+/=]{40,})<", text):
            for line in messages(blob):
                print("   ", line[:int(sys.argv[2]) if len(sys.argv) > 2 else 1500])
        fault = re.search(r"<s:Fault.*?</s:Fault>", text)
        if fault:
            print("   FAULT", fault.group(0)[:600])
