import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_SKILL_SCAN_LIMITS,
  SkillScanError,
  scanSkillLibrary,
  type SkillCatalog,
  type SkillRejectionCode,
} from "../../../src/extensions/skill/skill-catalog.js";
import { renderSkillModuleDescription } from "../../../src/extensions/skill/skill-description.js";
import {
  createTemporaryRoot,
  removeTemporaryRoot,
  skillFile,
  writeLibraryFile,
  writeSkill,
} from "./fixtures/skill-library.js";

const roots: string[] = [];

function newLibrary(): string {
  const root = createTemporaryRoot();
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) removeTemporaryRoot(roots.pop()!);
});

function rejectionCodes(catalog: SkillCatalog): readonly SkillRejectionCode[] {
  return catalog.rejections.map((rejection) => rejection.code);
}

function rejectionFor(catalog: SkillCatalog, subject: string) {
  return catalog.rejections.find((rejection) => rejection.subject === subject);
}

describe("skill library scan: valid discovery", () => {
  it("parses an Agent Skills directory into a bounded catalog entry", () => {
    const library = newLibrary();
    writeLibraryFile(
      library,
      "pdf-processing/SKILL.md",
      skillFile([
        "name: pdf-processing",
        "description: Extract PDF text, fill forms, merge files. Use when handling PDFs.",
        "license: Apache-2.0",
        "compatibility: Requires Python 3.14+ and uv",
        "allowed-tools: Bash(git:*) Read",
        "metadata:",
        "  author: example-org",
        '  version: "1.0"',
      ]),
    );

    const catalog = scanSkillLibrary({ libraryRoot: library });

    expect(catalog.rejections).toEqual([]);
    expect(catalog.entries).toHaveLength(1);
    expect(catalog.entries[0]).toMatchObject({
      skillId: "pdf-processing",
      name: "pdf-processing",
      description:
        "Extract PDF text, fill forms, merge files. Use when handling PDFs.",
      compatibility: "Requires Python 3.14+ and uv",
      entryResource: "pdf-processing/SKILL.md",
    });
    expect(catalog.entries[0]!.entryDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(catalog.formatId).toBe("agentskills.io/specification");
    expect(catalog.formatRevision).toBe("2026-07-26");
  });

  it("never surfaces allowed-tools as a Dolly capability", () => {
    const library = newLibrary();
    writeSkill(library, "danger", {
      extraFrontmatter: ["allowed-tools: Bash(rm:*) Write"],
    });

    const catalog = scanSkillLibrary({ libraryRoot: library });
    const rendered = renderSkillModuleDescription(catalog);

    expect(catalog.entries).toHaveLength(1);
    expect(JSON.stringify(catalog.entries[0])).not.toContain("Bash");
    expect(rendered).not.toContain("Bash");
    expect(rendered).toContain("never grants a tool");
  });

  it("orders entries by identifier, not by filesystem enumeration order", () => {
    const library = newLibrary();
    writeSkill(library, "zebra");
    writeSkill(library, "alpha");
    writeSkill(library, "mango");

    const catalog = scanSkillLibrary({ libraryRoot: library });

    expect(catalog.entries.map((entry) => entry.skillId)).toEqual([
      "alpha",
      "mango",
      "zebra",
    ]);
  });

  it("finds a nested skill and uses its full relative path as the identifier", () => {
    const library = newLibrary();
    writeSkill(library, "vendor/team/formatter");

    const catalog = scanSkillLibrary({ libraryRoot: library });

    expect(catalog.entries.map((entry) => entry.skillId)).toEqual([
      "vendor/team/formatter",
    ]);
    expect(catalog.entries[0]!.entryResource).toBe("vendor/team/formatter/SKILL.md");
  });

  it("does not descend below a skill root, so bundled resources cannot become skills", () => {
    const library = newLibrary();
    writeSkill(library, "outer");
    writeSkill(library, "outer/references/inner");

    const catalog = scanSkillLibrary({ libraryRoot: library });

    expect(catalog.entries.map((entry) => entry.skillId)).toEqual(["outer"]);
    expect(catalog.rejections).toEqual([]);
  });

  it("produces the same revision digest for the same library and a different one after an edit", () => {
    const library = newLibrary();
    writeSkill(library, "alpha");

    const first = scanSkillLibrary({ libraryRoot: library });
    const second = scanSkillLibrary({ libraryRoot: library });
    expect(second.revisionDigest).toBe(first.revisionDigest);

    writeSkill(library, "alpha", { description: "A different description entirely." });
    const third = scanSkillLibrary({ libraryRoot: library });
    expect(third.revisionDigest).not.toBe(first.revisionDigest);
  });
});

describe("skill library scan: empty and missing libraries", () => {
  it("returns an empty catalog with no rejections for an empty library", () => {
    const library = newLibrary();

    const catalog = scanSkillLibrary({ libraryRoot: library });

    expect(catalog.entries).toEqual([]);
    expect(catalog.rejections).toEqual([]);
    expect(catalog.scannedByteLength).toBe(0);
    expect(renderSkillModuleDescription(catalog)).toContain(
      "No skills are currently available",
    );
  });

  it("fails with SKILL_LIBRARY_NOT_FOUND when the root does not exist", () => {
    const library = newLibrary();

    expect(() => scanSkillLibrary({ libraryRoot: join(library, "absent") }))
      .toThrowError(
        expect.objectContaining<Partial<SkillScanError>>({
          code: "SKILL_LIBRARY_NOT_FOUND",
        }),
      );
  });

  it("fails with SKILL_LIBRARY_INVALID when the root is an ordinary file", () => {
    const library = newLibrary();
    writeLibraryFile(library, "not-a-directory", "x");

    expect(() => scanSkillLibrary({ libraryRoot: join(library, "not-a-directory") }))
      .toThrowError(
        expect.objectContaining<Partial<SkillScanError>>({
          code: "SKILL_LIBRARY_INVALID",
        }),
      );
  });

  it("rejects a SKILL.md placed directly in the library root", () => {
    const library = newLibrary();
    writeLibraryFile(
      library,
      "SKILL.md",
      skillFile(["name: root-skill", "description: Should not be a skill."]),
    );

    const catalog = scanSkillLibrary({ libraryRoot: library });

    expect(catalog.entries).toEqual([]);
    expect(rejectionFor(catalog, "SKILL.md")?.code).toBe("SKILL_PATH_INVALID");
  });
});

describe("skill library scan: front matter validation", () => {
  it("rejects a file with no front matter fence", () => {
    const library = newLibrary();
    writeLibraryFile(library, "plain/SKILL.md", "# Just markdown\n\nNo front matter.\n");

    const catalog = scanSkillLibrary({ libraryRoot: library });

    expect(catalog.entries).toEqual([]);
    expect(rejectionFor(catalog, "plain/SKILL.md")?.code).toBe(
      "SKILL_FRONTMATTER_MISSING",
    );
  });

  it("rejects an unterminated front matter fence", () => {
    const library = newLibrary();
    writeLibraryFile(
      library,
      "partial/SKILL.md",
      "---\nname: partial\ndescription: A half-written file.\n",
    );

    const catalog = scanSkillLibrary({ libraryRoot: library });

    expect(rejectionFor(catalog, "partial/SKILL.md")?.code).toBe(
      "SKILL_FRONTMATTER_MISSING",
    );
  });

  it.each([
    ["a YAML sequence", ["name: seq", "description: ok", "tags:", "  - one"]],
    ["a block scalar", ["name: seq", "description: |", "  multi", "  line"]],
    ["a tab character", ["name: seq", "description:\tvalue"]],
    ["a duplicate key", ["name: seq", "description: one", "description: two"]],
    ["a non mapping line", ["name: seq", "description: ok", "stray text"]],
  ])("rejects %s as malformed", (_label, frontmatter) => {
    const library = newLibrary();
    writeLibraryFile(library, "seq/SKILL.md", skillFile(frontmatter));

    const catalog = scanSkillLibrary({ libraryRoot: library });

    expect(catalog.entries).toEqual([]);
    expect(rejectionFor(catalog, "seq/SKILL.md")?.code).toBe(
      "SKILL_FRONTMATTER_MALFORMED",
    );
  });

  it.each([
    ["missing name", ["description: No name field here."]],
    ["uppercase name", ["name: Weather", "description: ok"]],
    ["consecutive hyphens", ["name: a--b", "description: ok"]],
    ["leading hyphen", ["name: -lead", "description: ok"]],
  ])("rejects %s", (_label, frontmatter) => {
    const library = newLibrary();
    writeLibraryFile(library, "weather/SKILL.md", skillFile(frontmatter));

    const catalog = scanSkillLibrary({ libraryRoot: library });

    expect(catalog.entries).toEqual([]);
    expect(rejectionFor(catalog, "weather/SKILL.md")?.code).toBe("SKILL_NAME_INVALID");
  });

  it("rejects a name that does not match its parent directory", () => {
    const library = newLibrary();
    writeLibraryFile(
      library,
      "weather/SKILL.md",
      skillFile(["name: forecast", "description: Mismatched directory name."]),
    );

    const catalog = scanSkillLibrary({ libraryRoot: library });

    expect(catalog.entries).toEqual([]);
    expect(rejectionFor(catalog, "weather/SKILL.md")).toMatchObject({
      code: "SKILL_NAME_INVALID",
      detail: expect.stringContaining("does not match its parent directory"),
    });
  });

  it("rejects a missing description and an over-long description", () => {
    const library = newLibrary();
    writeLibraryFile(library, "nodesc/SKILL.md", skillFile(["name: nodesc"]));
    writeLibraryFile(
      library,
      "toolong/SKILL.md",
      skillFile(["name: toolong", `description: ${"d".repeat(1025)}`]),
    );

    const catalog = scanSkillLibrary({ libraryRoot: library });

    expect(catalog.entries).toEqual([]);
    expect(rejectionFor(catalog, "nodesc/SKILL.md")?.code).toBe(
      "SKILL_DESCRIPTION_INVALID",
    );
    expect(rejectionFor(catalog, "toolong/SKILL.md")?.code).toBe(
      "SKILL_DESCRIPTION_INVALID",
    );
  });

  it("accepts a description of exactly the 1024 character upstream limit", () => {
    const library = newLibrary();
    writeLibraryFile(
      library,
      "atlimit/SKILL.md",
      skillFile(["name: atlimit", `description: ${"d".repeat(1024)}`]),
    );

    const catalog = scanSkillLibrary({ libraryRoot: library });

    expect(catalog.rejections).toEqual([]);
    expect(catalog.entries[0]!.description).toHaveLength(1024);
  });

  it("rejects a terminal escape sequence hidden in a description", () => {
    const library = newLibrary();
    const escape = String.fromCharCode(0x1b);
    writeLibraryFile(
      library,
      "sneaky/SKILL.md",
      skillFile(["name: sneaky", `description: harmless${escape}[31m red`]),
    );

    const catalog = scanSkillLibrary({ libraryRoot: library });

    expect(catalog.entries).toEqual([]);
    expect(rejectionFor(catalog, "sneaky/SKILL.md")?.code).toBe(
      "SKILL_ENCODING_INVALID",
    );
  });

  it("rejects a SKILL.md that is not valid UTF-8", () => {
    const library = newLibrary();
    writeLibraryFile(
      library,
      "binary/SKILL.md",
      Uint8Array.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe, 0x0a, 0x2d, 0x2d, 0x2d, 0x0a]),
    );

    const catalog = scanSkillLibrary({ libraryRoot: library });

    expect(catalog.entries).toEqual([]);
    expect(rejectionFor(catalog, "binary/SKILL.md")?.code).toBe(
      "SKILL_ENCODING_INVALID",
    );
  });

  it("rejects a second directory that claims an already used skill name", () => {
    const library = newLibrary();
    writeSkill(library, "a/dup");
    writeSkill(library, "b/dup");

    const catalog = scanSkillLibrary({ libraryRoot: library });

    expect(catalog.entries.map((entry) => entry.skillId)).toEqual(["a/dup"]);
    expect(rejectionFor(catalog, "b/dup")).toMatchObject({
      code: "SKILL_DUPLICATE_NAME",
      detail: expect.stringContaining("a/dup"),
    });
  });
});

describe("skill library scan: limits", () => {
  it("rejects invalid limit values with SKILL_LIMITS_INVALID", () => {
    const library = newLibrary();

    expect(() =>
      scanSkillLibrary({ libraryRoot: library, limits: { maxSkillCount: 0 } })
    ).toThrowError(
      expect.objectContaining<Partial<SkillScanError>>({ code: "SKILL_LIMITS_INVALID" }),
    );
    expect(() =>
      scanSkillLibrary({ libraryRoot: library, limits: { maxEntryFileBytes: 1.5 } })
    ).toThrowError(
      expect.objectContaining<Partial<SkillScanError>>({ code: "SKILL_LIMITS_INVALID" }),
    );
  });

  it("keeps the first skills in identifier order when the count limit is reached", () => {
    const library = newLibrary();
    writeSkill(library, "zebra");
    writeSkill(library, "alpha");
    writeSkill(library, "mango");

    const catalog = scanSkillLibrary({
      libraryRoot: library,
      limits: { maxSkillCount: 2 },
    });

    expect(catalog.entries.map((entry) => entry.skillId)).toEqual(["alpha", "mango"]);
    expect(rejectionFor(catalog, "zebra")).toMatchObject({
      code: "SKILL_LIMIT_EXCEEDED",
      detail: expect.stringContaining("maximum of 2 skills"),
    });
  });

  it("rejects a SKILL.md larger than the per-file limit without reading it", () => {
    const library = newLibrary();
    const smallBytes = writeSkill(library, "alpha");
    writeLibraryFile(
      library,
      "zebra/SKILL.md",
      skillFile(["name: zebra", "description: Big file."], "x".repeat(4096)),
    );

    const catalog = scanSkillLibrary({
      libraryRoot: library,
      limits: { maxEntryFileBytes: smallBytes },
    });

    expect(catalog.entries.map((entry) => entry.skillId)).toEqual(["alpha"]);
    expect(rejectionFor(catalog, "zebra/SKILL.md")?.code).toBe("SKILL_FILE_TOO_LARGE");
    // The oversized file is refused from its size alone; its bytes are never
    // pulled into memory, so they never reach the scanned total.
    expect(catalog.scannedByteLength).toBe(smallBytes);
  });

  it("stops reading at the total byte limit and says so", () => {
    const library = newLibrary();
    const alphaBytes = writeSkill(library, "alpha");
    writeSkill(library, "zebra");

    const catalog = scanSkillLibrary({
      libraryRoot: library,
      limits: { maxTotalBytes: alphaBytes },
    });

    expect(catalog.entries.map((entry) => entry.skillId)).toEqual(["alpha"]);
    expect(catalog.scannedByteLength).toBe(alphaBytes);
    expect(rejectionFor(catalog, "zebra/SKILL.md")).toMatchObject({
      code: "SKILL_LIMIT_EXCEEDED",
      detail: expect.stringContaining("byte library limit"),
    });
  });

  it("refuses to traverse below the directory depth limit", () => {
    const library = newLibrary();
    writeSkill(library, "group/deep");

    const shallow = scanSkillLibrary({
      libraryRoot: library,
      limits: { maxDirectoryDepth: 1 },
    });
    expect(shallow.entries).toEqual([]);
    expect(rejectionFor(shallow, "group/deep")).toMatchObject({
      code: "SKILL_LIMIT_EXCEEDED",
      detail: expect.stringContaining("depth limit 1"),
    });

    const deeper = scanSkillLibrary({
      libraryRoot: library,
      limits: { maxDirectoryDepth: 2 },
    });
    expect(deeper.entries.map((entry) => entry.skillId)).toEqual(["group/deep"]);
  });

  it("stops the walk at the visited entry budget and reports an incomplete catalog", () => {
    const library = newLibrary();
    writeSkill(library, "alpha");
    writeSkill(library, "mango");
    writeSkill(library, "zebra");

    const catalog = scanSkillLibrary({
      libraryRoot: library,
      limits: { maxVisitedEntries: 2 },
    });

    expect(catalog.entries).toEqual([]);
    expect(rejectionFor(catalog, "")).toMatchObject({
      code: "SKILL_LIMIT_EXCEEDED",
      detail: expect.stringContaining("the catalog is incomplete"),
    });
  });

  it("exposes finite defaults for every limit", () => {
    for (const [key, value] of Object.entries(DEFAULT_SKILL_SCAN_LIMITS)) {
      expect(Number.isSafeInteger(value), `${key} must be a safe integer`).toBe(true);
      expect(value, `${key} must be positive`).toBeGreaterThan(0);
    }
  });
});

describe("skill library scan: containment", () => {
  it("refuses to follow a link planted inside the library", () => {
    const outside = newLibrary();
    writeSkill(outside, "smuggled");
    const library = newLibrary();
    writeSkill(library, "legit");
    symlinkSync(
      outside,
      join(library, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const catalog = scanSkillLibrary({ libraryRoot: library });

    expect(catalog.entries.map((entry) => entry.skillId)).toEqual(["legit"]);
    expect(rejectionFor(catalog, "linked")).toMatchObject({
      code: "SKILL_SYMLINK_FORBIDDEN",
    });
  });

  it("refuses a SKILL.md that is a link rather than an ordinary file", () => {
    const outside = newLibrary();
    const target = join(outside, "SKILL.md");
    writeFileSync(target, skillFile(["name: linked", "description: Smuggled."]));
    const library = newLibrary();
    mkdirSync(join(library, "linked"));
    try {
      symlinkSync(target, join(library, "linked", "SKILL.md"), "file");
    } catch (error) {
      // Creating a file symlink on Windows needs a privilege this test cannot
      // assume. The directory link case above still covers containment there.
      expect((error as NodeJS.ErrnoException).code).toBe("EPERM");
      return;
    }

    const catalog = scanSkillLibrary({ libraryRoot: library });

    expect(catalog.entries).toEqual([]);
    expect(rejectionFor(catalog, "linked/SKILL.md")?.code).toBe(
      "SKILL_SYMLINK_FORBIDDEN",
    );
  });

  it("refuses a directory that canonicalizes outside the granted root", () => {
    const library = newLibrary();
    writeSkill(library, "swapped");
    const elsewhere = newLibrary();

    const catalog = scanSkillLibrary({
      libraryRoot: library,
      // Models the symlink swap race the lstat check alone cannot see: the
      // path passes the link check and then resolves somewhere else.
      canonicalizePath: (path) =>
        path.endsWith("swapped") ? join(elsewhere, "swapped") : path,
    });

    expect(catalog.entries).toEqual([]);
    expect(rejectionFor(catalog, "swapped")).toMatchObject({
      code: "SKILL_PATH_ESCAPE",
    });
  });

  it("refuses a SKILL.md that canonicalizes outside the granted root", () => {
    const library = newLibrary();
    writeSkill(library, "swapped");
    const elsewhere = newLibrary();

    const catalog = scanSkillLibrary({
      libraryRoot: library,
      canonicalizePath: (path) =>
        path.endsWith("SKILL.md") ? join(elsewhere, "SKILL.md") : path,
    });

    expect(catalog.entries).toEqual([]);
    expect(rejectionFor(catalog, "swapped/SKILL.md")).toMatchObject({
      code: "SKILL_PATH_ESCAPE",
    });
  });

  it("reports every rejection reason it encountered rather than skipping silently", () => {
    const library = newLibrary();
    writeSkill(library, "good");
    writeLibraryFile(library, "nofence/SKILL.md", "no front matter at all");
    writeLibraryFile(
      library,
      "mismatch/SKILL.md",
      skillFile(["name: other", "description: Wrong directory."]),
    );

    const catalog = scanSkillLibrary({ libraryRoot: library });

    expect(catalog.entries.map((entry) => entry.skillId)).toEqual(["good"]);
    expect(rejectionCodes(catalog).slice().sort()).toEqual([
      "SKILL_FRONTMATTER_MISSING",
      "SKILL_NAME_INVALID",
    ]);
  });
});
