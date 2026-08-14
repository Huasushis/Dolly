import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli, selectSubcommand } from "../../../src/cli/dispatch.js";
import { DOLLY_CLI_HELP } from "../../../src/cli/help.js";

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

const installedVersion = (
  JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../../../package.json"), "utf8"),
  ) as { version: string }
).version;

describe("CLI subcommand dispatch", () => {
  it.each([
    { argv: ["-h"], kind: "help" },
    { argv: ["--help"], kind: "help" },
    { argv: ["help"], kind: "help" },
    { argv: ["-v"], kind: "version" },
    { argv: ["--version"], kind: "version" },
    { argv: ["version"], kind: "version" },
    { argv: ["run", "--config", "instance.json"], kind: "run" },
    { argv: ["config", "show", "--config", "instance.json"], kind: "config" },
  ] as const)("selects $argv as the $kind subcommand", ({ argv, kind }) => {
    const selection = selectSubcommand(argv);
    expect(selection.kind).toBe(kind);
    if (selection.kind === "run" || selection.kind === "config") {
      expect(selection.argv).toBe(argv);
    }
  });

  it.each([
    { argv: [], kind: "legacy" },
    { argv: ["init", "--config", "instance.json"], kind: "legacy" },
    { argv: ["migrate-core-state", "--confirm"], kind: "legacy" },
    { argv: ["start"], kind: "legacy" },
    { argv: ["frobnicate"], kind: "legacy" },
    { argv: ["--config", "instance.json", "run"], kind: "legacy" },
  ] as const)(
    "falls through to the legacy entry path for $argv",
    ({ argv, kind }) => {
      expect(selectSubcommand(argv).kind).toBe(kind);
    },
  );

  it("prints the canonical help and exits 0", async () => {
    for (const argv of [["-h"], ["--help"], ["help"]]) {
      const stdout = capture();
      await expect(runCli(argv, { stdout: stdout.output })).resolves.toBe(0);
      expect(stdout.text()).toBe(`${DOLLY_CLI_HELP}\n`);
    }
  });

  it("prints the installed package version and exits 0", async () => {
    for (const argv of [["-v"], ["--version"], ["version"]]) {
      const stdout = capture();
      await expect(runCli(argv, { stdout: stdout.output })).resolves.toBe(0);
      expect(stdout.text().trim()).toBe(installedVersion);
    }
  });

  it("refuses an unknown subcommand", async () => {
    const stdout = capture();
    const stderr = capture();
    await expect(
      runCli(["frobnicate"], { stdout: stdout.output, stderr: stderr.output }),
    ).resolves.toBe(2);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("[CLI_ARGUMENT_INVALID]");
    expect(stderr.text()).toContain("Unknown command: frobnicate");
  });

  it("delegates run and config argument validation to the legacy executor", async () => {
    const configInvalid = capture();
    const stderr = capture();
    await expect(
      runCli(["config", "--config", "instance.json"], {
        stdout: configInvalid.output,
        stderr: stderr.output,
      }),
    ).resolves.toBe(2);
    expect(stderr.text()).toContain("Usage: dolly config show");

    const runInvalid = capture();
    const runStderr = capture();
    await expect(
      runCli(["run", "--surprise"], {
        stdout: runInvalid.output,
        stderr: runStderr.output,
      }),
    ).resolves.toBe(2);
    expect(runStderr.text()).toContain("[CLI_ARGUMENT_INVALID]");
    expect(runStderr.text()).toContain("Unknown option");
  });
});