/**
 * Agent Skills `SKILL.md` front matter parsing for the Dolly Skill extension
 * baseline.
 *
 * External format source of truth
 * -------------------------------
 * The Agent Skills open standard, "Specification - The complete format
 * specification for Agent Skills", published at
 * <https://agentskills.io/specification> (machine-readable mirror
 * <https://agentskills.io/specification.md>), retrieved 2026-07-26.
 * Claude Code documents that its skills follow the same standard at
 * <https://code.claude.com/docs/en/skills>.
 *
 * The upstream document publishes no version number and no changelog page
 * (checked against <https://agentskills.io/llms.txt> on the same date), so this
 * implementation pins the format by retrieval date rather than inventing a
 * version identifier. See `AGENT_SKILLS_FORMAT_ID` and
 * `AGENT_SKILLS_FORMAT_REVISION`.
 *
 * Front matter fields defined by that specification:
 *
 * | Field           | Required | Constraints                                  |
 * | --------------- | -------- | -------------------------------------------- |
 * | `name`          | Yes      | 1-64 characters; lowercase alphanumeric      |
 * |                 |          | (`a-z`, `0-9`) and hyphens; must not start   |
 * |                 |          | or end with `-`; must not contain `--`; must |
 * |                 |          | match the parent directory name.             |
 * | `description`   | Yes      | 1-1024 characters; non-empty.                |
 * | `license`       | No       | License name or bundled license file name.   |
 * | `compatibility` | No       | 1-500 characters if provided.                |
 * | `metadata`      | No       | Map from string keys to string values.       |
 * | `allowed-tools` | No       | Space-separated tool list. (Experimental)    |
 *
 * Deliberate restrictions of this baseline
 * ----------------------------------------
 * - Only a restricted YAML subset is accepted: `key: value` scalars at the top
 *   level plus one level of nested `key: value` scalars, which is exactly what
 *   the specification's own examples use. Block scalars, sequences, flow
 *   collections, anchors, aliases, tags, tabs, multi-line plain scalars, and
 *   duplicate keys are rejected as malformed rather than guessed at. Dolly has
 *   no YAML dependency, and silently misparsing untrusted text is worse than a
 *   visible rejection.
 * - `allowed-tools` is parsed and then discarded. Skill text can never grant a
 *   tool, a capability, or any host authority in Dolly; see
 *   `docs/spec/skill-extension.md` section 3.
 * - `license` and `metadata` are accepted for shape only and are never
 *   published in the Module description.
 */

/** Stable identifier of the external package format this baseline accepts. */
export const AGENT_SKILLS_FORMAT_ID = "agentskills.io/specification";

/**
 * Retrieval date of the pinned upstream specification. The upstream document
 * carries no version identifier, so the date is the pin.
 */
export const AGENT_SKILLS_FORMAT_REVISION = "2026-07-26";

/** The one file name the specification requires inside a skill directory. */
export const SKILL_ENTRY_FILE_NAME = "SKILL.md";

/** `name`: "Must be 1-64 characters". */
export const MAX_NAME_LENGTH = 64;

/** `description`: "Must be 1-1024 characters". */
export const MAX_DESCRIPTION_LENGTH = 1024;

/** `compatibility`: "Must be 1-500 characters if provided". */
export const MAX_COMPATIBILITY_LENGTH = 500;

/**
 * `name`: lowercase alphanumeric plus hyphens, no leading or trailing hyphen,
 * no consecutive hyphens. The upstream text says "unicode lowercase
 * alphanumeric characters" and then parenthesises the set as `a-z`, `0-9`; the
 * parenthesised ASCII set is authoritative here because it is the only
 * unambiguous reading and it is what the upstream examples use.
 */
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/**
 * Characters that must never reach a Module description: C0 controls, DEL, the
 * C1 next-line control, and the Unicode line and paragraph separators. They
 * enable terminal escape and log injection attacks and they break the
 * one-entry-per-line description format. See `docs/spec/skill-extension.md`
 * section 9.
 */
function containsForbiddenTextCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (
      code <= 0x1f ||
      code === 0x7f ||
      code === 0x85 ||
      code === 0x2028 ||
      code === 0x2029
    ) {
      return true;
    }
  }
  return false;
}

const BYTE_ORDER_MARK_CODE_POINT = 0xfeff;

const TOP_LEVEL_KEY_PATTERN = /^([A-Za-z0-9][A-Za-z0-9_-]*):(?:[ ](.*))?$/u;
const NESTED_KEY_PATTERN = /^([A-Za-z0-9][A-Za-z0-9_.-]*):(?:[ ](.*))?$/u;

export type SkillFrontmatterFailureCode =
  | "SKILL_FRONTMATTER_MISSING"
  | "SKILL_FRONTMATTER_MALFORMED"
  | "SKILL_NAME_INVALID"
  | "SKILL_DESCRIPTION_INVALID"
  | "SKILL_COMPATIBILITY_INVALID"
  | "SKILL_ENCODING_INVALID";

export interface SkillFrontmatterFailure {
  readonly ok: false;
  readonly code: SkillFrontmatterFailureCode;
  readonly detail: string;
}

export interface SkillFrontmatter {
  readonly name: string;
  readonly description: string;
  readonly compatibility: string | null;
}

export interface SkillFrontmatterSuccess {
  readonly ok: true;
  readonly frontmatter: SkillFrontmatter;
}

export type SkillFrontmatterResult = SkillFrontmatterSuccess | SkillFrontmatterFailure;

function failure(
  code: SkillFrontmatterFailureCode,
  detail: string,
): SkillFrontmatterFailure {
  return { ok: false, code, detail };
}

/** Counts Unicode code points, which is what "characters" means in the spec. */
function characterLength(value: string): number {
  let count = 0;
  for (const _character of value) count += 1;
  return count;
}

export type SkillTextResult =
  | { readonly ok: true; readonly text: string }
  | SkillFrontmatterFailure;

/**
 * Decodes UTF-8 strictly and strips one leading byte order mark. A skill file
 * that is not valid UTF-8 is rejected instead of being repaired with
 * replacement characters, because repaired text no longer matches the digest
 * that describes the file.
 */
export function decodeSkillText(bytes: Uint8Array): SkillTextResult {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    return failure(
      "SKILL_ENCODING_INVALID",
      `SKILL.md is not valid UTF-8: ${(error as Error).message}`,
    );
  }
  return {
    ok: true,
    text: text.codePointAt(0) === BYTE_ORDER_MARK_CODE_POINT ? text.slice(1) : text,
  };
}

interface FrontmatterSplit {
  readonly frontmatter: string;
  readonly body: string;
}

/**
 * Splits the `---` fenced front matter block. The specification requires that
 * `SKILL.md` "must contain YAML frontmatter followed by Markdown content", so a
 * file without both fences is not a skill file at all.
 */
function splitFrontmatter(text: string): FrontmatterSplit | null {
  const lines = text.split(/\r?\n/u);
  if (lines.length === 0 || lines[0] !== "---") return null;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === "---") {
      return {
        frontmatter: lines.slice(1, index).join("\n"),
        body: lines.slice(index + 1).join("\n"),
      };
    }
  }
  return null;
}

type ScalarResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly detail: string };

/**
 * Parses one YAML scalar from the restricted subset: a single-quoted string, a
 * double-quoted string with a fixed escape set, or a plain scalar. Constructs
 * this baseline does not implement are reported rather than guessed at.
 */
function parseScalar(raw: string): ScalarResult {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: "" };

  const first = trimmed[0]!;
  if (first === "'") {
    if (trimmed.length < 2 || !trimmed.endsWith("'")) {
      return { ok: false, detail: "unterminated single-quoted scalar" };
    }
    const inner = trimmed.slice(1, -1);
    // A doubled quote is the only escape YAML defines inside single quotes, so
    // any remaining apostrophe means the scalar was not actually terminated.
    if (inner.replaceAll("''", "").includes("'")) {
      return { ok: false, detail: "unbalanced quote inside a single-quoted scalar" };
    }
    return { ok: true, value: inner.replaceAll("''", "'") };
  }

  if (first === '"') {
    if (trimmed.length < 2 || !trimmed.endsWith('"')) {
      return { ok: false, detail: "unterminated double-quoted scalar" };
    }
    const inner = trimmed.slice(1, -1);
    let value = "";
    for (let index = 0; index < inner.length; index += 1) {
      const character = inner[index]!;
      if (character !== "\\") {
        if (character === '"') {
          return { ok: false, detail: "unescaped quote inside a double-quoted scalar" };
        }
        value += character;
        continue;
      }
      index += 1;
      const escape = inner[index];
      switch (escape) {
        case "\\":
        case '"':
        case "/":
          value += escape;
          break;
        case "n":
          value += "\n";
          break;
        case "r":
          value += "\r";
          break;
        case "t":
          value += "\t";
          break;
        default:
          return {
            ok: false,
            detail: `unsupported escape sequence \\${escape ?? "<end of scalar>"}`,
          };
      }
    }
    return { ok: true, value };
  }

  if (first === "|" || first === ">") {
    return { ok: false, detail: "block scalars are not supported by this baseline" };
  }
  if (first === "[" || first === "{") {
    return { ok: false, detail: "flow collections are not supported by this baseline" };
  }
  if (first === "&" || first === "*" || first === "!") {
    return { ok: false, detail: "anchors, aliases, and tags are not supported" };
  }
  if (first === "-" && (trimmed.length === 1 || trimmed[1] === " ")) {
    return { ok: false, detail: "sequences are not supported by this baseline" };
  }

  // Plain scalar: YAML ends it at a space followed by `#`, so the same rule
  // applies here.
  const commentIndex = trimmed.search(/\s#/u);
  const scalar = commentIndex === -1 ? trimmed : trimmed.slice(0, commentIndex);
  return { ok: true, value: scalar.trimEnd() };
}

type ParsedValue = string | ReadonlyMap<string, string>;

type MappingResult =
  | { readonly ok: true; readonly mapping: ReadonlyMap<string, ParsedValue> }
  | { readonly ok: false; readonly detail: string };

/** Parses the restricted YAML mapping subset described in this file's header. */
function parseRestrictedYamlMapping(source: string): MappingResult {
  const mapping = new Map<string, ParsedValue>();
  const lines = source.split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;
    index += 1;
    if (line.trim() === "") continue;
    if (line.includes("\t")) {
      return { ok: false, detail: "tab characters are not permitted in YAML front matter" };
    }
    if (line.trimStart().startsWith("#")) continue;
    if (line !== line.trimStart()) {
      return { ok: false, detail: "unexpected indented line at the top level" };
    }

    const match = TOP_LEVEL_KEY_PATTERN.exec(line);
    if (match === null) {
      return { ok: false, detail: 'line is not a supported "key: value" mapping entry' };
    }
    const key = match[1]!;
    if (mapping.has(key)) {
      return { ok: false, detail: `duplicate front matter key "${key}"` };
    }

    const rawValue = match[2] ?? "";
    if (rawValue.trim() !== "") {
      const scalar = parseScalar(rawValue);
      if (!scalar.ok) return { ok: false, detail: `${key}: ${scalar.detail}` };
      mapping.set(key, scalar.value);
      continue;
    }

    // An empty value introduces either an empty scalar or a nested mapping.
    const nested = new Map<string, string>();
    let nestedIndent: string | null = null;
    while (index < lines.length) {
      const candidate = lines[index]!;
      if (candidate.trim() === "") {
        index += 1;
        continue;
      }
      if (candidate.includes("\t")) {
        return { ok: false, detail: "tab characters are not permitted in YAML front matter" };
      }
      if (candidate === candidate.trimStart()) break;

      const indent = candidate.slice(0, candidate.length - candidate.trimStart().length);
      if (nestedIndent === null) nestedIndent = indent;
      if (indent !== nestedIndent) {
        return { ok: false, detail: `inconsistent indentation under "${key}"` };
      }
      index += 1;

      const body = candidate.slice(indent.length);
      if (body.startsWith("#")) continue;
      const nestedMatch = NESTED_KEY_PATTERN.exec(body);
      if (nestedMatch === null) {
        return {
          ok: false,
          detail: `nested block under "${key}" is not a supported "key: value" entry`,
        };
      }
      const nestedKey = nestedMatch[1]!;
      if (nested.has(nestedKey)) {
        return { ok: false, detail: `duplicate nested key "${key}.${nestedKey}"` };
      }
      const nestedScalar = parseScalar(nestedMatch[2] ?? "");
      if (!nestedScalar.ok) {
        return { ok: false, detail: `${key}.${nestedKey}: ${nestedScalar.detail}` };
      }
      nested.set(nestedKey, nestedScalar.value);
    }
    mapping.set(key, nestedIndent === null ? "" : nested);
  }

  return { ok: true, mapping };
}

function requireScalar(
  mapping: ReadonlyMap<string, ParsedValue>,
  key: string,
): string | null {
  const value = mapping.get(key);
  return typeof value === "string" ? value : null;
}

/**
 * Parses and validates one `SKILL.md` text against the pinned Agent Skills
 * specification. `directoryName` is the skill directory's own name, which the
 * specification requires `name` to match exactly.
 */
export function parseSkillFrontmatter(
  text: string,
  directoryName: string,
): SkillFrontmatterResult {
  const split = splitFrontmatter(text);
  if (split === null) {
    return failure(
      "SKILL_FRONTMATTER_MISSING",
      "SKILL.md does not open and close a `---` YAML front matter block",
    );
  }

  const parsed = parseRestrictedYamlMapping(split.frontmatter);
  if (!parsed.ok) {
    return failure("SKILL_FRONTMATTER_MALFORMED", parsed.detail);
  }

  const rawName = requireScalar(parsed.mapping, "name");
  if (rawName === null) {
    return failure(
      "SKILL_NAME_INVALID",
      parsed.mapping.has("name")
        ? "`name` must be a scalar string"
        : "required field `name` is missing",
    );
  }
  const name = rawName.trim();
  if (name.length === 0 || characterLength(name) > MAX_NAME_LENGTH) {
    return failure("SKILL_NAME_INVALID", `\`name\` must be 1-${MAX_NAME_LENGTH} characters`);
  }
  if (!NAME_PATTERN.test(name)) {
    return failure(
      "SKILL_NAME_INVALID",
      "`name` must use lowercase a-z, 0-9 and single hyphens, without a leading or trailing hyphen",
    );
  }
  if (name !== directoryName) {
    return failure(
      "SKILL_NAME_INVALID",
      `\`name\` "${name}" does not match its parent directory name`,
    );
  }

  const rawDescription = requireScalar(parsed.mapping, "description");
  if (rawDescription === null) {
    return failure(
      "SKILL_DESCRIPTION_INVALID",
      parsed.mapping.has("description")
        ? "`description` must be a scalar string"
        : "required field `description` is missing",
    );
  }
  const description = rawDescription.trim();
  if (description.length === 0) {
    return failure("SKILL_DESCRIPTION_INVALID", "`description` must be non-empty");
  }
  if (characterLength(description) > MAX_DESCRIPTION_LENGTH) {
    return failure(
      "SKILL_DESCRIPTION_INVALID",
      `\`description\` must be at most ${MAX_DESCRIPTION_LENGTH} characters`,
    );
  }
  if (containsForbiddenTextCharacter(description)) {
    return failure(
      "SKILL_ENCODING_INVALID",
      "`description` contains a control character or line separator",
    );
  }

  let compatibility: string | null = null;
  if (parsed.mapping.has("compatibility")) {
    const rawCompatibility = requireScalar(parsed.mapping, "compatibility");
    if (rawCompatibility === null) {
      return failure(
        "SKILL_COMPATIBILITY_INVALID",
        "`compatibility` must be a scalar string",
      );
    }
    compatibility = rawCompatibility.trim();
    const length = characterLength(compatibility);
    if (length === 0 || length > MAX_COMPATIBILITY_LENGTH) {
      return failure(
        "SKILL_COMPATIBILITY_INVALID",
        `\`compatibility\` must be 1-${MAX_COMPATIBILITY_LENGTH} characters when present`,
      );
    }
    if (containsForbiddenTextCharacter(compatibility)) {
      return failure(
        "SKILL_ENCODING_INVALID",
        "`compatibility` contains a control character or line separator",
      );
    }
  }

  // `license`, `metadata`, and `allowed-tools` are accepted and then dropped.
  // `allowed-tools` in particular never becomes a Dolly capability grant.
  return { ok: true, frontmatter: { name, description, compatibility } };
}
