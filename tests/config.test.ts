import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";

describe("Config", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "dolly-config-test-"));
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("zod schema validation", () => {
    it("should accept valid config", () => {
      const configPath = path.join(tempDir, "dolly.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          name: "test-instance",
          dataDir: path.join(tempDir, "data"),
          llm: {},
          pages: [{ id: "main" }],
          modules: [
            {
              id: "mod1",
              extension: "console",
              inputPages: ["main"],
              outputPages: ["main"],
            },
          ],
          logging: { level: "info" },
        }),
      );

      const config = loadConfig(configPath);
      expect(config.name).toBe("test-instance");
      expect(config.pages).toHaveLength(1);
      expect(config.modules).toHaveLength(1);
    });

    it("should reject invalid config (missing required fields)", () => {
      const configPath = path.join(tempDir, "bad.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          // Missing required 'id' in module
          modules: [{ extension: "test", inputPages: [], outputPages: [] }],
        }),
      );

      expect(() => loadConfig(configPath)).toThrow();
    });

    it("should reject non-existent config file", () => {
      expect(() => loadConfig(path.join(tempDir, "nonexistent.json"))).toThrow("Config not found");
    });
  });

  describe("$ENV_VAR replacement", () => {
    it("should replace environment variables in string values", () => {
      process.env.DOLLY_TEST_NAME = "from-env";
      const configPath = path.join(tempDir, "env.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          name: "$DOLLY_TEST_NAME",
          dataDir: path.join(tempDir, "data"),
        }),
      );

      const config = loadConfig(configPath);
      expect(config.name).toBe("from-env");

      delete process.env.DOLLY_TEST_NAME;
    });

    it("should replace env vars in nested objects", () => {
      process.env.DOLLY_API_KEY = "secret-key-123";
      const configPath = path.join(tempDir, "nested-env.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          name: "test",
          dataDir: path.join(tempDir, "data"),
          llm: {
            default: {
              base_url: "https://api.example.com",
              api_key: "$DOLLY_API_KEY",
              model: "gpt-4",
            },
          },
        }),
      );

      const config = loadConfig(configPath);
      expect(config.llm.default.api_key).toBe("secret-key-123");

      delete process.env.DOLLY_API_KEY;
    });

    it("should replace undefined env vars with empty string", () => {
      const configPath = path.join(tempDir, "undef-env.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          name: "$DOLLY_NONEXISTENT_VAR_XYZ",
          dataDir: path.join(tempDir, "data"),
        }),
      );

      const config = loadConfig(configPath);
      expect(config.name).toBe("");
    });
  });

  describe("defaults merging", () => {
    it("should apply default values for optional fields", () => {
      const configPath = path.join(tempDir, "minimal.json");
      writeFileSync(configPath, JSON.stringify({}));

      const config = loadConfig(configPath);
      expect(config.name).toBe("default");
      expect(config.pages).toEqual([]);
      expect(config.modules).toEqual([]);
      expect(config.logging.level).toBe("info");
    });

    it("should fill schedule defaults for modules", () => {
      const configPath = path.join(tempDir, "with-module.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          modules: [
            {
              id: "mod1",
              extension: "test",
              inputPages: [],
              outputPages: [],
            },
          ],
        }),
      );

      const config = loadConfig(configPath);
      expect(config.modules[0].schedule).toEqual({
        initialIntervalMs: 2000,
        minIntervalMs: 500,
        maxIntervalMs: 60000,
      });
    });

    it("should allow partial schedule overrides", () => {
      const configPath = path.join(tempDir, "partial-schedule.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          modules: [
            {
              id: "mod1",
              extension: "test",
              inputPages: [],
              outputPages: [],
              schedule: { initialIntervalMs: 5000 },
            },
          ],
        }),
      );

      const config = loadConfig(configPath);
      expect(config.modules[0].schedule!.initialIntervalMs).toBe(5000);
      expect(config.modules[0].schedule!.minIntervalMs).toBe(500); // default
      expect(config.modules[0].schedule!.maxIntervalMs).toBe(60000); // default
    });
  });
});
