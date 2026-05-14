/** 轻量中文 NLP——bigram 分词 + TF-IDF + 余弦相似度 */

/** CJK bigram tokenizer */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    // English/numbers: accumulate until delimiter
    if (/[a-zA-Z0-9]/.test(ch)) {
      let word = "";
      while (i < text.length && /[a-zA-Z0-9]/.test(text[i])) {
        word += text[i]; i++;
      }
      if (word.length > 1) tokens.push(word.toLowerCase());
      continue;
    }
    // CJK: bigram sliding window
    if (isCJK(ch) && i + 1 < text.length && isCJK(text[i + 1])) {
      tokens.push(ch + text[i + 1]);
    }
    // Also include single CJK characters for overlap
    if (isCJK(ch)) tokens.push(ch);
    i++;
  }
  return tokens;
}

function isCJK(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return (c >= 0x4E00 && c <= 0x9FFF) || // CJK Unified
         (c >= 0x3400 && c <= 0x4DBF) || // CJK Ext-A
         (c >= 0x20000 && c <= 0x2A6DF); // CJK Ext-B
}

/** Build a TF vector from tokens */
export function tfVector(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) {
    tf.set(t, (tf.get(t) ?? 0) + 1);
  }
  // Normalize
  const total = tokens.length || 1;
  for (const [k, v] of tf) tf.set(k, v / total);
  return tf;
}

/** Cosine similarity between two TF vectors */
export function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0, normA = 0, normB = 0;
  for (const [k, va] of a) {
    const vb = b.get(k) ?? 0;
    dot += va * vb;
    normA += va * va;
  }
  if (normA === 0) return 0;
  for (const [, vb] of b) normB += vb * vb;
  if (normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Extract top-N keywords using TF */
export function extractKeywords(text: string, topN = 10): string[] {
  const tokens = tokenize(text);
  const tf = tfVector(tokens);
  return [...tf.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([k]) => k);
}
