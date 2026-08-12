import { rmSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { copyRuntimeAssets } from "./copy-runtime-assets.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDirectory = resolve(repositoryRoot, "dist");

if (dirname(distDirectory) !== repositoryRoot || basename(distDirectory) !== "dist") {
  throw new Error(`Refusing to clean unexpected build directory: ${distDirectory}`);
}

rmSync(distDirectory, { recursive: true, force: true });

const compiler = resolve(repositoryRoot, "node_modules", "typescript", "bin", "tsc");
const compileResult = spawnSync(
  process.execPath,
  [compiler, "--project", resolve(repositoryRoot, "tsconfig.build.json")],
  { cwd: repositoryRoot, stdio: "inherit" },
);

if (compileResult.error) {
  throw compileResult.error;
}
if (compileResult.status !== 0) {
  process.exit(compileResult.status ?? 1);
}

copyRuntimeAssets({
  repositoryRoot,
  outputDirectory: distDirectory,
});
