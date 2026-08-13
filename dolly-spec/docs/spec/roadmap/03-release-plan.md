# Release and compatibility plan

## Release stages

| Stage | Audience | Guarantee |
| --- | --- | --- |
| `dev` | contributors | storage/protocol may be reset; no compatibility claim |
| `alpha` | controlled testing | migrations exist; breakage announced; no unattended critical use |
| `beta` | external testers | protocol/config compatibility within beta minor line; backup required |
| `rc` | acceptance | only blocker fixes and compatible clarifications |
| `v1 stable` | users | documented support, migration, recovery, and deprecation policy |

## Versioned artifacts

Every release publishes compatible versions for:

- spec;
- Extension wire protocol and SDK;
- config schema;
- database schema/migration chain;
- event-journal schema;
- Asset metadata schema;
- model-profile registry;
- each reference Extension state schema;
- Web/CLI admin API.

When shipped, an optional profile additionally publishes its profile revision,
upstream compatibility evidence, configuration/schema bundle, private-state
migration chain, and conformance result. NapCatQQ releases pin the NapCat/
OneBot registry, canonical operation-key map, sanitizer, fixed ActionContract,
facade Activation-ledger, hub journal/effect-ledger, and owner-registry schema
revisions; Filter releases pin the score, smoothing, projection, and ledger
schema revisions.

Testament Corpora/plans/artifacts and LevelUpper wire/share/checkpoint formats
are independently versioned research artifacts. They MUST NOT reuse the stable
Extension protocol or Core schema version to imply promotion or wire
compatibility.

## Upgrade

`REQ-REL-001` — Upgrade MUST perform preflight, verify free space and backup,
quiesce the instance, write a migration intent, migrate transactionally where
possible, verify invariants, then start new Extensions. Failure before cutover
restores the prior version. Failure after an irreversible cutover enters
`RecoveryRequired` with the exact supported recovery path.

`REQ-REL-002` — Extension replacement MUST negotiate state-schema support
before the old process is stopped. When no safe migration path exists, the
operator chooses an explicitly destructive reset; the system MUST NOT infer
consent.

## Downgrade

Downgrade is supported only when a release declares a tested reverse migration
and no committed data uses a newer irreversible capability. Otherwise the
command fails before mutation and directs the operator to restore a compatible
backup.

## Support matrix

The release manifest names exact OS architectures, minimum Rust-independent
runtime dependencies, external binaries such as FFmpeg, database format, and
provider profile revisions tested. “Best effort” platforms are clearly
separated from supported ones.
