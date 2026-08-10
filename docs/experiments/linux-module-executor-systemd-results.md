# Linux Module executor exit through systemd

## Result

At source commit `edbfd268478f65cb430aa5ece23c9dcd6634c872`, the
product `createLinuxModuleExecutor` passed the focused real-Linux test:

- 1 test file passed, with 1 test out of 1 passing.
- The systemd service main process ended with `ExecMainStatus=1`,
  `Result=exit-code`, and no signal.
- The fixture's separate fallback file was absent.
- The durable Module process record was left in `stopping`.
- The Core process, the launcher process, the Module control group, and the
  service control group were all observed to be gone.

The four-file real-Linux regression run then passed all 4 files and all 26
tests. It covered the launcher protocol, Module control-group handling,
attached descendants, and the focused product-executor/systemd test.

Both passing runs used a clean checkout of the same commit. The retained
environment record reports a cgroup version 2 filesystem, Python 3.12.3, and
an enabled systemd user manager with lingering.

## 2026-08-10 authorized-process identity regression

At source commit `de25be0bdb5cff57f392b1c6d64c3ffe52bac1e5`, a new
object-identity test required the ordered Linux start result to retain the exact
launcher whose membership was verified. The Linux executor now passes that
launcher, the same verified Module control group, and the same durable starting
record to its protocol-session factory. The platform-independent Linux
lifecycle regression passed 99 tests; two kernel-only tests were skipped in the
ordinary host shell as required.

The committed source was then archived into the uniquely named disposable
systemd container `dolly-experiment-813305-36e03163`. Two exact Linux test files
passed all 3 tests as the unprivileged `dolly` account:

- `linux-module-attached-process-integration.test.ts` proved real control-group
  descendant termination and the Extension protocol over the launcher's
  standard streams; and
- `linux-module-executor-systemd-integration.test.ts` proved the executor's
  nonzero Core-exit path and systemd cleanup of the unowned launcher.

The runner removed that exact container and its exact image. Raw output remains
under
`artifacts/experiments/linux-core-service-ownership/container-813305-20260810T025909Z/`
in the controlled workspace. Its key hashes are:

- `linux-integration.log`:
  `430949acb965991bd4b0ff9b1ef3761971663b0040006b598a4db841bdcf6ed9`;
- `source-commit.txt`:
  `ec90926fe8357b442546f4d19276d2fae211367223c9d5222909496285e0f3d7`;
- `environment.txt`:
  `4c66ed875461b8796fc11fdb7f45f40d4d34a120b081b8afa1e6977bd942d3d5`;
  and
- `preflight.txt`:
  `ecf7fce3780e2b756cfc847409343f9dc3196b8e6f9da072679da4c713411c36`.

This is a regression result, not the missing end-to-end product assembly. The
two real-Linux files exercise the executor and attached host in separate paths;
no startup caller yet constructs a real `ExtensionProcessHost` from the exact
authorized-process object.

## 2026-08-10 identity-bound Extension execution

At source commit `2b97b11b290f5e68f0cbc82a0722de4c19d6e017`, the
product-before-bootstrap `createLinuxExtensionModuleExecutor` closed that
specific assembly gap. It owns one reviewed launcher, retains the exact raw
child beside the launcher control object returned to the ordered lifecycle,
and constructs the attached `ExtensionProcessHost` only from the authorized
launcher, control group, and durable starting record. The public runtime still
does not call this factory and still rejects every configured Module.

The platform-independent construction and existing lifecycle regression first
passed 121 tests. The committed source was then archived into the uniquely
named disposable systemd container `dolly-experiment-827134-32dfde11`. As the
unprivileged `dolly` account, one real Linux test completed this exact chain:

1. persist one `starting` process record;
2. create one limited Module control group;
3. start the reviewed Python launcher and verify its membership from kernel
   files;
4. authorize it to replace itself with the real Node Extension fixture;
5. complete the Extension handshake and one `module.execute` over descriptors
   0 and 1;
6. receive `{ "processId": 327 }` from the same PID captured at authorization;
7. revoke the capability session, terminate the whole control group, observe
   the protocol channel close, remove the control-group directory, and write
   the same process record as `stopped`; and
8. prove that PID 327 with its captured process start time no longer existed.

The test passed 1/1 in 218 ms. Its exact Module control-group path was reported
as removed, and the result record was `stopped`. The runner then removed only
the exact container above and its exact image
`dolly-experiment-827134-32dfde11-image`; exact Docker inspection confirmed
both were absent.

Raw output remains under
`artifacts/experiments/linux-core-service-ownership/container-827134-20260810T032009Z/`.
Its key hashes are:

- `linux-integration.log`:
  `ba929672aa18d8a8a25388211d8de38e2b79980d2643aab02583389e787b3263`;
- `source-commit.txt`:
  `176c8524c3f113a0e01fe6f9498d967c6de371bcbcab89523fd1817fdf7fae4c`;
- `environment.txt`:
  `4c66ed875461b8796fc11fdb7f45f40d4d34a120b081b8afa1e6977bd942d3d5`;
  and
- `preflight.txt`:
  `ecf7fce3780e2b756cfc847409343f9dc3196b8e6f9da072679da4c713411c36`.

This closes the successful process-ownership and protocol assembly path, not
the product boundary. Installation lookup, runtime configuration, Scheduler
startup, capability budgets, durable external-effect outcomes, restart
reconciliation, and failure-matrix coverage remain incomplete. Therefore the
Module startup refusal is still required.

## 2026-08-10 identity-bound effect closure in the Linux process

At source commit `0d3bfd32461edf906d70167e977bfc22ee7a6cde`, the
same real-Linux chain was extended with persisted Core input and external-effect
state. Before execution, the test created one Page subscription, Block,
Delivery, and active Claim. After the reviewed launcher had become the durable
`running` process generation, it persisted the exact Module submission record:
Claim identity, attempt, Module and process generations, and canonical input
digest. The Host was therefore unable to authorize a different or invented
Run.

The committed source was archived into the uniquely named disposable systemd
container `dolly-experiment-855607-0702b18f`. As the unprivileged `dolly`
account, the test passed 1/1 and reported this sequence:

1. the Extension process with PID 327 executed the exact claimed input in its
   verified Module control group;
2. the Host stopped capability admission when the Module result arrived;
3. the durable effect journal atomically closed that exact Run with an empty
   effect set;
4. reopening the journal independently returned `no-effect` for the same
   Claim and no other Run;
5. ordered termination wrote the process record as `stopped`, removed the
   exact Module control group, and proved that PID 327 with its captured start
   identity no longer existed.

The exact container and image
`dolly-experiment-855607-0702b18f-image:latest` were then both absent on exact
Docker inspection. Raw output remains under
`artifacts/experiments/linux-core-service-ownership/container-855607-20260810T035723Z/`.
Its retained hashes are:

- `linux-integration.log`:
  `217eb65ae8979f34bbd54639a3781b2bf4764dd39de29de57d581b8c9e033295`;
- `source-commit.txt`:
  `f245406359adc7662ddd588104f0aeed9cdc5ef02edaeda673518d584918dbcb`;
- `source-snapshot.txt`:
  `f29a8edfeb13a57a80083bc82a8adf793bef64fb77af5d5a1818d6cdad3e8770`;
- `environment.txt`:
  `4c66ed875461b8796fc11fdb7f45f40d4d34a120b081b8afa1e6977bd942d3d5`;
- `preflight.txt`:
  `ecf7fce3780e2b756cfc847409343f9dc3196b8e6f9da072679da4c713411c36`;
- `command.txt`:
  `be5ccb2bfdafa1d78b1244571c0f62c3f6bc230e1e5ea735340c064b315c8b7b`;
  and
- `source-status.txt`:
  `3827ed29685b1d64326d4f3b1c120d18db18c96a9b08437e04efa3a6464711fd`.

This result combines the real Linux process boundary with a persisted,
identity-bound empty effect set. It still does not run the Scheduler or
`ReactiveModuleRuntime`, commit the Module result, exercise a nonempty
capability effect, or recover the same Run after a Core-process crash. It is a
product-before-bootstrap integration proof, not permission to remove
`RUNTIME_MODULE_MIGRATION_REQUIRED`.

## Failure path exercised

The launcher fixture deliberately does not write its process identifier to the
Module control group's `cgroup.procs` file. It nevertheless reports
`in-cgroup`, then ignores the launcher's protocol `exit` command. The product
adapter checks the kernel state, rejects this false pre-membership claim,
persists the `stopping` intent, performs bounded cleanup, and uses its default
nonzero Core exit.

The transient service uses `Restart=no`. This makes the observed status belong
to one service invocation and prevents a restart from hiding or replacing the
failure being tested. `KillMode=control-group` leaves systemd responsible for
removing the launcher that ignored the protocol exit after the Core process
ends.

## Counterexample

A counterexample mutation is a temporary, intentional production-code change
used to check that a test fails when the required behavior is removed. It is
not a proposed implementation.

The counterexample changed only
`src/adapters/linux-module-executor.ts`: the default `exitCoreProcess`
implementation returned instead of calling `process.exit(status)`. The test,
fixture, runner, and all other product files were unchanged. The retained
`mutation.patch`, `observed-mutation.diff`, source status, and input hashes make
that one-file change auditable.

With this change:

- the service main process ended with `ExecMainStatus=92`, not 1;
- the fixture wrote its fallback record with the reason
  `executor start rejected instead of ending Core`;
- the focused test failed on the expected `ExecMainStatus` difference; and
- the disposable-container test command returned status 1. The enclosing
  script required that exact failure and returned status 0 only after checking
  the status, fallback reason, source diff, and cleanup.

Status 92 is reserved by this fixture for the path where
`createLinuxModuleExecutor().start()` rejects instead of ending the Core
process. This result shows that the passing test reaches and requires the
product adapter's default exit function; it is not passing solely because of
the fixture or a test-only exit adapter.

## `ControlGroup` assertion correction

The first Linux run of the draft test required the value returned by
`systemctl show ... ControlGroup` after service termination to equal the live
service control-group path. That assertion was invalid. systemd may release an
empty unit control group before the completed unit's properties are queried,
in which case the retained property is an empty string. The final positive log
records exactly that valid state: `"ControlGroup":""`.

The corrected test captures the Core and launcher control-group paths from
`/proc` while both processes are alive. It derives the exact service path from
that live record, requires any nonempty retained `ControlGroup` value to agree
with it, and then waits for the exact Module and service filesystem paths to
disappear. This corrects the timing assumption without removing the process
membership or cleanup checks. The failed draft assertion is not presented as a
passing result in the evidence sets below.

## Retained evidence

All paths are relative to `docs/experiments/`.

| Run | Evidence directory | SHA-256 manifest | Key retained hashes |
| --- | --- | --- | --- |
| Focused positive run, 1/1 | `evidence/linux-module-executor-systemd-edbfd26/positive/` | `evidence/linux-module-executor-systemd-edbfd26/positive/SHA256SUMS` | `linux-integration.log`: `835f480d866f321310fe055216319b693857b91df23e1a8e0956580a0b390b06`; `source-commit.txt`: `483aac6c35db244e4972f22e62b924a464c0893e91fc771b4f5f4b9ac0851783` |
| Four-file regression, 26/26 | `evidence/linux-module-executor-systemd-edbfd26/four-file-regression/` | `evidence/linux-module-executor-systemd-edbfd26/four-file-regression/SHA256SUMS` | `linux-integration.log`: `d5d4a7d3ee0fcd556d411e8b82d854b317cf67f5e3f35b2f5f1a850aabf9029a`; `source-commit.txt`: `483aac6c35db244e4972f22e62b924a464c0893e91fc771b4f5f4b9ac0851783` |
| Default exit disabled, expected failure | `evidence/linux-module-executor-systemd-edbfd26/default-exit-disabled/` | `evidence/linux-module-executor-systemd-edbfd26/default-exit-disabled/SHA256SUMS` | `mutation.patch`: `58f802e24f5d73ac22e4676af7b0be20f5c73e62f72bce79c45d4a4b43f0774b`; `runner-console.log`: `bab118aca3188d736148f1dd0de9e631234de037041091979bb21020750cc914`; container `linux-integration.log`: `cde2249e5b60d07310978bfc94db8393b64701d76f11a234d81d471f9ce20ad0` |

Each `SHA256SUMS` file contains the SHA-256 digest for every other retained
file in its evidence directory. For the counterexample, this includes the
exact cleanup record, container and image inventories before and after the
run, the runner exit status, the one-file diff, the source status, and hashes
of every test input. The counterexample's exact disposable container and image
were removed; the cleanup record identifies them without relying on a broad
name match.

## Limits of the result

This evidence proves one specific fail-closed path: a launcher falsely reports
control-group membership before the kernel confirms it, ignores its protocol
exit command, and causes the product Linux Module executor's default Core exit
to terminate the service with status 1.

It does not prove:

- successful Module process startup or protocol execution;
- service restart, recovery, or reconciliation, because the test deliberately
  uses `Restart=no`;
- runtime startup wiring for `createLinuxModuleExecutor`;
- the production Core service-binding path; or
- other launcher failures before or after this false pre-membership case.

Those behaviors require separate product wiring and real-Linux tests. The
26/26 regression result establishes compatibility with the listed Linux test
files, not coverage beyond them.
