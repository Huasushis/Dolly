import { describe, expect, it } from "vitest";

import type {
  SkillCatalog,
  SkillCatalogEntry,
  SkillRejection,
} from "../../../src/extensions/skill/skill-catalog.js";
import {
  MIN_SKILL_DESCRIPTION_BYTES,
  SkillDescriptionError,
  renderSkillModuleDescription,
} from "../../../src/extensions/skill/skill-description.js";

function entry(index: number, description: string): SkillCatalogEntry {
  const name = `skill-${String(index).padStart(3, "0")}`;
  return {
    skillId: name,
    name,
    description,
    compatibility: null,
    entryResource: `${name}/SKILL.md`,
    entryDigest: `sha256:${String(index).padStart(64, "0")}`,
    entryByteLength: 256,
  };
}

function catalog(
  entries: readonly SkillCatalogEntry[],
  rejections: readonly SkillRejection[] = [],
): SkillCatalog {
  return {
    schemaVersion: "dolly.skill-catalog/1",
    formatId: "agentskills.io/specification",
    formatRevision: "2026-07-26",
    entries,
    rejections,
    revisionDigest: `sha256:${"ab".repeat(32)}`,
    scannedDirectoryEntryCount: entries.length,
    scannedByteLength: entries.length * 256,
  };
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

const LONG_DESCRIPTION =
  "Performs a bounded transformation over structured input and explains the " +
  "result. Use when the task mentions transformation, structured input, or a " +
  "bounded explanation of the outcome.";

describe("skill Module description rendering", () => {
  it("states that no skills exist for an empty catalog", () => {
    const text = renderSkillModuleDescription(catalog([]));

    expect(text).toContain("No skills are currently available");
    expect(text).toContain("agentskills.io/specification");
    expect(text).toContain("2026-07-26");
    expect(text).toContain(`sha256:${"ab".repeat(32)}`);
    expect(text).not.toContain("Omitted");
    expect(text).not.toContain("Refused");
  });

  it("renders one line per skill with its identifier and full description", () => {
    const text = renderSkillModuleDescription(
      catalog([entry(1, "Reads logs."), entry(2, "Writes reports.")]),
    );

    expect(text).toContain("- skill-001 [skill-001/SKILL.md]: Reads logs.");
    expect(text).toContain("- skill-002 [skill-002/SKILL.md]: Writes reports.");
    expect(text).toContain("2 skill(s) are available");
  });

  it("marks a declared compatibility requirement without granting anything", () => {
    const withCompatibility: SkillCatalogEntry = {
      ...entry(1, "Renders diagrams."),
      compatibility: "Requires graphviz",
    };

    const text = renderSkillModuleDescription(catalog([withCompatibility]));

    expect(text).toContain("(requires: Requires graphviz)");
    expect(text).toContain("never grants a tool");
  });

  it("produces byte identical text for the same catalog revision", () => {
    const source = catalog([entry(1, LONG_DESCRIPTION), entry(2, LONG_DESCRIPTION)]);

    expect(renderSkillModuleDescription(source)).toBe(
      renderSkillModuleDescription(source),
    );
  });

  it("stays inside the byte budget and names the skills it dropped", () => {
    const entries = Array.from({ length: 40 }, (_value, index) =>
      entry(index, LONG_DESCRIPTION));
    const maxBytes = 2048;

    const text = renderSkillModuleDescription(catalog(entries), { maxBytes });

    expect(byteLength(text)).toBeLessThanOrEqual(maxBytes);
    const included = entries.filter((candidate) =>
      text.includes(`- ${candidate.name} [`));
    expect(included.length).toBeGreaterThan(0);
    expect(included.length).toBeLessThan(entries.length);
    expect(text).toContain(
      `Omitted ${entries.length - included.length} skill(s) that did not fit`,
    );
  });

  it("drops a suffix of the catalog, never an arbitrary subset", () => {
    const entries = Array.from({ length: 40 }, (_value, index) =>
      entry(index, LONG_DESCRIPTION));

    const text = renderSkillModuleDescription(catalog(entries), { maxBytes: 2048 });

    const includedFlags = entries.map((candidate) =>
      text.includes(`- ${candidate.name} [`));
    const firstDropped = includedFlags.indexOf(false);
    expect(firstDropped).toBeGreaterThan(0);
    expect(includedFlags.slice(firstDropped).some((flag) => flag)).toBe(false);
  });

  it("never truncates an included entry into shortened metadata", () => {
    const entries = Array.from({ length: 40 }, (_value, index) =>
      entry(index, LONG_DESCRIPTION));

    const text = renderSkillModuleDescription(catalog(entries), { maxBytes: 2048 });

    for (const candidate of entries) {
      if (!text.includes(`- ${candidate.name} [`)) continue;
      expect(text).toContain(
        `- ${candidate.name} [${candidate.entryResource}]: ${LONG_DESCRIPTION}`,
      );
    }
  });

  it("chooses the same cut point every time and never grows it as the budget shrinks", () => {
    const entries = Array.from({ length: 40 }, (_value, index) =>
      entry(index, LONG_DESCRIPTION));
    const source = catalog(entries);
    const countIncluded = (text: string): number =>
      entries.filter((candidate) => text.includes(`- ${candidate.name} [`)).length;

    const wide = renderSkillModuleDescription(source, { maxBytes: 4096 });
    const narrow = renderSkillModuleDescription(source, { maxBytes: 2048 });
    const narrowAgain = renderSkillModuleDescription(source, { maxBytes: 2048 });

    expect(narrowAgain).toBe(narrow);
    expect(countIncluded(narrow)).toBeLessThan(countIncluded(wide));
  });

  it("caps how many identifiers an omission notice enumerates", () => {
    const entries = Array.from({ length: 40 }, (_value, index) =>
      entry(index, LONG_DESCRIPTION));

    const text = renderSkillModuleDescription(catalog(entries), {
      maxBytes: 2048,
      maxListedIdentifiers: 3,
    });

    const notice = text.split("\n").find((line) => line.startsWith("Omitted "))!;
    expect(notice).toMatch(/, and \d+ more\.$/u);
    expect(notice.split(", ")).toHaveLength(4);
  });

  it("summarizes refused paths with their typed codes", () => {
    const text = renderSkillModuleDescription(
      catalog([entry(1, "Reads logs.")], [
        { subject: "broken", code: "SKILL_FRONTMATTER_MISSING", detail: "no fence" },
        { subject: "", code: "SKILL_PATH_INVALID", detail: "root is a container" },
      ]),
    );

    expect(text).toContain("Refused 2 path(s) during the last scan");
    expect(text).toContain("broken (SKILL_FRONTMATTER_MISSING)");
    expect(text).toContain("(library root) (SKILL_PATH_INVALID)");
  });

  it("rejects a byte budget below the documented minimum", () => {
    expect(() =>
      renderSkillModuleDescription(catalog([]), {
        maxBytes: MIN_SKILL_DESCRIPTION_BYTES - 1,
      })
    ).toThrowError(
      expect.objectContaining<Partial<SkillDescriptionError>>({
        code: "SKILL_DESCRIPTION_LIMIT_INVALID",
      }),
    );
  });

  it("rejects a non-positive identifier list cap", () => {
    expect(() =>
      renderSkillModuleDescription(catalog([]), { maxListedIdentifiers: 0 })
    ).toThrowError(
      expect.objectContaining<Partial<SkillDescriptionError>>({
        code: "SKILL_DESCRIPTION_LIMIT_INVALID",
      }),
    );
  });

  it("falls back to counts when even the notices cannot fit", () => {
    const entries = Array.from({ length: 6 }, (_value, index) => ({
      ...entry(index, LONG_DESCRIPTION),
      skillId: `${"deeply-nested-directory/".repeat(12)}skill-${index}`,
    }));

    const text = renderSkillModuleDescription(catalog(entries), {
      maxBytes: MIN_SKILL_DESCRIPTION_BYTES,
    });

    expect(byteLength(text)).toBeLessThanOrEqual(MIN_SKILL_DESCRIPTION_BYTES);
    expect(text).toContain("Omitted all 6 skill(s)");
    expect(text).not.toContain("deeply-nested-directory");
  });
});
