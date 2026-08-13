import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyRuntimeAssets } from "../../../scripts/copy-runtime-assets.mjs";
import {
  defaultLauncherScriptPath,
  REVIEWED_LINUX_MODULE_LAUNCHER_DIGEST,
} from "../../../src/adapters/linux-module-launcher/linux-module-launcher-process.js";

const LAUNCHER_PATH = "src/adapters/linux-module-launcher/launcher.py";
const LAUNCHER_CONSUMER_PATH =
  "src/adapters/linux-module-launcher/linux-module-launcher-process.js";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dolly-build-assets-"));
  temporaryDirectories.push(root);
  const repositoryRoot = join(root, "repository");
  const outputDirectory = join(root, "dist");
  const source = join(repositoryRoot, LAUNCHER_PATH);
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, "#!/usr/bin/python3\nprint('Dolly launcher')\n", { mode: 0o755 });
  const compiledConsumer = join(outputDirectory, LAUNCHER_CONSUMER_PATH);
  mkdirSync(dirname(compiledConsumer), { recursive: true });
  writeFileSync(compiledConsumer, "export const compiled = true;\n");
  return { repositoryRoot, outputDirectory, source };
}

describe("runtime build assets", () => {
  it("keeps the shipped launcher bytes bound to their reviewed digest", () => {
    const digest = `sha256:${createHash("sha256")
      .update(readFileSync(defaultLauncherScriptPath()))
      .digest("hex")}`;
    expect(digest).toBe(REVIEWED_LINUX_MODULE_LAUNCHER_DIGEST);
  });

  it("copies the Linux launcher beside its compiled module with exact bytes", async () => {
    const { repositoryRoot, outputDirectory, source } = await fixture();

    expect(copyRuntimeAssets({ repositoryRoot, outputDirectory })).toEqual([LAUNCHER_PATH]);

    const target = join(outputDirectory, LAUNCHER_PATH);
    expect(readFileSync(target)).toEqual(readFileSync(source));
    if (process.platform !== "win32") {
      expect(statSync(target).mode & 0o777).toBe(0o644);
    }
  });

  it("fails instead of replacing an unexpected pre-existing output asset", async () => {
    const { repositoryRoot, outputDirectory } = await fixture();
    const target = join(outputDirectory, LAUNCHER_PATH);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "unreviewed launcher\n");

    expect(() => copyRuntimeAssets({ repositoryRoot, outputDirectory })).toThrow();
    expect(readFileSync(target, "utf8")).toBe("unreviewed launcher\n");
  });

  it("rejects a directory in place of the reviewed launcher file", async () => {
    const { repositoryRoot, outputDirectory, source } = await fixture();
    chmodSync(source, 0o644);
    await rm(source);
    mkdirSync(source);

    expect(() => copyRuntimeAssets({ repositoryRoot, outputDirectory })).toThrow(
      /must be an ordinary file/u,
    );
  });

  it("rejects a launcher asset whose runtime consumer was not compiled", async () => {
    const { repositoryRoot, outputDirectory } = await fixture();
    await rm(join(outputDirectory, LAUNCHER_CONSUMER_PATH));

    expect(() => copyRuntimeAssets({ repositoryRoot, outputDirectory })).toThrow(
      /Compiled runtime asset consumer/u,
    );
  });
});
