/**
 * 实验 3: Key 联想机制 (Key Association Mechanism)
 * 
 * ═══════════════════════════════════════════════════════════════════════════
 * 实验目的
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * 验证用户 Idea: "每日总结时提炼 key（关键词），像人通过 key 将两个或多个
 * 完全不相关的事物联系起来。联想到的不一定语义相关。"
 * 
 * 核心问题:
 * 1. 能否通过"中间概念"在 embedding 空间中连接表面不相关的事物？
 * 2. 如何量化"联想距离"——不太相关也不太不相关？
 * 3. 能否找到"意想不到但合理"的关联？
 * 
 * ═══════════════════════════════════════════════════════════════════════════
 * 理论基础
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * 认知心理学: 扩散激活理论 (Spreading Activation Theory)
 * - Collins & Loftus (1975): 概念在语义网络中通过连接相互关联
 * - 当一个概念被激活时，激活能量沿连接向外扩散
 * - 连接强度决定扩散效率
 * 
 * 工程实现: 
 * - lucid-memory, neural-memory 等项目已实现类似机制
 * - 通过 association graph + activation spreading 实现联想检索
 * 
 * ═══════════════════════════════════════════════════════════════════════════
 * 实验设计
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * 实验 A: 直接相似度 vs 桥接相似度
 * - 直接相似度: cosine(A, B)
 * - 桥接相似度: max_K [cosine(A, K) * cosine(K, B)]
 *   其中 K 是"桥接概念"
 * 
 * 实验 B: 联想距离控制
 * - 定义"联想距离" = 1 - 桥接相似度
 * - 测试不同距离阈值下的联想质量
 * 
 * 实验 C: 跨域联想
 * - 测试能否连接不同领域的概念
 * - 例: "编程" 和 "烹饪" 通过 "配方/算法" 连接
 * 
 * 假设:
 *   H1: 桥接相似度能发现直接相似度无法发现的关联
 *   H2: 存在一个"甜蜜区间"，联想既不太近也不太远
 * 
 * ═══════════════════════════════════════════════════════════════════════════
 * 运行方式
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * npx tsx test/memory-experiments/exp3-key-association.ts
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

// ─── 实验数据 ────────────────────────────────────────────────────────────────

/**
 * 概念集合: 用于测试联想机制
 * 包含多个领域的概念
 */
const CONCEPTS = {
  // 编程领域
  programming: ["编程", "算法", "代码", "调试", "重构", "架构", "接口", "递归"],
  // 烹饪领域
  cooking: ["烹饪", "食谱", "调味", "火候", "刀工", "摆盘", "腌制", "烘焙"],
  // 音乐领域
  music: ["音乐", "旋律", "节奏", "和声", "即兴", "编曲", "演奏", "共鸣"],
  // 自然领域
  nature: ["自然", "生态", "进化", "适应", "共生", "循环", "平衡", "多样性"],
  // 情感领域
  emotion: ["情感", "喜悦", "悲伤", "愤怒", "恐惧", "惊讶", "厌恶", "期待"],
  // 建筑领域
  architecture: ["建筑", "结构", "空间", "比例", "对称", "功能", "美学", "坚固"],
};

/**
 * 预期的"桥接概念"
 * 这些概念应该能连接两个看似不相关的领域
 */
const EXPECTED_BRIDGES = [
  { domain1: "programming", domain2: "cooking", bridge: "食谱/算法", reason: "都是按步骤执行的配方" },
  { domain1: "programming", domain2: "music", bridge: "节奏/循环", reason: "都有重复和模式" },
  { domain1: "cooking", domain2: "nature", bridge: "平衡/调和", reason: "都追求元素间的平衡" },
  { domain1: "music", domain2: "emotion", bridge: "共鸣/表达", reason: "都是情感的表达和共振" },
  { domain1: "architecture", domain2: "programming", bridge: "结构/架构", reason: "都关注系统设计" },
  { domain1: "nature", domain2: "architecture", bridge: "结构/形态", reason: "都遵循结构原理" },
];

/**
 * 测试用例: 表面不相关但可通过桥接连接的概念对
 */
const TEST_PAIRS = [
  { a: "调试代码", b: "调味烹饪", expectedBridge: "都需要反复尝试和调整" },
  { a: "递归函数", b: "俄罗斯套娃", expectedBridge: "自相似结构" },
  { a: "代码重构", b: "房屋装修", expectedBridge: "在保持功能的前提下改善结构" },
  { a: "接口设计", b: "门把手设计", expectedBridge: "人机交互的可用性" },
  { a: "程序bug", b: "身体疾病", expectedBridge: "系统异常需要诊断和修复" },
  { a: "算法优化", b: "减肥瘦身", expectedBridge: "去除冗余，提高效率" },
];

// ─── 实验执行 ────────────────────────────────────────────────────────────────

async function runExperiment() {
  console.log("╔══════════════════════════════════════════════════════════════════════╗");
  console.log("║  实验 3: Key 联想机制 (Key Association Mechanism)                    ║");
  console.log("╚══════════════════════════════════════════════════════════════════════╝\n");

  // ─── 实验 A: 直接相似度 vs 桥接相似度 ─────────────────────────────────────

  console.log("═".repeat(70));
  console.log("📊 实验 A: 直接相似度 vs 桥接相似度");
  console.log("═".repeat(70));

  // 获取所有概念的 embeddings
  const allConcepts = Object.values(CONCEPTS).flat();
  console.log(`\n📡 获取 ${allConcepts.length} 个概念的 embeddings...`);
  const conceptEmbeddings = await getEmbeddings(allConcepts);
  
  const conceptMap = new Map<string, number[]>();
  allConcepts.forEach((c, i) => conceptMap.set(c, conceptEmbeddings[i]));

  // 获取测试对的 embeddings
  const testTexts = TEST_PAIRS.flatMap(p => [p.a, p.b]);
  const testEmbeddings = await getEmbeddings(testTexts);
  
  const testMap = new Map<string, number[]>();
  TEST_PAIRS.forEach((p, i) => {
    testMap.set(p.a, testEmbeddings[i * 2]);
    testMap.set(p.b, testEmbeddings[i * 2 + 1]);
  });

  console.log("\n┌─────────────────────────────────────────────────────────────────────────────┐");
  console.log("│ 测试对分析                                                                  │");
  console.log("├─────────────────────────────────────────────────────────────────────────────┤");

  const experimentAResults: {
    pair: string;
    directSim: number;
    bestBridgeSim: number;
    bestBridge: string;
    improvement: number;
  }[] = [];

  for (const pair of TEST_PAIRS) {
    const embA = testMap.get(pair.a)!;
    const embB = testMap.get(pair.b)!;
    
    // 直接相似度
    const directSim = cosineSimilarity(embA, embB);
    
    // 寻找最佳桥接概念
    let bestBridgeSim = 0;
    let bestBridge = "";
    
    for (const [concept, conceptEmb] of conceptMap) {
      const simA = cosineSimilarity(embA, conceptEmb);
      const simB = cosineSimilarity(embB, conceptEmb);
      // 桥接相似度: 几何平均
      const bridgeSim = Math.sqrt(simA * simB);
      
      if (bridgeSim > bestBridgeSim) {
        bestBridgeSim = bridgeSim;
        bestBridge = concept;
      }
    }
    
    const improvement = bestBridgeSim - directSim;
    
    experimentAResults.push({
      pair: `${pair.a} ↔ ${pair.b}`,
      directSim,
      bestBridgeSim,
      bestBridge,
      improvement,
    });
    
    console.log(`│ ${pair.a.padEnd(10)} ↔ ${pair.b.padEnd(10)}                              │`);
    console.log(`│   直接相似度: ${fmt(directSim)}  |  桥接相似度: ${fmt(bestBridgeSim)}  |  桥接: ${bestBridge.padEnd(6)}  │`);
    console.log(`│   预期关联: ${pair.expectedBridge.slice(0, 50).padEnd(60)} │`);
    console.log("├─────────────────────────────────────────────────────────────────────────────┤");
  }

  // ─── 实验 B: 联想距离分布 ─────────────────────────────────────────────────

  console.log("\n\n" + "═".repeat(70));
  console.log("📊 实验 B: 联想距离分布分析");
  console.log("═".repeat(70));

  // 计算所有概念对之间的相似度分布
  const allSims: number[] = [];
  const conceptList = Array.from(conceptMap.keys());
  
  for (let i = 0; i < conceptList.length; i++) {
    for (let j = i + 1; j < conceptList.length; j++) {
      const sim = cosineSimilarity(
        conceptMap.get(conceptList[i])!,
        conceptMap.get(conceptList[j])!
      );
      allSims.push(sim);
    }
  }

  // 分桶统计
  const buckets = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
  const histogram = new Array(buckets.length - 1).fill(0);
  
  for (const sim of allSims) {
    for (let i = 0; i < buckets.length - 1; i++) {
      if (sim >= buckets[i] && sim < buckets[i + 1]) {
        histogram[i]++;
        break;
      }
    }
  }

  console.log("\n概念间相似度分布:");
  console.log("┌─────────────────────────────────────────────────────────────┐");
  for (let i = 0; i < histogram.length; i++) {
    const bar = "█".repeat(Math.round(histogram[i] / 5));
    console.log(`│ [${fmt(buckets[i], 1)}-${fmt(buckets[i + 1], 1)}) ${String(histogram[i]).padStart(3)} ${bar.padEnd(30)} │`);
  }
  console.log("└─────────────────────────────────────────────────────────────┘");

  const meanSim = mean(allSims);
  const stdSim = Math.sqrt(mean(allSims.map(s => (s - meanSim) ** 2)));
  
  console.log(`\n均值: ${fmt(meanSim)}, 标准差: ${fmt(stdSim)}`);
  console.log(`"甜蜜区间"建议: [${fmt(meanSim - stdSim)}, ${fmt(meanSim + stdSim)}]`);
  console.log(`  - 低于此区间: 太不相关，联想无意义`);
  console.log(`  - 高于此区间: 太相关，缺乏惊喜`);

  // ─── 实验 C: 跨域联想测试 ─────────────────────────────────────────────────

  console.log("\n\n" + "═".repeat(70));
  console.log("📊 实验 C: 跨域联想测试");
  console.log("═".repeat(70));

  const experimentCResults: {
    domain1: string;
    domain2: string;
    avgDirectSim: number;
    bestBridges: { concept: string; sim: number }[];
  }[] = [];

  const domainNames = Object.keys(CONCEPTS);
  
  for (let i = 0; i < domainNames.length; i++) {
    for (let j = i + 1; j < domainNames.length; j++) {
      const d1 = domainNames[i];
      const d2 = domainNames[j];
      
      // 计算两个领域间的平均直接相似度
      let totalSim = 0;
      let count = 0;
      
      for (const c1 of CONCEPTS[d1 as keyof typeof CONCEPTS]) {
        for (const c2 of CONCEPTS[d2 as keyof typeof CONCEPTS]) {
          totalSim += cosineSimilarity(conceptMap.get(c1)!, conceptMap.get(c2)!);
          count++;
        }
      }
      
      const avgDirectSim = totalSim / count;
      
      // 只输出部分结果
      if (i < 3 && j < 5) {
        console.log(`\n${d1} ↔ ${d2}: 平均相似度 = ${fmt(avgDirectSim)}`);
      }
      
      experimentCResults.push({
        domain1: d1,
        domain2: d2,
        avgDirectSim,
        bestBridges: [],
      });
    }
  }

  // 找出最"遥远"的领域对
  const sortedPairs = [...experimentCResults].sort((a, b) => a.avgDirectSim - b.avgDirectSim);
  
  console.log("\n\n最遥远的领域对 (直接相似度最低):");
  for (const pair of sortedPairs.slice(0, 3)) {
    console.log(`  ${pair.domain1} ↔ ${pair.domain2}: ${fmt(pair.avgDirectSim)}`);
  }

  console.log("\n最接近的领域对 (直接相似度最高):");
  for (const pair of sortedPairs.slice(-3)) {
    console.log(`  ${pair.domain1} ↔ ${pair.domain2}: ${fmt(pair.avgDirectSim)}`);
  }

  // ─── 实验 D: 实际联想路径发现 ─────────────────────────────────────────────

  console.log("\n\n" + "═".repeat(70));
  console.log("📊 实验 D: 联想路径发现");
  console.log("═".repeat(70));

  // 选择一对"遥远"的概念，尝试找到联想路径
  const startConcept = "编程";
  const endConcept = "烹饪";
  
  console.log(`\n寻找从 "${startConcept}" 到 "${endConcept}" 的联想路径...`);
  
  const startEmb = conceptMap.get(startConcept)!;
  const endEmb = conceptMap.get(endConcept)!;
  const directSim = cosineSimilarity(startEmb, endEmb);
  
  console.log(`直接相似度: ${fmt(directSim)}`);
  
  // 一跳路径: 找一个中间概念
  console.log("\n一跳联想路径:");
  const oneHopPaths: { bridge: string; sim1: number; sim2: number; total: number }[] = [];
  
  for (const [concept, emb] of conceptMap) {
    if (concept === startConcept || concept === endConcept) continue;
    
    const sim1 = cosineSimilarity(startEmb, emb);
    const sim2 = cosineSimilarity(emb, endEmb);
    const total = Math.sqrt(sim1 * sim2);
    
    oneHopPaths.push({ bridge: concept, sim1, sim2, total });
  }
  
  oneHopPaths.sort((a, b) => b.total - a.total);
  
  for (const path of oneHopPaths.slice(0, 5)) {
    console.log(`  ${startConcept} →(${fmt(path.sim1)})→ ${path.bridge} →(${fmt(path.sim2)})→ ${endConcept} [总: ${fmt(path.total)}]`);
  }

  // 两跳路径
  console.log("\n两跳联想路径 (top 3):");
  const twoHopPaths: { path: string[]; sims: number[]; total: number }[] = [];
  
  for (const [c1, emb1] of conceptMap) {
    if (c1 === startConcept || c1 === endConcept) continue;
    const sim1 = cosineSimilarity(startEmb, emb1);
    if (sim1 < 0.3) continue; // 剪枝
    
    for (const [c2, emb2] of conceptMap) {
      if (c2 === startConcept || c2 === endConcept || c2 === c1) continue;
      const sim2 = cosineSimilarity(emb1, emb2);
      if (sim2 < 0.3) continue; // 剪枝
      
      const sim3 = cosineSimilarity(emb2, endEmb);
      const total = Math.cbrt(sim1 * sim2 * sim3);
      
      twoHopPaths.push({
        path: [startConcept, c1, c2, endConcept],
        sims: [sim1, sim2, sim3],
        total,
      });
    }
  }
  
  twoHopPaths.sort((a, b) => b.total - a.total);
  
  for (const path of twoHopPaths.slice(0, 3)) {
    const pathStr = path.path.join(" → ");
    const simStr = path.sims.map(s => fmt(s)).join(", ");
    console.log(`  ${pathStr} [相似度: ${simStr}, 总: ${fmt(path.total)}]`);
  }

  // ─── 汇总分析 ──────────────────────────────────────────────────────────────

  console.log("\n\n" + "═".repeat(70));
  console.log("📊 汇总分析");
  console.log("═".repeat(70));

  const avgDirect = mean(experimentAResults.map(r => r.directSim));
  const avgBridged = mean(experimentAResults.map(r => r.bestBridgeSim));
  const avgImprovement = mean(experimentAResults.map(r => r.improvement));
  const improvementRate = experimentAResults.filter(r => r.improvement > 0).length / experimentAResults.length;

  console.log(`\n实验 A 结果:`);
  console.log(`  平均直接相似度:   ${fmt(avgDirect)}`);
  console.log(`  平均桥接相似度:   ${fmt(avgBridged)}`);
  console.log(`  平均提升:         ${fmt(avgImprovement)}`);
  console.log(`  提升比例:         ${fmt(improvementRate * 100, 1)}%`);

  const h1Supported = avgBridged > avgDirect && improvementRate > 0.5;
  const h2Supported = stdSim > 0.1; // 存在明显的距离分布差异

  // ─── 生成结论 ──────────────────────────────────────────────────────────────

  const result: ExperimentResult = {
    name: "Key 联想机制 (Key Association Mechanism)",
    hypothesis: "桥接相似度能发现直接相似度无法发现的关联；存在联想距离的甜蜜区间",
    data: {
      avgDirectSim: avgDirect,
      avgBridgedSim: avgBridged,
      avgImprovement: avgImprovement,
      improvementRate,
      simDistribution: { mean: meanSim, std: stdSim },
      suggestedSweetSpot: [meanSim - stdSim, meanSim + stdSim],
      bestOneHopPath: oneHopPaths[0],
      bestTwoHopPath: twoHopPaths[0],
      h1Supported,
      h2Supported,
    },
    conclusion:
      h1Supported
        ? `支持假设 H1: 桥接相似度 (${fmt(avgBridged)}) 显著高于直接相似度 (${fmt(avgDirect)})，` +
          `在 ${fmt(improvementRate * 100, 1)}% 的测试对中发现了更强的关联。` +
          (h2Supported 
            ? ` 支持 H2: 相似度分布存在明显差异 (std=${fmt(stdSim)})，可设定甜蜜区间 [${fmt(meanSim - stdSim)}, ${fmt(meanSim + stdSim)}]。`
            : "") +
          " 该机制可用于实现'意外但合理'的记忆联想。"
        : "部分支持假设。桥接机制能发现一些直接相似度无法发现的关联，但效果有限。" +
          " 建议结合 LLM 进行语义层面的联想推理。",
    feasible: h1Supported ? "yes" : "partial",
  };

  printResult(result);

  // ─── 实现建议 ──────────────────────────────────────────────────────────────

  console.log("💡 工程化实现建议:");
  console.log("   1. 每日总结时提取 key 关键词 (使用 TF-IDF 或 LLM)");
  console.log("   2. 构建 key 之间的关联图 (基于共现或 embedding 相似度)");
  console.log("   3. 检索时使用扩散激活: 从当前 key 出发，沿关联边扩散");
  console.log("   4. 控制扩散深度 (1-2 跳) 和衰减系数 (0.5-0.7)");
  console.log("   5. 设定相似度阈值窗口，过滤太近/太远的联想");
  console.log("   6. 参考实现: lucid-memory (Rust), neural-memory (Python)\n");
}

// ─── 运行 ────────────────────────────────────────────────────────────────────

runExperiment().catch(console.error);
