import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Creates an isolated real directory for one filesystem test. */
export function createTemporaryRoot(): string {
  return mkdtempSync(join(tmpdir(), "dolly-skill-"));
}

export function removeTemporaryRoot(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

/** Builds one `SKILL.md` text with the given front matter lines. */
export function skillFile(frontmatterLines: readonly string[], body = "Body."): string {
  return `---\n${frontmatterLines.join("\n")}\n---\n\n${body}\n`;
}

/**
 * Writes a file at a library-relative POSIX path and returns the byte length
 * actually written, so tests can set limits against exact sizes.
 */
export function writeLibraryFile(
  libraryRoot: string,
  relativePath: string,
  contents: string | Uint8Array,
): number {
  const absolute = join(libraryRoot, ...relativePath.split("/"));
  mkdirSync(dirname(absolute), { recursive: true });
  const bytes = typeof contents === "string" ? Buffer.from(contents, "utf8") : contents;
  writeFileSync(absolute, bytes);
  return bytes.byteLength;
}

/** Writes a minimal valid skill directory and returns its `SKILL.md` size. */
export function writeSkill(
  libraryRoot: string,
  relativeDirectory: string,
  options: { readonly name?: string; readonly description?: string; readonly extraFrontmatter?: readonly string[] } = {},
): number {
  const directoryName = relativeDirectory.split("/").at(-1)!;
  const frontmatter = [
    `name: ${options.name ?? directoryName}`,
    `description: ${options.description ?? `Does ${directoryName} work. Use when the task mentions ${directoryName}.`}`,
    ...(options.extraFrontmatter ?? []),
  ];
  return writeLibraryFile(
    libraryRoot,
    `${relativeDirectory}/SKILL.md`,
    skillFile(frontmatter),
  );
}
