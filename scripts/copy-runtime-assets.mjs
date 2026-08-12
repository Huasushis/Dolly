import {
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  chmodSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

const RUNTIME_ASSETS = [
  "src/adapters/linux-module-launcher/launcher.py",
];

function requireOrdinaryFile(path, label) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be an ordinary file`);
  }
}

/**
 * Copies non-TypeScript files that runtime modules resolve relative to their
 * compiled JavaScript. The build output uses the same repository-relative
 * path so `import.meta.url` resolves identically in source and installed code.
 */
export function copyRuntimeAssets({ repositoryRoot, outputDirectory }) {
  const copied = [];
  for (const relativePath of RUNTIME_ASSETS) {
    const source = resolve(repositoryRoot, relativePath);
    const target = resolve(outputDirectory, relativePath);
    requireOrdinaryFile(source, `Runtime asset ${relativePath}`);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target, constants.COPYFILE_EXCL);
    chmodSync(target, 0o644);
    requireOrdinaryFile(target, `Built runtime asset ${relativePath}`);
    const sourceBytes = readFileSync(source);
    const targetBytes = readFileSync(target);
    if (!sourceBytes.equals(targetBytes)) {
      throw new Error(`Built runtime asset ${relativePath} differs from its source`);
    }
    copied.push(relativePath);
  }
  return Object.freeze(copied);
}
