/**
 * Thin filesystem watcher adapter for the Dolly Skill extension baseline.
 *
 * The watcher is a hint source and nothing else
 * (`docs/spec/skill-extension.md` section 6: "Filesystem watcher events are
 * hints, not truth"). It reads no file, parses nothing, holds no catalog, and
 * cannot publish a Module description. Every event it sees becomes one call to
 * `onChange`, which the caller wires to `SkillRefreshScheduler.notifyChange`;
 * the scheduler debounces those hints into one serialized source activation
 * request.
 *
 * A watcher error is reported through `onDegraded` rather than swallowed, so
 * the caller can ask for the stronger full rescan that section 6 requires after
 * watcher overflow or unsupported filesystem semantics.
 */

import { watch, type FSWatcher } from "chokidar";

export interface SkillLibraryWatcherOptions {
  readonly libraryRoot: string;
  /**
   * Traversal depth passed to the watcher. It should match the scanner's
   * `maxDirectoryDepth` so the watcher does not report changes the scan will
   * never look at.
   */
  readonly maxDepth: number;
  readonly onChange: () => void;
  readonly onDegraded: (error: unknown) => void;
}

export interface SkillLibraryWatcher {
  close(): Promise<void>;
}

/**
 * Starts watching one granted library root and resolves once the watcher is
 * ready. Symbolic links are never followed, matching the scanner, so a link
 * planted inside the library cannot extend the watched scope.
 */
export function watchSkillLibrary(
  options: SkillLibraryWatcherOptions,
): Promise<SkillLibraryWatcher> {
  const watcher: FSWatcher = watch(options.libraryRoot, {
    ignoreInitial: true,
    followSymlinks: false,
    depth: options.maxDepth,
    persistent: true,
  });

  return new Promise<SkillLibraryWatcher>((resolveWatcher, rejectWatcher) => {
    const onStartupError = (error: unknown): void => {
      watcher.off("ready", onReady);
      void watcher.close().finally(() => rejectWatcher(error));
    };
    const onReady = (): void => {
      watcher.off("error", onStartupError);
      for (const event of ["add", "change", "unlink", "addDir", "unlinkDir"] as const) {
        watcher.on(event, () => options.onChange());
      }
      watcher.on("error", (error) => options.onDegraded(error));
      resolveWatcher({
        close: async () => {
          await watcher.close();
        },
      });
    };

    watcher.once("ready", onReady);
    watcher.once("error", onStartupError);
  });
}
