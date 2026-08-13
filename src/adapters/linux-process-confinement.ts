import { posix } from "node:path";
import type { ExtensionPackageSnapshot } from "../core/extension-package-snapshot.js";
import { LINUX_PROCESS_CONFINEMENT_PROGRAM } from "../linux-module-runtime-assets.js";

export { LINUX_PROCESS_CONFINEMENT_PROGRAM };

const GUEST_NODE_PROGRAM = "/run/dolly/node";
const GUEST_PACKAGE_SNAPSHOT = "/run/dolly/package.snapshot";
const PACKAGE_SNAPSHOT_DESCRIPTOR = "4";
const RUNTIME_MOUNT_ROOTS = ["/run", "/tmp"] as const;

export const LINUX_PACKAGE_SNAPSHOT_BOOTSTRAP = String.raw`
import hashlib,hmac,os,stat,struct,sys
M=b'DOLLYPKGSNAP1\n';S='/run/dolly/package.snapshot';R='/run/dolly/extension';N='/run/dolly/node'
def main():
 D,L,C,T,E=sys.argv[1:];L=int(L);C=int(C);T=int(T);f=open(S,'rb',buffering=0);h=hashlib.sha256();n=0
 def r(k):
  nonlocal n
  assert k>=0 and n+k<=L
  a=[];q=k
  while q:
   b=f.read(min(65536,q));assert b;a.append(b);q-=len(b)
  b=b''.join(a);h.update(b);n+=len(b);return b
 assert r(len(M))==M
 c=struct.unpack('>I',r(4))[0];assert c==C and c>0
 os.mkdir(R,0o700);ds={R};prev=None;total=0;paths=set()
 for _ in range(c):
  a=r(44);pl=struct.unpack('>I',a[:4])[0];size=struct.unpack('>Q',a[4:12])[0];want=a[12:]
  assert 0<pl<=4096 and size<=T
  p=r(pl).decode('utf-8','strict');parts=p.split('/')
  assert not p.startswith('/') and '\\' not in p and all(x not in ('','.','..') for x in parts)
  assert prev is None or p>prev;prev=p;paths.add(p);total+=size;assert total<=T
  dst=os.path.join(R,*parts);parent=os.path.dirname(dst);os.makedirs(parent,mode=0o700,exist_ok=True)
  q=parent
  while q!=R:ds.add(q);q=os.path.dirname(q)
  g=hashlib.sha256();out=open(dst,'xb',buffering=0);left=size
  try:
   while left:
    b=r(min(65536,left));g.update(b);assert out.write(b)==len(b);left-=len(b)
  finally:out.close()
  os.chmod(dst,0o400);assert hmac.compare_digest(g.digest(),want)
 assert total==T and n==L and not f.read(1);f.close()
 assert hmac.compare_digest('sha256:'+h.hexdigest(),D) and E in paths
 os.unlink(S)
 for d in sorted(ds,key=len,reverse=True):os.chmod(d,0o500)
 x=os.path.join(R,*E.split('/'));assert stat.S_ISREG(os.stat(x,follow_symlinks=False).st_mode)
 os.chdir(R);os.execve(N,[N,x],{'PWD':R})
try:main()
except BaseException as e:
 try:os.write(2,('dolly-package-bootstrap: '+str(e)+'\n').encode('utf-8','replace')[:512])
 finally:os._exit(70)
`.trim();

export interface LinuxProcessConfinementOptions {
  /** Absolute Host path of the reviewed bubblewrap executable. */
  readonly bubblewrapProgram: string;
  /** Absolute Host path of the Node executable selected by Core. */
  readonly nodeProgram: string;
  /** Integrity-checked installed package directory. */
  readonly installationDirectory: string;
  /** Integrity-checked entry point inside installationDirectory. */
  readonly entrypointPath: string;
  /** Exact package bytes captured by the installation registry's verified scan. */
  readonly packageSnapshot: ExtensionPackageSnapshot;
  /** Effective Core state directory that must be hidden from the process. */
  readonly coreStateDirectory: string;
}

export interface LinuxProcessConfinementExecution {
  readonly program: string;
  readonly argumentVector: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly packageSnapshot: ExtensionPackageSnapshot;
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
  // The installation registry commonly lives below Core state. Keep the two
  // roots non-overlapping in the reverse direction so snapshot staging cannot
  // be mistaken for managed package content by a caller with a malformed
  // layout.
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
 * cgroup, mount, IPC, UTS, and network namespaces. The guest starts without a
 * Host root mount: it sees only the read-only system runtime tree, the exact
 * Core-selected Node executable, and a private reconstruction of the package
 * snapshot captured during registry verification, plus private `/dev`,
 * `/proc`, `/run`, and `/tmp` mounts. It never reopens the managed package path
 * after verification. This default-deny view keeps unrelated instance,
 * configuration, Media, home, and service-manager files absent. The process
 * also loses every capability and cannot create another user namespace. All
 * arguments come from Host-validated installation and instance state, never
 * from an Extension request.
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

  const argumentVector = Object.freeze([
    options.bubblewrapProgram,
    // `/usr` supplies the reviewed system runtime and native libraries. FHS
    // compatibility paths are recreated inside the otherwise empty guest;
    // none of `/etc`, `/home`, `/var`, or the Host root becomes visible.
    "--ro-bind", "/usr", "/usr",
    "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/sbin", "/sbin",
    "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib64", "/lib64",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/run",
    "--tmpfs", "/tmp",
    "--dir", "/run/dolly",
    "--file", PACKAGE_SNAPSHOT_DESCRIPTOR, GUEST_PACKAGE_SNAPSHOT,
    "--ro-bind", options.nodeProgram, GUEST_NODE_PROGRAM,
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
    "--chdir", "/run/dolly",
    "--",
    "/usr/bin/python3",
    "-I",
    "-B",
    "-c",
    LINUX_PACKAGE_SNAPSHOT_BOOTSTRAP,
    options.packageSnapshot.digest,
    String(options.packageSnapshot.byteLength),
    String(options.packageSnapshot.fileCount),
    String(options.packageSnapshot.totalFileBytes),
    relativeEntrypoint,
  ]);
  return Object.freeze({
    program: options.bubblewrapProgram,
    argumentVector,
    environment: Object.freeze({}),
    packageSnapshot: options.packageSnapshot,
  });
}
