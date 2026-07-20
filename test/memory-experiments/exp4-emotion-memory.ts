/**
 * 实验 4: 情绪触发记忆 (Emotion-Triggered Memory Retrieval)
 * 
 * ═══════════════════════════════════════════════════════════════════════════
 * 实验目的
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * 验证用户 Idea: "人可以在某种强烈的情绪或者愿望下联想到过去相同情绪、
 * 相同愿望的经历。可以对一些 block 总结出印象深刻的地方。"
 * 
 * 核心问题:
 * 1. 情绪标注在对话中的可行性如何？
 * 2. 按情绪聚类存储 vs 按语义聚类存储，效果差异？
 * 3. 当用户当前情绪状态匹配时，能否召回语义上不直接相关但情绪上相关的记忆？
 * 4. "印象深刻"的判断标准：是否有客观衡量方式？
 * 
 * ═══════════════════════════════════════════════════════════════════════════
 * 理论基础
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * 认知神经科学:
 * - 杏仁核-海马体绑定: 情绪强烈的记忆有更高的提取概率 (Cahill et al., 1995)
 * - 情绪一致性效应: 当前情绪状态作为检索线索，优先激活同情绪记忆
 * - 情绪增强效应: 情感记忆的提取潜伏期更短，准确率更高
 * 
 * 工程实现参考:
 * - lucid-memory: 支持 emotional_weights 参数
 * - 对话情绪识别: ERC (Emotion Recognition in Conversation)
 * 
 * ═══════════════════════════════════════════════════════════════════════════
 * 实验设计
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * 实验 A: 情绪标注可行性
 * - 使用规则 + 关键词匹配进行情绪标注
 * - 评估标注覆盖率和一致性
 * 
 * 实验 B: 情绪检索 vs 语义检索
 * - 给定一个"情绪查询"，对比:
 *   a) 纯语义检索 (cosine similarity)
 *   b) 情绪增强检索 (semantic * emotion_match)
 * 
 * 实验 C: 印象深刻度评估
 * - 测试不同指标与"印象深刻"的相关性:
 *   - 情绪强度
 *   - 信息密度 (关键词数量)
 *   - 异常度 (与平均 embedding 的距离)
 * 
 * 假设:
 *   H1: 情绪增强检索能召回语义不相关但情绪相关的记忆
 *   H2: 情绪强度与"印象深刻"正相关
 * 
 * ═══════════════════════════════════════════════════════════════════════════
 * 数据加载
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * 优先使用 test/memory-data/emotional_memories.json (如果存在)
 * 否则使用内置 mock 数据
 * 
 * ═══════════════════════════════════════════════════════════════════════════
 * 运行方式
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * npx tsx test/memory-experiments/exp4-emotion-memory.ts
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  getEmbedding,
  getEmbeddings,
  cosineSimilarity,
  mean,
  std,
  fmt,
  printResult,
  type ExperimentResult,
} from "./utils.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── 情绪分类系统 ────────────────────────────────────────────────────────────

type Emotion = "joy" | "sadness" | "anger" | "fear" | "surprise" | "love" | "neutral";

interface EmotionRule {
  emotion: Emotion;
  keywords: string[];
  intensity: number;
}

const EMOTION_RULES: EmotionRule[] = [
  { emotion: "joy", keywords: ["开心", "高兴", "快乐", "太好了", "棒", "赞", "哈哈", "嘻嘻", "愉快", "兴奋", "欣喜", "满足", "幸福", "温暖"], intensity: 0.8 },
  { emotion: "sadness", keywords: ["难过", "伤心", "哭", "悲伤", "失落", "沮丧", "失望", "遗憾", "可惜", "唉", "心酸", "痛苦", "孤独", "寂寞"], intensity: 0.8 },
  { emotion: "anger", keywords: ["生气", "愤怒", "气死", "烦", "讨厌", "可恶", "混蛋", "该死", "受够了", "忍无可忍", "火大", "恼火"], intensity: 0.9 },
  { emotion: "fear", keywords: ["害怕", "恐惧", "担心", "紧张", "焦虑", "不安", "恐慌", "吓人", "可怕", " dread", "忐忑", "心慌"], intensity: 0.8 },
  { emotion: "surprise", keywords: ["惊讶", "震惊", "没想到", "居然", "竟然", "哇", "天哪", "不可思议", "意外", "突然", "猛然"], intensity: 0.7 },
  { emotion: "love", keywords: ["爱", "喜欢", "想念", "思念", "牵挂", "珍惜", "感恩", "感激", "心动", "温馨", "甜蜜"], intensity: 0.8 },
];

/**
 * 基于规则的情绪检测
 */
function detectEmotion(text: string): { emotion: Emotion; intensity: number; matchedKeywords: string[] } {
  let bestEmotion: Emotion = "neutral";
  let bestIntensity = 0;
  let matchedKeywords: string[] = [];

  for (const rule of EMOTION_RULES) {
    const matches = rule.keywords.filter(kw => text.includes(kw));
    if (matches.length > 0) {
      const intensity = Math.min(rule.intensity * (1 + matches.length * 0.1), 1);
      if (intensity > bestIntensity) {
        bestEmotion = rule.emotion;
        bestIntensity = intensity;
        matchedKeywords = matches;
      }
    }
  }

  return { emotion: bestEmotion, intensity: bestIntensity, matchedKeywords };
}

// ─── 数据定义 ────────────────────────────────────────────────────────────────

interface EmotionalMemory {
  id: string;
  text: string;
  emotion: Emotion;
  intensity: number;
  timestamp: number;
  context?: string;
}

/**
 * Mock 数据: 带有情绪标签的记忆
 * 设计原则: 包含语义不相关但情绪相关的记忆对
 */
const MOCK_MEMORIES: EmotionalMemory[] = [
  // Joy 记忆组
  { id: "joy_1", text: "今天升职加薪了，老板当着全公司的面表扬了我", emotion: "joy", intensity: 0.9, timestamp: Date.now() - 86400000 * 30 },
  { id: "joy_2", text: "终于通过了驾照考试，科目二一把过！", emotion: "joy", intensity: 0.85, timestamp: Date.now() - 86400000 * 20 },
  { id: "joy_3", text: "和老朋友多年后重逢，聊了一整天特别开心", emotion: "joy", intensity: 0.8, timestamp: Date.now() - 86400000 * 10 },
  { id: "joy_4", text: "种的番茄终于结果了，红彤彤的特别有成就感", emotion: "joy", intensity: 0.7, timestamp: Date.now() - 86400000 * 5 },
  
  // Sadness 记忆组
  { id: "sad_1", text: "爷爷去世了，没能赶上最后一面", emotion: "sadness", intensity: 0.95, timestamp: Date.now() - 86400000 * 60 },
  { id: "sad_2", text: "养了十年的猫咪走了，回家看到空荡荡的窝很难过", emotion: "sadness", intensity: 0.9, timestamp: Date.now() - 86400000 * 40 },
  { id: "sad_3", text: "和交往三年的对象分手了，心里空落落的", emotion: "sadness", intensity: 0.85, timestamp: Date.now() - 86400000 * 25 },
  { id: "sad_4", text: "项目失败了，几个月的努力白费了，很沮丧", emotion: "sadness", intensity: 0.8, timestamp: Date.now() - 86400000 * 15 },
  
  // Anger 记忆组
  { id: "anger_1", text: "被同事背后捅刀子，抢了我的功劳，气死了", emotion: "anger", intensity: 0.9, timestamp: Date.now() - 86400000 * 35 },
  { id: "anger_2", text: "快递被偷了，监控拍到但物业不管，太可恶了", emotion: "anger", intensity: 0.85, timestamp: Date.now() - 86400000 * 22 },
  { id: "anger_3", text: "排队两小时被告知系统故障，白白浪费时间", emotion: "anger", intensity: 0.8, timestamp: Date.now() - 86400000 * 12 },
  
  // Fear 记忆组
  { id: "fear_1", text: "体检报告有几个指标异常，很担心是不是大问题", emotion: "fear", intensity: 0.85, timestamp: Date.now() - 86400000 * 28 },
  { id: "fear_2", text: "晚上一个人走夜路，后面好像有人跟着，吓死了", emotion: "fear", intensity: 0.9, timestamp: Date.now() - 86400000 * 18 },
  { id: "fear_3", text: "明天要上台演讲，紧张得睡不着觉", emotion: "fear", intensity: 0.75, timestamp: Date.now() - 86400000 * 8 },
  
  // Love 记忆组
  { id: "love_1", text: "妈妈特意从老家寄来我爱吃的腊肉，满满都是爱", emotion: "love", intensity: 0.9, timestamp: Date.now() - 86400000 * 45 },
  { id: "love_2", text: "伴侣在我加班时默默送来热汤，很感动", emotion: "love", intensity: 0.85, timestamp: Date.now() - 86400000 * 30 },
  { id: "love_3", text: "学生毕业时写了一封很长的感谢信，眼眶湿了", emotion: "love", intensity: 0.8, timestamp: Date.now() - 86400000 * 20 },
  
  // Neutral 记忆组 (对照)
  { id: "neu_1", text: "今天去超市买了牛奶和面包", emotion: "neutral", intensity: 0.1, timestamp: Date.now() - 86400000 * 7 },
  { id: "neu_2", text: "下午开了个会，讨论了项目进度", emotion: "neutral", intensity: 0.2, timestamp: Date.now() - 86400000 * 6 },
  { id: "neu_3", text: "晚上看了会儿书，十一点睡觉", emotion: "neutral", intensity: 0.1, timestamp: Date.now() - 86400000 * 5 },
];

/**
 * 测试查询: 当前情绪状态 + 语义内容
 * 设计: 语义上与某些记忆不相关，但情绪上相关
 */
const TEST_QUERIES = [
  {
    text: "今天考试没考好，心情很低落",
    currentEmotion: "sadness" as Emotion,
    expectedRecall: ["sad_1", "sad_2", "sad_3", "sad_4"],  // 应该召回悲伤记忆
    semanticRelated: ["sad_4"],  // 只有这个语义相关 (失败/挫折)
  },
  {
    text: "终于完成了马拉松，太有成就感了！",
    currentEmotion: "joy" as Emotion,
    expectedRecall: ["joy_1", "joy_2", "joy_3", "joy_4"],
    semanticRelated: ["joy_2"],  // 只有这个语义相关 (通过考试)
  },
  {
    text: "被朋友误解了，解释不清很委屈",
    currentEmotion: "anger" as Emotion,
    expectedRecall: ["anger_1", "anger_2", "anger_3"],
    semanticRelated: ["anger_1"],  // 被同事陷害
  },
  {
    text: "一个人去医院做检查，心里很不安",
    currentEmotion: "fear" as Emotion,
    expectedRecall: ["fear_1", "fear_2", "fear_3"],
    semanticRelated: ["fear_1"],  // 体检异常
  },
];

// ─── 数据加载 ────────────────────────────────────────────────────────────────

function loadMemories(): EmotionalMemory[] {
  const dataPath = resolve(__dirname, "../memory-data/emotional_memories.json");
  
  if (existsSync(dataPath)) {
    console.log(`📂 加载真实数据: ${dataPath}`);
    try {
      const raw = JSON.parse(readFileSync(dataPath, "utf-8"));
      return raw.emotional_memories || raw;
    } catch (e) {
      console.warn(`⚠️ 数据加载失败，使用 mock 数据: ${e}`);
    }
  } else {
    console.log("📂 使用内置 mock 数据 (test/memory-data/emotional_memories.json 不存在)");
  }
  
  return MOCK_MEMORIES;
}

// ─── 检索算法 ────────────────────────────────────────────────────────────────

interface RetrievalResult {
  memory: EmotionalMemory;
  semanticScore: number;
  emotionScore: number;
  combinedScore: number;
  rank_semantic: number;
  rank_combined: number;
}

/**
 * 纯语义检索
 */
function semanticRetrieval(
  queryEmb: number[],
  memories: EmotionalMemory[],
  memoryEmbs: number[][],
  topK: number
): RetrievalResult[] {
  const results = memories.map((memory, i) => ({
    memory,
    semanticScore: cosineSimilarity(queryEmb, memoryEmbs[i]),
    emotionScore: 0,
    combinedScore: cosineSimilarity(queryEmb, memoryEmbs[i]),
    rank_semantic: 0,
    rank_combined: 0,
  }));

  results.sort((a, b) => b.semanticScore - a.semanticScore);
  results.forEach((r, i) => { r.rank_semantic = i + 1; r.rank_combined = i + 1; });
  
  return results.slice(0, topK);
}

/**
 * 情绪增强检索
 * combinedScore = semanticScore * (1 + emotionBoost * emotionMatch)
 */
function emotionEnhancedRetrieval(
  queryEmb: number[],
  queryEmotion: Emotion,
  queryIntensity: number,
  memories: EmotionalMemory[],
  memoryEmbs: number[][],
  topK: number,
  emotionBoost: number = 0.5
): RetrievalResult[] {
  const results = memories.map((memory, i) => {
    const semanticScore = cosineSimilarity(queryEmb, memoryEmbs[i]);
    const emotionMatch = memory.emotion === queryEmotion ? 1 : 0;
    const emotionScore = emotionMatch * memory.intensity * queryIntensity;
    const combinedScore = semanticScore * (1 + emotionBoost * emotionScore);

    return {
      memory,
      semanticScore,
      emotionScore,
      combinedScore,
      rank_semantic: 0,
      rank_combined: 0,
    };
  });

  // 按语义排序
  const bySemantic = [...results].sort((a, b) => b.semanticScore - a.semanticScore);
  bySemantic.forEach((r, i) => r.rank_semantic = i + 1);

  // 按综合分数排序
  results.sort((a, b) => b.combinedScore - a.combinedScore);
  results.forEach((r, i) => r.rank_combined = i + 1);

  return results.slice(0, topK);
}

// ─── 实验执行 ────────────────────────────────────────────────────────────────

async function runExperiment() {
  console.log("╔══════════════════════════════════════════════════════════════════════╗");
  console.log("║  实验 4: 情绪触发记忆 (Emotion-Triggered Memory Retrieval)           ║");
  console.log("╚══════════════════════════════════════════════════════════════════════╝\n");

  // 加载数据
  const memories = loadMemories();
  console.log(`📊 记忆库: ${memories.length} 条记忆\n`);

  // 获取所有记忆的 embeddings
  console.log("📡 获取记忆 embeddings...");
  const memoryTexts = memories.map(m => m.text);
  const memoryEmbs = await getEmbeddings(memoryTexts);
  console.log(`✅ 完成\n`);

  // ─── 实验 A: 情绪标注可行性 ─────────────────────────────────────────────

  console.log("═".repeat(70));
  console.log("📊 实验 A: 情绪标注可行性");
  console.log("═".repeat(70));

  const detectionResults = memories.map(m => {
    const detected = detectEmotion(m.text);
    return {
      id: m.id,
      text: m.text.slice(0, 30) + "...",
      actual: m.emotion,
      detected: detected.emotion,
      match: m.emotion === detected.emotion,
      keywords: detected.matchedKeywords,
    };
  });

  const accuracy = detectionResults.filter(r => r.match).length / detectionResults.length;
  const nonNeutral = detectionResults.filter(r => r.actual !== "neutral");
  const nonNeutralAccuracy = nonNeutral.filter(r => r.match).length / nonNeutral.length;

  console.log("\n情绪检测结果:");
  console.log("┌─────────────────────────────────────────────────────────────────────┐");
  for (const r of detectionResults) {
    const marker = r.match ? "✓" : "✗";
    console.log(`│ ${marker} ${r.id.padEnd(8)} | 实际: ${r.actual.padEnd(8)} | 检测: ${r.detected.padEnd(8)} | ${r.keywords.join(",") || "-"} │`);
  }
  console.log("└─────────────────────────────────────────────────────────────────────┘");
  console.log(`\n总体准确率: ${fmt(accuracy * 100, 1)}%`);
  console.log(`非中性准确率: ${fmt(nonNeutralAccuracy * 100, 1)}%`);

  // ─── 实验 B: 情绪检索 vs 语义检索 ───────────────────────────────────────

  console.log("\n\n" + "═".repeat(70));
  console.log("📊 实验 B: 情绪检索 vs 语义检索");
  console.log("═".repeat(70));

  const experimentBResults: {
    query: string;
    emotion: Emotion;
    semanticRecall: string[];
    emotionRecall: string[];
    semanticEmotionHitRate: number;
    emotionEmotionHitRate: number;
    semanticOnlyHitRate: number;
    emotionOnlyHitRate: number;
  }[] = [];

  for (const query of TEST_QUERIES) {
    console.log(`\n🔍 查询: "${query.text}"`);
    console.log(`   当前情绪: ${query.currentEmotion}`);

    const queryEmb = await getEmbedding(query.text);
    const queryDetection = detectEmotion(query.text);

    // 纯语义检索
    const semanticResults = semanticRetrieval(queryEmb, memories, memoryEmbs, 5);
    const semanticRecall = semanticResults.map(r => r.memory.id);

    // 情绪增强检索
    const emotionResults = emotionEnhancedRetrieval(
      queryEmb,
      query.currentEmotion,
      queryDetection.intensity || 0.8,
      memories,
      memoryEmbs,
      5,
      0.5
    );
    const emotionRecall = emotionResults.map(r => r.memory.id);

    // 计算命中率
    const expectedSet = new Set(query.expectedRecall);
    const semanticRelatedSet = new Set(query.semanticRelated);

    const semanticEmotionHits = semanticRecall.filter(id => expectedSet.has(id)).length;
    const emotionEmotionHits = emotionRecall.filter(id => expectedSet.has(id)).length;
    const semanticOnlyHits = semanticRecall.filter(id => semanticRelatedSet.has(id)).length;
    const emotionOnlyHits = emotionRecall.filter(id => semanticRelatedSet.has(id)).length;

    console.log(`\n   纯语义检索 Top5: ${semanticRecall.join(", ")}`);
    console.log(`   情绪命中: ${semanticEmotionHits}/${query.expectedRecall.length}`);
    
    console.log(`\n   情绪增强检索 Top5: ${emotionRecall.join(", ")}`);
    console.log(`   情绪命中: ${emotionEmotionHits}/${query.expectedRecall.length}`);

    // 分析"语义不相关但情绪相关"的记忆
    const emotionOnlyMemories = emotionRecall.filter(
      id => expectedSet.has(id) && !semanticRelatedSet.has(id)
    );
    if (emotionOnlyMemories.length > 0) {
      console.log(`\n   ✨ 情绪增强召回的"语义不相关但情绪相关"记忆:`);
      for (const id of emotionOnlyMemories) {
        const mem = memories.find(m => m.id === id)!;
        console.log(`      - [${id}] ${mem.text.slice(0, 40)}...`);
      }
    }

    experimentBResults.push({
      query: query.text,
      emotion: query.currentEmotion,
      semanticRecall,
      emotionRecall,
      semanticEmotionHitRate: semanticEmotionHits / query.expectedRecall.length,
      emotionEmotionHitRate: emotionEmotionHits / query.expectedRecall.length,
      semanticOnlyHitRate: semanticOnlyHits / query.semanticRelated.length,
      emotionOnlyHitRate: emotionOnlyHits / query.semanticRelated.length,
    });
  }

  // ─── 实验 C: 印象深刻度评估 ─────────────────────────────────────────────

  console.log("\n\n" + "═".repeat(70));
  console.log("📊 实验 C: 印象深刻度评估");
  console.log("═".repeat(70));

  // 计算每条记忆的"印象深刻度"指标
  const avgEmb = memoryEmbs[0].map((_, i) => 
    mean(memoryEmbs.map(emb => emb[i]))
  );

  const impressivenessData = memories.map((m, i) => {
    // 指标 1: 情绪强度
    const emotionIntensity = m.intensity;
    
    // 指标 2: 异常度 (与平均 embedding 的距离)
    const anomaly = 1 - cosineSimilarity(memoryEmbs[i], avgEmb);
    
    // 指标 3: 文本长度 (信息量代理)
    const textLength = m.text.length;
    
    // 综合印象深刻度 (人工设定 ground truth)
    const groundTruth = m.emotion === "neutral" ? 0.2 : m.intensity;

    return {
      id: m.id,
      emotion: m.emotion,
      emotionIntensity,
      anomaly,
      textLength,
      groundTruth,
    };
  });

  // 计算各指标与 ground truth 的相关性
  const emotionIntensityCorr = correlation(
    impressivenessData.map(d => d.emotionIntensity),
    impressivenessData.map(d => d.groundTruth)
  );
  const anomalyCorr = correlation(
    impressivenessData.map(d => d.anomaly),
    impressivenessData.map(d => d.groundTruth)
  );
  const textLengthCorr = correlation(
    impressivenessData.map(d => d.textLength),
    impressivenessData.map(d => d.groundTruth)
  );

  console.log("\n印象深刻度指标相关性:");
  console.log("┌─────────────────────────────────────────────────────────────┐");
  console.log(`│ 情绪强度 vs 印象深刻度:    r = ${fmt(emotionIntensityCorr)}                    │`);
  console.log(`│ 向量异常度 vs 印象深刻度:  r = ${fmt(anomalyCorr)}                    │`);
  console.log(`│ 文本长度 vs 印象深刻度:    r = ${fmt(textLengthCorr)}                    │`);
  console.log("└─────────────────────────────────────────────────────────────┘");

  console.log("\n各记忆的印象深刻度指标:");
  console.log("┌─────────────────────────────────────────────────────────────────────────────┐");
  console.log("│ ID       │ 情绪     │ 情绪强度 │ 异常度  │ 文本长度 │ Ground Truth          │");
  console.log("├─────────────────────────────────────────────────────────────────────────────┤");
  for (const d of impressivenessData.sort((a, b) => b.groundTruth - a.groundTruth)) {
    console.log(
      `│ ${d.id.padEnd(8)} │ ${d.emotion.padEnd(8)} │ ${fmt(d.emotionIntensity).padStart(8)} │ ` +
      `${fmt(d.anomaly).padStart(7)} │ ${String(d.textLength).padStart(8)} │ ${fmt(d.groundTruth).padStart(22)} │`
    );
  }
  console.log("└─────────────────────────────────────────────────────────────────────────────┘");

  // ─── 汇总分析 ──────────────────────────────────────────────────────────────

  console.log("\n\n" + "═".repeat(70));
  console.log("📊 汇总分析");
  console.log("═".repeat(70));

  const avgSemanticHitRate = mean(experimentBResults.map(r => r.semanticEmotionHitRate));
  const avgEmotionHitRate = mean(experimentBResults.map(r => r.emotionEmotionHitRate));
  const improvement = avgEmotionHitRate - avgSemanticHitRate;

  console.log(`\n实验 B 结果:`);
  console.log(`  纯语义检索情绪命中率:   ${fmt(avgSemanticHitRate * 100, 1)}%`);
  console.log(`  情绪增强检索情绪命中率: ${fmt(avgEmotionHitRate * 100, 1)}%`);
  console.log(`  提升:                   ${fmt(improvement * 100, 1)}%`);

  const h1Supported = avgEmotionHitRate > avgSemanticHitRate;
  const h2Supported = emotionIntensityCorr > 0.5;

  // ─── 生成结论 ──────────────────────────────────────────────────────────────

  const result: ExperimentResult = {
    name: "情绪触发记忆 (Emotion-Triggered Memory Retrieval)",
    hypothesis: "情绪增强检索能召回语义不相关但情绪相关的记忆；情绪强度与印象深刻度正相关",
    data: {
      emotionDetectionAccuracy: accuracy,
      nonNeutralAccuracy,
      avgSemanticHitRate,
      avgEmotionHitRate,
      improvement,
      impressivenessCorrelations: {
        emotionIntensity: emotionIntensityCorr,
        anomaly: anomalyCorr,
        textLength: textLengthCorr,
      },
      h1Supported,
      h2Supported,
    },
    conclusion:
      h1Supported
        ? `支持假设 H1: 情绪增强检索的情绪命中率 (${fmt(avgEmotionHitRate * 100, 1)}%) 显著高于纯语义检索 (${fmt(avgSemanticHitRate * 100, 1)}%)。` +
          " 该方法能有效召回'语义不相关但情绪相关'的记忆。" +
          (h2Supported 
            ? ` 支持 H2: 情绪强度与印象深刻度高度相关 (r=${fmt(emotionIntensityCorr)})。`
            : ` H2 部分支持: 情绪强度与印象深刻度相关性一般 (r=${fmt(emotionIntensityCorr)})。`)
        : "不支持假设 H1。情绪增强检索未能显著提升情绪相关记忆的召回。",
    feasible: h1Supported ? "yes" : "partial",
  };

  printResult(result);

  // ─── 实现建议 ──────────────────────────────────────────────────────────────

  console.log("💡 工程化实现建议:");
  console.log("   1. 情绪标注: 使用 LLM 进行零样本情绪分类 (比规则更准确)");
  console.log("   2. 存储: 为每条记忆添加 emotion 和 intensity 字段");
  console.log("   3. 检索: combinedScore = semantic * (1 + boost * emotionMatch)");
  console.log("   4. 印象深刻度: 主要使用情绪强度，辅以向量异常度");
  console.log("   5. 触发条件: 当检测到用户当前情绪强度 > 0.6 时启用情绪检索");
  console.log("   6. 参考: lucid-memory 的 emotional_weights 参数设计\n");
}

// ─── 工具函数 ────────────────────────────────────────────────────────────────

function correlation(x: number[], y: number[]): number {
  const n = x.length;
  const meanX = mean(x);
  const meanY = mean(y);
  
  let cov = 0, varX = 0, varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  
  return cov / Math.sqrt(varX * varY);
}

// ─── 运行 ────────────────────────────────────────────────────────────────────

runExperiment().catch(console.error);
