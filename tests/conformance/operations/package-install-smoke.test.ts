import { gunzipSync } from "node:zlib";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

interface PackResult {
  filename: string;
  files: Array<{ path: string; size: number }>;
  size: number;
  unpackedSize: number;
}

function readNullTerminated(buffer: Buffer, start: number, length: number): string {
  const field = buffer.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

function readOctal(buffer: Buffer, start: number, length: number): number {
  const value = readNullTerminated(buffer, start, length).trim();
  if (!/^[0-7]*$/.test(value)) {
    throw new Error(`Invalid tar size field: ${JSON.stringify(value)}`);
  }
  return value === "" ? 0 : Number.parseInt(value, 8);
}

function parsePaxPath(data: Buffer): string | undefined {
  let offset = 0;
  let path: string | undefined;
  while (offset < data.length) {
    const separator = data.indexOf(0x20, offset);
    if (separator === -1) break;
    const recordLength = Number.parseInt(data.toString("ascii", offset, separator), 10);
    if (!Number.isSafeInteger(recordLength) || recordLength <= 0) break;
    const record = data.toString("utf8", separator + 1, offset + recordLength).trimEnd();
    const equals = record.indexOf("=");
    if (record.slice(0, equals) === "path") path = record.slice(equals + 1);
    offset += recordLength;
  }
  return path;
}

function readTarGzFiles(tarball: Buffer): Map<string, Buffer> {
  const archive = gunzipSync(tarball);
  const files = new Map<string, Buffer>();
  let offset = 0;
  let nextPath: string | undefined;

  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const shortName = readNullTerminated(header, 0, 100);
    const prefix = readNullTerminated(header, 345, 155);
    const headerPath = prefix ? `${prefix}/${shortName}` : shortName;
    const size = readOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) throw new Error("Truncated tar entry");
    const data = archive.subarray(dataStart, dataEnd);

    if (type === "x" || type === "g") {
      nextPath = parsePaxPath(data) ?? nextPath;
    } else if (type === "L") {
      nextPath = readNullTerminated(data, 0, data.length).replace(/\n$/, "");
    } else {
      const entryPath = nextPath ?? headerPath;
      nextPath = undefined;
      if (type === "0" || type === "\0" || type === "") {
        files.set(entryPath, Buffer.from(data));
      }
    }

    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  return files;
}

function parsePackOutput(stdout: string): PackResult {
  const trimmed = stdout.trim();
  const candidates = [trimmed, trimmed.slice(trimmed.lastIndexOf("\n[") + 1)];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as PackResult[];
      if (Array.isArray(parsed) && parsed.length === 1) return parsed[0]!;
    } catch {
      // Try the next candidate so lifecycle output cannot hide the pack manifest.
    }
  }
  throw new Error(`npm pack did not return one JSON result:\n${stdout}`);
}

describe("PKG-001 distributable package", () => {
  it("packs only runtime files and runs the extracted CLI metadata commands", () => {
    const repositoryRoot = resolve(import.meta.dirname, "../../..");
    const temporaryRoot = mkdtempSync(join(tmpdir(), "dolly-package-smoke-"));

    try {
      const packDirectory = join(temporaryRoot, "pack");
      const cacheDirectory = join(temporaryRoot, "npm-cache");
      mkdirSync(packDirectory, { recursive: true });
      mkdirSync(cacheDirectory, { recursive: true });

      const npmCli = process.env.npm_execpath;
      if (!npmCli) {
        throw new Error("Package smoke test must run through an npm script");
      }
      const packed = spawnSync(
        process.execPath,
        [
          npmCli,
          "pack",
          "--json",
          "--pack-destination",
          packDirectory,
          "--cache",
          cacheDirectory,
        ],
        {
          cwd: repositoryRoot,
          encoding: "utf8",
          env: { ...process.env, NO_COLOR: "1" },
        },
      );
      expect(packed.error).toBeUndefined();
      expect(packed.status, packed.stderr).toBe(0);

      const manifest = parsePackOutput(packed.stdout);
      const publishedPaths = new Set(manifest.files.map((file) => file.path));
      const requiredPaths = [
        "LICENSE",
        "bin/dolly.js",
        "dist/src/entry.js",
        "dist/src/entry.d.ts",
        "dist/src/sdk/index.js",
        "dist/src/sdk/index.d.ts",
        "dist/src/sdk/types.d.ts",
      ];
      for (const requiredPath of requiredPaths) {
        expect(publishedPaths, `missing ${requiredPath}`).toContain(requiredPath);
      }

      for (const publishedPath of publishedPaths) {
        expect(publishedPath).not.toMatch(/^dist\/daemon(?:\/|$)/);
        expect(publishedPath).not.toMatch(/^dist\/extensions(?:\/|$)/);
        expect(publishedPath).not.toMatch(/^dist\/src\/core\/ipc(?:\.|$)/);
        expect(publishedPath).not.toMatch(
          /^dist\/src\/(?:config|core\/(?:block-manager|legacy-in-process-extension|media|orchestrator|page|scheduler|types))(?:\.|$)/,
        );
        expect(publishedPath).not.toMatch(/^(?:test|tests|docs|scripts)\//);
        expect(publishedPath).not.toMatch(/(?:^|\/)\.env(?:\.|$)/);
        expect(publishedPath).not.toMatch(/(?:^|\/)(?:dolly\.json|TASK_HANDOVER\.md)$/);
        expect(publishedPath).not.toMatch(/\.tar\.gz$/);
        if (publishedPath.endsWith(".ts")) expect(publishedPath).toMatch(/\.d\.ts$/);
      }
      expect(manifest.size).toBeLessThan(5_000_000);
      expect(manifest.unpackedSize).toBeLessThan(10_000_000);

      const tarball = readFileSync(join(packDirectory, manifest.filename));
      const tarFiles = readTarGzFiles(tarball);
      const packageJson = JSON.parse(
        tarFiles.get("package/package.json")?.toString("utf8") ?? "null",
      );
      expect(packageJson).toMatchObject({
        private: true,
        main: "./dist/src/entry.js",
        types: "./dist/src/entry.d.ts",
        bin: { dolly: "./bin/dolly.js" },
      });
      expect(packageJson.exports).toMatchObject({
        ".": {
          types: "./dist/src/entry.d.ts",
          import: "./dist/src/entry.js",
        },
        "./sdk": {
          types: "./dist/src/sdk/index.d.ts",
          import: "./dist/src/sdk/index.js",
        },
      });

      const publicSdkTypes = tarFiles
        .get("package/dist/src/sdk/types.d.ts")
        ?.toString("utf8");
      expect(publicSdkTypes).toBeDefined();
      expect(publicSdkTypes).not.toMatch(
        /\b(?:BlockAccess|CliCommandSpec|DollyExtension|LLMClient|MediaAccess|ModuleContext|RawBlock)\b/,
      );
      expect(publicSdkTypes).not.toContain("legacy-in-process-extension");
      expect(publicSdkTypes).not.toContain("../core/types.js");

      const extractedPackage = join(temporaryRoot, "installed", "package");
      const filesToExtract = ["package/package.json", "package/bin/dolly.js"];
      for (const archivePath of filesToExtract) {
        const data = tarFiles.get(archivePath);
        expect(data, `missing tar entry ${archivePath}`).toBeDefined();
        const destination = join(extractedPackage, archivePath.slice("package/".length));
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, data!);
      }

      const cli = join(extractedPackage, "bin", "dolly.js");
      const helpResult = spawnSync(process.execPath, [cli, "--help"], {
        cwd: extractedPackage,
        encoding: "utf8",
      });
      expect(helpResult.status, helpResult.stderr).toBe(0);
      expect(helpResult.stdout).toContain("Usage: dolly <command>");

      const versionResult = spawnSync(process.execPath, [cli, "--version"], {
        cwd: extractedPackage,
        encoding: "utf8",
      });
      expect(versionResult.status, versionResult.stderr).toBe(0);
      expect(versionResult.stdout.trim()).toBe(packageJson.version);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it("keeps every internal module clause out of the pack selection", () => {
    const repositoryRoot = resolve(import.meta.dirname, "../../..");
    const temporaryRoot = mkdtempSync(join(tmpdir(), "dolly-pack-clause-"));

    try {
      const cacheDirectory = join(temporaryRoot, "npm-cache");
      mkdirSync(cacheDirectory, { recursive: true });

      const npmCli = process.env.npm_execpath;
      if (!npmCli) {
        throw new Error("Package smoke test must run through an npm script");
      }
      const packed = spawnSync(
        process.execPath,
        [
          npmCli,
          "pack",
          "--json",
          "--dry-run",
          "--cache",
          cacheDirectory,
        ],
        {
          cwd: repositoryRoot,
          encoding: "utf8",
          env: { ...process.env, NO_COLOR: "1" },
        },
      );
      expect(packed.status, packed.stderr).toBe(0);

      const manifest = parsePackOutput(packed.stdout);
      const publishedPaths = new Set(manifest.files.map((file) => file.path));

      const requiredPaths = [
        "LICENSE",
        "bin/dolly.js",
        "dist/src/entry.js",
        "dist/src/entry.d.ts",
        "dist/src/sdk/index.js",
        "dist/src/sdk/index.d.ts",
        "dist/src/sdk/types.d.ts",
      ];
      for (const requiredPath of requiredPaths) {
        expect(publishedPaths, `missing ${requiredPath}`).toContain(requiredPath);
      }

      const forbiddenClauses: Array<{ label: string; pattern: RegExp }> = [
        { label: "dist/daemon", pattern: /^dist\/daemon(?:\/|$)/ },
        { label: "dist/extensions", pattern: /^dist\/extensions(?:\/|$)/ },
        { label: "dist/src/core/ipc", pattern: /^dist\/src\/core\/ipc(?:\.|$)/ },
        { label: "dist/src/config", pattern: /^dist\/src\/config(?:\.|$)/ },
        { label: "dist/src/core/block-manager", pattern: /^dist\/src\/core\/block-manager(?:\.|$)/ },
        {
          label: "dist/src/core/legacy-in-process-extension",
          pattern: /^dist\/src\/core\/legacy-in-process-extension(?:\.|$)/,
        },
        { label: "dist/src/core/media", pattern: /^dist\/src\/core\/media(?:\.|$)/ },
        { label: "dist/src/core/orchestrator", pattern: /^dist\/src\/core\/orchestrator(?:\.|$)/ },
        { label: "dist/src/core/page", pattern: /^dist\/src\/core\/page(?:\.|$)/ },
        { label: "dist/src/core/scheduler", pattern: /^dist\/src\/core\/scheduler(?:\.|$)/ },
        { label: "dist/src/core/types", pattern: /^dist\/src\/core\/types(?:\.|$)/ },
      ];
      for (const { label, pattern } of forbiddenClauses) {
        const offenders = [...publishedPaths].filter((path) => pattern.test(path));
        expect(offenders, `pack selection still ships internal module ${label}`).toEqual([]);
      }
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
