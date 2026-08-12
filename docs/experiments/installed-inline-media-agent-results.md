# Installed inline-Media Agent integration result

Date: 2026-08-12 UTC

Successful source: `ad25d8d20235a6ab680259c7dab01d3ccef8c7fa`

Environment: uniquely named disposable Ubuntu 24.04 systemd container

## Question

Can the product-before-bootstrap installed Linux composition take a Media
reference delivered in one exact Scheduler Claim, authorize the corresponding
local PNG only for that active Run, invoke the product `ChatModelBroker` with
strict streaming, commit one result atomically, and then prove that its process
and resources reached terminal state?

This is an engineering integration test, not a model-efficacy experiment. Its
provider response is deterministic test data carried over the real strict-SSE
decoder. It makes no paid request and does not use an owner endpoint or secret.

## Result

The final focused integration passed 1/1 test in the disposable container
`dolly-experiment-3484117-d6f6c170`. The runner removed only that exact
container, and a post-run lookup found it absent.

The passing chain established all of the following in one execution:

- an installed package and validated configuration produced one real isolated
  Extension process and one Scheduler-driven Run;
- the input Claim delivered the only authorized Media reference;
- `model-operation/v3` exposed neither provider credentials nor a path, URL,
  data URL, access mode, or placement decision to the Extension;
- the Host-owned resolver required the exact active Claim, matching durable
  submission, running process record, and live process session;
- the product broker emitted one request with `stream=true`,
  `stream_options.include_usage=true`, `thinking.type=disabled`, no
  `enable_thinking`, JSON-object output, and one Host-constructed inline PNG;
- the strict-SSE decoder accepted one deterministic terminal response and the
  Module result coordinator committed one output exactly once;
- the input Claim was terminal, the effect journal contained one terminal
  outcome with a SHA-256 result digest, and no dead letter was created;
- Media leases and provider-access records were both zero at completion;
- the process record was durably `stopped`, its control group was removed, and
  reopening the stores preserved the stopped process and single committed
  result.

The structured test observation was:

```json
{"packageDigest":"sha256:3c30b0e88180eeb87efd9124a0c795ff00e4023d028210a5c1e204006b1f8723","moduleId":"installed-inline-media-agent","capabilityVersion":"v3","providerRequests":1,"strictSse":true,"inlineMediaBytes":12,"providerAccessRecords":0,"mediaLeases":0,"committedModuleResults":1,"finalRecordState":"stopped","cgroupRemoved":true}
```

Portable evidence is in
`docs/experiments/evidence/installed-inline-media-agent-ad25d8d/`. The retained
local raw log SHA-256 is
`1b0eb84734da4f04924c63e53c9e79127271876b06a4a74f352c89b49c88fbb2`.

## Retained counterexamples

Two earlier runs are retained instead of being overwritten:

1. Source `6a7af20599ebe61ef84ea900c85842ea7684f196`, container
   `dolly-experiment-3481628-6c715cbf`, failed before Module startup or provider
   dispatch. The test ran in a fork whose PID differed from the systemd service
   `MainPID`; the Core service binding correctly failed closed with
   `CORE_SERVICE_MAIN_PID_MISMATCH`. This caused the runner to place the file in
   the same worker-thread pool as the other real Core-service tests.
2. Source `0dc787e3842e1e50f67d05670b24b00a88fbd5e2`, container
   `dolly-experiment-3482843-6f01dfdc`, completed the functional chain but failed
   its final test oracle. The assertion required the nested effect outcome to
   equal only `{kind: "terminal"}`, while the valid record also carried the
   required `resultDigest`. Source `ad25d8d` replaced that false oracle with an
   exact count, terminal-kind check, and SHA-256 digest check.

Their raw log SHA-256 values are recorded in the evidence inventory. Neither
failed run was relabelled as passing evidence.

## Relation to the real-model result

The separate `scheduler-inline-media-agent-live-v0` result made one real
strict-streaming Aether request to the owner's qwen3.6-27b deployment and
obtained the expected image answer. That run used a real Extension and
Scheduler but did not prove the installed Linux control-group chain.

This result closes the complementary engineering composition gap with a
deterministic provider response. These two evidence layers must remain
separate: together they justify the next reversible slice, but they are not a
single run that proves both real model behavior and installed process
ownership.

## What this does not prove

This result does not prove public Module support, model intelligence, real
provider networking from the installed container, repeatability across models,
Windows or macOS execution, dynamic configuration, long-lived retry safety,
URL/OSS/provider-upload Media, browser control, or protection against a
same-UID child escaping its assigned delegated control group.

`openDollyRuntime` still refuses every configured Module with
`RUNTIME_MODULE_MIGRATION_REQUIRED`. This integration directly constructs the
candidate composition and does not remove, bypass, or weaken that guard.
