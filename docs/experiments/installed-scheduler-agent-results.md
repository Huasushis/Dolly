# Installed Scheduler Agent vertical-slice results

Date: 2026-08-12 UTC

Sources:

- registered read-tool Agent: `43e4f6155b6b04c385e876a3992d8b13b2da7b4a`;
- task-switch/checkpoint Agent: `d51fc593d1681053ef67628aeec2d92c2b57ee8d`.

Environment: uniquely named disposable Ubuntu 24.04 systemd container

## Question

Can one integrity-checked installed Extension receive only Host-selected model
and read-only tool authority, be dispatched from a persistent Page by the
shared Scheduler, complete a grounded multi-turn task, atomically commit its
output, and then prove whole-control-group shutdown?

This combines two previously separate claims. The installed Linux integration
had proved Scheduler, package, FileCore, process-record, and control-group
behavior without model or tool authority. The general Agent experiment had
proved model/tool behavior in a real child process without the installed Linux
composition. Neither component result alone proved the combined path.

## Result

The exact Linux test passed with the following observed chain:

1. the installation registry copied and hashed the Agent package, after which
   the package source directory was deleted;
2. `FileCoreStateStore` persisted one input Block and Delivery;
3. `ModuleScheduler` dispatched one `READY_REACTIVE` Run;
4. the real installed child received active-Run `model-operation/v2` and
   `tool-invocation/v2` handles derived from the exact package, configuration,
   and permission-policy identifiers;
5. the Agent made four model calls, and every broker input had `stream=true`;
6. it discovered `deployment-note`, read it through two registered read-only
   tool rounds, and returned the grounded answer `EMBER-7421` citing that key;
7. the result coordinator committed one output and acknowledged the input;
8. the tool journal reopened with two complete rounds, and the effect-intent
   store contained eight terminal capability records;
9. orderly stop persisted the process as `stopped`, removed the exact Module
   control group, and the reopened Core and result files retained the commit.

The container reported cgroup v2 with the CPU, memory, and process-count
controllers, systemd 255, Node 20.20.2, Python 3.12.3, and an unprivileged
account with `Linger=yes`. The tracked source and dependencies were read-only;
`.env`, Git metadata, and owner checkout state were absent.

That first run revalidated downstream capacity recovery, manual Source
activation, and non-empty periodic activation, for 4/4 passing tests. The
runner created only the recorded container
`dolly-experiment-2721734-03d89d92`; exact post-run inspection returned absent.

The retained local transcript is
`artifacts/experiments/linux-core-service-ownership/container-2721734-20260812T102204Z/linux-integration.log`
with SHA-256
`f0edb4e3613203408ce764b1f1ab818c452d610cedc91170a30ff9dcfb3f8754`.
The environment and preflight files have SHA-256
`4c66ed875461b8796fc11fdb7f45f40d4d34a120b081b8afa1e6977bd942d3d5`
and
`ecf7fce3780e2b756cfc847409343f9dc3196b8e6f9da072679da4c713411c36`.

## Task switching with one simple checkpoint

The second question was whether the same installed Linux Scheduler chain could
stop relying on an Agent's active context for an interrupted task. One
installed child therefore processed three separate Scheduler Runs in order:

1. task A supplied a sourced `dolly.task-checkpoint/1`; the model returned a
   closed `store_checkpoint` action and the Host wrote exactly one private
   storage entry;
2. unrelated task B asked for `29 - 12`; it completed with answer `17` without
   any storage call, and the exact model messages contained neither task A's
   identifier nor its `canary-91` next-action target;
3. a later cue named task A but did not contain its checkpoint; the child used
   Host `list` and `get` operations, then the model returned the stored
   `{kind:"verify", target:"canary-91", reason:"check rollout health"}` action
   with the checkpoint key as its evidence.

All three model invocations had `stream=true`. The three Runs produced three
durable result commits and six terminal capability-effect records: three model
calls plus storage `set`, `list`, and `get`. After orderly stop, the exact
control group was absent; reopening the Core state, result repository, and
private store retained all three commits, the stopped process record, and the
single checkpoint entry.

The focused disposable-container run passed 6/6 cases in 13.17 seconds,
including the earlier capacity-recovery, registered-tool Agent, Source, and
periodic cases. It created only
`dolly-experiment-3008740-03cf7b06`; exact post-run inspection returned absent,
and its tracked-source snapshot was removed. The retained transcript is
`artifacts/experiments/linux-core-service-ownership/container-3008740-20260812T132623Z/linux-integration.log`
with SHA-256
`0b3cf6dc13f5d6f7aaab0d57257f1955daa530370de8201c09e18f240d00192f`.
Its environment and preflight hashes equal the first run's hashes above.

## What this does not prove

The model broker in this Linux lifecycle case is a deterministic Host fixture;
it verifies Dolly's streaming requirement and composition, not network SSE.
The separate owner-Aether Memory run supplies the real strict-SSE evidence.
These fixtures are not a broad Agent or Memory benchmark. The simple checkpoint
test demonstrates an explicit, sourced representation and cue-driven reload;
it does not identify the right retrieval, association, consolidation, or
automatic-resume design. The registered tool set remains read-only. The private
checkpoint policy permits bounded `set`, `list`, and `get`, but not delete,
ambient network, destructive operations, or approval-requiring tools.

The permission-policy registry is still an in-process operator input rather
than a persistent, revision-controlled product configuration. Ordinary process
isolation does not prevent ambient filesystem, network, or subprocess effects.
Instance schema version 9 cannot persist the complete Scheduler, Linux, or
permission-policy inputs. Windows and macOS process ownership are not proved.

`openDollyRuntime` continues to reject every configured Module with
`RUNTIME_MODULE_MIGRATION_REQUIRED`. This result closes the combined
product-before-bootstrap vertical counterexample; it is not authorization to
remove that safety condition.
