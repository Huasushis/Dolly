import { posix } from "node:path";

const GUEST_PACKAGE_DIRECTORY = "/run/dolly/extension";
const RUNTIME_MOUNT_ROOTS = ["/run", "/tmp"] as const;

/** Exact backend exercised by the Ubuntu 24.04 acceptance environment. */
export const LINUX_PROCESS_CONFINEMENT_PROGRAM = "/usr/bin/bwrap";

export interface LinuxProcessConfinementOptions {
  /** Absolute Host path of the reviewed bubblewrap executable. */
  readonly bubblewrapProgram: string;
  /** Absolute Host path of the Node executable selected by Core. */
  readonly nodeProgram: string;
  /** Integrity-checked installed package directory. */
  readonly installationDirectory: string;
  /** Integrity-checked entry point inside installationDirectory. */
  readonly entrypointPath: string;
  /** Effective Core state directory that must be hidden from the process. */
  readonly coreStateDirectory: string;
}

export interface LinuxProcessConfinementExecution {
  readonly program: string;
  readonly argumentVector: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}

function assertAbsoluteNormalizedPath(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    !posix.isAbsolute(value) ||
    posix.normalize(value) !== value
  ) {
    throw new TypeError(`${label} must be an absolute normalized Linux path`);
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = posix.relative(parent, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith("../");
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || isWithin(left, right) || isWithin(right, left);
}

function assertSafeStateDirectory(
  stateDirectory: string,
  processExecutables: readonly string[],
  installationDirectory: string,
): void {
  if (
    stateDirectory === "/" ||
    RUNTIME_MOUNT_ROOTS.some((root) =>
      stateDirectory === root || isWithin(root, stateDirectory)
    )
  ) {
    throw new TypeError(
      "coreStateDirectory cannot be a root or runtime-system directory",
    );
  }
  if (processExecutables.some((path) => pathsOverlap(stateDirectory, path))) {
    throw new TypeError(
      "coreStateDirectory must not overlap the process executables",
    );
  }
  // The installation registry commonly lives below Core state. That direction
  // is safe because bubblewrap resolves the Host source and remounts only the
  // verified package after the state directory is hidden. The reverse would
  // re-expose Core state as part of the guest package mount.
  if (
    stateDirectory === installationDirectory ||
    isWithin(installationDirectory, stateDirectory)
  ) {
    throw new TypeError(
      "coreStateDirectory must not be the installed package or one of its descendants",
    );
  }
}

/**
 * Derives the fixed process-confinement command used before public Module
 * activation is considered.
 *
 * This is a process ownership boundary, not a claim that arbitrary Extension
 * code is fully sandboxed. The command gives the child fresh user, process,
 * cgroup, mount, IPC, UTS, and network namespaces; makes the Host filesystem
 * read-only; hides Core state and service-manager sockets; drops capabilities;
 * and prevents nested user namespaces. The installed package is then mounted
 * read-only at one fixed guest path. All arguments come from Host-validated
 * installation and instance state, never from an Extension request.
 */
export function deriveLinuxProcessConfinementExecution(
  options: LinuxProcessConfinementOptions,
): LinuxProcessConfinementExecution {
  assertAbsoluteNormalizedPath(options.bubblewrapProgram, "bubblewrapProgram");
  assertAbsoluteNormalizedPath(options.nodeProgram, "nodeProgram");
  assertAbsoluteNormalizedPath(
    options.installationDirectory,
    "installationDirectory",
  );
  assertAbsoluteNormalizedPath(options.entrypointPath, "entrypointPath");
  assertAbsoluteNormalizedPath(options.coreStateDirectory, "coreStateDirectory");

  const relativeEntrypoint = posix.relative(
    options.installationDirectory,
    options.entrypointPath,
  );
  if (
    relativeEntrypoint.length === 0 ||
    relativeEntrypoint === ".." ||
    relativeEntrypoint.startsWith("../") ||
    posix.isAbsolute(relativeEntrypoint)
  ) {
    throw new TypeError("entrypointPath must be inside installationDirectory");
  }
  if (options.installationDirectory === "/") {
    throw new TypeError("installationDirectory cannot be the filesystem root");
  }
  assertSafeStateDirectory(
    options.coreStateDirectory,
    [options.bubblewrapProgram, options.nodeProgram],
    options.installationDirectory,
  );

  const guestEntrypoint = posix.join(
    GUEST_PACKAGE_DIRECTORY,
    relativeEntrypoint,
  );
  const argumentVector = Object.freeze([
    options.bubblewrapProgram,
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/run",
    "--tmpfs", "/tmp",
    "--tmpfs", options.coreStateDirectory,
    "--dir", "/run/dolly",
    "--ro-bind", options.installationDirectory, GUEST_PACKAGE_DIRECTORY,
    "--unshare-user",
    "--unshare-pid",
    "--unshare-cgroup",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-net",
    "--disable-userns",
    "--die-with-parent",
    "--new-session",
    "--clearenv",
    "--cap-drop", "ALL",
    "--chdir", GUEST_PACKAGE_DIRECTORY,
    "--",
    options.nodeProgram,
    guestEntrypoint,
  ]);
  return Object.freeze({
    program: options.bubblewrapProgram,
    argumentVector,
    environment: Object.freeze({}),
  });
}
