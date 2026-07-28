#!/usr/bin/env python3
"""Protocol-frame-limit fixture for case LM-05-protocol-frame.

Fixed local script, no command-line or environment input, finite deadline.

It writes two frames on the Extension protocol transport, in this order:

  1. one well-formed frame of exactly the maximum size Core accepts, so the
     case can show the limit is a boundary rather than a rough cut-off; then
  2. one frame whose four-byte length header is one byte over that maximum,
     which Core must refuse from the header alone, before it reads a body.

The size below is the Core default `maxFrameBytes` in
`src/core/extension-process-host.ts`. The driver asserts the frame it received
was exactly this many bytes, so a mismatch between the two files shows up as a
failed assertion instead of a silent pass.
"""

import json
import os
import signal
import time

DEADLINE_SECONDS = 20
CORE_DEFAULT_MAX_FRAME_BYTES = 256 * 1024
SENTINEL = "dolly-test-frame-boundary"

signal.alarm(DEADLINE_SECONDS)

# Built so the encoded object is exactly CORE_DEFAULT_MAX_FRAME_BYTES bytes.
# Every character used here is one byte in UTF-8.
skeleton = json.dumps({"sentinel": SENTINEL, "pad": ""}, separators=(",", ":"))
padding = "a" * (CORE_DEFAULT_MAX_FRAME_BYTES - len(skeleton))
at_limit = json.dumps({"sentinel": SENTINEL, "pad": padding}, separators=(",", ":")).encode("utf-8")
assert len(at_limit) == CORE_DEFAULT_MAX_FRAME_BYTES

os.write(1, len(at_limit).to_bytes(4, "big") + at_limit)

over_limit_length = CORE_DEFAULT_MAX_FRAME_BYTES + 1
os.write(1, over_limit_length.to_bytes(4, "big"))
# A few body bytes, so the refusal cannot be blamed on a truncated write.
os.write(1, b'{"a":1}')

time.sleep(5)
