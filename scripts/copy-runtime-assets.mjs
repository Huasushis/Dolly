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
  {
    path: "src/adapters/linux-module-launcher/launcher.py",
    compiledConsumer: "src/adapters/linux-module-launcher/linux-module-launcher-process.js",
  },
  {
    // The console client page, script, and styles resolve relative to the
    // compiled web-channel loader (`new URL("./web/…", import.meta.url)`).
    path: "src/extensions/console/web/index.html",
    compiledConsumer: "src/extensions/console/web-channel.js",
  },
  {
    path: "src/extensions/console/web/app.js",
    compiledConsumer: "src/extensions/console/web-channel.js",
  },
  {
    path: "src/extensions/console/web/styles.css",
    compiledConsumer: "src/extensions/console/web-channel.js",
  },
];

function requireOrdinaryFile(path, label) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch (cause) {
    throw new Error(`${label} must be an ordinary file`, { cause });
  }
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
  for (const asset of RUNTIME_ASSETS) {
    const relativePath = asset.path;
    const source = resolve(repositoryRoot, relativePath);
    const target = resolve(outputDirectory, relativePath);
    requireOrdinaryFile(
      resolve(outputDirectory, asset.compiledConsumer),
      `Compiled runtime asset consumer ${asset.compiledConsumer}`,
    );
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
