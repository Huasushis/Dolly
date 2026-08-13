# Technology profile

This chapter specifies the reference implementation stack. Except where a wire
or storage format is named, alternate implementations are conforming if their
observable semantics and test results are equivalent.

## Reference stack

| Area | Reference choice | Contract rationale |
| --- | --- | --- |
| Language | Rust 2024 edition | memory safety, cross-platform native processes, one workspace |
| Async runtime | Tokio | bounded channels, timers, process and network I/O |
| HTTP/WebSocket | axum + tower | typed service composition and middleware |
| Serialization | serde + serde_json with duplicate-key guard | explicit wire types and closed-world validation |
| Durable store | SQLite in WAL mode | local atomic transactions and recoverable single-writer state |
| SQL access | sqlx or rusqlite behind a repository boundary | migrations and explicit transactions |
| Observability | tracing + OpenTelemetry-compatible export | structured spans, metrics, and correlation |
| CLI | clap | stable command grammar |
| Web UI | React + TypeScript + Vite, pnpm | typed client; no Extension JavaScript injection |
| Schema | JSON Schema 2020-12 | wire/config shape validation |
| Config update | RFC 6902 JSON Patch over keyed objects | revisioned, testable proposals |
| LLM tools | Host-owned Tool Broker with an MCP 2025-06-18 v1 adapter | centralize credentials, transport fencing, schema pinning, and side-effect reconciliation; defer 2026 multi-round-trip semantics until the ledger can represent them |

`REQ-TECH-001` — The workspace MUST separate at least `core-domain`,
`runtime`, `protocol`, `extension-sdk`, `daemon`, `cli`, `asset-service`,
`model-gateway`, and each reference Extension. Domain crates MUST NOT depend on
provider SDKs or UI crates.

`REQ-TECH-002` — Dependency versions are locked for releases and updated by a
dedicated compatibility change. The specification intentionally does not pin
fast-moving crate versions.

`REQ-TECH-003` — Every durable-conformance build MUST embed and use an
upstream SQLite library whose runtime version is at least **3.51.3**
(`sqlite3_libversion_number() >= 3051003`). The release manifest MUST record
`sqlite3_libversion()`, `sqlite3_sourceid()`, compile options, linkage mode, and
the library artifact digest. Startup MUST verify the loaded library against
the attested release record before opening an instance for writes. A missing,
older, or substituted library is `STORAGE_UNSAFE_SQLITE_BUILD`; it permits
read-only inspection or startup refusal, never a writable unsafe override.

This floor is a correctness requirement, not a preference: SQLite versions
through 3.51.2 contain the documented WAL-reset race. V1 deliberately chooses
one unambiguous upstream floor instead of treating distributor-specific
backports as equivalent without a new compatibility decision.

## SQLite durability profile

The implementation MUST document and expose its durability setting. Release
mode defaults to WAL with `synchronous=FULL`; a weaker mode is allowed only as
an explicitly named unsafe performance profile and MUST NOT claim power-loss
durability. Checkpointing is controlled, observed, and included in backup tests.

SQLite atomic commit is the boundary for Runtime internal exactly-once state.
It does not make Extension databases or external providers part of the same
transaction.

## Protocol choices

Dolly's Extension protocol uses JSON-RPC 2.0 messages but adds its own framing,
lifecycle, capabilities, deadlines, and semantic schemas. JSON-RPC is transport
agnostic and does not itself define these properties; they are not optional.

MCP is a Host Tool Broker adapter concern, not Dolly's Extension protocol. The
Host owns the server transport and credentials; an LLM Extension is only the
logical caller through Host RPC. The adapter version is pinned per release and
validated against each configured server during candidate prepare. V1 pins
`2025-06-18` intentionally: MCP `2026-07-28` removes the initialization/session
model and permits multi-round-trip `tools/call` continuations, which cannot be
mapped onto Dolly's no-post-dispatch-replay ledger without a new versioned
contract. See [ADR 0008](../../adrs/0008-pin-mcp-2025-06-18.md).

## Informative primary references

- [Rust 2024 Edition Guide](https://doc.rust-lang.org/edition-guide/rust-2024/)
- [Tokio bounded channels guidance](https://tokio.rs/tokio/tutorial/channels)
- [SQLite WAL, including the WAL-reset fix boundary](https://www.sqlite.org/wal.html) and [atomic commit](https://www.sqlite.org/atomiccommit.html)
- [JSON-RPC 2.0](https://www.jsonrpc.org/specification)
- [JSON Schema 2020-12](https://json-schema.org/draft/2020-12)
- [MCP 2025-06-18 lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)
- [MCP 2026-07-28 changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog) and [official Rust SDK compatibility](https://github.com/modelcontextprotocol/rust-sdk)
