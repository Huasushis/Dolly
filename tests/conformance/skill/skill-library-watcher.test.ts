import { afterEach, describe, expect, it } from "vitest";

import { scanSkillLibrary } from "../../../src/extensions/skill/skill-catalog.js";
import { renderSkillModuleDescription } from "../../../src/extensions/skill/skill-description.js";
import {
  SkillRefreshScheduler,
  type SkillSourceActivationRequest,
} from "../../../src/extensions/skill/skill-refresh.js";
import {
  watchSkillLibrary,
  type SkillLibraryWatcher,
} from "../../../src/extensions/skill/skill-library-watcher.js";
import { ManualTimerHost } from "./fixtures/manual-timers.js";
import {
  createTemporaryRoot,
  removeTemporaryRoot,
  writeSkill,
} from "./fixtures/skill-library.js";

const roots: string[] = [];
const watchers: SkillLibraryWatcher[] = [];

function newLibrary(): string {
  const root = createTemporaryRoot();
  roots.push(root);
  return root;
}

afterEach(async () => {
  while (watchers.length > 0) await watchers.pop()!.close();
  while (roots.length > 0) removeTemporaryRoot(roots.pop()!);
});

/**
 * Waits for a real filesystem event with a finite bound. This is the only place
 * in the suite that waits on wall-clock time; the debounce, coalescing, and
 * idempotency rules are covered by the injected-clock tests instead.
 */
async function waitForCondition(
  predicate: () => boolean,
  label: string,
  timeoutMs = 10000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("skill library watcher", () => {
  it("reports a new skill file as a change hint", async () => {
    const library = newLibrary();
    let changes = 0;
    const degraded: unknown[] = [];
    const watcher = await watchSkillLibrary({
      libraryRoot: library,
      maxDepth: 4,
      onChange: () => {
        changes += 1;
      },
      onDegraded: (error) => degraded.push(error),
    });
    watchers.push(watcher);

    writeSkill(library, "weather");
    await waitForCondition(() => changes > 0, "a watcher change hint");

    expect(changes).toBeGreaterThan(0);
    expect(degraded).toEqual([]);
  });

  it("stops reporting once it is closed", async () => {
    const library = newLibrary();
    let changes = 0;
    const watcher = await watchSkillLibrary({
      libraryRoot: library,
      maxDepth: 4,
      onChange: () => {
        changes += 1;
      },
      onDegraded: () => {},
    });

    writeSkill(library, "weather");
    await waitForCondition(() => changes > 0, "the first watcher change hint");
    await watcher.close();

    const afterClose = changes;
    writeSkill(library, "forecast");
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(changes).toBe(afterClose);
  });
});

describe("skill hot reload end to end", () => {
  it("turns a real directory change into one serialized refresh request and a new description", async () => {
    const library = newLibrary();
    writeSkill(library, "weather");

    const timers = new ManualTimerHost();
    const requests: SkillSourceActivationRequest[] = [];
    const scheduler = new SkillRefreshScheduler({
      moduleId: "skill-module",
      monotonicNow: timers.monotonicNow,
      setTimer: timers.setTimer,
      submitSourceActivation: (request) => requests.push(request),
      debounceMs: 500,
      periodicVerificationMs: 0,
    });

    // The initial run is the actor run the runtime creates from the first
    // source activation request. Only that run produces a description.
    scheduler.start();
    expect(requests).toHaveLength(1);
    const firstCatalog = scanSkillLibrary({ libraryRoot: library });
    const firstDescription = renderSkillModuleDescription(firstCatalog);
    scheduler.completeRefresh(requests[0]!.idempotencyKey);

    expect(firstDescription).toContain("weather");
    expect(firstDescription).not.toContain("forecast");

    const watcher = await watchSkillLibrary({
      libraryRoot: library,
      maxDepth: 4,
      onChange: () => scheduler.notifyChange("filesystem-change"),
      onDegraded: () => scheduler.notifyChange("watcher-degraded"),
    });
    watchers.push(watcher);

    writeSkill(library, "forecast");
    await waitForCondition(
      () => scheduler.status().pendingSignalCount > 0,
      "a coalesced change hint",
    );

    // Background activity has proposed nothing on its own so far.
    expect(requests).toHaveLength(1);

    timers.advance(500);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      idempotencyKey: "skill-refresh:skill-module:1",
      reason: "filesystem-change",
    });

    const secondCatalog = scanSkillLibrary({ libraryRoot: library });
    const secondDescription = renderSkillModuleDescription(secondCatalog);
    scheduler.completeRefresh(requests[1]!.idempotencyKey);

    expect(secondCatalog.revisionDigest).not.toBe(firstCatalog.revisionDigest);
    expect(secondDescription).toContain("forecast");
    expect(secondDescription).toContain("weather");

    scheduler.stop();
  });
});
