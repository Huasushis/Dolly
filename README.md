# Dolly

Dolly is a local-first runtime for connecting independent programs into one
information-processing graph. Programs publish immutable records to named
broadcast channels; other programs consume everything new on their channels as a
single batch and publish at most one record back.

> **Project status: early redesign. Dolly cannot run a Module yet.**
> An instance that lists any Module in its configuration refuses to start. What
> works today is the storage, delivery, and process-boundary machinery beneath
> that. See [What works today](#what-works-today) for the exact line between the
> two.

## The model

**Block** — one immutable information record, encoded as JSON. It has content the
producer wrote and identity the runtime assigned. Once committed it never
changes.

**Page** — a named broadcast channel plus its append-only history. Several
producers may append to one Page and several consumers may read it. Each consumer
keeps its own position, so a slow reader never blocks a fast one.

**Module** — one configured program in the graph, reading from some Pages and
writing to others. When it runs, it receives *everything* pending across *all* of
its input Pages as one ordered batch, and returns either nothing or exactly one
Block, which is broadcast to *every* one of its output Pages. One Module never
runs twice at the same time, and input that arrives mid-run waits for the next
run instead of joining the batch in flight.

**Description** — short text each Module publishes about what input it
understands and what output it produces. Before invoking a Module, the runtime
hands it the descriptions of its immediate neighbors. A Module can therefore
learn what the programs around it accept without being shown the graph or being
able to call them. This one is specified and not yet built.

An **Extension** is the reusable package; a **Module** is one configured instance
of it. One Extension can back many Modules with different configuration and
different connections.

That is the whole model. [The concepts guide](docs/guides/concepts.md) works
through it properly, with examples, and marks what is not running yet.

## What works today

Dolly is being rebuilt from an earlier prototype. The rebuild is deliberately
bottom-up: durable state and process isolation first, execution last. This is
what that means in practice.

**Built and covered by tests that were verified to run:**

- immutable Blocks with runtime-assigned identity, ordering, and provenance;
- Pages and Deliveries, with per-consumer positions, claims, acknowledgement,
  retry, and dead-letter handling;
- retention through strong references and access leases, rather than manual
  reference counting;
- Media registration and deletion, its stored bytes, and provider access records;
- a Module result commit journal that can recover an interrupted commit;
- the Extension process protocol — framing, session identity, lifecycle, quotas,
  and run-scoped capability checks — exercised against real child processes;
- Extension package installation, digest-checked resolution, and an installation
  registry;
- instance identity, configuration locking, and atomic configuration revisions;
- a private-by-default network exposure policy and a Console host gateway with
  pairing, session, origin, and cross-site protections;
- a foreground command-line interface.

**Specified but not built:** a running scheduler, Module descriptions, periodic
and source activation, every standard capability implementation (storage, Media,
model operations, tools), configuration migrations, daemon supervision, and
multi-instance management.

**Not available.** Each of these fails with a clear error rather than pretending:

- **Running a configured Module.** Startup fails with
  `RUNTIME_MODULE_MIGRATION_REQUIRED`. The isolated process runtime that would
  contain Extension code is unfinished, and the Linux process-ownership design
  ([ADR 0009](docs/adr/0009-linux-core-service-process-ownership.md)) is still
  `Proposed`.
- **Installing or running a third-party Extension.** There is no `dolly
  extension` command; it is refused with `CLI_FEATURE_UNAVAILABLE`.
- **Running Dolly as a background service.** `daemon`, `start`, `stop`,
  `restart`, and `status` are all refused with `CLI_FEATURE_UNAVAILABLE`. Only
  foreground `run` exists.
- **A chat console, web panel, or graph editor.** Not built. The Console
  contract is specified; the interface is not.
- **Editing configuration through the command line.** `config edit` is refused
  until revision-checked, schema-aware editing exists.
- **Running untrusted Extension code.** No platform sandbox backend passes its
  escape tests, so untrusted execution is refused rather than quietly downgraded
  to ordinary process isolation.

The `extensions/` directory holds Console, LLM, Memory, and Skill prototypes from
the earlier design. They are **legacy migration evidence**: excluded from the
package build, outside the public boundary, not covered by the supported test
suite, and not safe to expose to a network.

For the full picture by workstream, see
[the project roadmap](docs/takeover/project-roadmap.md).

## Requirements

- Node.js 20.9 or newer
- npm or pnpm

Linux is the primary platform for implementation and release validation. Windows
is supported as a secondary development platform. macOS is not currently a
release gate.

A Linux deployment that eventually runs executable Modules will also need a
Python 3 interpreter, because the reviewed child launcher must join a control
group, set its own open-file limit, and replace its own process image without
forking — which the installed Node.js runtime cannot do. That path is not enabled
yet.

## Quick start

```text
npm install
npm run build
node bin/dolly.js init --name "My Dolly"
node bin/dolly.js config show
node bin/dolly.js run
```

`init` writes `dolly.json` in the current directory, generates a fresh version 4
universally unique identifier (UUIDv4) as the instance identity, and registers
the instance. It prints the identifier, the configuration path, and the state
directory. State lives outside the repository by default.

`config show` validates the configuration and prints it with secrets redacted.

`run` starts the instance in the foreground and stays there until it receives an
interrupt (`SIGINT`) or termination (`SIGTERM`) signal, then shuts down cleanly.
With the default configuration — no Pages in use and no Modules — it starts,
holds its instance lock, and does nothing else. That is currently the whole
runtime experience, and it is worth knowing before you run it.

To run more than one instance, run `init` separately for each with a distinct
`--config` path so each gets its own identity and state directory.
[`dolly.example.json`](dolly.example.json) shows the document shape with Media
enabled, but its `instanceId` is a fixed placeholder — copying that file
unchanged for two instances gives them the same identity.

### Commands

| Command | What it does |
| --- | --- |
| `init` | Create and register a new local instance |
| `run` | Run an initialized instance in the foreground |
| `config show` | Validate and print the public configuration, with secrets redacted |
| `migrate-core-state` | Migrate a **stopped** instance's Core state to the current supported schema |
| `help` | Print usage |

Options: `--config <path>` (default `./dolly.json`), `--name <name>` (with `init`
only), `--confirm` (with `migrate-core-state` only), `-h` / `--help`, and
`-v` / `--version`.

Without `--confirm`, `migrate-core-state` only describes what it would do and
changes nothing and does not guess which older schema or backup suffix the state
file uses. With `--confirm` it takes the instance controller lock, then verifies
that the instance identity and configuration revision have not changed before it
derives the state path or writes anything. It validates the complete source
document against that claimed configuration, including the Delivery failure
limit and whether Media is enabled. It then keeps the exact original bytes in a
source-version-specific backup and reports the actual source schema, target
schema, and backup path returned by the migration.

An active Delivery Claim whose older state lacks an exact Module submission
record remains explicitly unresolved after migration. Startup reports
`STARTUP_ACTIVE_CLAIM_UNRESOLVED` instead of guessing whether sending was
authorized; resolving that uncertainty requires a separate audited operator
action. Dolly does not yet provide that operator command, so the affected
Module remains blocked.

### Configuration

`init` writes the closed `dolly.instance/9` schema. Unknown fields are rejected,
and fields removed in earlier schema versions are **not** accepted as aliases —
for example `core.limits.maxAttempts`, replaced by
`core.limits.maxFailedAttempts`, requires an explicit migration rather than being
silently reinterpreted.

Media starts disabled as `{"enabled": false}`. Enabling it requires the complete
set of limits shown in [`dolly.example.json`](dolly.example.json): per-item and
total byte ceilings, record-count ceilings for registrations, storage records and
provider access records, a deleted-registration retention interval, and bounds on
the input/output operations that move raw bytes into storage. Field names ending
in `Ms` are durations in milliseconds.

Every field is defined in
[the Core runtime contract, section 5.1](docs/spec/core-runtime.md).

## Development

```text
npm run typecheck
npm run build
npm test
npm run test:conformance
```

`npm test` is the supported suite and is deterministic: it must not reach a
non-loopback network endpoint, use a private service, or make a paid call. It may
use bounded loopback sockets and real local child processes, because some
contracts are only meaningfully tested across a real process boundary.

`npm run test:conformance` runs the contract tests under `tests/conformance/`
against injected identifiers, clocks, stores, and failure controls.

Two suites are excluded from the default run. `npm run test:legacy` exercises the
old in-process prototype and is kept for migration diagnosis only — it is not a
release gate and is not evidence that anything is safe. `npm run test:live`
requires explicit environment opt-in and may cost money. Details are in
[tests/README.md](tests/README.md).

Some Linux integration tests must run inside a delegated control group and will
otherwise skip. `scripts/run-linux-module-launcher-integration.sh` starts them in
a transient user service so they cannot silently skip; it installs nothing and
changes no system configuration.

## Documentation

- [Concepts](docs/guides/concepts.md) — Blocks, Pages, Deliveries, Modules,
  descriptions, Media, and retention, with examples.
- [Extension developer guide](docs/guides/extension-developer-guide.md) — the
  package manifest, process protocol, capability model, and conformance
  requirements.
- [Project roadmap](docs/takeover/project-roadmap.md) — every workstream with its
  state: built, specified, research, or untouched.
- [Linux deployment](docs/deployment/linux-headless.md) — the headless Ubuntu
  baseline, including desktop and browser prerequisites.
- [Computer use](docs/guides/computer-use.md) and
  [its security requirements](docs/security/computer-use.md) — intended behavior
  and the rules for exposing it.
- [Specification index](docs/spec/README.md) — the normative contract set and its
  authority order.
- [Architecture decision records](docs/adr/README.md) — decisions taken,
  including the ones that were rejected and why.
- [Open research questions](docs/research/open-research-questions.md) —
  hypotheses that must not become defaults before evidence supports them.

Every specification is a Draft unless it says `Accepted`. A Draft may use MUST
and SHOULD to state its intent precisely, but an implementation may not claim
conformance to it, and a Draft is not a release guarantee.

## Providers and private services

An endpoint and a model are configuration choices, not Extension dependencies. An
Extension must work for a deployment that has only a text embedding endpoint as
well as for one that can embed images, and it must declare which modalities it
accepts rather than inferring them from a provider's brand name. When image
embedding is unavailable, Dolly must expose that limitation and apply an
explicitly configured fallback — never claim an image was embedded when it was
not.

Whether a model actually reasoned is observed from each response, not assumed
from a configured parameter.

Remote object storage is optional and private by default. A private object needs
a short-lived signed web address when a remote provider must fetch it; the
existence of a URL never makes an object anonymously readable. A crop is a
logical reference and does not create a second stored object. Remote lifecycle
cleanup needs delete permission in addition to least-privilege upload and read
access.

No provider account, relay, credential, or bucket is required to install Dolly or
to run its ordinary tests.

## Public boundary

The package root exposes the command-line entry point. `dolly/sdk` currently
exports read-only JSON and Block content types only; it does **not** promise a
stable in-process Extension interface. The Extension boundary is a versioned
process protocol with session authorization, described in
[the extension developer guide](docs/guides/extension-developer-guide.md).

An ordinary child process is not an operating-system sandbox. Until a tested
sandbox backend exists for a platform, untrusted public Extensions stay
unsupported there.

## Contributing

Contributions are welcome. Read [AGENTS.md](AGENTS.md) first — it is short, and
it is enforced.

The rule that matters most: use established technical terms with their
conventional meanings. Do not invent a project-specific name when ordinary
language already describes the thing. When a project-specific term is genuinely
unavoidable, define it in plain language at its first authoritative use, saying
what it names, how it relates to concepts Dolly already has, and why an
established term is not sufficient. Use one name for one concept across source,
tests, specifications, and user-facing text.

Beyond that:

- A change that alters a public contract needs deterministic tests and a stated
  migration impact.
- A removed field is not an alias for its replacement. Say so, and provide a
  migration path.
- Do not add credentials, private endpoints, personal host paths, generated
  archives, or live-service assumptions to the repository.
- Do not describe a component test as end-to-end evidence. A passing test for one
  part does not mean the feature works.

Issue and pull request templates, a code of conduct, and a security disclosure
policy are not yet written.

## License

[MIT](LICENSE).
