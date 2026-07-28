/**
 * Bounded, deterministic Agent Skills catalog scanner for the Dolly Skill
 * extension baseline.
 *
 * Contract: `docs/spec/skill-extension.md` sections 4, 5, 9, and 10. Owner
 * requirement `OWNER-SKILL-001` in `docs/takeover/confirmed-user-requirements.md`
 * reduces the baseline to "update a description from Agent Skills-compatible
 * files and hot reload changes".
 *
 * What this scanner deliberately does NOT do:
 *
 * - it never calls a model or provider to decide what to inject or rank;
 * - it never executes a skill, a script, a shell command, or package code;
 * - it never reads anything except each candidate `SKILL.md`;
 * - it never grants a tool, a capability, a filesystem scope, or any other
 *   authority, no matter what the skill text asks for; and
 * - it never writes to the scanned library.
 *
 * Every rejection is reported in `SkillCatalog.rejections` rather than silently
 * skipped, so an operator can see why a skill did not appear.
 */

import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";

import { canonicalJsonDigest } from "../../core/canonical-json.js";
import {
  AGENT_SKILLS_FORMAT_ID,
  AGENT_SKILLS_FORMAT_REVISION,
  decodeSkillText,
  parseSkillFrontmatter,
  SKILL_ENTRY_FILE_NAME,
} from "./skill-frontmatter.js";

export type SkillScanErrorCode =
  | "SKILL_LIBRARY_NOT_FOUND"
  | "SKILL_LIBRARY_INVALID"
  | "SKILL_LIBRARY_UNREADABLE"
  | "SKILL_LIMITS_INVALID";

export class SkillScanError extends Error {
  constructor(
    readonly code: SkillScanErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SkillScanError";
  }
}

export type SkillRejectionCode =
  | "SKILL_SYMLINK_FORBIDDEN"
  | "SKILL_PATH_ESCAPE"
  | "SKILL_PATH_INVALID"
  | "SKILL_SPECIAL_FILE"
  | "SKILL_FILE_TOO_LARGE"
  | "SKILL_LIMIT_EXCEEDED"
  | "SKILL_READ_FAILED"
  | "SKILL_DUPLICATE_NAME"
  | "SKILL_FRONTMATTER_MISSING"
  | "SKILL_FRONTMATTER_MALFORMED"
  | "SKILL_NAME_INVALID"
  | "SKILL_DESCRIPTION_INVALID"
  | "SKILL_COMPATIBILITY_INVALID"
  | "SKILL_ENCODING_INVALID";

/**
 * One visibly refused candidate. `subject` is a library-relative POSIX path, or
 * the empty string for the library itself. Host paths never appear here because
 * they must not reach a Block or a Module description
 * (`docs/spec/skill-extension.md` section 2).
 */
export interface SkillRejection {
  readonly subject: string;
  readonly code: SkillRejectionCode;
  readonly detail: string;
}

export interface SkillCatalogEntry {
  /**
   * Stable identity of one skill: its library-relative POSIX directory path.
   * Section 4 requires that this is not derived from the display name alone,
   * so two directories declaring the same `name` stay distinguishable.
   */
  readonly skillId: string;
  readonly name: string;
  readonly description: string;
  readonly compatibility: string | null;
  /** Library-relative POSIX path of the skill's `SKILL.md`. Not a host path. */
  readonly entryResource: string;
  /** `sha256:` digest of the `SKILL.md` bytes only; resources are not read. */
  readonly entryDigest: string;
  readonly entryByteLength: number;
}

export interface SkillCatalog {
  readonly schemaVersion: "dolly.skill-catalog/1";
  readonly formatId: string;
  readonly formatRevision: string;
  readonly entries: readonly SkillCatalogEntry[];
  readonly rejections: readonly SkillRejection[];
  /** Digest over the whole revision; equal input libraries give equal digests. */
  readonly revisionDigest: string;
  readonly scannedDirectoryEntryCount: number;
  readonly scannedByteLength: number;
}

export interface SkillScanLimits {
  /** Maximum accepted catalog entries. */
  readonly maxSkillCount: number;
  /** Maximum directory entries examined during the whole walk. */
  readonly maxVisitedEntries: number;
  /** Maximum bytes of a single `SKILL.md`. */
  readonly maxEntryFileBytes: number;
  /** Maximum total bytes read across all accepted `SKILL.md` files. */
  readonly maxTotalBytes: number;
  /** Maximum directory depth below the library root that is traversed. */
  readonly maxDirectoryDepth: number;
}

/**
 * Defaults are finite and deliberately small; every one of them can be lowered
 * by configuration. Rationale for each value:
 *
 * - `maxSkillCount` 256: the upstream specification budgets roughly 100 tokens
 *   of always-loaded metadata per skill, so 256 skills is already far more than
 *   a bounded Module description can carry, and the description limit trims the
 *   rest deterministically.
 * - `maxVisitedEntries` 4096: bounds the walk itself against a wide or deeply
 *   fanned-out library, independently of how many skills are valid.
 * - `maxEntryFileBytes` 65536: the upstream specification recommends keeping
 *   `SKILL.md` under 500 lines and its body under about 5000 tokens; 64 KiB
 *   holds that comfortably, including non-Latin scripts, and still bounds one
 *   read.
 * - `maxTotalBytes` 4194304: `maxSkillCount` times 16 KiB, which is generous
 *   headroom for an average skill file while keeping one scan's total read work
 *   bounded.
 * - `maxDirectoryDepth` 4: the upstream layout is `skill-name/SKILL.md`, so
 *   depth 1 suffices for a flat library; depth 4 still allows a few grouping
 *   directories (for example `vendor/team/skill-name`) without inviting an
 *   unbounded tree walk.
 */
export const DEFAULT_SKILL_SCAN_LIMITS: SkillScanLimits = Object.freeze({
  maxSkillCount: 256,
  maxVisitedEntries: 4096,
  maxEntryFileBytes: 65536,
  maxTotalBytes: 4194304,
  maxDirectoryDepth: 4,
});

export interface SkillScanOptions {
  /** Absolute path of the one granted skill library root. */
  readonly libraryRoot: string;
  readonly limits?: Partial<SkillScanLimits>;
  /**
   * Canonicalization seam. It exists so the second-line containment check
   * against a symlink swap race can be exercised deterministically; production
   * callers must leave it unset so `realpathSync.native` is used.
   */
  readonly canonicalizePath?: (path: string) => string;
}

interface SkillCandidate {
  readonly skillId: string;
  readonly directoryName: string;
  readonly entryResource: string;
  readonly absoluteEntryPath: string;
  readonly byteLength: number;
}

interface WalkFrame {
  readonly absolute: string;
  readonly relative: string;
  readonly depth: number;
}

function compareByteWise(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Case-folding key used to detect duplicate skill names. It matches the
 * normalization used by the Extension installation registry so a library that
 * is portable there stays portable here.
 */
function normalizedCaseKey(value: string): string {
  return value.normalize("NFKC").toUpperCase().toLowerCase();
}

function isWithin(parent: string, candidate: string): boolean {
  const parentValue = process.platform === "win32" ? parent.toLowerCase() : parent;
  const candidateValue = process.platform === "win32"
    ? candidate.toLowerCase()
    : candidate;
  const difference = relative(parentValue, candidateValue);
  return difference === "" ||
    (!difference.startsWith("..") && !isAbsolute(difference));
}

/**
 * Rejects directory entry names that cannot safely become part of a
 * library-relative identifier: separators, NUL, control characters, the NTFS
 * alternate data stream separator, and the relative directory names.
 */
function isSafePathSegment(name: string): boolean {
  if (name.length === 0 || name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\") || name.includes(":")) return false;
  for (const character of name) {
    const code = character.codePointAt(0)!;
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

function resolveLimits(limits: Partial<SkillScanLimits> | undefined): SkillScanLimits {
  const merged: SkillScanLimits = { ...DEFAULT_SKILL_SCAN_LIMITS, ...limits };
  for (const [key, value] of Object.entries(merged)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new SkillScanError(
        "SKILL_LIMITS_INVALID",
        `Skill scan limit "${key}" must be a positive safe integer`,
      );
    }
  }
  return merged;
}

function digestBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Scans one granted library and returns an immutable catalog revision.
 *
 * Determinism: candidates are collected by a breadth-first walk whose children
 * are sorted at every level, then sorted again by `skillId`, and only then are
 * the count and byte limits applied. Filesystem enumeration order therefore
 * cannot change which skills are accepted or the order they appear in.
 */
export function scanSkillLibrary(options: SkillScanOptions): SkillCatalog {
  const limits = resolveLimits(options.limits);
  const canonicalizePath = options.canonicalizePath ?? realpathSync.native;
  const libraryRoot = resolve(options.libraryRoot);

  let rootMetadata;
  try {
    rootMetadata = lstatSync(libraryRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SkillScanError(
        "SKILL_LIBRARY_NOT_FOUND",
        "The configured skill library root does not exist",
        { cause: error },
      );
    }
    throw new SkillScanError(
      "SKILL_LIBRARY_UNREADABLE",
      "The configured skill library root could not be inspected",
      { cause: error },
    );
  }
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new SkillScanError(
      "SKILL_LIBRARY_INVALID",
      "The configured skill library root must be a real directory, not a link or a file",
    );
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = canonicalizePath(libraryRoot);
  } catch (error) {
    throw new SkillScanError(
      "SKILL_LIBRARY_UNREADABLE",
      "The configured skill library root could not be canonicalized",
      { cause: error },
    );
  }

  const rejections: SkillRejection[] = [];
  const candidates: SkillCandidate[] = [];
  const queue: WalkFrame[] = [{ absolute: canonicalRoot, relative: "", depth: 0 }];
  let queueIndex = 0;
  let visitedEntries = 0;
  let walkBudgetExhausted = false;

  while (queueIndex < queue.length && !walkBudgetExhausted) {
    const frame = queue[queueIndex]!;
    queueIndex += 1;

    let directoryEntries;
    try {
      directoryEntries = readdirSync(frame.absolute, { withFileTypes: true });
    } catch (error) {
      rejections.push({
        subject: frame.relative,
        code: "SKILL_READ_FAILED",
        detail: `directory could not be read: ${(error as NodeJS.ErrnoException).code ?? "unknown error"}`,
      });
      continue;
    }
    directoryEntries.sort((left, right) => compareByteWise(left.name, right.name));

    visitedEntries += directoryEntries.length;
    if (visitedEntries > limits.maxVisitedEntries) {
      rejections.push({
        subject: frame.relative,
        code: "SKILL_LIMIT_EXCEEDED",
        detail: `the scan stopped after ${limits.maxVisitedEntries} directory entries; the catalog is incomplete`,
      });
      walkBudgetExhausted = true;
      break;
    }

    const entryFile = directoryEntries.find(
      (entry) => entry.name === SKILL_ENTRY_FILE_NAME,
    );
    if (entryFile !== undefined) {
      // The library root is a container of skills, not a skill itself: the
      // upstream `name` rule has no parent directory to match against there.
      if (frame.depth === 0) {
        rejections.push({
          subject: SKILL_ENTRY_FILE_NAME,
          code: "SKILL_PATH_INVALID",
          detail: "the library root is a container of skill directories, not a skill itself",
        });
      } else {
        const candidate = inspectEntryFile(frame, canonicalizePath, canonicalRoot);
        if ("code" in candidate) rejections.push(candidate);
        else candidates.push(candidate);
        // A directory holding SKILL.md is a skill root; its subtree is skill
        // resources, never further skills. Nothing below it is traversed.
        continue;
      }
    }

    for (const entry of directoryEntries) {
      if (entry.isSymbolicLink()) {
        rejections.push({
          subject: joinRelative(frame.relative, entry.name),
          code: "SKILL_SYMLINK_FORBIDDEN",
          detail: "symbolic links and reparse points are never followed inside a skill library",
        });
        continue;
      }
      if (!entry.isDirectory()) continue;
      if (!isSafePathSegment(entry.name)) {
        rejections.push({
          subject: frame.relative,
          code: "SKILL_PATH_INVALID",
          detail: "a directory name contains a separator, a control character, or a stream separator",
        });
        continue;
      }
      const childRelative = joinRelative(frame.relative, entry.name);
      if (frame.depth + 1 > limits.maxDirectoryDepth) {
        rejections.push({
          subject: childRelative,
          code: "SKILL_LIMIT_EXCEEDED",
          detail: `directory depth limit ${limits.maxDirectoryDepth} reached; this subtree was not scanned`,
        });
        continue;
      }

      const childAbsolute = join(frame.absolute, entry.name);
      let childCanonical: string;
      try {
        childCanonical = canonicalizePath(childAbsolute);
      } catch (error) {
        rejections.push({
          subject: childRelative,
          code: "SKILL_READ_FAILED",
          detail: `directory could not be canonicalized: ${(error as NodeJS.ErrnoException).code ?? "unknown error"}`,
        });
        continue;
      }
      if (!isWithin(canonicalRoot, childCanonical)) {
        rejections.push({
          subject: childRelative,
          code: "SKILL_PATH_ESCAPE",
          detail: "the directory resolves outside the granted skill library root",
        });
        continue;
      }
      queue.push({
        absolute: childCanonical,
        relative: childRelative,
        depth: frame.depth + 1,
      });
    }
  }

  candidates.sort((left, right) => compareByteWise(left.skillId, right.skillId));

  const entries: SkillCatalogEntry[] = [];
  const namesByCaseKey = new Map<string, string>();
  let scannedByteLength = 0;

  for (const candidate of candidates) {
    if (entries.length >= limits.maxSkillCount) {
      rejections.push({
        subject: candidate.skillId,
        code: "SKILL_LIMIT_EXCEEDED",
        detail: `the catalog already holds the maximum of ${limits.maxSkillCount} skills`,
      });
      continue;
    }
    if (candidate.byteLength > limits.maxEntryFileBytes) {
      rejections.push({
        subject: candidate.entryResource,
        code: "SKILL_FILE_TOO_LARGE",
        detail: `SKILL.md is ${candidate.byteLength} bytes; the limit is ${limits.maxEntryFileBytes}`,
      });
      continue;
    }
    if (scannedByteLength + candidate.byteLength > limits.maxTotalBytes) {
      rejections.push({
        subject: candidate.entryResource,
        code: "SKILL_LIMIT_EXCEEDED",
        detail: `reading this file would exceed the ${limits.maxTotalBytes} byte library limit`,
      });
      continue;
    }

    let bytes: Buffer;
    try {
      bytes = readFileSync(candidate.absoluteEntryPath);
    } catch (error) {
      rejections.push({
        subject: candidate.entryResource,
        code: "SKILL_READ_FAILED",
        detail: `SKILL.md could not be read: ${(error as NodeJS.ErrnoException).code ?? "unknown error"}`,
      });
      continue;
    }
    // `scannedByteLength` counts input/output actually performed, so it grows
    // as soon as the read succeeds. A file refused by the checks above is never
    // opened and therefore never appears in this total.
    scannedByteLength += bytes.byteLength;
    // The size seen during the walk can be stale, so the real bytes are checked
    // again before anything is parsed.
    if (bytes.byteLength > limits.maxEntryFileBytes) {
      rejections.push({
        subject: candidate.entryResource,
        code: "SKILL_FILE_TOO_LARGE",
        detail: `SKILL.md is ${bytes.byteLength} bytes; the limit is ${limits.maxEntryFileBytes}`,
      });
      continue;
    }

    const decoded = decodeSkillText(bytes);
    if (!decoded.ok) {
      rejections.push({
        subject: candidate.entryResource,
        code: decoded.code,
        detail: decoded.detail,
      });
      continue;
    }

    const parsed = parseSkillFrontmatter(decoded.text, candidate.directoryName);
    if (!parsed.ok) {
      rejections.push({
        subject: candidate.entryResource,
        code: parsed.code,
        detail: parsed.detail,
      });
      continue;
    }

    const caseKey = normalizedCaseKey(parsed.frontmatter.name);
    const previous = namesByCaseKey.get(caseKey);
    if (previous !== undefined) {
      rejections.push({
        subject: candidate.skillId,
        code: "SKILL_DUPLICATE_NAME",
        detail: `skill name "${parsed.frontmatter.name}" is already claimed by "${previous}"`,
      });
      continue;
    }
    namesByCaseKey.set(caseKey, candidate.skillId);

    entries.push({
      skillId: candidate.skillId,
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      compatibility: parsed.frontmatter.compatibility,
      entryResource: candidate.entryResource,
      entryDigest: digestBytes(bytes),
      entryByteLength: bytes.byteLength,
    });
  }

  rejections.sort((left, right) =>
    compareByteWise(left.subject, right.subject) ||
    compareByteWise(left.code, right.code) ||
    compareByteWise(left.detail, right.detail));

  const revisionDigest = canonicalJsonDigest({
    schemaVersion: "dolly.skill-catalog/1",
    formatId: AGENT_SKILLS_FORMAT_ID,
    formatRevision: AGENT_SKILLS_FORMAT_REVISION,
    entries: entries.map((entry) => ({ ...entry })),
    rejections: rejections.map((rejection) => ({ ...rejection })),
  });

  const catalog: SkillCatalog = {
    schemaVersion: "dolly.skill-catalog/1",
    formatId: AGENT_SKILLS_FORMAT_ID,
    formatRevision: AGENT_SKILLS_FORMAT_REVISION,
    entries: Object.freeze(entries),
    rejections: Object.freeze(rejections),
    revisionDigest,
    scannedDirectoryEntryCount: visitedEntries,
    scannedByteLength,
  };
  return Object.freeze(catalog);
}

function joinRelative(prefix: string, name: string): string {
  return prefix === "" ? name : `${prefix}/${name}`;
}

/**
 * Validates the `SKILL.md` of one skill directory without reading it: the file
 * must be an ordinary file that still resolves inside the granted root.
 */
function inspectEntryFile(
  frame: WalkFrame,
  canonicalizePath: (path: string) => string,
  canonicalRoot: string,
): SkillCandidate | SkillRejection {
  const entryResource = joinRelative(frame.relative, SKILL_ENTRY_FILE_NAME);
  const absoluteEntryPath = join(frame.absolute, SKILL_ENTRY_FILE_NAME);
  const directoryName = frame.relative.split("/").at(-1) ?? "";

  let metadata;
  try {
    metadata = lstatSync(absoluteEntryPath);
  } catch (error) {
    return {
      subject: entryResource,
      code: "SKILL_READ_FAILED",
      detail: `SKILL.md could not be inspected: ${(error as NodeJS.ErrnoException).code ?? "unknown error"}`,
    };
  }
  if (metadata.isSymbolicLink()) {
    return {
      subject: entryResource,
      code: "SKILL_SYMLINK_FORBIDDEN",
      detail: "SKILL.md is a symbolic link or reparse point",
    };
  }
  if (!metadata.isFile()) {
    return {
      subject: entryResource,
      code: "SKILL_SPECIAL_FILE",
      detail: "SKILL.md is not an ordinary file",
    };
  }

  let canonicalEntryPath: string;
  try {
    canonicalEntryPath = canonicalizePath(absoluteEntryPath);
  } catch (error) {
    return {
      subject: entryResource,
      code: "SKILL_READ_FAILED",
      detail: `SKILL.md could not be canonicalized: ${(error as NodeJS.ErrnoException).code ?? "unknown error"}`,
    };
  }
  if (!isWithin(canonicalRoot, canonicalEntryPath)) {
    return {
      subject: entryResource,
      code: "SKILL_PATH_ESCAPE",
      detail: "SKILL.md resolves outside the granted skill library root",
    };
  }

  return {
    skillId: frame.relative,
    directoryName,
    entryResource,
    absoluteEntryPath: canonicalEntryPath,
    byteLength: metadata.size,
  };
}
