/**
 * 共享工具模块 - 记忆检索实验
 * 
 * 提供 embedding API 调用、向量运算等基础功能
 */

import OpenAI from "openai";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// 加载环境变量
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../.env") });

// ─── Embedding Client ────────────────────────────────────────────────────────

// 使用阿里云 MaaS 的 OpenAI 兼容接口
const dashscopeBaseUrl = process.env.DASHSCOPE_BASE_URL || "dashscope.aliyuncs.com";
const embeddingClient = new OpenAI({
  baseURL: `https://${dashscopeBaseUrl}/compatible-mode/v1`,
  apiKey: process.env.DASHSCOPE_API_KEY || "",
});

// 阿里云 MaaS 支持的 embedding 模型
const EMBEDDING_MODEL = "text-embedding-v3";

/**
 * 获取文本的 embedding 向量
 */
export async function getEmbedding(text: string): Promise<number[]> {
  const response = await embeddingClient.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text.slice(0, 8000),
  });
  return response.data[0].embedding;
}

/**
 * 批量获取 embeddings
 * 注意: 批量限制为 25 条，超过需要分批
 */
export async function getEmbeddings(texts: string[]): Promise<number[][]> {
  const BATCH_SIZE = 25;
  const allEmbeddings: number[][] = [];
  
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const response = await embeddingClient.embeddings.create({
      model: EMBEDDING_MODEL,
      input: batch.map(t => t.slice(0, 8000)),
    });
    allEmbeddings.push(...response.data.map(d => d.embedding));
    
    // 避免 rate limit
    if (i + BATCH_SIZE < texts.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  
  return allEmbeddings;
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
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
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
