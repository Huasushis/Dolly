/**
 * H5c: Skill Extension 独立测试
 * 测试 SKILL.md 解析、热更新等功能
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import type {
  BlockAccess,
  MediaAccess,
  ModuleContext,
} from "../../src/core/legacy-in-process-extension.js";
import type { Block, PremiseCollection } from "../../src/core/types.js";

describe("Skill Extension Standalone", () => {
  let skillModule: any;
  let tempDir: string;
  let skillsDir: string;

  const mockBlockAccess: BlockAccess = {
    get: vi.fn().mockReturnValue(null),
    acquire: () => {},
    release: () => {},
  };

  const mockMediaAccess: MediaAccess = {
    get: vi.fn().mockResolvedValue(Buffer.from("")),
    crop: vi.fn().mockResolvedValue("cropped"),
  };

  const emptyPremises: PremiseCollection = { upstream: [], downstream: [] };

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(path.join(tmpdir(), "dolly-skill-test-"));
    skillsDir = path.join(tempDir, "skills");
    mkdirSync(skillsDir, { recursive: true });

    const mockCtx: ModuleContext = {
      storagePath: tempDir,
      sharedPath: tempDir,
      media: mockMediaAccess,
      blocks: mockBlockAccess,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      config: {},
    };

    const skillExtension = (await import("../../extensions/skill/index.js")).default;
    skillModule = skillExtension.createModule({
      id: "standalone-skill",
      config: {
        skillsDir: skillsDir,
      },
    });
    await skillModule.init(mockCtx);
  });

  afterEach(async () => {
    if (skillModule) {
      await skillModule.onStop();
    }
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function createSkillMd(name: string, description: string, body: string): string {
    return `---
name: ${name}
description: ${description}
---
${body}`;
  }

  function writeSkill(skillName: string, content: string): void {
    const skillPath = path.join(skillsDir, skillName);
    mkdirSync(skillPath, { recursive: true });
    writeFileSync(path.join(skillPath, "SKILL.md"), content, "utf-8");
  }

  describe("syncFromDisk()", () => {
    it("should parse SKILL.md files", async () => {
      writeSkill(
        "weather",
        createSkillMd("weather", "Get weather info", "Use this skill to get weather.")
      );

      // 重新同步
      await skillModule.refresh();

      const skills = skillModule.listSkills();
      expect(skills.length).toBeGreaterThanOrEqual(1);
      expect(skills.some((s: any) => s.name === "weather")).toBe(true);
    });

    it("should handle missing SKILL.md gracefully", async () => {
      // 创建空目录
      mkdirSync(path.join(skillsDir, "empty-skill"), { recursive: true });

      await skillModule.refresh();

      // 不应该报错
      expect(true).toBe(true);
    });

    it("should parse frontmatter correctly", async () => {
      writeSkill(
        "test-skill",
        createSkillMd("test-skill", "A test skill", "Body content here")
      );

      await skillModule.refresh();

      const skills = skillModule.listSkills();
      const testSkill = skills.find((s: any) => s.name === "test-skill");
      expect(testSkill).toBeDefined();
      expect(testSkill.description).toBe("A test skill");
    });
  });

  describe("getOutputPremise()", () => {
    it("should return no skills message when empty", async () => {
      // 清空 skills 目录
      rmSync(skillsDir, { recursive: true, force: true });
      mkdirSync(skillsDir, { recursive: true });

      await skillModule.refresh();

      const premise = skillModule.getOutputPremise();
      expect(premise).toContain("No skills");
    });

    it("should list skills in premise", async () => {
      writeSkill(
        "calculator",
        createSkillMd("calculator", "Do math", "Math skill body")
      );

      await skillModule.refresh();

      const premise = skillModule.getOutputPremise();
      expect(premise).toContain("calculator");
      expect(premise).toContain("Do math");
    });

    it("should not expose an absolute file path in premise", async () => {
      writeSkill(
        "path-test",
        createSkillMd("path-test", "Path test skill", "Body")
      );

      await skillModule.refresh();

      const premise = skillModule.getOutputPremise();
      expect(premise).not.toContain(tempDir);
      expect(premise).not.toContain("SKILL.md");
    });
  });

  describe("getSkill()", () => {
    it("should return skill body", async () => {
      writeSkill(
        "body-test",
        createSkillMd("body-test", "Test", "This is the skill body content")
      );

      await skillModule.refresh();

      const body = await skillModule.getSkill("body-test");
      expect(body).toContain("skill body content");
    });

    it("should reject for non-existent skill", async () => {
      await expect(skillModule.getSkill("non-existent")).rejects.toThrow();
    });
  });

  describe("execute()", () => {
    it("should return null (passive module)", async () => {
      const result = await skillModule.execute({
        blocks: [],
        adjacentPremises: emptyPremises,
      });

      expect(result).toBeNull();
    });
  });

  describe("hot reload (chokidar)", () => {
    it("should detect new skill files", async () => {
      // 初始状态
      const initialSkills = skillModule.listSkills();

      // 添加新 skill
      writeSkill(
        "hot-reload-test",
        createSkillMd("hot-reload-test", "Hot reload", "New skill")
      );

      // 等待 watcher 触发
      await vi.waitFor(
        () => {
          expect(
            skillModule.listSkills().some((skill: any) => skill.name === "hot-reload-test"),
          ).toBe(true);
        },
        { timeout: 2000, interval: 20 },
      );

      // 手动触发同步（watcher 可能延迟）
    });
  });
});
