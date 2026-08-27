import { gunzipSync } from "node:zlib";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { REVIEWED_WORKER_HOST_DIGEST } from "../../../src/adapters/installed-worker-host.js";

import { describe, expect, it } from "vitest";

interface PackResult {
  filename: string;
  files: Array<{ path: string }>;
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
  const candidates = [
    trimmed,
    trimmed.slice(trimmed.lastIndexOf("\n{") + 1),
    trimmed.slice(trimmed.lastIndexOf("\n[") + 1),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const manifest = Array.isArray(parsed)
        ? (parsed.length === 1 ? parsed[0] : undefined)
        : (typeof parsed === "object" && parsed !== null
            ? parsed
            : undefined);
      if (
        manifest &&
        typeof manifest === "object" &&
        "filename" in manifest &&
        "files" in manifest
      ) {
        const files = Array.isArray(manifest.files)
          ? manifest.files
              .map((file: unknown) =>
                file && typeof file === "object" && "path" in file
                  ? file.path
                  : undefined,
              )
              .filter(
                (path: unknown): path is string => typeof path === "string",
              )
              .map((path: string) => ({ path }))
          : [];
        return { filename: basename(String(manifest.filename ?? "")), files };
      }
    } catch {
      // Try the next candidate so lifecycle output cannot hide the pack manifest.
    }
  }
  throw new Error(`npm pack did not return one JSON result:\n${stdout}`);
}

/**
 * One pack invocation for the candidate checkout. The intended root comes from
 * the actual npm-script working directory (`INIT_CWD`, set by the launcher)
 * and is validated there (must be the dolly package) — never from `import.meta`
 * transformed module realpaths, node_modules virtual-store realpaths, an
 * ambient prefix, or a bare absolute host path. The active package manager is
 * invoked with an explicit root selection (pnpm `--dir`, npm `--prefix`) and
 * the lifecycle-visible state (cwd, PWD, INIT_CWD, npm_config_prefix) is bound
 * to that root, so prepack/build resolve to the candidate checkout. The
 * returned receipt names the sanitized root identity for same-root proof.
 */
interface PackReceipt {
  readonly root: string;
  readonly name: string;
  readonly version: string;
}

interface PackInvocation {
  readonly packed: SpawnSyncReturns<string>;
  readonly receipt: PackReceipt;
}

function packCandidatePackage(
  packDirectory: string,
  cacheDirectory: string,
): PackInvocation {
  const root = process.env.INIT_CWD;
  if (!root) {
    throw new Error("Package smoke test must run through an npm script");
  }
  let rootPackageJson: { name?: unknown; version?: unknown };
  try {
    rootPackageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
  } catch {
    throw new Error(`Candidate checkout has no readable package.json: ${root}`);
  }
  if (rootPackageJson.name !== "dolly" || typeof rootPackageJson.version !== "string") {
    throw new Error(`Candidate checkout root does not carry the dolly identity: ${root}`);
  }
  const npmCli = process.env.npm_execpath;
  if (!npmCli) {
    throw new Error("Package smoke test must run through an npm script");
  }
  const isPnpm = basename(npmCli).toLowerCase().startsWith("pnpm");
  const packArguments = [
    npmCli,
    ...(isPnpm ? ["--dir", root] : ["--prefix", root]),
    "pack",
    "--json",
    "--pack-destination",
    packDirectory,
  ];
  if (!isPnpm) {
    packArguments.push("--cache", cacheDirectory);
  }
  const packed = spawnSync(process.execPath, packArguments, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PWD: root,
      INIT_CWD: root,
      npm_config_prefix: root,
      NO_COLOR: "1",
    },
  });
  const receipt: PackReceipt = {
    root,
    name: rootPackageJson.name,
    version: rootPackageJson.version,
  };
  console.log(`package root ${basename(root)} identity ${receipt.name}@${receipt.version}`);
  return { packed, receipt };
}

describe("PKG-001 distributable package", () => {
  it("packs only runtime files and runs the extracted CLI metadata commands", async () => {
    const repositoryRoot = resolve(import.meta.dirname, "../../..");
    const temporaryRoot = mkdtempSync(join(tmpdir(), "dolly-package-smoke-"));

    try {
      const packDirectory = join(temporaryRoot, "pack");
      const cacheDirectory = join(temporaryRoot, "npm-cache");
      mkdirSync(packDirectory, { recursive: true });
      mkdirSync(cacheDirectory, { recursive: true });

      const { packed, receipt } = packCandidatePackage(packDirectory, cacheDirectory);
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
        "dist/src/linux-module-runtime-assets.js",
        "dist/src/adapters/installed-linux-extension-module-executor.js",
        "dist/src/adapters/linux-process-confinement.js",
        "dist/src/adapters/linux-module-launcher/linux-module-launcher-process.js",
        "dist/src/adapters/linux-module-launcher/launcher.py",
        "dist/src/daemon/daemon-config.js",
        "dist/src/daemon/daemon-config.d.ts",
        "dist/src/daemon/daemon-config.js.map",
      ];
      // The compiled CLI entry needs exactly the daemon-config compilation;
      // every other dist/src/daemon/** artifact must stay excluded.
      const shippedDaemonAllowlist = new Set([
        "dist/src/daemon/daemon-config.js",
        "dist/src/daemon/daemon-config.d.ts",
        "dist/src/daemon/daemon-config.js.map",
      ]);
      for (const requiredPath of requiredPaths) {
        expect(publishedPaths, `missing ${requiredPath}`).toContain(requiredPath);
      }

      for (const publishedPath of publishedPaths) {
        if (publishedPath.startsWith("dist/src/daemon/")) {
          expect(shippedDaemonAllowlist, `unexpected daemon artifact ${publishedPath}`).toContain(publishedPath);
        }
        expect(publishedPath).not.toMatch(/^dist\/src\/extensions(?:\/|$)/);
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
      const tarball = readFileSync(join(packDirectory, manifest.filename));
      expect(tarball.length).toBeLessThan(20_000_000);
      const tarFiles = readTarGzFiles(tarball);
      const unpackedSize = [...tarFiles.values()].reduce(
        (total, data) => total + data.length,
        0,
      );
      expect(unpackedSize).toBeLessThan(30_000_000);
      const packageJson = JSON.parse(
        tarFiles.get("package/package.json")?.toString("utf8") ?? "null",
      );
      expect(packageJson).toMatchObject({
        private: true,
        main: "./dist/src/entry.js",
        types: "./dist/src/entry.d.ts",
        bin: { dolly: "./bin/dolly.js" },
      });
      // Same-root receipt: the packed manifest identity must equal the root
      // this test packed from, so package authority never drifted to another
      // checkout (an observed production-tooling failure mode).
      expect(packageJson.name).toBe(receipt.name);
      expect(packageJson.version).toBe(receipt.version);
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

      const reviewedLauncherSource = readFileSync(
        resolve(repositoryRoot, "src/adapters/linux-module-launcher/launcher.py"),
      );
      const linuxRuntimeGraphArchivePaths = [
        "package/dist/src/adapters/installed-linux-extension-module-executor.js",
        "package/dist/src/adapters/linux-process-confinement.js",
        "package/dist/src/adapters/linux-module-launcher/linux-module-launcher-process.js",
        "package/dist/src/adapters/linux-module-launcher/launcher.py",
      ];
      for (const archivePath of linuxRuntimeGraphArchivePaths) {
        const data = tarFiles.get(archivePath);
        expect(data, `missing tar entry ${archivePath}`).toBeDefined();
        expect(data!.length).toBeGreaterThan(0);
      }
      // The reviewed installed worker-host binary must ship in the package
      // at the fixed layout the production adapter resolves, byte-for-byte
      // matching the reviewed digest enforced by scripts/build.mjs.
      const packagedWorkerHost = tarFiles.get("package/dist/bin/worker_host");
      expect(packagedWorkerHost, "missing packaged worker_host binary").toBeDefined();
      expect(
        `sha256:${createHash("sha256").update(packagedWorkerHost!).digest("hex")}`,
      ).toBe(REVIEWED_WORKER_HOST_DIGEST);
      // The launcher asset must be shipped byte-for-byte as reviewed, so the
      // installed runtime graph can consume a fixed program.
      const packagedLauncher = tarFiles.get(
        "package/dist/src/adapters/linux-module-launcher/launcher.py",
      );
      expect(packagedLauncher).toEqual(reviewedLauncherSource);
      expect(
        `sha256:${createHash("sha256").update(packagedLauncher!).digest("hex")}`,
      ).toBe("sha256:2c95f759603f902340f719abaaf12b2df0ab7194d9c89f35aa835927486d3177");

      const extractedPackage = join(temporaryRoot, "installed", "package");
      const filesToExtract = [
        "package/package.json",
        "package/bin/dolly.js",
        "package/dist/src/linux-module-runtime-assets.js",
        "package/dist/src/linux-module-runtime-assets.js.map",
        "package/dist/src/adapters/linux-module-launcher/launcher.py",
      ];
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

      // The extracted installed module is only present under a temp dir at
      // pack time; a static import cannot reference a path created here.
      const runtimeAssetsModule = await import(
        pathToFileURL(
          join(extractedPackage, "dist/src/linux-module-runtime-assets.js"),
        ).href
      );
      const installedLauncherPath = join(
        extractedPackage,
        "dist/src/adapters/linux-module-launcher/launcher.py",
      );
      expect(runtimeAssetsModule.defaultLauncherScriptPath()).toBe(installedLauncherPath);
      const installedLauncherBytes = readFileSync(installedLauncherPath);
      expect(
        `sha256:${createHash("sha256").update(installedLauncherBytes).digest("hex")}`,
      ).toBe(runtimeAssetsModule.REVIEWED_LINUX_MODULE_LAUNCHER_DIGEST);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }, 300_000);

  it("installs the packed tarball in a clean Node 20.20.2 consumer and attests the native SQLite binding through create, commit, close, reopen", async () => {
    const repositoryRoot = resolve(import.meta.dirname, "../../..");
    const temporaryRoot = mkdtempSync(join(tmpdir(), "dolly-package-sqlite-consumer-"));

    try {
      const packDirectory = join(temporaryRoot, "pack");
      const cacheDirectory = join(temporaryRoot, "npm-cache");
      mkdirSync(packDirectory, { recursive: true });
      mkdirSync(cacheDirectory, { recursive: true });

      const { packed, receipt } = packCandidatePackage(packDirectory, cacheDirectory);
      expect(packed.error).toBeUndefined();
      expect(packed.status, packed.stderr).toBe(0);

      const manifest = parsePackOutput(packed.stdout);
      const tarballBytes = readFileSync(join(packDirectory, manifest.filename));
      const tarFiles = readTarGzFiles(tarballBytes);

      // The distributable must NOT bundle a node_modules tree or a native
      // binding; the consumer resolves the pinned better-sqlite3 prebuild
      // itself. Only the compiled loader/attestation bridge travels in the
      // package.
      const nonPortable = [...tarFiles.keys()].filter(
        (entry) =>
          entry.includes("node_modules") ||
          /\.(?:node|so|dylib|dll)(?:\.map)?$/u.test(entry),
      );
      expect(nonPortable).toEqual([]);
      for (const required of [
        "package/dist/src/adapters/storage/native-sqlite.js",
        "package/dist/src/adapters/storage/native-sqlite.d.ts",
        "package/dist/src/adapters/storage/native-sqlite-binding.js",
      ]) {
        expect(tarFiles.has(required), `missing ${required}`).toBe(true);
      }

      // Clean consumer: only the tarball and a minimal manifest, resolved by
      // this machine's Node 20.20.2 with the real registry. This is the only
      // network use the slice permits: the exact locked packages and the
      // better-sqlite3 prebuild they pin.
      const consumerRoot = join(temporaryRoot, "consumer");
      mkdirSync(consumerRoot, { recursive: true });
      writeFileSync(
        join(consumerRoot, "package.json"),
        JSON.stringify({ name: "dolly-smoke-consumer", private: true, version: "0.0.0" }, undefined, 2),
      );
      const npm = join(dirname(process.execPath), "npm");
      const installResult = spawnSync(
        npm,
        [
          "install",
          "--no-audit",
          "--no-fund",
          "--no-progress",
          "--cache",
          cacheDirectory,
          join(packDirectory, manifest.filename),
        ],
        {
          cwd: consumerRoot,
          encoding: "utf8",
          env: { ...process.env, NO_COLOR: "1" },
          timeout: 300_000,
        },
      );
      expect(installResult.status, installResult.stderr).toBe(0);

      // The consumer really imports the CJS binding, runs the shipped loader
      // against a file database, commits, closes, reopens and re-attests.
      const consumerScript = `
import Database from "better-sqlite3";
import { pathToFileURL } from "node:url";

const [adapterFile, dbFile] = process.argv.slice(2);
const adapter = await import(pathToFileURL(adapterFile).href);

const rawProbe = new Database(":memory:");
const rawSqliteVersion = rawProbe.prepare("SELECT sqlite_version() AS v").get().v;
rawProbe.close();

const firstAttestation = adapter.attestNativeSqliteBuild();
const handle = adapter.openAttestedNativeSqlite(dbFile);
handle.database.exec("CREATE TABLE IF NOT EXISTS attestation(value TEXT NOT NULL)");
handle.database.exec("BEGIN IMMEDIATE");
handle.database.prepare("INSERT INTO attestation(value) VALUES (?)").run("committed");
handle.database.exec("COMMIT");
handle.database.exec("CREATE TABLE IF NOT EXISTS attestation_2(value TEXT NOT NULL)");
handle.database.prepare("INSERT INTO attestation_2(value) VALUES (?)").run("still-there");
handle.database.exec("DELETE FROM attestation_2");
handle.close();

const reopened = adapter.openAttestedNativeSqlite(dbFile);
const row = reopened.database.prepare("SELECT value FROM attestation LIMIT 1").get();
const journalMode = reopened.database.pragma("journal_mode", { simple: true });
const foreignKeys = reopened.database.pragma("foreign_keys", { simple: true });
const busyTimeout = reopened.database.pragma("busy_timeout", { simple: true });
const secondAttestation = adapter.attestNativeSqliteBuild();
reopened.close();

process.stdout.write(JSON.stringify({
  rawSqliteVersion,
  attestedVersion: firstAttestation.version,
  attestedVersionAgain: secondAttestation.version,
  persisted: row?.value ?? null,
  journalMode,
  foreignKeys,
  busyTimeout,
}));
`;
      const scriptPath = join(consumerRoot, "consumer-attestation.mjs");
      writeFileSync(scriptPath, consumerScript);
      const dbPath = join(consumerRoot, "attested.db");
      const adapterRel = join("node_modules", "dolly", "dist/src/adapters/storage/native-sqlite.js");
      const adapterFile = join(consumerRoot, adapterRel);
      expect(readFileSync(adapterFile, "utf8")).toContain("better-sqlite3");

      const consumerResult = spawnSync(
        process.execPath,
        [scriptPath, adapterFile, dbPath],
        { cwd: consumerRoot, encoding: "utf8" },
      );
      expect(consumerResult.status, consumerResult.stderr).toBe(0);
      const observed = JSON.parse(consumerResult.stdout.trim()) as {
        rawSqliteVersion: string;
        attestedVersion: string;
        attestedVersionAgain: string;
        persisted: string | null;
        journalMode: string;
        foreignKeys: number;
        busyTimeout: number;
      };
      expect(observed.rawSqliteVersion).toBe("3.53.0");
      expect(observed.attestedVersion).toBe("3.53.0");
      expect(observed.attestedVersionAgain).toBe("3.53.0");
      expect(observed.persisted).toBe("committed");
      expect(observed.journalMode).toBe("wal");
      expect(observed.foreignKeys).toBe(1);
      expect(observed.busyTimeout).toBe(5000);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }, 360_000);
});
