/**
 * 共享工具模块 - 记忆检索实验
 * 
 * 提供 embedding API 调用、向量运算等基础功能
 * 
 * 注意: 由于 embedding API 不可用，使用基于哈希的模拟 embedding
 * 该模拟方法确保:
 * 1. 相同文本产生相同向量 (确定性)
 * 2. 相似文本产生相似向量 (基于词重叠)
 * 3. 不同文本产生不同向量 (区分性)
 */

import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// 加载环境变量
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../.env") });

// ─── 模拟 Embedding ──────────────────────────────────────────────────────────

const EMBEDDING_DIM = 256;  // 使用较小的维度便于计算

/**
 * 简单的字符串哈希函数
 */
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash);
}

/**
 * 基于词袋的模拟 embedding
 * 原理: 
 * 1. 将文本分词 (简单按字符/空格)
 * 2. 每个词贡献一个固定方向的向量
 * 3. 最终向量是所有词向量的加权和
 */
export function mockEmbedding(text: string): number[] {
  const vector = new Array(EMBEDDING_DIM).fill(0);
  
  // 分词: 中文按字符，英文按空格
  const tokens = text
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9\s]/g, " ")
    .split(/\s+|(?<=[\u4e00-\u9fa5])(?=[\u4e00-\u9fa5])/)
    .filter(t => t.length > 0);
  
  for (const token of tokens) {
    // 每个词生成一个确定性的"方向"
    const hash = hashString(token);
    const startIdx = hash % EMBEDDING_DIM;
    const length = 3 + (hash % 5); // 影响 3-7 个维度
    
    for (let i = 0; i < length; i++) {
      const idx = (startIdx + i) % EMBEDDING_DIM;
      // 使用哈希决定正负和强度
      const sign = ((hash >> i) & 1) ? 1 : -1;
      const strength = 0.5 + ((hash >> (i + 8)) & 0xFF) / 255 * 0.5;
      vector[idx] += sign * strength;
    }
  }
  
  // 归一化
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (norm > 0) {
    for (let i = 0; i < vector.length; i++) {
      vector[i] /= norm;
    }
  }
  
  return vector;
}

/**
 * 获取文本的 embedding 向量
 * 使用模拟 embedding (API 不可用时的备选方案)
 */
export async function getEmbedding(text: string): Promise<number[]> {
  // 模拟 API 延迟
  await new Promise(r => setTimeout(r, 10));
  return mockEmbedding(text);
}

/**
 * 批量获取 embeddings
 */
export async function getEmbeddings(texts: string[]): Promise<number[][]> {
  // 模拟 API 延迟
  await new Promise(r => setTimeout(r, 50));
  return texts.map(t => mockEmbedding(t));
}

// ─── 向量运算 ────────────────────────────────────────────────────────────────

/**
 * 余弦相似度
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error("Vector length mismatch");
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * 欧氏距离
 */
export function euclideanDistance(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error("Vector length mismatch");
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

/**
 * 向量减法
 */
export function vectorSubtract(a: number[], b: number[]): number[] {
  return a.map((v, i) => v - b[i]);
}

/**
 * 向量加法
 */
export function vectorAdd(a: number[], b: number[]): number[] {
  return a.map((v, i) => v + b[i]);
}

/**
 * 向量缩放
 */
export function vectorScale(a: number[], scalar: number): number[] {
  return a.map(v => v * scalar);
}

/**
 * 向量归一化
 */
export function vectorNormalize(a: number[]): number[] {
  const norm = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
  return norm === 0 ? a : a.map(v => v / norm);
}

/**
 * 向量点积
 */
export function dotProduct(a: number[], b: number[]): number {
  return a.reduce((sum, v, i) => sum + v * b[i], 0);
}

// ─── DTW (Dynamic Time Warping) ──────────────────────────────────────────────

/**
 * 动态时间规整算法
 * 用于计算两个向量序列之间的形状相似度
 * 
 * @param seq1 向量序列 1
 * @param seq2 向量序列 2
 * @param distFn 距离函数（默认欧氏距离）
 * @returns DTW 距离（越小越相似）
 */
export function dtwDistance(
  seq1: number[][],
  seq2: number[][],
  distFn: (a: number[], b: number[]) => number = euclideanDistance
): number {
  const n = seq1.length;
  const m = seq2.length;
  
  // 创建 DP 表
  const dtw: number[][] = Array(n + 1)
    .fill(null)
    .map(() => Array(m + 1).fill(Infinity));
  
  dtw[0][0] = 0;
  
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = distFn(seq1[i - 1], seq2[j - 1]);
      dtw[i][j] = cost + Math.min(
        dtw[i - 1][j],      // 插入
        dtw[i][j - 1],      // 删除
        dtw[i - 1][j - 1]   // 匹配
      );
    }
  }
  
  return dtw[n][m];
}

/**
 * DTW 相似度（归一化到 0-1，越大越相似）
 */
export function dtwSimilarity(
  seq1: number[][],
  seq2: number[][],
  distFn: (a: number[], b: number[]) => number = euclideanDistance
): number {
  const distance = dtwDistance(seq1, seq2, distFn);
  return 1 / (1 + distance);
}

// ─── MMR (Maximal Marginal Relevance) ────────────────────────────────────────

export interface MMRResult {
  index: number;
  score: number;
  relevance: number;
  diversity: number;
}

/**
 * 最大边际相关性算法
 * 平衡相关性和多样性
 * 
 * @param queryVector 查询向量
 * @param docVectors 文档向量数组
 * @param lambda 平衡参数 (0-1)，越大越重视相关性
 * @param topK 返回数量
 * @returns 排序后的结果
 */
export function mmrSelect(
  queryVector: number[],
  docVectors: number[][],
  lambda: number = 0.5,
  topK: number = 5
): MMRResult[] {
  const n = docVectors.length;
  const selected: MMRResult[] = [];
  const remaining = new Set(Array.from({ length: n }, (_, i) => i));
  
  // 预计算与 query 的相关性
  const relevanceScores = docVectors.map(doc => cosineSimilarity(queryVector, doc));
  
  while (selected.length < topK && remaining.size > 0) {
    let bestIdx = -1;
    let bestScore = -Infinity;
    let bestRelevance = 0;
    let bestDiversity = 0;
    
    for (const idx of remaining) {
      const relevance = relevanceScores[idx];
      
      // 计算与已选文档的最大相似度
      let maxSimToSelected = 0;
      for (const sel of selected) {
        const sim = cosineSimilarity(docVectors[idx], docVectors[sel.index]);
        maxSimToSelected = Math.max(maxSimToSelected, sim);
      }
      
      const diversity = 1 - maxSimToSelected;
      const mmrScore = lambda * relevance - (1 - lambda) * maxSimToSelected;
      
      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIdx = idx;
        bestRelevance = relevance;
        bestDiversity = diversity;
      }
    }
    
    if (bestIdx >= 0) {
      selected.push({
        index: bestIdx,
        score: bestScore,
        relevance: bestRelevance,
        diversity: bestDiversity,
      });
      remaining.delete(bestIdx);
    }
  }
  
  return selected;
}

/**
 * 纯相似度排序（作为 MMR 的对比基线）
 */
export function pureSimilaritySelect(
  queryVector: number[],
  docVectors: number[][],
  topK: number = 5
): MMRResult[] {
  const scores = docVectors.map((doc, idx) => ({
    index: idx,
    score: cosineSimilarity(queryVector, doc),
    relevance: cosineSimilarity(queryVector, doc),
    diversity: 0,
  }));
  
  return scores
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// ─── 统计工具 ────────────────────────────────────────────────────────────────

/**
 * 计算平均值
 */
export function mean(arr: number[]): number {
  return arr.reduce((sum, v) => sum + v, 0) / arr.length;
}

/**
 * 计算标准差
 */
export function std(arr: number[]): number {
  const m = mean(arr);
  const variance = arr.reduce((sum, v) => sum + (v - m) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

/**
 * 格式化数字输出
 */
export function fmt(n: number, decimals: number = 4): string {
  return n.toFixed(decimals);
}

// ─── 实验结果输出 ────────────────────────────────────────────────────────────

export interface ExperimentResult {
  name: string;
  hypothesis: string;
  data: Record<string, unknown>;
  conclusion: string;
  feasible: "yes" | "partial" | "no";
}

/**
 * 打印实验结果
 */
export function printResult(result: ExperimentResult): void {
  console.log("\n" + "=".repeat(70));
  console.log(`实验: ${result.name}`);
  console.log("=".repeat(70));
  console.log(`假设: ${result.hypothesis}`);
  console.log("\n数据:");
  console.log(JSON.stringify(result.data, null, 2));
  console.log(`\n结论: ${result.conclusion}`);
  console.log(`可行性判定: ${result.feasible}`);
  console.log("=".repeat(70) + "\n");
}
