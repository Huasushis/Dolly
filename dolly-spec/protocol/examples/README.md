# Extension protocol examples

JSON files are complete logical JSON-RPC messages; the wire prefix is the
four-byte big-endian length of their UTF-8 JCS encoding. `invalid-*.txt` files
preserve hostile bytes or duplicate keys that cannot be represented by parsed
JSON.

These examples do not replace method schemas. A receiver first enforces frame
rules, then strict JSON/JSON-RPC, then the named method schema, then authority
and durable-state preconditions.

`valid-module-activate.json` illustrates the immutable per-Manifest frame-byte
and frame-depth bounds used when a replacement generation is admitted.
`valid-extension-initialize.json` and
`valid-extension-initialize-result.json` illustrate limit negotiation plus an
activation-ledger continuity binding and exact Extension configuration
revision/value/schema-digest binding for one Module generation.
`valid-asset-status.json` illustrates reconciliation of a lost import response
without changing the original `import_id`.

`valid-extension-ping.json` and `valid-extension-ping-result.json` exercise the
closed heartbeat pair. `valid-host-operation-status.json` and its result show
generic reconciliation returning authoritative `absent` without starting the
target pin. `valid-extension-progress.json` is a bounded notification with no
request ID. `invalid-host-operation-status-missing-deadline.json` is rejected
before status lookup because the params contract is incomplete.
`valid-parse-error-response.json` exercises the only response class that has no
recoverable request method or string ID: its JSON-RPC ID is `null`, while its
closed Dolly error data still records the stable parse-error category.
