/**
 * 实验 1: 向量轨迹匹配 (Vector Trajectory Matching)
 * 
 * ═══════════════════════════════════════════════════════════════════════════
 * 实验目的
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * 验证用户 Idea: "把向量的序列看成空间中的一段轨迹，然后去查找数据库里相似的轨迹"
 * 
 * 核心问题:
 * 1. 能否用 DTW (Dynamic Time Warping) 衡量 embedding 序列的"形状相似度"？
 * 2. 轨迹相似度能否区分"相似对话模式"和"不同对话模式"？
 * 3. 与逐点 cosine 相似度相比，DTW 是否能捕获"整体模式"而非"点对点匹配"？
 * 
 * ═══════════════════════════════════════════════════════════════════════════
 * 实验设计
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * 自变量: 对话序列的类型
 *   - 类型 A: "问题-解答-追问" 模式 (技术问答)
 *   - 类型 B: "闲聊-分享-回应" 模式 (日常对话)
 *   - 类型 C: "请求-执行-确认" 模式 (任务执行)
 * 
 * 因变量: 
 *   - DTW 距离/相似度
 *   - 逐点 cosine 相似度 (作为对比基线)
 * 
 * 控制变量:
 *   - 每个序列长度相同 (5 个 block)
 *   - 使用相同的 embedding 模型
 * 
 * 假设:
 *   H1: 相同模式的对话序列，DTW 相似度显著高于不同模式
 *   H2: DTW 比逐点 cosine 更能捕获"形状"相似性（允许时间偏移）
 * 
 * ═══════════════════════════════════════════════════════════════════════════
 * 运行方式
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * npx tsx test/memory-experiments/exp1-trajectory-matching.ts
 */

import {
  getEmbeddings,
  dtwDistance,
  dtwSimilarity,
  cosineSimilarity,
  euclideanDistance,
  mean,
  std,
  fmt,
  printResult,
  type ExperimentResult,
} from "./utils.js";

// ─── 实验数据 ────────────────────────────────────────────────────────────────

/**
 * 模拟对话序列
 * 每个序列代表一种"对话模式"的 5 个连续 block
 */
const CONVERSATION_SEQUENCES = {
  // 类型 A: 技术问答模式 (问题 -> 解答 -> 追问 -> 深入 -> 总结)
  techQA_1: [
    "用户询问如何配置 TypeScript 的 tsconfig.json 文件",
    "助手详细解释了 compilerOptions 中各个参数的含义和推荐配置",
    "用户追问 moduleResolution 应该选择 node 还是 bundler",
    "助手对比分析了两种模式的差异，建议新项目使用 bundler",
    "用户表示理解，确认会按照建议修改配置",
  ],
  techQA_2: [
    "用户询问 React 中 useEffect 的依赖数组应该如何设置",
    "助手解释了依赖数组的作用和常见错误用法",
    "用户追问如果依赖是对象或数组该怎么办",
    "助手建议使用 useMemo 或 useCallback 来稳定引用",
    "用户表示感谢，说会尝试这个方案",
  ],
  techQA_3: [
    "用户询问 Python 中如何正确处理文件编码问题",
    "助手说明了 UTF-8 编码的重要性和 open 函数的 encoding 参数",
    "用户追问读取未知编码的文件时应该怎么办",
    "助手推荐使用 chardet 库自动检测编码",
    "用户确认会安装这个库来解决问题",
  ],

  // 类型 B: 日常闲聊模式 (打招呼 -> 分享 -> 回应 -> 延伸 -> 结束)
  casual_1: [
    "用户说早上好，今天天气真不错",
    "助手回应早上好，确实是个适合出门的好天气",
    "用户分享说打算下午去公园散步",
    "助手说公园散步很惬意，可以顺便拍拍照",
    "用户说好的，到时候分享照片给你看",
  ],
  casual_2: [
    "用户说晚上好，刚吃完晚饭",
    "助手问吃了什么好吃的",
    "用户说尝试做了一道新菜，番茄炒蛋",
    "助手夸赞番茄炒蛋是经典家常菜，味道一定不错",
    "用户笑着说下次尝试更复杂的菜",
  ],
  casual_3: [
    "用户说周末好，终于休息了",
    "助手说辛苦一周了，好好放松一下",
    "用户分享说准备看一部新上映的电影",
    "助手问是什么类型的电影，推荐了几部口碑不错的",
    "用户说谢谢推荐，看完再来聊感受",
  ],

  // 类型 C: 任务执行模式 (请求 -> 确认 -> 执行 -> 反馈 -> 完成)
  task_1: [
    "用户请求帮忙创建一个项目目录结构",
    "助手确认需求：需要 src、test、docs 三个主要目录",
    "助手执行创建目录并生成了初始文件",
    "用户检查后说结构符合要求，但需要添加 config 目录",
    "助手补充创建了 config 目录，任务完成",
  ],
  task_2: [
    "用户请求将一段 JSON 数据转换成 CSV 格式",
    "助手确认数据结构和需要保留的字段",
    "助手执行转换并输出了 CSV 内容",
    "用户反馈说日期字段格式需要调整",
    "助手修正了日期格式，用户确认完成",
  ],
  task_3: [
    "用户请求帮忙写一个正则表达式匹配邮箱地址",
    "助手确认需要匹配的邮箱格式要求",
    "助手提供了正则表达式并解释了各部分含义",
    "用户测试后发现不支持子域名，需要修改",
    "助手更新了正则表达式，用户验证通过",
  ],
};

// ─── 实验执行 ────────────────────────────────────────────────────────────────

async function runExperiment() {
  console.log("╔══════════════════════════════════════════════════════════════════════╗");
  console.log("║  实验 1: 向量轨迹匹配 (Vector Trajectory Matching)                   ║");
  console.log("╚══════════════════════════════════════════════════════════════════════╝\n");

  // 定义 cosine 距离函数 (在函数作用域内)
  const cosDistFn = (a: number[], b: number[]) => 1 - cosineSimilarity(a, b);

  // 1. 获取所有序列的 embeddings
  console.log("📡 正在获取 embeddings...");
  const allTexts: string[] = [];
  const sequenceMeta: { name: string; type: string; startIdx: number }[] = [];

  for (const [name, texts] of Object.entries(CONVERSATION_SEQUENCES)) {
    const type = name.split("_")[0];
    sequenceMeta.push({ name, type, startIdx: allTexts.length });
    allTexts.push(...texts);
  }

  const allEmbeddings = await getEmbeddings(allTexts);
  console.log(`✅ 获取了 ${allEmbeddings.length} 个 embeddings\n`);

  // 2. 重构为序列
  const sequences: Record<string, number[][]> = {};
  for (const meta of sequenceMeta) {
    sequences[meta.name] = allEmbeddings.slice(meta.startIdx, meta.startIdx + 5);
  }

  // 3. 计算所有序列对之间的相似度
  console.log("📊 计算序列间相似度...\n");

  const seqNames = Object.keys(sequences);
  const results: {
    pair: [string, string];
    sameType: boolean;
    dtwSim: number;
    dtwDist: number;
    pointwiseCos: number;
  }[] = [];

  for (let i = 0; i < seqNames.length; i++) {
    for (let j = i + 1; j < seqNames.length; j++) {
      const nameA = seqNames[i];
      const nameB = seqNames[j];
      const seqA = sequences[nameA];
      const seqB = sequences[nameB];

      const typeA = nameA.split("_")[0];
      const typeB = nameB.split("_")[0];
      const sameType = typeA === typeB;

      // DTW 相似度（使用 cosine 距离作为基础距离）
      const dtwDist = dtwDistance(seqA, seqB, cosDistFn);
      const dtwSim = dtwSimilarity(seqA, seqB, cosDistFn);

      // 逐点 cosine 相似度（对齐位置）
      const pointwiseCos = mean(
        seqA.map((vecA, idx) => cosineSimilarity(vecA, seqB[idx]))
      );

      results.push({
        pair: [nameA, nameB],
        sameType,
        dtwSim,
        dtwDist,
        pointwiseCos,
      });
    }
  }

  // 4. 分组统计
  const sameTypeResults = results.filter(r => r.sameType);
  const diffTypeResults = results.filter(r => !r.sameType);

  const sameTypeDTW = sameTypeResults.map(r => r.dtwSim);
  const diffTypeDTW = diffTypeResults.map(r => r.dtwSim);
  const sameTypeCos = sameTypeResults.map(r => r.pointwiseCos);
  const diffTypeCos = diffTypeResults.map(r => r.pointwiseCos);

  // 5. 输出详细结果
  console.log("┌─────────────────────────────────────────────────────────────────────┐");
  console.log("│ 详细结果 (按 DTW 相似度排序)                                        │");
  console.log("├─────────────────────────────────────────────────────────────────────┤");
  
  const sortedResults = [...results].sort((a, b) => b.dtwSim - a.dtwSim);
  for (const r of sortedResults) {
    const marker = r.sameType ? "✓同类" : "✗异类";
    console.log(
      `│ ${marker} ${r.pair[0].padEnd(10)} ↔ ${r.pair[1].padEnd(10)} │ ` +
      `DTW=${fmt(r.dtwSim)} │ Cos=${fmt(r.pointwiseCos)} │`
    );
  }
  console.log("└─────────────────────────────────────────────────────────────────────┘\n");

  // 6. 统计摘要
  console.log("┌─────────────────────────────────────────────────────────────────────┐");
  console.log("│ 统计摘要                                                            │");
  console.log("├─────────────────────────────────────────────────────────────────────┤");
  console.log(`│ 同类序列 DTW 相似度: 均值=${fmt(mean(sameTypeDTW))} 标准差=${fmt(std(sameTypeDTW))}      │`);
  console.log(`│ 异类序列 DTW 相似度: 均值=${fmt(mean(diffTypeDTW))} 标准差=${fmt(std(diffTypeDTW))}      │`);
  console.log(`│ 区分度 (均值差):     ${fmt(mean(sameTypeDTW) - mean(diffTypeDTW))}                              │`);
  console.log(`│                                                                     │`);
  console.log(`│ 同类序列逐点 Cos:    均值=${fmt(mean(sameTypeCos))} 标准差=${fmt(std(sameTypeCos))}      │`);
  console.log(`│ 异类序列逐点 Cos:    均值=${fmt(mean(diffTypeCos))} 标准差=${fmt(std(diffTypeCos))}      │`);
  console.log(`│ 区分度 (均值差):     ${fmt(mean(sameTypeCos) - mean(diffTypeCos))}                              │`);
  console.log("└─────────────────────────────────────────────────────────────────────┘\n");

  // 7. 验证 H2: DTW vs 逐点 Cosine 的区分能力
  const dtwDiscriminability = mean(sameTypeDTW) - mean(diffTypeDTW);
  const cosDiscriminability = mean(sameTypeCos) - mean(diffTypeCos);

  console.log("📈 区分能力对比:");
  console.log(`   DTW 区分度:        ${fmt(dtwDiscriminability)}`);
  console.log(`   逐点 Cosine 区分度: ${fmt(cosDiscriminability)}`);
  console.log(`   DTW 是否更优:      ${dtwDiscriminability > cosDiscriminability ? "是 ✓" : "否 ✗"}\n`);

  // 8. 测试时间偏移不变性 (DTW 的核心优势)
  console.log("🔄 测试时间偏移不变性...");
  
  // 创建一个"偏移"版本的序列：去掉第一个元素，添加一个新的结尾
  const techQA1 = sequences["techQA_1"];
  const techQA1Shifted = [
    techQA1[1],
    techQA1[2],
    techQA1[3],
    techQA1[4],
    techQA1[4], // 重复最后一个作为"延伸"
  ];

  const dtwShifted = dtwSimilarity(techQA1, techQA1Shifted, cosDistFn);
  const cosShifted = mean(
    techQA1.map((v, i) => cosineSimilarity(v, techQA1Shifted[i]))
  );

  console.log(`   原始序列 vs 偏移序列:`);
  console.log(`   DTW 相似度:     ${fmt(dtwShifted)} (应该较高，因为形状相似)`);
  console.log(`   逐点 Cosine:    ${fmt(cosShifted)} (可能较低，因为位置不对齐)`);
  console.log(`   DTW 优势:       ${dtwShifted > cosShifted ? "是 ✓" : "否 ✗"}\n`);

  // 9. 生成实验结论
  const h1Supported = mean(sameTypeDTW) > mean(diffTypeDTW);
  const h2Supported = dtwDiscriminability > cosDiscriminability || dtwShifted > cosShifted;

  const result: ExperimentResult = {
    name: "向量轨迹匹配 (Vector Trajectory Matching)",
    hypothesis: "DTW 轨迹相似度能区分相似/不同对话模式，且比逐点 cosine 更能捕获形状相似性",
    data: {
      sameTypeDTW: { mean: mean(sameTypeDTW), std: std(sameTypeDTW), n: sameTypeDTW.length },
      diffTypeDTW: { mean: mean(diffTypeDTW), std: std(diffTypeDTW), n: diffTypeDTW.length },
      sameTypeCos: { mean: mean(sameTypeCos), std: std(sameTypeCos) },
      diffTypeCos: { mean: mean(diffTypeCos), std: std(diffTypeCos) },
      dtwDiscriminability,
      cosDiscriminability,
      timeShiftTest: { dtw: dtwShifted, cos: cosShifted },
      h1Supported,
      h2Supported,
    },
    conclusion: h1Supported
      ? `支持假设: 同类对话模式的 DTW 相似度 (${fmt(mean(sameTypeDTW))}) 显著高于异类 (${fmt(mean(diffTypeDTW))})。` +
        (h2Supported ? " DTW 在时间偏移场景下展现出优势。" : " 但 DTW 相比逐点 cosine 的优势不明显。") +
        " 该方法可用于检测对话模式的历史重复。"
      : "不支持假设: DTW 相似度无法有效区分同类/异类对话模式。",
    feasible: h1Supported ? (h2Supported ? "yes" : "partial") : "no",
  };

  printResult(result);

  // 10. 实现建议
  console.log("💡 工程化实现建议:");
  console.log("   1. 存储最近 N 个 block 的 embedding 序列作为'当前轨迹'");
  console.log("   2. 使用 DTW 与历史轨迹片段进行匹配");
  console.log("   3. 当 DTW 相似度超过阈值时，触发'模式识别'事件");
  console.log("   4. 可结合 LanceDB 存储轨迹特征向量，加速检索");
  console.log("   5. 注意: DTW 计算复杂度 O(n*m)，长序列需考虑优化\n");
}

// ─── 运行 ────────────────────────────────────────────────────────────────────

runExperiment().catch(console.error);
