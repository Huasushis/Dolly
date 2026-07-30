import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DOLLY_CLI_HELP,
  runDollyCli,
  type DollyCliContext,
} from "../../../src/entry.js";
import type { DollyRuntimeDirectories } from "../../../src/core/runtime-bootstrap.js";

interface OutputCapture {
  readonly output: { write(text: string): void };
  readonly text: () => string;
}

function capture(): OutputCapture {
  let value = "";
  return {
    output: { write: (text) => { value += text; } },
    text: () => value,
  };
}

describe("public CLI runtime boundary", () => {
  let root: string;
  let project: string;
  let configPath: string;
  let directories: DollyRuntimeDirectories;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dolly-cli-runtime-"));
    project = join(root, "project");
    mkdirSync(project);
    configPath = join(project, "instance.json");
    directories = {
      registryDirectory: join(root, "registry"),
      defaultStateRoot: join(root, "instances"),
    };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function context(overrides: DollyCliContext = {}) {
    const stdout = capture();
    const stderr = capture();
    return {
      value: {
        cwd: project,
        directories,
        stdout: stdout.output,
        stderr: stderr.output,
        ...overrides,
      } satisfies DollyCliContext,
      stdout,
      stderr,
    };
  }

  it("initializes a stable provider-neutral instance and refuses overwrite", async () => {
    const first = context();
    await expect(runDollyCli([
      "init",
      "--config",
      configPath,
      "--name",
      "Local Dolly",
    ], first.value)).resolves.toBe(0);

    const document = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(document).toMatchObject({
      schemaVersion: "dolly.instance/9",
      displayName: "Local Dolly",
      modules: [],
      core: { media: { enabled: false } },
    });
    expect(document.instanceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(first.stdout.text()).toContain(`Configuration: ${realpathSync.native(configPath)}`);
    expect(first.stderr.text()).toBe("");
    expect(JSON.stringify(document)).not.toMatch(/aether|dashscope|oss|api[_-]?key/i);

    const duplicate = context();
    await expect(runDollyCli(["init", "--config", configPath], duplicate.value)).resolves.toBe(1);
    expect(duplicate.stderr.text()).toContain("[CONFIG_ALREADY_EXISTS]");
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(document);
  });

  it("shows only validated public configuration and never loads a project .env", async () => {
    const init = context();
    expect(await runDollyCli(["init", "--config", configPath], init.value)).toBe(0);
    writeFileSync(join(project, ".env"), "DOLLY_TEST_SECRET=must-not-load\n", "utf8");
    delete process.env.DOLLY_TEST_SECRET;

    const shown = context();
    expect(await runDollyCli(["config", "show", `--config=${configPath}`], shown.value)).toBe(0);
    expect(JSON.parse(shown.stdout.text())).toMatchObject({
      schemaVersion: "dolly.instance/9",
      instanceId: expect.any(String),
    });
    expect(shown.stdout.text()).not.toContain("must-not-load");
    expect(process.env.DOLLY_TEST_SECRET).toBeUndefined();
  });

  it("runs the production bootstrap and stops it cleanly", async () => {
    const init = context();
    expect(await runDollyCli(["init", "--config", configPath], init.value)).toBe(0);

    let observedReady = false;
    let observedStatus = false;
    let publicObjectOnly = false;
    const running = context({
      waitForShutdown: async (session) => {
        observedReady = session.state === "ready";
        observedStatus = session.status().state === "ready";
        publicObjectOnly =
          Object.isFrozen(session) &&
          !("core" in session) &&
          !("commits" in session) &&
          !("config" in session) &&
          !("recovery" in session);
        if (false) {
          // @ts-expect-error Public runtime sessions do not expose mutable Core state.
          session.core;
          // @ts-expect-error Public runtime sessions do not expose commit coordination.
          session.commits;
        }
      },
    });
    expect(await runDollyCli(["run", "--config", configPath], running.value)).toBe(0);

    expect(observedReady).toBe(true);
    expect(observedStatus).toBe(true);
    expect(publicObjectOnly).toBe(true);
    expect(running.stdout.text()).toMatch(/Dolly ready: [0-9a-f-]+/u);
    expect(running.stdout.text()).toContain("Dolly stopped");
    const instanceId = (JSON.parse(readFileSync(configPath, "utf8")) as { instanceId: string }).instanceId;
    expect(existsSync(join(directories.defaultStateRoot, instanceId, "core-state.json"))).toBe(true);
    expect(existsSync(join(directories.defaultStateRoot, instanceId, "module-result-commits.json"))).toBe(true);
  });

  it("fails closed for legacy configuration and migration-blocked commands", async () => {
    writeFileSync(configPath, JSON.stringify({
      name: "legacy",
      llm: { api_key: "must-not-echo" },
      pages: [],
      modules: [],
      logging: { level: "info" },
    }), "utf8");

    const legacy = context();
    expect(await runDollyCli(["run", "--config", configPath], legacy.value)).toBe(1);
    expect(legacy.stderr.text()).toContain("[CONFIG_DOCUMENT_INVALID]");
    expect(legacy.stderr.text()).not.toContain("must-not-echo");

    for (const command of ["start", "stop", "status"]) {
      const daemon = context();
      expect(await runDollyCli([command, "--config", configPath], daemon.value)).toBe(2);
      expect(daemon.stderr.text()).toContain("[CLI_FEATURE_UNAVAILABLE]");
      expect(daemon.stderr.text()).toContain("secure daemon");
    }
  });

  it("provides accurate help and rejects unknown command-line surface", async () => {
    const help = context();
    expect(await runDollyCli([], help.value)).toBe(0);
    expect(help.stdout.text().trim()).toBe(DOLLY_CLI_HELP);

    const unknown = context();
    expect(await runDollyCli(["run", "--surprise"], unknown.value)).toBe(2);
    expect(unknown.stderr.text()).toContain("[CLI_ARGUMENT_INVALID]");
    expect(unknown.stderr.text()).toContain("Unknown option");
  });
});
