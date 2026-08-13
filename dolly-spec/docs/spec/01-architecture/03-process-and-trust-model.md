# Process and trust model

## Required process topology

`REQ-PROC-001` — A normal installation contains one per-user `dollyd`, zero or
more Worker child processes, and zero or more Extension child processes per
Worker. A Worker owns exactly one running instance. A single Extension process
MAY host several Modules of the same Extension type when its manifest declares
that isolation mode; high-risk Extensions SHOULD run per Module.

Modules are logical actors, not OS threads. Different Modules MAY execute
concurrently. A Module MUST have at most one live Activation lease per
generation.

## Failure containment

- Extension crash: affected Modules become unavailable and restart according to
  crash policy; the Worker and committed data continue.
- Worker crash: `dollyd` records the exit and MAY restart it; the instance DB is
  recovered before Extensions start.
- Daemon crash: already-running Workers MUST terminate unless explicitly
  adopted using a versioned authenticated protocol; v1 uses parent-death
  containment and restarts cleanly.
- UI/CLI failure: no effect on instance execution.

`REQ-PROC-002` — Startup MUST acquire an exclusive per-instance OS lock before
opening the writable database. Failure returns `STORAGE_INSTANCE_LOCKED`;
it MUST NOT fall back to a second writer.

## Trust tiers

| Tier | Examples | Default trust |
| --- | --- | --- |
| Core | Worker/reference machine | trusted computing base |
| Control | `dollyd`, authenticated admin client | privileged but audited |
| Service | Asset/Model Gateway | least privilege, instance-scoped |
| Extension | LLM, Memory, Channel, third-party process | untrusted input producer |
| Content | Block text, Descriptor, Skill, Memory, provider/tool output | hostile data |
| External | URL, MCP, web, model provider, OSS | hostile and fallible |

Process separation alone grants no filesystem or network safety. Capability
policy and OS sandbox availability are defined by the threat model.

## No ambient authority

`REQ-PROC-003` — Extension processes MUST start with a cleaned environment,
closed unrelated handles, an instance-scoped working directory, no inherited
secrets, and only explicitly granted host capabilities. Host RPC authorization
is checked per call and bound to `{instance, extension_process, generation}`.
