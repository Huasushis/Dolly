/**
 * 实验 2: 去词性 Embedding (POS-Removed Embedding)
 * 
 * ═══════════════════════════════════════════════════════════════════════════
 * 实验目的
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * 验证用户 Idea: "去掉句子中一些特殊词性的词，然后跑 embedding，
 * 来查找相同抽象模式的段落"
 * 
 * 核心问题:
 * 1. 去掉名词后的 embedding 是否能捕获"关系结构"相似性？
 * 2. 去掉动词后是否保留"实体关系"？
 * 3. 去词性 embedding vs 完整 embedding，哪个更能匹配"模式相似但措辞不同"的文本？
 * 
 * ═══════════════════════════════════════════════════════════════════════════
 * 实验设计
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * 测试用例设计原则:
 * - 组 A: 相同"抽象模式"但不同具体内容
 *   例: "猫追老鼠" vs "狗追兔子" (都是: 动物A 追 动物B)
 * - 组 B: 不同"抽象模式"但相似词汇
 *   例: "猫追老鼠" vs "猫抓老鼠" (动作不同)
 * 
 * 自变量: 文本处理方式
 *   - 原始文本
 *   - 去名词 (保留动作/关系)
 *   - 去动词 (保留实体)
 *   - 去形容词/副词 (保留核心结构)
 * 
 * 因变量: 与目标文本的 cosine 相似度
 * 
 * 假设:
 *   H1: 去名词后的 embedding 更能匹配"相同动作模式"的文本
 *   H2: 去动词后的 embedding 更能匹配"相同实体关系"的文本
 * 
 * ═══════════════════════════════════════════════════════════════════════════
 * 运行方式
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * npx tsx test/memory-experiments/exp2-pos-removed-embedding.ts
 */

import {
  getEmbedding,
  getEmbeddings,
  cosineSimilarity,
  mean,
  fmt,
  printResult,
  type ExperimentResult,
} from "./utils.js";

// ─── 简易中文分词与词性标注 ──────────────────────────────────────────────────

/**
 * 由于 nodejieba 需要编译，这里使用简化的规则分词
 * 实际生产环境应使用 nodejieba.tag()
 * 
 * 简化策略: 基于常见词性词典进行匹配
 */

// 常见名词 (n)
const NOUNS = new Set([
  "猫", "狗", "老鼠", "兔子", "鸟", "鱼", "树", "花", "草", "山", "河", "海",
  "太阳", "月亮", "星星", "云", "雨", "雪", "风", "火", "水", "土", "石",
  "人", "孩子", "老人", "男人", "女人", "朋友", "家人", "老师", "学生",
  "书", "笔", "纸", "电脑", "手机", "车", "房子", "门", "窗", "桌子", "椅子",
  "苹果", "香蕉", "橘子", "西瓜", "葡萄", "草莓",
  "北京", "上海", "广州", "深圳", "杭州", "成都",
  "春天", "夏天", "秋天", "冬天", "早上", "中午", "晚上",
  "公司", "学校", "医院", "公园", "商店", "餐厅",
  "问题", "方法", "结果", "数据", "信息", "知识", "经验",
  "项目", "任务", "目标", "计划", "方案", "报告",
]);

// 常见动词 (v)
const VERBS = new Set([
  "追", "跑", "走", "飞", "游", "跳", "爬", "坐", "站", "躺",
  "吃", "喝", "看", "听", "说", "读", "写", "画", "唱", "跳",
  "抓", "拿", "放", "推", "拉", "打", "踢", "扔", "接", "抱",
  "爱", "恨", "喜欢", "讨厌", "害怕", "担心", "希望", "想念",
  "是", "有", "在", "成为", "变成", "感觉", "觉得", "认为",
  "学习", "工作", "研究", "分析", "解决", "处理", "完成", "开始",
  "创建", "删除", "修改", "更新", "保存", "加载", "运行", "测试",
  "去", "来", "回", "到", "进", "出", "上", "下",
]);

// 常见形容词 (a)
const ADJECTIVES = new Set([
  "大", "小", "高", "矮", "长", "短", "宽", "窄", "厚", "薄",
  "快", "慢", "早", "晚", "新", "旧", "好", "坏", "美", "丑",
  "冷", "热", "暖", "凉", "干", "湿", "硬", "软", "轻", "重",
  "红", "黄", "蓝", "绿", "白", "黑", "紫", "灰",
  "开心", "难过", "生气", "害怕", "惊讶", "无聊", "兴奋", "疲惫",
  "重要", "简单", "复杂", "困难", "容易", "有趣", "无聊",
]);

// 常见副词 (d)
const ADVERBS = new Set([
  "很", "非常", "特别", "十分", "相当", "比较", "有点", "稍微",
  "都", "也", "又", "再", "还", "已经", "正在", "刚刚", "马上",
  "不", "没", "别", "未", "非", "无",
  "就", "才", "只", "仅", "光", "单",
]);

/**
 * 简易分词 (单字 + 双字匹配)
 */
function simpleTokenize(text: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  
  while (i < text.length) {
    // 尝试双字词
    if (i + 1 < text.length) {
      const twoChar = text.slice(i, i + 2);
      if (NOUNS.has(twoChar) || VERBS.has(twoChar) || ADJECTIVES.has(twoChar) || ADVERBS.has(twoChar)) {
        tokens.push(twoChar);
        i += 2;
        continue;
      }
    }
    
    // 单字词
    const oneChar = text[i];
    if (/[\u4e00-\u9fa5]/.test(oneChar)) {
      tokens.push(oneChar);
    } else if (/[a-zA-Z0-9]/.test(oneChar)) {
      // 英文/数字连续
      let j = i;
      while (j < text.length && /[a-zA-Z0-9]/.test(text[j])) j++;
      tokens.push(text.slice(i, j));
      i = j;
      continue;
    }
    i++;
  }
  
  return tokens;
}

/**
 * 获取词的词性
 */
function getPOS(word: string): "n" | "v" | "a" | "d" | "other" {
  if (NOUNS.has(word)) return "n";
  if (VERBS.has(word)) return "v";
  if (ADJECTIVES.has(word)) return "a";
  if (ADVERBS.has(word)) return "d";
  return "other";
}

/**
 * 按词性过滤文本
 */
function filterByPOS(text: string, removePOS: Set<string>): string {
  const tokens = simpleTokenize(text);
  const filtered = tokens.filter(token => {
    const pos = getPOS(token);
    return !removePOS.has(pos);
  });
  return filtered.join(" ");
}

// ─── 实验数据 ────────────────────────────────────────────────────────────────

/**
 * 测试用例组
 * 
 * 设计原则:
 * - patternMatch: 相同抽象模式，不同具体内容 (应该被去名词 embedding 匹配)
 * - entityMatch: 相同实体，不同动作 (应该被去动词 embedding 匹配)
 * - control: 无关文本 (基线)
 */
const TEST_CASES = {
  // 测试 1: "A追B" 模式
  query1: {
    text: "猫追老鼠",
    patternMatch: ["狗追兔子", "鸟追虫子", "孩子追蝴蝶"],  // 相同模式: X追Y
    entityMatch: ["猫抓老鼠", "猫怕老鼠", "猫看老鼠"],      // 相同实体: 猫-老鼠
    control: ["太阳升起", "花朵开放", "河水流动"],          // 无关
  },
  
  // 测试 2: "A在B里C" 模式
  query2: {
    text: "鱼在水里游",
    patternMatch: ["鸟在天上飞", "孩子在公园跑", "车在路上开"],  // 相同模式: X在Y里Z
    entityMatch: ["鱼在水里吃", "鱼在水里睡", "鱼在水里跳"],    // 相同实体: 鱼-水
    control: ["书在桌上放", "笔在纸上写", "云在山顶飘"],        // 弱相关
  },
  
  // 测试 3: "A给B送C" 模式
  query3: {
    text: "朋友给我送礼物",
    patternMatch: ["老师给学生送知识", "父母给孩子送温暖", "公司给客户送优惠"],
    entityMatch: ["朋友给我写信", "朋友给我打电话", "朋友给我发消息"],
    control: ["太阳给大地送温暖", "月亮给夜晚送光明", "春天给花朵送颜色"],
  },
  
  // 测试 4: 技术场景 "A解决B" 模式
  query4: {
    text: "程序员解决bug",
    patternMatch: ["医生解决病人问题", "老师解决学生疑惑", "律师解决案件纠纷"],
    entityMatch: ["程序员发现bug", "程序员修复bug", "程序员报告bug"],
    control: ["厨师解决晚餐", "司机解决交通", "设计师解决方案"],
  },
};

// ─── 实验执行 ────────────────────────────────────────────────────────────────

async function runExperiment() {
  console.log("╔══════════════════════════════════════════════════════════════════════╗");
  console.log("║  实验 2: 去词性 Embedding (POS-Removed Embedding)                    ║");
  console.log("╚══════════════════════════════════════════════════════════════════════╝\n");

  const results: {
    queryName: string;
    method: string;
    patternSim: number;
    entitySim: number;
    controlSim: number;
    patternVsControl: number;
    entityVsControl: number;
  }[] = [];

  const methods = [
    { name: "原始文本", removePOS: new Set<string>() },
    { name: "去名词", removePOS: new Set(["n"]) },
    { name: "去动词", removePOS: new Set(["v"]) },
    { name: "去形容词", removePOS: new Set(["a"]) },
    { name: "去名+动", removePOS: new Set(["n", "v"]) },
  ];

  for (const [queryName, testCase] of Object.entries(TEST_CASES)) {
    console.log(`\n📝 测试用例: ${queryName}`);
    console.log(`   查询文本: "${testCase.text}"`);
    
    // 展示分词结果
    const tokens = simpleTokenize(testCase.text);
    const posTags = tokens.map(t => `${t}/${getPOS(t)}`);
    console.log(`   分词结果: ${posTags.join(" ")}`);

    for (const method of methods) {
      // 处理查询文本
      const processedQuery = method.removePOS.size > 0
        ? filterByPOS(testCase.text, method.removePOS)
        : testCase.text;
      
      console.log(`\n   🔧 方法: ${method.name}`);
      console.log(`      处理后: "${processedQuery}"`);

      // 获取查询 embedding
      const queryEmb = await getEmbedding(processedQuery);

      // 处理并获取各类别文本的 embeddings
      const processTexts = (texts: string[]) =>
        texts.map(t => method.removePOS.size > 0 ? filterByPOS(t, method.removePOS) : t);

      const patternTexts = processTexts(testCase.patternMatch);
      const entityTexts = processTexts(testCase.entityMatch);
      const controlTexts = processTexts(testCase.control);

      console.log(`      模式匹配文本: ${patternTexts.map(t => `"${t}"`).join(", ")}`);

      const [patternEmbs, entityEmbs, controlEmbs] = await Promise.all([
        getEmbeddings(patternTexts),
        getEmbeddings(entityTexts),
        getEmbeddings(controlEmbs.length ? controlTexts : controlTexts),
      ]);

      // 计算平均相似度
      const patternSim = mean(patternEmbs.map(e => cosineSimilarity(queryEmb, e)));
      const entitySim = mean(entityEmbs.map(e => cosineSimilarity(queryEmb, e)));
      const controlSim = mean(controlEmbs.map(e => cosineSimilarity(queryEmb, e)));

      results.push({
        queryName,
        method: method.name,
        patternSim,
        entitySim,
        controlSim,
        patternVsControl: patternSim - controlSim,
        entityVsControl: entitySim - controlSim,
      });

      console.log(`      📊 相似度: 模式=${fmt(patternSim)} | 实体=${fmt(entitySim)} | 对照=${fmt(controlSim)}`);
      console.log(`      📈 区分度: 模式-对照=${fmt(patternSim - controlSim)} | 实体-对照=${fmt(entitySim - controlSim)}`);
    }
  }

  // ─── 汇总分析 ──────────────────────────────────────────────────────────────

  console.log("\n\n" + "═".repeat(70));
  console.log("📊 汇总分析");
  console.log("═".repeat(70));

  // 按方法分组统计
  const methodStats: Record<string, {
    patternSim: number[];
    entitySim: number[];
    controlSim: number[];
    patternDiscrim: number[];
    entityDiscrim: number[];
  }> = {};

  for (const r of results) {
    if (!methodStats[r.method]) {
      methodStats[r.method] = {
        patternSim: [],
        entitySim: [],
        controlSim: [],
        patternDiscrim: [],
        entityDiscrim: [],
      };
    }
    methodStats[r.method].patternSim.push(r.patternSim);
    methodStats[r.method].entitySim.push(r.entitySim);
    methodStats[r.method].controlSim.push(r.controlSim);
    methodStats[r.method].patternDiscrim.push(r.patternVsControl);
    methodStats[r.method].entityDiscrim.push(r.entityVsControl);
  }

  console.log("\n┌─────────────────────────────────────────────────────────────────────────────┐");
  console.log("│ 各方法的平均区分度 (越高越好)                                               │");
  console.log("├──────────────┬──────────────────┬──────────────────┬────────────────────────┤");
  console.log("│ 方法         │ 模式匹配区分度   │ 实体匹配区分度   │ 综合评价               │");
  console.log("├──────────────┼──────────────────┼──────────────────┼────────────────────────┤");

  for (const [method, stats] of Object.entries(methodStats)) {
    const avgPatternDiscrim = mean(stats.patternDiscrim);
    const avgEntityDiscrim = mean(stats.entityDiscrim);
    const overall = (avgPatternDiscrim + avgEntityDiscrim) / 2;
    
    console.log(
      `│ ${method.padEnd(12)} │ ${fmt(avgPatternDiscrim).padStart(16)} │ ` +
      `${fmt(avgEntityDiscrim).padStart(16)} │ ${fmt(overall).padStart(22)} │`
    );
  }
  console.log("└──────────────┴──────────────────┴──────────────────┴────────────────────────┘");

  // ─── 验证假设 ──────────────────────────────────────────────────────────────

  const originalPattern = mean(methodStats["原始文本"].patternDiscrim);
  const noNounPattern = mean(methodStats["去名词"].patternDiscrim);
  const noVerbEntity = mean(methodStats["去动词"].entityDiscrim);
  const originalEntity = mean(methodStats["原始文本"].entityDiscrim);

  const h1Supported = noNounPattern > originalPattern;
  const h2Supported = noVerbEntity > originalEntity;

  console.log("\n📋 假设验证:");
  console.log(`   H1: 去名词后模式匹配区分度提升?`);
  console.log(`       原始: ${fmt(originalPattern)} → 去名词: ${fmt(noNounPattern)} ${h1Supported ? "✓ 支持" : "✗ 不支持"}`);
  console.log(`   H2: 去动词后实体匹配区分度提升?`);
  console.log(`       原始: ${fmt(originalEntity)} → 去动词: ${fmt(noVerbEntity)} ${h2Supported ? "✓ 支持" : "✗ 不支持"}`);

  // ─── 生成结论 ──────────────────────────────────────────────────────────────

  const result: ExperimentResult = {
    name: "去词性 Embedding (POS-Removed Embedding)",
    hypothesis: "去名词 embedding 更能匹配抽象模式；去动词 embedding 更能匹配实体关系",
    data: {
      methodComparison: Object.fromEntries(
        Object.entries(methodStats).map(([method, stats]) => [
          method,
          {
            patternDiscrim: mean(stats.patternDiscrim),
            entityDiscrim: mean(stats.entityDiscrim),
          },
        ])
      ),
      h1Supported,
      h2Supported,
      originalPatternDiscrim: originalPattern,
      noNounPatternDiscrim: noNounPattern,
      originalEntityDiscrim: originalEntity,
      noVerbEntityDiscrim: noVerbEntity,
    },
    conclusion: 
      (h1Supported || h2Supported)
        ? `部分支持假设。` +
          (h1Supported ? `去名词后模式匹配区分度从 ${fmt(originalPattern)} 提升到 ${fmt(noNounPattern)}。` : "") +
          (h2Supported ? `去动词后实体匹配区分度从 ${fmt(originalEntity)} 提升到 ${fmt(noVerbEntity)}。` : "") +
          " 该方法可作为辅助检索维度，但效果提升有限，建议与其他方法结合使用。"
        : "不支持假设。去词性处理未能显著提升抽象模式匹配能力。" +
          " 现代 embedding 模型可能已经在向量空间中编码了结构信息。",
    feasible: (h1Supported || h2Supported) ? "partial" : "no",
  };

  printResult(result);

  // ─── 实现建议 ──────────────────────────────────────────────────────────────

  console.log("💡 工程化实现建议:");
  console.log("   1. 使用 nodejieba.tag() 进行准确的中文词性标注");
  console.log("   2. 为每个 block 生成多个 embedding 变体 (原始/去名词/去动词)");
  console.log("   3. 检索时根据查询意图选择对应的 embedding 变体");
  console.log("   4. 计算成本: 每个 block 需要 2-3 倍 embedding 调用");
  console.log("   5. 替代方案: 使用 LLM 直接提取'抽象模式描述'再 embedding\n");
}

// ─── 运行 ────────────────────────────────────────────────────────────────────

runExperiment().catch(console.error);
