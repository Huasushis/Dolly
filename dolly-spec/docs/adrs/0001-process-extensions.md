# ADR 0001: Process Extensions

- Status: Accepted
- Scope: Extension ABI and hot replacement

## Decision

Dolly v1 uses child processes speaking the Dolly Extension JSON-RPC protocol.
Rust dynamic libraries and in-process third-party plugins are out of scope.

## Rationale

Rust has no stable language ABI for long-lived third-party plugin compatibility;
unloading code safely is difficult; an Extension crash must not unwind through
Core; independent processes allow version negotiation, resource limits, and
replacement without unloading executable code from the Worker.

## Consequences

Serialization and IPC cost are accepted. The protocol must fully define
framing, lifecycle, capabilities, state migration, fencing, and failures.
Process isolation is not advertised as a security sandbox.

## Rejected alternatives

- `cdylib`: unstable ABI and unsafe lifecycle boundary.
- one Worker binary containing every Extension: strong coupling and restart
  blast radius.
- Wasm Component Model in v1: promising future sandbox target, but increases
  implementation scope before semantics are validated.

