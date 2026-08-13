import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

/** Exact interpreter exercised by the Ubuntu 24.04 Module profile. */
export const LINUX_MODULE_LAUNCHER_INTERPRETER = "/usr/bin/python3";

/** Exact confinement backend exercised by the Ubuntu 24.04 Module profile. */
export const LINUX_PROCESS_CONFINEMENT_PROGRAM = "/usr/bin/bwrap";

/** Absolute path of the reviewed launcher asset shipped with this package. */
export function defaultLauncherScriptPath(): string {
  return fileURLToPath(
    new URL("./adapters/linux-module-launcher/launcher.py", import.meta.url),
  );
}

/** Digest of the reviewed launcher bytes copied unchanged by the build. */
export const REVIEWED_LINUX_MODULE_LAUNCHER_DIGEST =
  "sha256:2c95f759603f902340f719abaaf12b2df0ab7194d9c89f35aa835927486d3177";

/** Closed identity shared by activation checks and installed execution. */
export interface ReviewedLinuxModuleRuntimeIdentity {
  readonly schemaVersion: "dolly.linux-module-runtime-profile/1";
  /** Exact Node executable that the confinement plan exposes to the Module. */
  readonly nodeProgram: string;
  /** Node runtime semantics paired with `nodeProgram` for this Core process. */
  readonly nodeVersion: string;
  readonly interpreterProgram: typeof LINUX_MODULE_LAUNCHER_INTERPRETER;
  readonly launcherScriptPath: string;
  readonly launcherDigest: typeof REVIEWED_LINUX_MODULE_LAUNCHER_DIGEST;
  readonly confinementProgram: typeof LINUX_PROCESS_CONFINEMENT_PROGRAM;
}

export function reviewedLinuxModuleRuntimeIdentity(): ReviewedLinuxModuleRuntimeIdentity {
  return Object.freeze({
    schemaVersion: "dolly.linux-module-runtime-profile/1",
    nodeProgram: process.execPath,
    nodeVersion: process.versions.node,
    interpreterProgram: LINUX_MODULE_LAUNCHER_INTERPRETER,
    launcherScriptPath: defaultLauncherScriptPath(),
    launcherDigest: REVIEWED_LINUX_MODULE_LAUNCHER_DIGEST,
    confinementProgram: LINUX_PROCESS_CONFINEMENT_PROGRAM,
  });
}

/**
 * Rejects a structurally substituted profile before it reaches a launcher.
 * The Host-minted activation permission remains the authority boundary; this
 * check additionally prevents lower-level candidate seams from describing a
 * Node runtime different from the one that will actually be exposed.
 */
export function assertReviewedLinuxModuleRuntimeIdentity(
  value: ReviewedLinuxModuleRuntimeIdentity,
): void {
  const expected = reviewedLinuxModuleRuntimeIdentity();
  const keys = Object.keys(value).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    expectedKeys.some((key) =>
      value[key as keyof ReviewedLinuxModuleRuntimeIdentity] !==
        expected[key as keyof ReviewedLinuxModuleRuntimeIdentity]
    )
  ) {
    throw new TypeError(
      "Linux Module runtime profile does not match this reviewed Host runtime",
    );
  }
}

/** Copies the closed fields once so caller getters cannot change them after validation. */
export function snapshotReviewedLinuxModuleRuntimeIdentity(
  value: ReviewedLinuxModuleRuntimeIdentity,
): ReviewedLinuxModuleRuntimeIdentity {
  const snapshot = Object.freeze({ ...value });
  assertReviewedLinuxModuleRuntimeIdentity(snapshot);
  return snapshot;
}

export type ReviewedLinuxModuleRuntimeInspection =
  | {
      readonly available: true;
      readonly runtime: ReviewedLinuxModuleRuntimeIdentity;
    }
  | {
      readonly available: false;
      readonly runtime: ReviewedLinuxModuleRuntimeIdentity;
      readonly detail: string;
    };

/** Inspects only the fixed reviewed runtime; callers cannot replace its paths. */
export async function inspectReviewedLinuxModuleRuntime(): Promise<
  ReviewedLinuxModuleRuntimeInspection
> {
  const runtime = reviewedLinuxModuleRuntimeIdentity();
  const { access, readFile } = await import("node:fs/promises");
  const { constants } = await import("node:fs");
  for (const [label, path] of [
    ["interpreter", runtime.interpreterProgram],
    ["confinement backend", runtime.confinementProgram],
  ] as const) {
    try {
      await access(path, constants.X_OK);
    } catch {
      return {
        available: false,
        runtime,
        detail: `the child launcher ${label} at ${path} is missing or not executable`,
      };
    }
  }
  let launcherBytes: Buffer;
  try {
    await access(runtime.launcherScriptPath, constants.R_OK);
    launcherBytes = await readFile(runtime.launcherScriptPath);
  } catch {
    return {
      available: false,
      runtime,
      detail: `the child launcher script at ${runtime.launcherScriptPath} is missing or not readable`,
    };
  }
  const launcherDigest = `sha256:${createHash("sha256")
    .update(launcherBytes)
    .digest("hex")}`;
  if (launcherDigest !== runtime.launcherDigest) {
    return {
      available: false,
      runtime,
      detail: `the child launcher script at ${runtime.launcherScriptPath} does not match the reviewed digest`,
    };
  }
  return { available: true, runtime };
}
