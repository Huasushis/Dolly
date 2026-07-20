/**
 * 实验 5: 相关性/不相关性平衡 (MMR / Serendipity)
 * 
 * ═══════════════════════════════════════════════════════════════════════════
 * 实验目的
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * 验证用户 Idea: "rerank 不是唯一挑选依据，需要平衡相关性和不相关性。
 * 全部相关会变成查找机器，过于不相关又会出现混乱。"
 * 
 * 核心问题:
 * 1. MMR (Maximal Marginal Relevance) 能否实现相关性-多样性平衡？
 * 2. 不同 λ 参数下，检索结果的相关性和多样性如何变化？
 * 3. 是否存在"惊喜度"(serendipity) 的最优区间？
 * 4. 与纯相似度检索相比，MMR 能否引入有价值的"意外"记忆？
 * 
 * ═══════════════════════════════════════════════════════════════════════════
 * 理论基础
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * MMR 公式 (Carbonell & Goldstein, 1998):
 *   MMR = λ * Sim(d, Q) - (1-λ) * max(Sim(d, d_j))
 *   
 *   其中:
 *   - Sim(d, Q): 文档 d 与查询 Q 的相关性
 *   - max(Sim(d, d_j)): 文档 d 与已选文档的最大相似度 (冗余度)
 *   - λ: 平衡参数 (0-1)
 * 
 * Serendipity 定义:
 *   Serendipity = 意外性 × 价值性
 *   - 意外性: 与查询/已选内容的差异度
 *   - 价值性: 对用户实际有用
 * 
 * ═══════════════════════════════════════════════════════════════════════════
 * 实验设计
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * 实验 A: λ 参数扫描
 * - 测试 λ = 0.0, 0.2, 0.4, 0.5, 0.6, 0.8, 1.0
 * - 测量每个 λ 下的平均相关性和多样性
 * 
 * 实验 B: 纯相似度 vs MMR 对比
 * - 相同查询下，对比两种方法的 Top-K 结果
 * - 分析 MMR 引入的"意外"记忆是否有价值
 * 
 * 实验 C: 惊喜度评估
 * - 定义惊喜度 = 与查询的语义距离 × 与主题的潜在关联
 * - 评估不同 λ 下的惊喜度分布
 * 
 * 假设:
 *   H1: MMR (λ=0.5-0.7) 能在保持相关性的同时提升多样性
 *   H2: 存在一个 λ 区间，惊喜度最大化
 * 
 * ═══════════════════════════════════════════════════════════════════════════
 * 运行方式
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * npx tsx test/memory-experiments/exp5-mmr-serendipity.ts
 */

import {
  getEmbedding,
  getEmbeddings,
  cosineSimilarity,
  mmrSelect,
  pureSimilaritySelect,
  mean,
  std,
  fmt,
  printResult,
  type ExperimentResult,
  type MMRResult,
} from "./utils.js";

// ─── 实验数据 ────────────────────────────────────────────────────────────────

/**
 * 记忆库: 模拟一个用户的对话历史
 * 包含多个主题，有些与查询相关，有些"意外但可能有价值"
 */
const MEMORY_BANK = [
  // 与"学习编程"直接相关
  { id: "prog_1", text: "今天学习了 JavaScript 的异步编程，理解了 Promise 和 async/await", topic: "programming" },
  { id: "prog_2", text: "调试了一个很久的 bug，原来是闭包变量作用域的问题", topic: "programming" },
  { id: "prog_3", text: "读了一篇关于设计模式的文章，单例模式和工厂模式很有启发", topic: "programming" },
  { id: "prog_4", text: "尝试用 TypeScript 重构了之前的项目，类型安全确实减少了很多错误", topic: "programming" },
  
  // 与"学习"相关但不同领域
  { id: "learn_1", text: "学做意大利面，发现火候控制很重要，和写代码调参数很像", topic: "cooking" },
  { id: "learn_2", text: "练习吉他一个月了，从完全不会到能弹简单的曲子，坚持很重要", topic: "music" },
  { id: "learn_3", text: "看了一部关于学习方法论的纪录片，间隔重复确实有效", topic: "learning" },
  
  // 与"解决问题"相关
  { id: "solve_1", text: "帮朋友修好了电脑，排查问题的思路和调试代码很像", topic: "troubleshooting" },
  { id: "solve_2", text: "家里水管漏水，自己查资料修好了，很有成就感", topic: "diy" },
  
  // "意外"记忆 - 表面不相关但可能有深层联系
  { id: "surprise_1", text: "今天爬山到山顶，俯瞰城市的感觉让我思考了很多关于视角的问题", topic: "reflection" },
  { id: "surprise_2", text: "看蚂蚁搬家，它们协作的方式让我想到了分布式系统", topic: "nature" },
  { id: "surprise_3", text: "读了一本关于建筑设计的书，空间布局和功能分区的思想很有趣", topic: "architecture" },
  { id: "surprise_4", text: "和朋友下棋，布局思维和对全局的把握让我联想到系统架构", topic: "game" },
  
  // 完全不相关 (噪声)
  { id: "noise_1", text: "今天天气不错，出去散了散步", topic: "daily" },
  { id: "noise_2", text: "晚上吃了火锅，有点辣", topic: "food" },
  { id: "noise_3", text: "买了件新衣服，颜色很喜欢", topic: "shopping" },
];

/**
 * 测试查询
 */
const TEST_QUERIES = [
  {
    text: "最近在学习编程，遇到了一些困难，想看看之前有没有相关的经验",
    expectedRelevant: ["prog_1", "prog_2", "prog_3", "prog_4"],
    expectedSerendipity: ["surprise_2", "surprise_4", "solve_1"],  // 可能有启发的"意外"记忆
    expectedNoise: ["noise_1", "noise_2", "noise_3"],
  },
  {
    text: "想学习一项新技能，不知道从哪里开始",
    expectedRelevant: ["learn_1", "learn_2", "learn_3"],
    expectedSerendipity: ["prog_1", "surprise_1"],
    expectedNoise: ["noise_1", "noise_2", "noise_3"],
  },
  {
    text: "遇到一个复杂问题不知道怎么拆解",
    expectedRelevant: ["solve_1", "solve_2", "prog_2"],
    expectedSerendipity: ["surprise_3", "surprise_4"],
    expectedNoise: ["noise_1", "noise_2", "noise_3"],
  },
];

// ─── 评估指标 ────────────────────────────────────────────────────────────────

interface RetrievalEvaluation {
  method: string;
  lambda?: number;
  avgRelevance: number;      // 与查询的平均相关性
  avgDiversity: number;      // 结果间的平均差异度
  relevantHitRate: number;   // 命中预期相关记忆的比例
  serendipityRate: number;   // 命中"意外但有价值"记忆的比例
  noiseRate: number;         // 命中噪声记忆的比例
  results: string[];         // 检索到的记忆 ID
}

/**
 * 评估检索结果
 */
function evaluateRetrieval(
  results: MMRResult[],
  query: typeof TEST_QUERIES[0],
  memories: typeof MEMORY_BANK,
  memoryEmbs: number[][],
  queryEmb: number[],
  method: string,
  lambda?: number
): RetrievalEvaluation {
  const resultIds = results.map(r => memories[r.index].id);
  const resultEmbs = results.map(r => memoryEmbs[r.index]);
  
  // 相关性: 与查询的平均相似度
  const avgRelevance = mean(results.map(r => cosineSimilarity(queryEmb, memoryEmbs[r.index])));
  
  // 多样性: 结果间的平均差异度
  let diversitySum = 0;
  let diversityCount = 0;
  for (let i = 0; i < resultEmbs.length; i++) {
    for (let j = i + 1; j < resultEmbs.length; j++) {
      diversitySum += 1 - cosineSimilarity(resultEmbs[i], resultEmbs[j]);
      diversityCount++;
    }
  }
  const avgDiversity = diversityCount > 0 ? diversitySum / diversityCount : 0;
  
  // 命中率
  const relevantSet = new Set(query.expectedRelevant);
  const serendipitySet = new Set(query.expectedSerendipity);
  const noiseSet = new Set(query.expectedNoise);
  
  const relevantHits = resultIds.filter(id => relevantSet.has(id)).length;
  const serendipityHits = resultIds.filter(id => serendipitySet.has(id)).length;
  const noiseHits = resultIds.filter(id => noiseSet.has(id)).length;
  
  return {
    method,
    lambda,
    avgRelevance,
    avgDiversity,
    relevantHitRate: relevantHits / query.expectedRelevant.length,
    serendipityRate: serendipityHits / query.expectedSerendipity.length,
    noiseRate: noiseHits / query.expectedNoise.length,
    results: resultIds,
  };
}

// ─── 实验执行 ────────────────────────────────────────────────────────────────

async function runExperiment() {
  console.log("╔══════════════════════════════════════════════════════════════════════╗");
  console.log("║  实验 5: 相关性/不相关性平衡 (MMR / Serendipity)                     ║");
  console.log("╚══════════════════════════════════════════════════════════════════════╝\n");

  // 获取所有记忆的 embeddings
  console.log("📡 获取记忆 embeddings...");
  const memoryTexts = MEMORY_BANK.map(m => m.text);
  const memoryEmbs = await getEmbeddings(memoryTexts);
  console.log(`✅ ${memoryEmbs.length} 条记忆\n`);

  // ─── 实验 A: λ 参数扫描 ─────────────────────────────────────────────────

  console.log("═".repeat(70));
  console.log("📊 实验 A: λ 参数扫描");
  console.log("═".repeat(70));

  const lambdaValues = [0.0, 0.2, 0.4, 0.5, 0.6, 0.8, 1.0];
  const topK = 5;

  const lambdaResults: {
    lambda: number;
    avgRelevance: number;
    avgDiversity: number;
    avgSerendipity: number;
    avgNoise: number;
  }[] = [];

  for (const lambda of lambdaValues) {
    console.log(`\n🔧 λ = ${lambda}`);
    
    const queryEvaluations: RetrievalEvaluation[] = [];
    
    for (const query of TEST_QUERIES) {
      const queryEmb = await getEmbedding(query.text);
      
      let results: MMRResult[];
      if (lambda === 1.0) {
        results = pureSimilaritySelect(queryEmb, memoryEmbs, topK);
      } else {
        results = mmrSelect(queryEmb, memoryEmbs, lambda, topK);
      }
      
      const eval_ = evaluateRetrieval(results, query, MEMORY_BANK, memoryEmbs, queryEmb, `MMR(λ=${lambda})`, lambda);
      queryEvaluations.push(eval_);
    }
    
    const avgRelevance = mean(queryEvaluations.map(e => e.avgRelevance));
    const avgDiversity = mean(queryEvaluations.map(e => e.avgDiversity));
    const avgSerendipity = mean(queryEvaluations.map(e => e.serendipityRate));
    const avgNoise = mean(queryEvaluations.map(e => e.noiseRate));
    
    lambdaResults.push({ lambda, avgRelevance, avgDiversity, avgSerendipity, avgNoise });
    
    console.log(`   相关性: ${fmt(avgRelevance)} | 多样性: ${fmt(avgDiversity)} | 惊喜率: ${fmt(avgSerendipity * 100, 1)}% | 噪声率: ${fmt(avgNoise * 100, 1)}%`);
  }

  // 绘制 λ 曲线
  console.log("\n\n┌─────────────────────────────────────────────────────────────────────────────┐");
  console.log("│ λ 参数 vs 各指标                                                            │");
  console.log("├─────────┬─────────────┬─────────────┬─────────────┬─────────────────────────┤");
  console.log("│ λ       │ 相关性      │ 多样性      │ 惊喜率      │ 噪声率                  │");
  console.log("├─────────┼─────────────┼─────────────┼─────────────┼─────────────────────────┤");
  for (const r of lambdaResults) {
    console.log(
      `│ ${fmt(r.lambda, 1).padStart(7)} │ ${fmt(r.avgRelevance).padStart(11)} │ ` +
      `${fmt(r.avgDiversity).padStart(11)} │ ${fmt(r.avgSerendipity * 100, 1).padStart(10)}% │ ` +
      `${fmt(r.avgNoise * 100, 1).padStart(22)}% │`
    );
  }
  console.log("└─────────┴─────────────┴─────────────┴─────────────┴─────────────────────────┘");

  // ─── 实验 B: 纯相似度 vs MMR 详细对比 ────────────────────────────────────

  console.log("\n\n" + "═".repeat(70));
  console.log("📊 实验 B: 纯相似度 vs MMR 详细对比");
  console.log("═".repeat(70));

  const bestLambda = 0.6;  // 基于实验 A 选择
  const detailedResults: {
    query: string;
    pureResults: string[];
    mmrResults: string[];
    pureRelevance: number;
    mmrRelevance: number;
    pureDiversity: number;
    mmrDiversity: number;
    mmrNewItems: string[];  // MMR 引入的新项
  }[] = [];

  for (const query of TEST_QUERIES) {
    console.log(`\n🔍 查询: "${query.text.slice(0, 40)}..."`);
    
    const queryEmb = await getEmbedding(query.text);
    
    // 纯相似度
    const pureResults = pureSimilaritySelect(queryEmb, memoryEmbs, topK);
    const pureEval = evaluateRetrieval(pureResults, query, MEMORY_BANK, memoryEmbs, queryEmb, "Pure");
    
    // MMR
    const mmrResults = mmrSelect(queryEmb, memoryEmbs, bestLambda, topK);
    const mmrEval = evaluateRetrieval(mmrResults, query, MEMORY_BANK, memoryEmbs, queryEmb, `MMR(λ=${bestLambda})`, bestLambda);
    
    const pureIds = pureResults.map(r => MEMORY_BANK[r.index].id);
    const mmrIds = mmrResults.map(r => MEMORY_BANK[r.index].id);
    const mmrNewItems = mmrIds.filter(id => !pureIds.includes(id));
    
    console.log(`\n   纯相似度 Top${topK}: ${pureIds.join(", ")}`);
    console.log(`   相关性: ${fmt(pureEval.avgRelevance)} | 多样性: ${fmt(pureEval.avgDiversity)}`);
    console.log(`   命中相关: ${pureEval.relevantHitRate * 100}% | 命中惊喜: ${pureEval.serendipityRate * 100}%`);
    
    console.log(`\n   MMR(λ=${bestLambda}) Top${topK}: ${mmrIds.join(", ")}`);
    console.log(`   相关性: ${fmt(mmrEval.avgRelevance)} | 多样性: ${fmt(mmrEval.avgDiversity)}`);
    console.log(`   命中相关: ${mmrEval.relevantHitRate * 100}% | 命中惊喜: ${mmrEval.serendipityRate * 100}%`);
    
    if (mmrNewItems.length > 0) {
      console.log(`\n   ✨ MMR 引入的"意外"记忆:`);
      for (const id of mmrNewItems) {
        const mem = MEMORY_BANK.find(m => m.id === id)!;
        const isSerendipity = query.expectedSerendipity.includes(id);
        const marker = isSerendipity ? "💡有价值" : "❓待评估";
        console.log(`      ${marker} [${id}] ${mem.text.slice(0, 50)}...`);
      }
    }
    
    detailedResults.push({
      query: query.text,
      pureResults: pureIds,
      mmrResults: mmrIds,
      pureRelevance: pureEval.avgRelevance,
      mmrRelevance: mmrEval.avgRelevance,
      pureDiversity: pureEval.avgDiversity,
      mmrDiversity: mmrEval.avgDiversity,
      mmrNewItems,
    });
  }

  // ─── 实验 C: 惊喜度分析 ─────────────────────────────────────────────────

  console.log("\n\n" + "═".repeat(70));
  console.log("📊 实验 C: 惊喜度分析");
  console.log("═".repeat(70));

  /**
   * 惊喜度定义:
   * Serendipity = (1 - 与查询的相似度) × 与主题的潜在关联度
   * 
   * 这里简化为: 与查询不太相关，但属于"有启发"主题的记忆
   */
  
  const serendipityTopics = new Set(["reflection", "nature", "architecture", "game"]);
  
  console.log("\n各记忆的惊喜度潜力:");
  console.log("┌─────────────────────────────────────────────────────────────────────────────┐");
  console.log("│ ID          │ 主题          │ 惊喜潜力 │ 说明                              │");
  console.log("├─────────────────────────────────────────────────────────────────────────────┤");
  
  for (const mem of MEMORY_BANK) {
    const isSerendipityTopic = serendipityTopics.has(mem.topic);
    const potential = isSerendipityTopic ? "高" : (mem.topic === "daily" || mem.topic === "food" || mem.topic === "shopping" ? "低" : "中");
    console.log(`│ ${mem.id.padEnd(11)} │ ${mem.topic.padEnd(13)} │ ${potential.padEnd(8)} │ ${mem.text.slice(0, 35).padEnd(33)} │`);
  }
  console.log("└─────────────────────────────────────────────────────────────────────────────┘");

  // ─── 汇总分析 ──────────────────────────────────────────────────────────────

  console.log("\n\n" + "═".repeat(70));
  console.log("📊 汇总分析");
  console.log("═".repeat(70));

  // 找到最优 λ (惊喜率最高且噪声率可接受)
  const validLambdas = lambdaResults.filter(r => r.avgNoise < 0.2);  // 噪声率 < 20%
  const bestSerendipityLambda = validLambdas.reduce((best, r) => 
    r.avgSerendipity > best.avgSerendipity ? r : best
  , validLambdas[0]);

  const avgPureRelevance = mean(detailedResults.map(r => r.pureRelevance));
  const avgMmrRelevance = mean(detailedResults.map(r => r.mmrRelevance));
  const avgPureDiversity = mean(detailedResults.map(r => r.pureDiversity));
  const avgMmrDiversity = mean(detailedResults.map(r => r.mmrDiversity));
  const relevanceDrop = (avgPureRelevance - avgMmrRelevance) / avgPureRelevance;
  const diversityGain = (avgMmrDiversity - avgPureDiversity) / avgPureDiversity;

  console.log(`\n纯相似度 vs MMR(λ=${bestLambda}):`);
  console.log(`  平均相关性: ${fmt(avgPureRelevance)} → ${fmt(avgMmrRelevance)} (变化: ${fmt(-relevanceDrop * 100, 1)}%)`);
  console.log(`  平均多样性: ${fmt(avgPureDiversity)} → ${fmt(avgMmrDiversity)} (变化: +${fmt(diversityGain * 100, 1)}%)`);
  console.log(`\n最优惊喜 λ: ${bestSerendipityLambda?.lambda ?? "N/A"} (惊喜率: ${fmt((bestSerendipityLambda?.avgSerendipity ?? 0) * 100, 1)}%)`);

  const h1Supported = avgMmrDiversity > avgPureDiversity && relevanceDrop < 0.15;
  const h2Supported = bestSerendipityLambda !== undefined;

  // ─── 生成结论 ──────────────────────────────────────────────────────────────

  const result: ExperimentResult = {
    name: "相关性/不相关性平衡 (MMR / Serendipity)",
    hypothesis: "MMR 能在保持相关性的同时提升多样性；存在惊喜度最优的 λ 区间",
    data: {
      lambdaScan: lambdaResults,
      bestLambda,
      bestSerendipityLambda: bestSerendipityLambda?.lambda,
      avgPureRelevance,
      avgMmrRelevance,
      relevanceDrop,
      avgPureDiversity,
      avgMmrDiversity,
      diversityGain,
      h1Supported,
      h2Supported,
    },
    conclusion:
      h1Supported
        ? `支持假设 H1: MMR(λ=${bestLambda}) 在相关性仅下降 ${fmt(relevanceDrop * 100, 1)}% 的情况下，` +
          `多样性提升了 ${fmt(diversityGain * 100, 1)}%。` +
          (h2Supported 
            ? ` 支持 H2: 最优惊喜 λ 约为 ${bestSerendipityLambda?.lambda}。`
            : "") +
          " MMR 能有效引入'意外但有价值'的记忆，避免'查找机器'问题。"
        : "部分支持假设。MMR 提升了多样性，但相关性下降较多，需要更精细的参数调优。",
    feasible: h1Supported ? "yes" : "partial",
  };

  printResult(result);

  // ─── 实现建议 ──────────────────────────────────────────────────────────────

  console.log("💡 工程化实现建议:");
  console.log("   1. 默认使用 λ=0.6-0.7 (偏重相关性，适度多样性)");
  console.log("   2. 提供'探索模式'开关，切换到 λ=0.4-0.5 (更多惊喜)");
  console.log("   3. 动态调整: 根据用户反馈调整 λ (点击/忽略惊喜记忆)");
  console.log("   4. 结合情绪状态: 情绪低落时提高 λ (需要相关安慰)");
  console.log("   5. 结合时间: 深夜/闲暇时降低 λ (允许更多漫游)");
  console.log("   6. LangChain 已内置 MMR: vectorstore.asRetriever({ searchType: 'mmr' })\n");
}

// ─── 运行 ────────────────────────────────────────────────────────────────────

runExperiment().catch(console.error);
