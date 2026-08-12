# Strict-streaming browser Agent through Camoufox and MCP

Date: 2026-08-12

Preregistration: `docs/experiments/preregistrations/camoufox-agent-stream-v0.json`

Confirmation run: `artifacts/experiments/probes/camoufox-agent-stream-v0/live-20260812c`

Independent audit: `artifacts/experiments/probes/camoufox-agent-stream-v0/verifier-audit-v4-20260812a`

## Decision

Keep this strict-streaming model-to-Model-Context-Protocol-to-Camoufox path as a
general-Agent research candidate on Linux. The owner Aether fixture selected
and executed a complete browser action sequence in three fresh sessions without
a harness-authored selector or action sequence.

This does not make Aether a Dolly dependency, prove arbitrary-site browser
reliability or model image understanding, or authorize removing
`RUNTIME_MODULE_MIGRATION_REQUIRED`. The next product step is to expose this
kind of browser tool through the host-owned tool registry, approval, active-Run,
deadline, byte-limit, and durable external-effect boundaries.

## Effect result

The independently reconstructed v3 result was three complete cases out of
three. Each case made eight model-selected browser calls:

1. navigate to the fresh loopback page;
2. take a top screenshot;
3. obtain the accessibility snapshot;
4. type the page's exact target text;
5. click Apply once;
6. click the off-screen Bottom action once;
7. click Recover once; and
8. take a bottom screenshot.

After the model stopped, a host-only read of `window.__probeRead()` found, in
every case:

- `inputText = "AGENT-TARGET-4821"`;
- `appliedCount = 1`;
- `bottomCount = 1`;
- `recoveredCount = 1`; and
- `scrollY = 1250`.

The model's final statement was not used as the success oracle. The three page
instances had distinct `pageTimeOrigin` values, so this was not one retained
session counted three times.

All six model-selected PNG screenshots were 800 by 600 pixels. The independent
verifier required the frozen exact top or bottom RGB anchors and byte identity
between each retained screenshot and the corresponding MCP-owned screenshot.
This proves that the Agent requested correct screenshots at the right task
stages. The model received screenshot metadata rather than image bytes, so it
does not prove native screenshot perception.

## Streaming and reasoning result

All 24 logical model calls used:

- `stream: true`;
- `stream_options.include_usage: true`;
- `thinking: {"type":"enabled"}`;
- no `enable_thinking` field; and
- no non-stream fallback.

Every response satisfied the bounded Server-Sent Events contract: HTTP 200
`text/event-stream`, stable response identity, one finish reason, exactly one
terminal usage event, exactly one `[DONE]`, and no bytes after `[DONE]`. There
were 24 attempts for 24 logical calls and therefore no retry. Finish reasons
were 21 `tool_calls` and three `stop`.

Every one of the 24 responses contained non-empty `reasoning_content`, which is
the only evidence used to claim reasoning for an individual response. Total
accounting was 50,680 prompt tokens, 2,721 completion tokens, and 53,401 tokens.

Two responses took longer than the gateway's former 120-second cutoff; the
maximum was 167,158 ms. Both streams completed normally. This is direct evidence
that the owner's gateway change and the client's strict streaming path no longer
produce the earlier 120-second cancellation for this workload. The runner kept
its own independent 20-minute request deadline.

## Counterexamples that changed the implementation

The first retained run, `live-20260812a`, made zero model calls. The runner had
not bound browser child `HOME` and `XDG_CACHE_HOME` to the isolated dependency
tree, so Camoufox could not locate its installed browser. It left no child
process. Three exact empty directories created under the default Camoufox cache
were identified by the run timestamp and removed individually. Version 2 then
constructed the browser child environment from a fixed allowlist under
`/home/ubuntu/codex-dolly` and withheld Aether values and ambient proxy values.

The second retained run, `live-20260812b`, had 15 of 15 valid streamed model
responses and one complete case out of three. In both failures the model swapped
the MCP meanings of `element` and `target`: it put `ref=e9` in the human-readable
field and a human-readable textbox description in the exact target field. The
model-facing narrowed schema had accidentally removed the upstream field
descriptions. Version 3 restored those ordinary interface semantics without
adding a selector or action sequence. The task, model, tools, transport, budget,
and three-of-three threshold did not change.

## Independent validation

The first verifier audit exposed three false greens out of nine mutations:
removing a relevant source hash, adding an undeclared artifact, and replacing a
request message. Those findings were not hidden. The verifier was hardened to:

- require the exact source inventory at the recorded Git commit;
- require a closed artifact inventory;
- reconstruct the initial prompt and every assistant/tool-result replay round;
- match every model tool call to the exact MCP execution;
- compare each case summary with run metadata;
- compare retained and MCP-owned screenshot hashes; and
- independently check exact final state, streaming evidence, reasoning evidence,
  process finalization, and PNG pixels.

The unmodified baseline then passed, and all nine independent mutations were
rejected. The mutations covered source removal, an extra artifact,
`stream:false`, missing `[DONE]` evidence, wrong final state, a changed PNG pixel
with updated artifact digest and replay, a forged reasoning flag, a recorded
live process, and replaced request messages.

Relevant evidence hashes:

- run metadata: `5cf3e1838f0e1327050ed5dcf12b92b106b8300b9b0b0c2a4f1e3dc851a96aed`;
- hardened baseline verification: `9755ece61efd6d84025712f15bc581372b1d46de2e5d2f0ff76f9f185bd67aa9`;
- mutation audit: `7d7815f9539507da1d02aebe2dd89f667577c65194b5998ebef29a08e4ca9210`;
- v3 preregistration: `3dd37fd3576aaf1d52661d9e95e6e6e66c8616c4a2cf2e40183aecff3e64011e`;
- hardened verifier: `277b0d72f9030dd41865a67878f46767a8ed8775b7fa0e894dc2c7b56f52aaf2`.

The browser and MCP children were finalized only by recorded PID plus Linux
process start ticks. All three confirmation cases recorded zero remaining child
processes. No process-name scan, prefix kill, container operation, object
storage, public website, or other model provider was used.

## Product boundary

The public runtime bootstrap conformance test still passes and still rejects
every configured Module before creating Core state or a controller lock. The
strict streaming decoder's six conformance cases also pass. Dolly's Broker
continues to represent both streaming and non-streaming provider capabilities;
this experiment does not silently delete the latter compatibility path. What is
now established is that the current general-Agent browser effect path can and
does use strict streaming for every generation request.
