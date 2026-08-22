#!/usr/bin/env python3
"""Fast structural validation for the Dolly specification repository.

This script is deliberately dependency-light. If `jsonschema` is installed it
also checks each schema against its declared meta-schema. Semantic conformance
still belongs to the reference-machine and implementation test suites.
"""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[1]
NORMATIVE = ROOT / "docs" / "spec"
MARKER_RE = re.compile(r"\b(?:TODO|TBD|FIXME)\b|\?\?\?", re.IGNORECASE)
LINK_RE = re.compile(r"(?<!!)\[[^\]]+\]\(([^)]+)\)")
ID_RE = re.compile(r"\b(?:REQ|INV)-[A-Z0-9]+-[0-9]{3}\b")
SOURCE_HASHES = {
    "docs/owner-notes/01-dolly_new.txt": "1e9570f1b1328ad401c10973ce1ba85ad8c02712903c91de27a5f107dd3b3264",
    "docs/owner-notes/02-newnew.txt": "fa7696156bbb0cdf02bc595c3676a00ac4712e56f497bc056f5cff93cb1445c3",
    "docs/owner-notes/03-pro-conversation-clarification.txt": "927a866dac141076f20d735c617ae4a62d2b8e310d33792904277feec868bd72",
    "docs/owner-notes/04-memory-injection-clarification.txt": "eef595087ed9d36158b556e12930c182db9fdc0d9a23c009024366118234dd19",
    "docs/owner-notes/05-extension-and-future-clarification.txt": "e3b9bbd097cd513134d7d546818a24748bed41f7a9942925b34900343ab0ba8c",
    "docs/owner-notes/06-development-order-clarification.txt": "9cc9811e7df681c2d826ee4e78d06515d32c0de76331a8529a8a387b1ca19bca",
    "docs/baseline/gpt-5.6-pro-planning.md": "1651175cf8a5c65f7cda3cfcc966b338328ec08b60bbc517de8917c31ed90e8d",
}


class DuplicateKey(ValueError):
    pass


def reject_json_constant(value: str) -> None:
    raise ValueError(f"non-JSON numeric constant: {value}")


def no_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in pairs:
        if key in out:
            raise DuplicateKey(f"duplicate JSON key: {key}")
        out[key] = value
    return out


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(
            handle,
            object_pairs_hook=no_duplicates,
            parse_constant=reject_json_constant,
        )


def canonical_bytes(value: Any) -> bytes:
    """Return RFC 8785 bytes using the repository's required ECMAScript runtime."""
    source = json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    program = r"""
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
function canonical(input) {
  if (Array.isArray(input)) return `[${input.map(canonical).join(",")}]`;
  if (input !== null && typeof input === "object") {
    return `{${Object.keys(input).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(input[key])}`).join(",")}}`;
  }
  return JSON.stringify(input);
}
process.stdout.write(canonical(value));
"""
    return subprocess.run(
        ["node", "--input-type=module", "-e", program],
        input=source,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    ).stdout


ACTION_SET_VALIDATOR = {
    "id": "org.dolly.validator.module-descriptor-actions",
    "revision": 1,
}
ACTION_RESULT_VALIDATORS = {
    ("org.dolly.validator.channel-send-result", 1),
    ("org.dolly.validator.skills-result", 1),
    ("org.dolly.validator.alarm-result", 1),
    ("org.dolly.validator.memory-search-result", 1),
}


def iter_schema_refs(value: Any) -> list[str]:
    refs: list[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            if key == "$ref" and isinstance(child, str):
                refs.append(child)
            else:
                refs.extend(iter_schema_refs(child))
    elif isinstance(value, list):
        for child in value:
            refs.extend(iter_schema_refs(child))
    return refs


def schema_resource_index() -> dict[str, Path]:
    index: dict[str, Path] = {}
    for path in sorted((ROOT / "schemas").glob("*.json")):
        document = load_json(path)
        resource_id = document.get("$id") if isinstance(document, dict) else None
        if isinstance(resource_id, str):
            index[resource_id] = path
    return index


def schema_bundle(root_path: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    """Return the closed schema bundle and root resource for a local binding."""
    id_index = schema_resource_index()
    pending = [root_path.resolve()]
    visited: set[Path] = set()
    resources: dict[str, Any] = {}
    root_document: dict[str, Any] | None = None

    while pending:
        path = pending.pop()
        if path in visited:
            continue
        try:
            path.relative_to((ROOT / "schemas").resolve())
        except ValueError as exc:
            raise ValueError(f"schema dependency escapes schemas/: {path}") from exc
        document = load_json(path)
        if not isinstance(document, dict) or not isinstance(document.get("$id"), str):
            raise ValueError(f"schema resource lacks absolute $id: {path.relative_to(ROOT)}")
        resource_id = document["$id"]
        if resource_id in resources and resources[resource_id] != document:
            raise ValueError(f"duplicate schema resource $id: {resource_id}")
        resources[resource_id] = document
        visited.add(path)
        if path == root_path.resolve():
            root_document = document

        for raw_ref in iter_schema_refs(document):
            ref_base = raw_ref.split("#", 1)[0]
            if not ref_base:
                continue
            if "://" in ref_base:
                target = id_index.get(ref_base)
                if target is None:
                    raise ValueError(f"unresolved absolute schema dependency: {ref_base}")
            else:
                target = (path.parent / unquote(ref_base)).resolve()
                if not target.is_file():
                    raise ValueError(
                        f"missing schema dependency {ref_base!r} from {path.relative_to(ROOT)}"
                    )
            pending.append(target)

    if root_document is None:  # defensive; root is always first pending item
        raise ValueError(f"missing root schema resource: {root_path.relative_to(ROOT)}")
    bundle = {
        "schema": "dolly.schema-bundle/v1",
        "root": root_document["$id"],
        "resources": resources,
    }
    return bundle, root_document


def resolve_schema_fragment(document: Any, fragment: str) -> Any:
    if not fragment:
        return document
    decoded = unquote(fragment)
    if decoded.startswith("/"):
        current = document
        for raw_token in decoded[1:].split("/"):
            token = raw_token.replace("~1", "/").replace("~0", "~")
            if isinstance(current, dict) and token in current:
                current = current[token]
            elif isinstance(current, list) and token.isdigit() and int(token) < len(current):
                current = current[int(token)]
            else:
                raise ValueError(f"unresolved schema JSON Pointer fragment: #{fragment}")
        return current

    def find_anchor(value: Any) -> Any | None:
        if isinstance(value, dict):
            if value.get("$anchor") == decoded:
                return value
            for child in value.values():
                found = find_anchor(child)
                if found is not None:
                    return found
        elif isinstance(value, list):
            for child in value:
                found = find_anchor(child)
                if found is not None:
                    return found
        return None

    anchored = find_anchor(document)
    if anchored is None:
        raise ValueError(f"unresolved schema anchor fragment: #{fragment}")
    return anchored


def validate_action_contracts(label: str, descriptor: Any, errors: list[str]) -> None:
    if not isinstance(descriptor, dict):
        errors.append(f"{label}: Descriptor is not an object")
        return
    actions = descriptor.get("actions")
    if not isinstance(actions, list):
        errors.append(f"{label}: Descriptor actions is not an array")
        return

    names = [action.get("name") for action in actions if isinstance(action, dict)]
    for name, count in Counter(names).items():
        if isinstance(name, str) and count > 1:
            errors.append(
                f"{label}: semantic validator {ACTION_SET_VALIDATOR['id']}@"
                f"{ACTION_SET_VALIDATOR['revision']} rejects duplicate Action name {name}"
            )

    for action in actions:
        if not isinstance(action, dict):
            continue
        action_name = action.get("name", "<unknown>")
        for field in ("arguments_schema", "result_schema"):
            binding = action.get(field)
            if not isinstance(binding, dict):
                errors.append(f"{label}: {action_name} {field} is not a SchemaBinding")
                continue
            uri = binding.get("uri")
            if not isinstance(uri, str):
                errors.append(f"{label}: {action_name} {field}.uri is invalid")
                continue
            parsed = urlsplit(uri)
            if parsed.scheme:
                # Remote-looking identifiers are permitted only when their exact
                # installed bundle is outside this repository's fixture surface.
                continue
            if parsed.netloc or parsed.query:
                errors.append(f"{label}: {action_name} {field}.uri is not a safe local URI")
                continue
            schema_path = (ROOT / unquote(parsed.path)).resolve()
            try:
                schema_path.relative_to(ROOT.resolve())
            except ValueError:
                errors.append(f"{label}: {action_name} {field}.uri escapes repository")
                continue
            if not schema_path.is_file():
                errors.append(f"{label}: {action_name} has missing {field} resource {parsed.path}")
                continue
            try:
                bundle, root_document = schema_bundle(schema_path)
                selected = resolve_schema_fragment(root_document, parsed.fragment)
                if not isinstance(selected, (dict, bool)):
                    raise ValueError("fragment does not select a JSON Schema")
            except Exception as exc:  # noqa: BLE001 - aggregate repository errors
                errors.append(f"{label}: {action_name} invalid {field} bundle: {exc}")
                continue
            actual_digest = "sha256:" + hashlib.sha256(canonical_bytes(bundle)).hexdigest()
            if binding.get("schema_digest") != actual_digest:
                errors.append(
                    f"{label}: {action_name} {field}.schema_digest mismatch; "
                    f"expected {actual_digest}"
                )

            annotation_key = (
                "x-dolly-action-result-validator"
                if field == "result_schema"
                else "x-dolly-action-arguments-validator"
            )
            declared_validator = binding.get("semantic_validator")
            annotated_validator = root_document.get(annotation_key)
            if declared_validator != annotated_validator:
                errors.append(
                    f"{label}: {action_name} {field}.semantic_validator does not match "
                    f"{annotation_key}"
                )
            if isinstance(declared_validator, dict) and field == "result_schema":
                identity = (
                    declared_validator.get("id"),
                    declared_validator.get("revision"),
                )
                if identity not in ACTION_RESULT_VALIDATORS:
                    errors.append(
                        f"{label}: {action_name} unavailable result semantic validator "
                        f"{identity[0]}@{identity[1]}"
                    )


def json_depth(value: Any) -> int:
    if isinstance(value, dict):
        return 1 + max((json_depth(child) for child in value.values()), default=0)
    if isinstance(value, list):
        return 1 + max((json_depth(child) for child in value), default=0)
    return 0


def validate_json(errors: list[str], warnings: list[str]) -> None:
    json_files = sorted(ROOT.rglob("*.json"))
    schemas: list[tuple[Path, Any]] = []
    for path in json_files:
        if any(part in {"book", "dist", ".git"} for part in path.parts):
            continue
        try:
            doc = load_json(path)
        except Exception as exc:  # noqa: BLE001 - validator reports all inputs
            errors.append(f"{path.relative_to(ROOT)}: invalid JSON: {exc}")
            continue
        if path.parent.name == "schemas" or path.name.endswith(".schema.json"):
            if not isinstance(doc, dict) or "$schema" not in doc or "$id" not in doc:
                errors.append(f"{path.relative_to(ROOT)}: schema lacks $schema or $id")
            else:
                schemas.append((path, doc))

    try:
        import jsonschema  # type: ignore
    except ImportError:
        warnings.append("jsonschema package absent; skipped meta-schema validation")
        return

    for path, schema in schemas:
        try:
            jsonschema.Draft202012Validator.check_schema(schema)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{path.relative_to(ROOT)}: invalid Draft 2020-12 schema: {exc}")


def strip_code_fences(text: str) -> str:
    lines: list[str] = []
    fenced = False
    for line in text.splitlines():
        if line.lstrip().startswith("```"):
            fenced = not fenced
            continue
        if not fenced:
            lines.append(line)
    return "\n".join(lines)


def validate_markdown(errors: list[str]) -> Counter[str]:
    ids: Counter[str] = Counter()
    markdown = sorted((ROOT / "docs").rglob("*.md"))
    markdown += [ROOT / "README.md", ROOT / "CONTRIBUTING.md"]

    for path in markdown:
        text = path.read_text(encoding="utf-8")
        visible = strip_code_fences(text)
        relative = path.relative_to(ROOT)

        if path.is_relative_to(NORMATIVE):
            h1_count = sum(1 for line in text.splitlines() if line.startswith("# "))
            if h1_count != 1:
                errors.append(f"{relative}: normative document has {h1_count} H1 headings")
            headings = [
                re.sub(r"\s+#+$", "", line.lstrip("#").strip()).casefold()
                for line in text.splitlines()
                if re.match(r"^#{2,6} ", line)
            ]
            for heading, count in Counter(headings).items():
                if count > 1:
                    errors.append(f"{relative}: duplicate heading {heading!r}")
            marker = MARKER_RE.search(visible)
            if marker:
                errors.append(f"{relative}: unresolved marker {marker.group(0)!r}")

        ids.update(ID_RE.findall(visible))

        for raw_target in LINK_RE.findall(visible):
            target = raw_target.strip().split(maxsplit=1)[0].strip("<>")
            if target.startswith(("http://", "https://", "mailto:", "#")):
                continue
            target_path = target.split("#", 1)[0]
            if not target_path:
                continue
            resolved = (path.parent / target_path).resolve()
            try:
                resolved.relative_to(ROOT.resolve())
            except ValueError:
                errors.append(f"{relative}: link escapes repository: {target}")
                continue
            if not resolved.exists():
                errors.append(f"{relative}: missing link target: {target}")

    return ids


def validate_summary(errors: list[str]) -> None:
    summary = ROOT / "docs" / "SUMMARY.md"
    text = summary.read_text(encoding="utf-8")
    targets = [target.split("#", 1)[0] for target in LINK_RE.findall(text)]
    for target, count in Counter(targets).items():
        if target and count > 1:
            errors.append(f"docs/SUMMARY.md: duplicate chapter target {target}")


def validate_vectors(errors: list[str], known_ids: Counter[str]) -> None:
    fixture_ids: set[str] = set()
    for path in sorted((ROOT / "test-vectors" / "fixtures").glob("*.json")):
        relative = path.relative_to(ROOT)
        try:
            fixture = load_json(path)
        except Exception as exc:
            errors.append(f"{relative}: unreadable fixture: {exc}")
            continue
        if not isinstance(fixture, dict) or fixture.get("schema") != "dolly.test-fixture/v1":
            errors.append(f"{relative}: wrong or missing fixture schema")
            continue
        fixture_id = fixture.get("fixture_id")
        if not isinstance(fixture_id, str) or not re.fullmatch(
            r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*", fixture_id
        ):
            errors.append(f"{relative}: invalid fixture_id {fixture_id!r}")
        elif fixture_id in fixture_ids:
            errors.append(f"{relative}: duplicate fixture_id {fixture_id}")
        else:
            fixture_ids.add(fixture_id)

    paths = sorted((ROOT / "test-vectors").rglob("*.json"))
    paths = [
        path
        for path in paths
        if path.parent.name != "fixtures" and not path.name.endswith(".schema.json")
    ]
    if len(paths) < 8:
        errors.append(f"test-vectors: expected at least 8 executable vectors, found {len(paths)}")

    seen: set[str] = set()
    for path in paths:
        relative = path.relative_to(ROOT)
        try:
            vector = load_json(path)
        except Exception as exc:  # already reported by validate_json, keep context
            errors.append(f"{relative}: unreadable vector: {exc}")
            continue
        if not isinstance(vector, dict) or vector.get("schema") != "dolly.test-vector/v1":
            errors.append(f"{relative}: wrong or missing vector schema")
            continue
        test_id = vector.get("test_id")
        if not isinstance(test_id, str) or not re.fullmatch(r"TST-[A-Z]+-[0-9]{3}", test_id):
            errors.append(f"{relative}: invalid test_id {test_id!r}")
        elif test_id in seen:
            errors.append(f"{relative}: duplicate test_id {test_id}")
        else:
            seen.add(test_id)
        covers = vector.get("covers")
        if not isinstance(covers, list) or not covers:
            errors.append(f"{relative}: covers must be a non-empty list")
        else:
            for req_id in covers:
                if req_id not in known_ids:
                    errors.append(f"{relative}: unknown covered requirement {req_id}")
        expected = vector.get("expected")
        if not isinstance(expected, dict) or not expected.get("assertions"):
            errors.append(f"{relative}: expected.assertions must be non-empty")

        def fixture_references(value: Any) -> list[str]:
            refs: list[str] = []
            if isinstance(value, dict):
                for key, child in value.items():
                    if key in {"fixture", "draft_fixture"} and isinstance(child, str):
                        refs.append(child)
                    else:
                        refs.extend(fixture_references(child))
            elif isinstance(value, list):
                for child in value:
                    refs.extend(fixture_references(child))
            return refs

        for fixture_id in fixture_references(vector):
            if fixture_id not in fixture_ids:
                errors.append(f"{relative}: unknown fixture reference {fixture_id}")


def validate_examples(errors: list[str]) -> None:
    config_path = ROOT / "examples" / "runtime-config.minimal.json"
    if not config_path.is_file():
        errors.append("missing required file: examples/runtime-config.minimal.json")
        return
    config = load_json(config_path)
    spec = config["spec"]
    limits = spec["limits"]
    frame = limits["max_frame_bytes"]
    block = limits["max_block_bytes"]
    for module_id, module in spec["modules"].items():
        if module["descriptor"]["module_id"] != module_id:
            errors.append(f"example config: descriptor ID mismatch for {module_id}")
        validate_action_contracts(
            f"example config: {module_id}", module["descriptor"], errors
        )
        input_bytes = module["activation"]["max_input_bytes"]
        if block > input_bytes:
            errors.append(f"example config: max_block_bytes exceeds {module_id} input limit")
        activation = module["activation"]
        manifest_bound = (
            input_bytes
            + activation["max_descriptor_bytes"]
            + activation["manifest_structural_reserve_bytes"]
        )
        if manifest_bound > frame:
            errors.append(f"example config: {module_id} manifest bound exceeds frame")
        act = module["activation"]
        if act["retry_base_ms"] > act["retry_cap_ms"]:
            errors.append(f"example config: {module_id} retry base exceeds cap")
    asset = spec["services"]["asset"]
    if asset["max_inline_base64_chars"] + 65_536 > frame:
        errors.append("example config: inline base64 plus reserve exceeds frame")
    if asset["replica_retry"]["retry_base_ms"] > asset["replica_retry"]["retry_cap_ms"]:
        errors.append("example config: Asset replica retry base exceeds cap")
    gateway = spec["services"]["model_gateway"]
    if gateway["retry_base_ms"] > gateway["retry_cap_ms"]:
        errors.append("example config: Gateway retry base exceeds cap")
    for key, profile in gateway["profiles"].items():
        if profile["profile_id"] != key:
            errors.append(f"example config: profile map key mismatch for {key}")

    manifest_example = load_json(ROOT / "protocol" / "examples" / "valid-module-activate.json")
    manifest = manifest_example["params"]["manifest"]
    expected_digest = manifest["manifest_digest"]
    digest_input = {key: value for key, value in manifest.items() if key != "manifest_digest"}
    actual_digest = "sha256:" + hashlib.sha256(canonical_bytes(digest_input)).hexdigest()
    if actual_digest != expected_digest:
        errors.append("valid-module-activate.json: manifest_digest does not match canonical Manifest")
    frame_bytes = len(canonical_bytes(manifest_example))
    if frame_bytes > manifest["required_frame_bytes"]:
        errors.append("valid-module-activate.json: actual frame exceeds required_frame_bytes")
    if json_depth(manifest_example) > manifest["required_frame_nesting_depth"]:
        errors.append("valid-module-activate.json: actual frame exceeds required_frame_nesting_depth")

    fixture = load_json(
        ROOT
        / "test-vectors"
        / "fixtures"
        / "neighbor-is-both-input-producer-and-output-consumer.json"
    )
    validate_action_contracts(
        "neighbor descriptor fixture", fixture["value"]["source_descriptor"], errors
    )
    descriptor_digest = "sha256:" + hashlib.sha256(
        canonical_bytes(fixture["value"]["source_descriptor"])
    ).hexdigest()
    vector = load_json(
        ROOT / "test-vectors" / "core" / "TST-DESC-001-neighbor-projection.json"
    )
    if vector["initial"]["source_descriptor_digest"] != descriptor_digest:
        errors.append("TST-DESC-001: source_descriptor_digest does not match fixture")
    source = fixture["value"]["source_descriptor"]
    for group_name in ("emits", "accepts", "actions"):
        expected_group = next(
            (
                assertion["value"]
                for assertion in vector["expected"]["assertions"]
                if assertion["path"]
                == f"/manifest/neighbor_descriptors/0/projection/{group_name}"
            ),
            None,
        )
        if expected_group != source[group_name]:
            errors.append(
                f"TST-DESC-001: projection.{group_name} assertion does not equal "
                f"the fixture source {group_name} Contract/ActionContract group"
            )

    replay_vector = load_json(
        ROOT / "test-vectors" / "core" / "TST-CORE-009-activation-ledger-evidence.json"
    )
    for case_name, case in replay_vector["stimulus"]["cases"].items():
        evidence_command = next(
            (
                command
                for command in case["commands"]
                if command.get("command") == "RecordReplayEvidence"
            ),
            None,
        )
        if evidence_command is None:
            errors.append(f"TST-CORE-009 {case_name}: missing RecordReplayEvidence command")
            continue
        actual_evidence_digest = "sha256:" + hashlib.sha256(
            canonical_bytes(evidence_command["record"])
        ).hexdigest()
        if evidence_command.get("expected_evidence_digest") != actual_evidence_digest:
            errors.append(
                f"TST-CORE-009 {case_name}: replay evidence JCS digest mismatch"
            )


def validate_schema_refs(errors: list[str]) -> None:
    for path in sorted((ROOT / "schemas").glob("*.json")):
        text = path.read_text(encoding="utf-8")
        for ref in re.findall(r'"\\$ref"\s*:\s*"([^"#]+)', text):
            if "://" in ref:
                continue
            target = path.parent / ref
            if not target.exists():
                errors.append(f"{path.relative_to(ROOT)}: missing local $ref target {ref}")


def validate_required_files(errors: list[str]) -> None:
    required = [
        "README.md",
        "SPEC_VERSION.json",
        "book.toml",
        "docs/SUMMARY.md",
        "docs/spec/core/07-reference-abstract-machine.md",
        "docs/spec/extension-protocol/01-wire-protocol.md",
        "docs/spec/extensions/filter-two-thirds.md",
        "docs/spec/extensions/napcatqq.md",
        "docs/spec/research/testament.md",
        "docs/spec/research/levelupper.md",
        "docs/spec/verification/02-failure-matrix.md",
        "docs/baseline/REVIEW.md",
        "docs/baseline/SOURCE-MANIFEST.md",
        "docs/adrs/0015-runtime-authority-database.md",
        "schemas/block.schema.json",
        "schemas/activation-manifest.schema.json",
        "schemas/action-result.schema.json",
        "schemas/activation-status.schema.json",
        "schemas/activation-replay-evidence.schema.json",
        "schemas/extension-initialize-request.schema.json",
        "schemas/extension-initialize-result.schema.json",
        "schemas/alarm-action.schema.json",
        "schemas/alarm-result.schema.json",
        "schemas/channel-send-result.schema.json",
        "schemas/memory-search-result.schema.json",
        "schemas/memory-injection-decision.schema.json",
        "schemas/filter-signal.schema.json",
        "schemas/filter-config.schema.json",
        "schemas/filter-decision.schema.json",
        "schemas/napcatqq-mailbox-changed.schema.json",
        "schemas/napcatqq-config.schema.json",
        "schemas/napcatqq-action.schema.json",
        "schemas/napcatqq-result.schema.json",
        "schemas/testament-corpus-manifest.schema.json",
        "schemas/module-activation-premises.schema.json",
        "schemas/runtime-authority-record.schema.json",
        "schemas/testament-replay-plan.schema.json",
        "schemas/levelupper-share.schema.json",
        "schemas/levelupper-portable-block.schema.json",
        "schemas/levelupper-entry-envelope.schema.json",
        "schemas/levelupper-wire-control.schema.json",
        "schemas/skills-action.schema.json",
        "schemas/skills-result.schema.json",
        "protocol/examples/README.md",
        "protocol/examples/valid-extension-initialize.json",
        "protocol/examples/valid-extension-initialize-result.json",
        "test-vectors/README.md",
        "test-vectors/fixture.schema.json",
        "test-vectors/vector.schema.json",
        "test-vectors/core/TST-AUTH-004-config-revision-transaction-crash.json",
        "test-vectors/core/TST-AUTH-005-reopen-identity-digest.json",
        "test-vectors/core/TST-AUTH-006-stale-pointer-cross-origin.json",
        "tools/package_repo.py",
        "tools/validate_schemas.mjs",
        "tools/validate_research_domains.mjs",
    ]
    for item in required:
        if not (ROOT / item).is_file():
            errors.append(f"missing required file: {item}")


def validate_source_hashes(errors: list[str]) -> None:
    for relative, expected in SOURCE_HASHES.items():
        path = ROOT / relative
        if not path.is_file():
            errors.append(f"missing source evidence: {relative}")
            continue
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        if actual != expected:
            errors.append(
                f"{relative}: source-evidence SHA-256 changed; "
                f"expected {expected}, got {actual}"
            )


def main() -> int:
    errors: list[str] = []
    warnings: list[str] = []
    validate_required_files(errors)
    validate_source_hashes(errors)
    validate_json(errors, warnings)
    validate_schema_refs(errors)
    ids = validate_markdown(errors)
    validate_summary(errors)
    validate_vectors(errors, ids)
    validate_examples(errors)

    for req_id, count in sorted(ids.items()):
        if count > 8:
            warnings.append(f"{req_id} appears {count} times; check accidental reuse")

    for warning in warnings:
        print(f"WARN: {warning}")
    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        print(f"FAILED: {len(errors)} error(s), {len(warnings)} warning(s)")
        return 1
    print(f"OK: JSON, schemas, Markdown links, headings, and {len(ids)} requirement IDs")
    return 0


if __name__ == "__main__":
    sys.exit(main())
