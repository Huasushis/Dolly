---
name: skill-creator
description: 创建、修改和优化 Agent Skills。当用户想要创建一个新 skill、编辑现有 skill、评估 skill 效果时触发。
---

# Skill Creator

用于创建和迭代优化 Agent Skills。

## 创建流程

1. **确定需求**：这个 skill 要做什么？什么时候触发？输出什么？
2. **写草稿**：创建 SKILL.md（YAML frontmatter + Markdown 指令）
3. **测试**：编写测试用例，验证 skill 效果
4. **迭代**：根据测试结果修改，反复优化

## SKILL.md 格式

```
---
name: skill-name        # 必须小写+连字符+匹配目录名
description: 功能描述+触发条件  # 这是主要的触发检测依据
---

# Skill 名称

## 使用说明
...
```

## 目录结构

```
skill-name/
├── SKILL.md (必需)
│   ├── YAML frontmatter (name + description 必需)
│   └── Markdown 指令
└── 可选资源
    ├── scripts/    - 可执行脚本
    ├── references/ - 参考文档
    └── assets/     - 模板、资源文件
```

## 关键技巧

- `description` 要写得稍微"激进"——LLM 倾向于不触发 skill，所以描述要明确告诉它什么时候必须用
- SKILL.md body 控制在 500 行以内
- 把详细参考材料放在 `references/` 中，按需加载
