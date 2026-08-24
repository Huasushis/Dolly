import { runDollyCli } from "./entry.js";
export {
  produceReservedV10ExtensionPackageManifest,
  type ProduceReservedV10ExtensionPackageManifestOptions,
  type ReservedV10InstalledExtensionPackageManifest,
} from "./core/reserved-v10-extension-package.js";

process.exitCode = await runDollyCli();
