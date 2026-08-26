import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { tmpdir as tempDirectory } from "node:os";
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

// Build the installed worker-host binary from the pinned Rust workspace.
// The cargo target directory stays OUTSIDE the checkout (rust-gate
// precedent). When WORKER_HOST_CARGO_TARGET_DIR is not provided, a UNIQUE
// temporary target is created and removed in finally — never a shared or
// stale path. The reviewed digest is extracted from the authoritative
// adapter source and enforced on BOTH the built source binary and the
// copied output.
const adapterSource = readFileSync(
  resolve(repositoryRoot, "src", "adapters", "installed-worker-host.ts"),
  "utf8",
);
const digestMatch = adapterSource.match(
  /REVIEWED_WORKER_HOST_DIGEST\s*=\s*"sha256:([0-9a-f]{64})"/,
);
if (!digestMatch) {
  throw new Error("REVIEWED_WORKER_HOST_DIGEST not found in adapter source");
}
const reviewedWorkerHostDigest = digestMatch[1];

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function requireOrdinaryExecutable(path, label) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be an ordinary non-symlink file: ${path}`);
  }
  if ((metadata.mode & 0o111) === 0) {
    throw new Error(`${label} must carry an executable bit: ${path}`);
  }
}

function assertOutsideRepository(resolvedPath) {
  const rel = relative(repositoryRoot, resolvedPath);
  const insideRepository =
    rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
  if (insideRepository) {
    throw new Error(
      `worker_host cargo target must resolve outside the repository: ${resolvedPath}`,
    );
  }
}

// The TMPDIR base is environment-controlled; validate it before mkdtemp so a
// redirected temp directory inside the checkout cannot pass silently.
assertOutsideRepository(tempDirectory());

let workerHostTargetDir = process.env.WORKER_HOST_CARGO_TARGET_DIR;
let targetIsTemporary = false;
if (!workerHostTargetDir || workerHostTargetDir === "") {
  workerHostTargetDir = mkdtempSync(resolve(tempDirectory(), "wh-target-"));
  targetIsTemporary = true;
} else {
  // An explicit override must live OUTSIDE the repository: equal to it or a
  // descendant would put build output inside the checkout and risk cleanup
  // or packaging contamination.
  const resolvedOverride = resolve(workerHostTargetDir);
  assertOutsideRepository(resolvedOverride);
}

try {
  const workerHostBuild = spawnSync(
    "cargo",
    ["build", "--locked", "--release", "-p", "dolly-worker", "--bin", "worker_host"],
    {
      cwd: repositoryRoot,
      stdio: "inherit",
      env: { ...process.env, CARGO_TARGET_DIR: workerHostTargetDir },
    },
  );
  if (workerHostBuild.error) throw workerHostBuild.error;
  if (workerHostBuild.status !== 0) {
    throw new Error(`cargo build for worker_host failed with status ${workerHostBuild.status}`);
  }

  const workerHostSource = resolve(workerHostTargetDir, "release", "worker_host");
  requireOrdinaryExecutable(workerHostSource, "built worker_host");
  const sourceDigest = sha256File(workerHostSource);
  if (sourceDigest !== reviewedWorkerHostDigest) {
    throw new Error(
      `built worker_host digest ${sourceDigest} != reviewed ${reviewedWorkerHostDigest}`,
    );
  }

  const workerHostOutputDirectory = resolve(distDirectory, "bin");
  mkdirSync(workerHostOutputDirectory, { recursive: true });
  const workerHostOutput = resolve(workerHostOutputDirectory, "worker_host");
  copyFileSync(workerHostSource, workerHostOutput);
  chmodSync(workerHostOutput, 0o755);
  requireOrdinaryExecutable(workerHostOutput, "installed worker_host");
  const outputDigest = sha256File(workerHostOutput);
  if (outputDigest !== reviewedWorkerHostDigest) {
    throw new Error(
      `installed worker_host digest ${outputDigest} != reviewed ${reviewedWorkerHostDigest}`,
    );
  }
} finally {
  if (targetIsTemporary) {
    rmSync(workerHostTargetDir, { recursive: true, force: true });
  }
}
