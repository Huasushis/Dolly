# Reasoning Control Parameters Across Providers

Status: Draft

## 1. Purpose and authority

This document records a survey and a controlled measurement of the request-side
parameters that switch large language model (LLM) reasoning ("thinking") on and
off, and of the response-side field that proves reasoning actually ran.

It is research evidence, not a contract. It does not amend
`docs/spec/model-provider.md`. Section 8 lists gaps that the owner of that
specification may choose to address; this document does not change it.

It exists to settle one question raised by the project owner: is
`"thinking": {"type": "enabled"}` a portable control that Dolly can send
everywhere, or does Dolly need per-endpoint adaptation?

The short answer is in Section 6. It is: **no, it is not portable in general,
but it is the single correct control for every endpoint Dolly currently
targets.**

Measurements were taken on 2026-07-26. Documentation was retrieved on
2026-07-26. Endpoints are referred to as `<relay>` (the owner's Aether relay)
and `<bailian>` (Alibaba Cloud Model Studio / DashScope OpenAI-compatible
mode). No address, credential, or key appears in this document.

## 2. Method

Two endpoints were tested. Both serve a model whose identifier is exactly
`qwen3.6-27b`, so the comparison isolates the endpoint, not the model.

Every request used the same minimal body: one user message `"hi"`,
`max_tokens: 16`, non-streaming. Reasoning tokens are emitted before final
content, so a 16-token ceiling is sufficient to observe whether reasoning ran
and keeps paid usage negligible.

The measurement rule, applied without exception:

> Reasoning is treated as active only when the response message carries a
> non-empty `reasoning_content`. A request that is accepted is **not** evidence
> that the parameter in it had any effect.

Section 5.2 shows why that rule is mandatory rather than pedantic.

Twenty billable completion requests were made in total: ten against `<relay>`,
ten against `<bailian>`. Two non-billable `GET /models` listings were also made
to confirm that both endpoints publish the same `qwen3.6-27b` identifier.

## 3. Documented parameter shapes

Each row states what the provider's own documentation says. Rows marked
"measured" in Section 4 may differ; Section 5 lists the differences.

| Provider | Request field | Value shape | Depth / budget control | Documented default | Reasoning output field |
| --- | --- | --- | --- | --- | --- |
| DeepSeek | `thinking` | `{"type": "enabled" \| "disabled"}` | `reasoning_effort`: `high`, `max` | enabled | `reasoning_content` |
| Alibaba Model Studio (DashScope) | `enable_thinking` | boolean | `thinking_budget` (integer); `preserve_thinking` (boolean) | varies per model; some on, some off | `reasoning_content` |
| OpenAI | `reasoning` | `{"effort": "none" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max", "summary": ...}` | `effort` itself | model-dependent; `effort: "none"` disables | not returned; only optional summaries |
| Anthropic | `thinking` | `{"type": "enabled", "budget_tokens": N}` or `{"type": "adaptive"}` | `budget_tokens` (min 1024) or `output_config.effort` | off unless requested | `thinking` content block |
| Google Gemini | `generation_config.thinking_level` | `"minimal" \| "low" \| "medium" \| "high"` | the level itself | on for most current models | `thought` steps with `signature` / `summary` |

Sources, all retrieved 2026-07-26:

- DeepSeek, *Thinking Mode*, <https://api-docs.deepseek.com/guides/thinking_mode/>
- Alibaba Cloud Model Studio, *深度思考模型的用法*, <https://help.aliyun.com/zh/model-studio/deep-thinking>
- OpenAI, *Reasoning*, <https://developers.openai.com/api/docs/guides/reasoning>
- Anthropic, *Extended thinking*, <https://platform.claude.com/docs/en/docs/build-with-claude/extended-thinking>
- Google, *Gemini thinking*, <https://ai.google.dev/gemini-api/docs/thinking>

Four observations follow from the table alone, before any measurement:

1. The field **name** `thinking` is shared by DeepSeek and Anthropic, and the
   two mean different things by it. Anthropic has no `"disabled"` value —
   thinking is disabled by omitting the object — and its `"enabled"` requires a
   `budget_tokens` companion that DeepSeek does not accept.
2. Anthropic's newest models **reject** `{"type": "enabled"}` with HTTP 400 and
   require `{"type": "adaptive"}`. The same field with the same value is
   correct on one model of a provider and a hard error on the next.
3. OpenAI and Gemini have no boolean at all. Reasoning depth is an enum, and on
   OpenAI "off" is a member of that enum (`effort: "none"`) rather than a
   separate switch.
4. Only DeepSeek and Alibaba return raw reasoning text in `reasoning_content`.
   OpenAI returns none, and Anthropic and Gemini return structured blocks.
   `reasoning_content` is therefore an OpenAI-compatible-dialect convention,
   not a universal one.

## 4. Measured behavior

### 4.1 `<relay>` — Aether, `qwen3.6-27b`

| # | Request contains | HTTP | `reasoning_content` | `content` | finish |
| --- | --- | --- | --- | --- | --- |
| 1 | nothing (baseline) | 200 | **present**, 55 chars | empty | `length` |
| 2 | `enable_thinking: true` | 503 | — | — | rejected |
| 3 | `enable_thinking: false` | 503 | — | — | rejected |
| 4 | `thinking: {"type": "enabled"}` | 200 | **present**, 55 chars | empty | `length` |
| 5 | `thinking: {"type": "disabled"}` | 200 | absent | 32 chars | `stop` |
| 6 | `enable_thinking: false` **and** `thinking: {"type": "enabled"}` | 503 | — | — | rejected |
| 7 | `thinking: {"type": "bogus"}` | 503 | — | — | rejected |
| 8 | `dolly_not_a_real_param_xyz: true` | 503 | — | — | rejected |
| 9 | `thinking: {"type": "auto"}` | 503 | — | — | rejected |

Cases 3 and 8 were each re-run once and reproduced the same 503, so the
rejection is deterministic and not a transient upstream outage.

In cases 1 and 4 the entire 16-token allowance was consumed by reasoning, which
is why `content` is empty and `finish` is `length`. That is the expected shape
for a reasoning-on response under a tiny budget, and it does not weaken the
observation.

Findings:

- Reasoning is **on by default** on this endpoint (case 1).
- Reasoning **can be turned off** (case 5). This endpoint is therefore
  request-controlled, not always-on. The wording "reasoning is enabled by
  default" in `docs/takeover/confirmed-user-requirements.md` is correct but
  must not be read as "cannot be disabled".
- `thinking: {"type": ...}` is genuinely honored, not merely tolerated: case 4
  and case 5 produce opposite, correct outcomes.
- The relay **allowlists request body fields**. It rejects `enable_thinking`
  (cases 2, 3, 6), an invented field (case 8), an out-of-range `type` (case 7),
  and `"auto"` (case 9). The existing requirement "do not send
  `enable_thinking` to this endpoint" is a special case of a broader rule:
  *send no field this relay does not recognize.*
- The accepted value domain here is exactly `{"enabled", "disabled"}` — strictly
  narrower than `<bailian>`'s (Section 4.2, case 7).

### 4.2 `<bailian>` — DashScope compatible mode, `qwen3.6-27b`

| # | Request contains | HTTP | `reasoning_content` | `content` | reasoning tokens |
| --- | --- | --- | --- | --- | --- |
| 1 | nothing (baseline) | 200 | **present**, 853 chars | 37 chars | 235 |
| 2 | `enable_thinking: true` | 200 | **present**, 583 chars | 38 chars | 149 |
| 3 | `enable_thinking: false` | 200 | absent | 32 chars | 0 |
| 4 | `thinking: {"type": "enabled"}` | 200 | **present**, 613 chars | 37 chars | 152 |
| 5 | `thinking: {"type": "disabled"}` | 200 | absent | 32 chars | 0 |
| 6 | `enable_thinking: false` **and** `thinking: {"type": "enabled"}` | 200 | **present**, 827 chars | 32 chars | 235 |
| 7 | `thinking: {"type": "bogus"}` | 400 | — | — | rejected |
| 8 | `dolly_not_a_real_param_xyz: true` | 200 | **present**, 791 chars | 32 chars | 230 |
| 9 | `thinking: {"type": "auto"}` | 200 | absent | 32 chars | 0 |

Case 7 returned `invalid_parameter_error` with the message:

~~~text
'type' must be in ["enabled", "disabled", "auto"]
~~~

Findings:

- Reasoning is **on by default** on this endpoint (case 1).
- Both controls work independently and correctly (cases 2–5).
- **`thinking` overrides `enable_thinking` when both are sent** (case 6):
  `enable_thinking: false` combined with `thinking: {"type": "enabled"}`
  produced 235 reasoning tokens. The object form wins. Dolly must never send
  both and rely on a guess about precedence.
- The endpoint accepts a **third value, `auto`**, which no consulted
  documentation mentions. Case 9 shows `auto` produced no reasoning for the
  trivial prompt `"hi"`, consistent with "the model decides per request". This
  is a genuine tri-state, and Dolly's current directive vocabulary cannot
  express it (Section 8).
- The endpoint **silently ignores unknown top-level fields** (case 8): an
  invented parameter returned HTTP 200 with reasoning still active.

## 5. Where documentation and measurement disagree

This is the most important result of the investigation.

### 5.1 Alibaba Model Studio accepts an undocumented parameter

The official Model Studio page documents `enable_thinking`, `thinking_budget`,
and `preserve_thinking`. It documents **no `thinking` object as an input** —
`reasoning_content` appears there only as an output field. Yet `<bailian>`
accepts `thinking: {"type": ...}`, validates its value against a closed enum,
and lets it override the documented `enable_thinking`.

Two independent proofs that this is real support rather than accidental
tolerance:

1. Case 7 returns a **400 with an enum error naming all three legal values**.
   An ignored field cannot produce a value-domain error.
2. Cases 4, 5 and 9 produce three **different, correct** reasoning outcomes.
   An ignored field cannot change behavior.

The practical consequence: **the absence of a parameter from official
documentation is not evidence that the endpoint rejects it, and its presence is
not evidence that the endpoint accepts it.** Documentation is a starting
hypothesis, never a conclusion.

### 5.2 Acceptance does not imply effect — and the two endpoints fail in opposite directions

`<bailian>` silently ignores an invented field (4.2 case 8, HTTP 200, reasoning
still on). `<relay>` hard-rejects an invented field (4.1 case 8, HTTP 503).

These are mirror images, and each defeats a different naive inference:

- On `<bailian>`, **"the request succeeded" proves nothing.** Had `thinking`
  been unsupported there, cases 4 and 5 would still have returned HTTP 200 —
  and case 4 would still have shown reasoning, because reasoning is on by
  default. Only case 5 (reasoning turned *off*) and case 7 (enum error)
  distinguish real support from silent tolerance. A test that only ever asks
  for reasoning to be *enabled* on a default-on endpoint proves nothing at all.
- On `<relay>`, **"the request failed" does not identify what failed.** The 503
  message is a generic routing complaint ("no candidate provider completed the
  request") and is byte-identical for an invalid enum value, an unknown field
  name, and a genuine upstream outage.

### 5.3 A permanent request error arrives as a retryable status code

`<relay>` reports a permanent, deterministic request-shape rejection as **HTTP
503**. Under `docs/spec/model-provider.md` §4, 503 maps naturally to
`transient-server-failure`, which is listed in `RetryFeatures.safeConditions`.
A conforming broker would therefore retry a request that can never succeed,
burning the whole attempt budget and the wall-clock deadline before failing.

This is not a reasoning problem, but it was found by this investigation and it
affects any descriptor bound to this relay. It is recorded here for the owner of
the retry contract.

### 5.4 Same field name, incompatible semantics

`thinking` is used as an input object by DeepSeek, Anthropic, `<relay>`, and
`<bailian>`. The four do not agree:

| | `enabled` | `disabled` | `auto` / `adaptive` | budget companion |
| --- | --- | --- | --- | --- |
| DeepSeek | yes | yes | no | `reasoning_effort` (separate field) |
| `<relay>` | yes | yes | **rejected** | none |
| `<bailian>` | yes | yes | **`auto`** | `thinking_budget` (separate field) |
| Anthropic | yes, but **400 on newest models** | **no such value** | **`adaptive`** | `budget_tokens` **inside** the object |

A codec written against any one column is wrong for at least one other.

## 6. Direct answer to the owner's question

**Is `"thinking": {"type": "enabled"}` universal? No — but it is the right
single choice for Dolly's current fleet.**

Supported by evidence:

- It works, and is genuinely honored, on **both** endpoints Dolly targets for
  `qwen3.6-27b`, including the disable direction (`<relay>` 4.1 cases 4–5,
  `<bailian>` 4.2 cases 4–5).
- It is DeepSeek's documented control.
- It is the **only** form that works on `<relay>`, which rejects
  `enable_thinking` outright.
- On `<bailian>`, where both forms work, the object form takes precedence.

So for `<relay>` and `<bailian>` a single codec —
`thinking-object.enabled-disabled.v1`, already implemented in
`src/core/model-provider-chat.ts` — is correct and sufficient. Dolly does not
need a separate adaptation for these two endpoints today.

Bounded by evidence:

- It is **not** portable to OpenAI or Gemini, which have no such field.
- It is **not** portable to Anthropic: no `"disabled"` value exists, and the
  newest models return 400 for `"enabled"`.
- It is **not** portable to Alibaba models generally. `qwen3.6-27b` was
  measured; other Model Studio models were not, and the documented
  `enable_thinking` default differs per model.
- `deepseek-v4-flash` and `deepseek-v4-pro` are published by `<relay>` but were
  **not measured**. DeepSeek's documentation says the object form is correct,
  but per this document's own rule, that is a hypothesis until measured.

The generalization that actually holds is narrower than the owner's question
and more useful: **within the OpenAI-compatible dialect served by Chinese
providers, the `thinking` object is converging into a de facto standard that
outruns the published documentation.** Alibaba implements it without documenting
it, and implements it as a superset. That is a reason to prefer it, and not a
reason to assume it.

## 7. What Dolly should do

### 7.1 The existing architecture is sufficient

The descriptor-plus-`strategyId` design in `docs/spec/model-provider.md` §6.3
handles every case found here. Nothing in this investigation argues for
replacing it. Its central rule — features are declared for one exact
endpoint/model/operation tuple and never guessed from a name — is exactly the
rule that these measurements vindicate. Two endpoints serving a
character-for-character identical `modelId` disagree about which parameters are
legal, which values are legal, and how unknown fields are treated. Any design
keyed on provider family or model name would get at least one of them wrong.

### 7.2 Codecs required

For the fleet Dolly targets today, **one** codec is required and it already
exists:

| Codec | Wire form | Covers |
| --- | --- | --- |
| `thinking-object.enabled-disabled.v1` | `{"thinking": {"type": "enabled"\|"disabled"}}` | `<relay>` `qwen3.6-27b`, `<bailian>` `qwen3.6-27b`, DeepSeek (documented, unmeasured) |

`openai.enable-thinking.boolean.v1` is also implemented and remains correct for
`<bailian>` and for other Model Studio models, but no descriptor should select
it for `qwen3.6-27b` on either endpoint: it is fatal on `<relay>` and merely
redundant on `<bailian>`.

If Dolly later adds the providers surveyed in Section 3, **three** further
codecs would be needed — `reasoning.effort` (OpenAI), `thinking` with
`budget_tokens` / `adaptive` (Anthropic), and `thinking_level` (Gemini). None is
needed now, and none should be written before an endpoint is measured.

### 7.3 Expressing "on by default"

Both measured endpoints default to reasoning **on**. The descriptor cannot
currently say so, and this matters: `ReasoningWireDirective` includes `"omit"`,
and a consumer choosing `"omit"` has no declared way to know whether the result
will be reasoning-on, reasoning-off, or model-chosen. On both measured
endpoints `"omit"` means reasoning-on, which is the expensive outcome.

Until the specification provides a field for it (Section 8), descriptors for
these two endpoints should simply avoid `"omit"` and state the intent
explicitly with `"enable"` or `"disable"`.

Note also that `support: "always-on"` would be **wrong** for both endpoints.
Both default to on and both can be switched off. They are `request-controlled`.

### 7.4 Binding rules for descriptor authors

1. **Never infer a reasoning parameter from the provider name.** `<relay>` and
   `<bailian>` serve the same `modelId` and disagree.
2. **Never infer it from official documentation.** `<bailian>` supports a
   parameter its documentation omits (§5.1), and Anthropic documents a value its
   newest models reject.
3. **Never infer it from a successful request.** `<bailian>` returns HTTP 200
   for parameters it discards entirely (§5.2).
4. **Confirm with non-empty `reasoning_content`, and confirm both directions.**
   On a default-on endpoint only the *disable* case can distinguish a working
   control from an ignored one.
5. **Send exactly one reasoning control.** Where two are accepted, precedence is
   an endpoint-specific behavior (`<bailian>` lets the object win) that no
   descriptor should depend on.
6. **Re-measure when the endpoint changes.** These properties belong to the
   deployment, not to the model weights.

## 8. Gaps in the current reasoning contract

Reported for the owner of `docs/spec/model-provider.md` §6.3. This document
does not change that specification.

1. **No declared default.** `ReasoningWireFeatures` has no field stating what
   happens when the directive is `"omit"`. Both measured endpoints default to
   reasoning-on, and a consumer cannot discover that from the descriptor. A
   field such as `defaultWhenOmitted: "reasoning-on" | "reasoning-off" |
   "model-decides" | "unknown"` would close this.

2. **`enum-strategy` is unreachable end-to-end.** `requestControl` offers
   `{kind: "enum-strategy"}`, but `ReasoningWireDirective` is only
   `"omit" | "enable" | "disable"`. There is no way to carry *which* enum member
   was selected. `<bailian>`'s third value `auto` cannot be requested, and
   OpenAI's seven effort levels could not be expressed if that provider were
   added. Today `enum-strategy` can only encode a two-valued control, which
   makes it indistinguishable in practice from `boolean-strategy`.

3. **No depth or budget control.** Four of the five surveyed providers offer one
   (`reasoning_effort`, `thinking_budget`, `budget_tokens`, `thinking_level`).
   The contract has no place for any of them.

4. **`always-on` is ambiguous.** It reads naturally as both "reasoning cannot be
   disabled" and "reasoning is on unless you disable it". These measurements
   found the second case on both endpoints, where the correct value is
   `request-controlled`. A descriptor author following the looser reading would
   mislabel both, and Dolly would never disable reasoning it is paying for.

5. **Unknown-field tolerance is undeclared.** Whether an endpoint rejects or
   silently ignores unrecognized fields determines whether a misconfigured
   descriptor is detectable at all. `<relay>` and `<bailian>` sit at opposite
   extremes and the descriptor cannot express which.

6. **Retry classification can be actively harmful here.** See §5.3: `<relay>`
   returns HTTP 503 for permanent request-shape errors, which a conforming
   broker would classify as `transient-server-failure` and retry to exhaustion.

## 9. Reproducing this

The probes were throwaway scripts run from a scratch directory; they are not
part of the repository and no fixture was added under `tests/`. To reproduce,
send the bodies in the Section 4 tables to each endpoint's
`chat/completions` route with `max_tokens: 16` and the single user message
`"hi"`, and record HTTP status, `choices[0].message.reasoning_content`,
`choices[0].message.content`, and `usage`.

Any such run is a live paid provider test. Under
`docs/spec/model-provider.md` §10.2 it must not become a default or CI
dependency, and it requires explicit `RUN_LIVE_INTEGRATION=1` /
`RUN_PAID_INTEGRATION=1` opt-in if it is ever turned into a fixture.
