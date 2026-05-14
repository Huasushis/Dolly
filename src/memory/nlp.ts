/** 多语言 NLP——bigram + 词边界分词 + TF-IDF + 余弦相似度 */

const STOP_WORDS = new Set([
  "the","a","an","is","are","was","were","be","been","being","have","has","had",
  "do","does","did","will","would","shall","should","may","might","must","can","could",
  "i","me","my","we","us","our","you","your","he","him","his","she","her","it","its",
  "they","them","their","this","that","these","those","to","of","in","for","on","with",
  "at","by","from","as","into","through","during","before","after","above","below",
  "between","and","but","or","nor","not","so","if","then","than","too","very","just",
  "的","了","在","是","我","有","和","就","不","人","都","一","个","上","也","很","到","说","要","去",
  "你","会","着","没","看","好","自己","这","他","她","它","们","那","些","什么","怎么","哪",
]);

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const cp = ch.codePointAt(0)!;

    // Latin/Cyrillic/Arabic: accumulate alphabetic sequences
    if (isAlpha(cp)) {
      let word = "";
      while (i < text.length && isAlpha(text.codePointAt(i)!)) {
        word += text[i]; i++;
      }
      const lower = word.toLowerCase();
      if (lower.length > 1 && !STOP_WORDS.has(lower)) tokens.push(lower);
      continue;
    }

    // Digits
    if (/\d/.test(ch)) {
      let num = "";
      while (i < text.length && /[\d.]/.test(text[i])) { num += text[i]; i++; }
      if (num.length > 0) tokens.push(num);
      continue;
    }

    // CJK: bigram + unigram
    if (isCJK(cp)) {
      if (i + 1 < text.length && isCJK(text.codePointAt(i + 1)!)) {
        tokens.push(ch + text[i + 1]);
      }
      // Unigram for overlap (skip stop words)
      if (!STOP_WORDS.has(ch)) tokens.push(ch);
      i++;
      continue;
    }

    // Other: skip single punctuation/spaces
    i++;
  }
  return tokens;
}

function isAlpha(cp: number): boolean {
  return (cp >= 0x41 && cp <= 0x5A) || (cp >= 0x61 && cp <= 0x7A) || // Latin
         (cp >= 0xC0 && cp <= 0x24F) || // Latin Extended
         (cp >= 0x400 && cp <= 0x4FF) || // Cyrillic
         (cp >= 0x600 && cp <= 0x6FF) || // Arabic
         (cp >= 0x900 && cp <= 0x97F);   // Devanagari
}

function isCJK(cp: number): boolean {
  return (cp >= 0x4E00 && cp <= 0x9FFF) ||
         (cp >= 0x3400 && cp <= 0x4DBF) ||
         (cp >= 0x20000 && cp <= 0x2A6DF) ||
         (cp >= 0x3040 && cp <= 0x309F) || // Hiragana
         (cp >= 0x30A0 && cp <= 0x30FF) || // Katakana
         (cp >= 0xAC00 && cp <= 0xD7AF);   // Hangul
}

export function tfVector(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  const total = tokens.length || 1;
  for (const [k, v] of tf) tf.set(k, v / total);
  return tf;
}

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

export function extractKeywords(text: string, topN = 10): string[] {
  const tokens = tokenize(text);
  const tf = tfVector(tokens);
  return [...tf.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([k]) => k);
}
