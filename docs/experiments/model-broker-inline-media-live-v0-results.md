# Product-broker inline-image canary

Date: 2026-08-12

Experiment: `model-broker-inline-media-live-v0`, preregistration version 2

Frozen source commit: `f985dc6`

Backend fixture: owner's optional Aether deployment, model `qwen3.6-27b`

## Result

The version-two canary passed its one-case compatibility gate. Dolly's
`ChatModelBroker` authorized one delivered 640×360 local PNG, constructed the
inline provider request in the host, received one strict streaming response,
and returned the exact frozen JSON answer.

The request used:

- `stream=true` and `stream_options.include_usage=true`;
- `thinking.type=disabled`, with no `enable_thinking` field;
- `response_format.type=json_object`;
- one provider attempt and no non-stream fallback; and
- Dolly's own 1,800,000 ms application bound. The actual request finished in
  6.510 seconds. The owner's reported Nginx change from 120 seconds to 24 hours
  was not independently measured and is not used as Dolly's deadline.

The parsed answer exactly matched the title, nonce, three ordered labelled
boxes, checksum 20, and answer token 12. The response finished with `stop` and
reported `reasoningState=not-observed`; therefore this run is not evidence of
actual reasoning. The provider request was 29,147 bytes and the returned public
JSON content was 349 bytes.

The 21,283-byte PNG was re-inspected as `image/png`, 640×360, with digest
`sha256:bc238ff86859388b5b268df435a6d3a5083df998f572488ebf6852c067618d0e`.
After the request, the Media lease count and provider-access-record count were
both zero. The secret lease was released exactly once. The artifact verifier
found no exact endpoint or credential value and recorded zero Module processes.

Independent validation returned `valid=true` for the exact answer, strict
streaming wire, disabled-thinking object, absence of `enable_thinking`, absence
of observed reasoning, Media lease closure, and private-value scan.

## Preserved failed run

Version one (`68daa2f`, run `live-v0-20260812a`) failed locally before provider
dispatch because the experiment runner omitted the required `MediaStore.now`
dependency. Its manifest, failure result, and invalid validation are retained;
they record zero provider dispatches. Version two added the clock, moved private
configuration loading after local Media setup, used a new run identifier, and
did not reuse or overwrite the failed run.

## Artifacts

The private, git-ignored artifact root is
`artifacts/experiments/probes/model-broker-inline-media-live-v0/`.

For `live-v1-20260812a`:

| File | SHA-256 |
| --- | --- |
| `manifest.json` | `dfe0481d3f27079c04275641b34a574ab91afb720503e5034f053ecec3b8e30a` |
| `result.json` | `1d72e717268d0ac30d560d369a368cccf881f0de0172f9ce41f2b3264d2003a7` |
| `validation.json` | `261d138036f0192219917dc861912410ab8074703f988c11b39b4feffc394035` |

Artifacts contain only public fixture values, sizes, hashes, usage summaries,
wire booleans, and closed status fields. They omit the endpoint, credential,
headers, image bytes, data URL, response content, and reasoning text.

## Engineering decision and limits

This result promotes the exact endpoint/model-specific inline-PNG placement to
a candidate for the next separately preregistered multi-turn Agent demo. It
does not establish generic vision, another model, URL or object-storage media,
tool use, Memory, Scheduler integration, or public Module support. The public
Module startup refusal remains unchanged. Text-only compatible deployments
must continue to reject image input rather than inherit this profile.
