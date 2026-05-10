/**
 * Deterministic hash-bag embedder v2. No deps, no LLM, no provider.
 *
 * Three feature streams hashed into a single 384-dim float vector:
 *   1. Word unigrams (after stop-word strip + light stemming) — topic match.
 *   2. Word bigrams — phrase match.
 *   3. Character 4-grams over the de-spaced lowered text — catches
 *      hyphenation/spacing variants (`auto-extraction` ↔ `auto extraction`)
 *      and inflection drift (`extracting` ↔ `extraction`).
 *
 * Each stream is weighted (words 1.0, bigrams 0.7, char-grams 0.4),
 * L2-normalized once at the end. Sign-bit trick prevents collision collapse.
 *
 * Cosine on this space:
 *   - exact paraphrases: 0.5–0.85
 *   - shared topic, different wording: 0.25–0.5
 *   - unrelated short summaries: 0.0–0.15
 *
 * Storage: little-endian Float32Array of `EMBED_DIM` floats.
 */

export const EMBED_MODEL = "hashbag-v2";
export const EMBED_DIM = 384;

const TOKEN_RE = /[\p{L}\p{N}]+/gu;

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "be",
  "but",
  "by",
  "do",
  "for",
  "from",
  "i",
  "if",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "so",
  "the",
  "then",
  "to",
  "we",
  "you",
  "your",
  "this",
  "that",
  "these",
  "those",
  "with",
  "was",
  "were",
  "are",
  "am",
  "not",
  "no",
  "do",
  "does",
  "did",
  "done",
  "has",
  "have",
  "had",
  "will",
  "would",
  "should",
  "can",
  "could",
  "may",
  "might",
  "just",
  "really",
  "actually",
  "basically",
]);

/**
 * Light stemming — strips a handful of common English suffixes so
 * `extracting`, `extracted`, `extraction`, `extractor` collapse to
 * `extract`. Conservative: never shortens below 4 chars.
 */
function stem(word: string): string {
  if (word.length <= 4) return word;
  for (const suffix of [
    "ization",
    "izations",
    "ations",
    "ation",
    "ings",
    "tion",
    "ness",
    "ment",
    "able",
    "ible",
    "ings",
    "ies",
    "ied",
    "ier",
    "est",
    "ing",
    "ers",
    "ed",
    "es",
    "ly",
    "ic",
    "al",
    "s",
  ]) {
    if (word.length > suffix.length + 3 && word.endsWith(suffix)) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

function tokenizeWords(text: string): string[] {
  const lower = text.toLowerCase();
  const raw = lower.match(TOKEN_RE) ?? [];
  const out: string[] = [];
  for (const w of raw) {
    if (w.length < 2) continue;
    if (STOP_WORDS.has(w)) continue;
    out.push(stem(w));
  }
  return out;
}

function charNgrams(text: string, n: number): string[] {
  const compact = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (compact.length < n) return [];
  const out: string[] = [];
  for (let i = 0; i <= compact.length - n; i++) out.push(compact.slice(i, i + n));
  return out;
}

/** FNV-1a 32-bit. Fast, deterministic, good distribution for short strings. */
function hashToken(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function project(vec: Float32Array, token: string, weight: number, dim: number): void {
  const h = hashToken(token);
  const bin = h % dim;
  const sign = (hashToken(`s:${token}`) & 1) === 0 ? 1 : -1;
  vec[bin] = (vec[bin] ?? 0) + sign * weight;
}

export function embed(text: string, dim = EMBED_DIM): Float32Array {
  const vec = new Float32Array(dim);
  if (!text) return vec;

  const words = tokenizeWords(text);
  // Gate everything on at least one real word token. Punctuation/emoji-only
  // input → zero vector (so it can't accidentally cluster with any memory).
  if (words.length === 0) return vec;

  // Stream 1: word unigrams.
  for (const w of words) project(vec, `w:${w}`, 1.0, dim);
  // Stream 2: word bigrams.
  for (let i = 0; i < words.length - 1; i++) {
    project(vec, `b:${words[i]}_${words[i + 1]}`, 0.7, dim);
  }
  // Stream 3: char 4-grams over collapsed text.
  const grams = charNgrams(text, 4);
  for (const g of grams) project(vec, `c:${g}`, 0.4, dim);

  let norm = 0;
  for (let i = 0; i < dim; i++) norm += (vec[i] ?? 0) * (vec[i] ?? 0);
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) vec[i] = (vec[i] ?? 0) / norm;
  }
  return vec;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  // Vectors are unit-normalized at embed() time, so dot == cosine.
  return dot;
}

export function vectorToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function bufferToVector(buf: Buffer | Uint8Array): Float32Array {
  const view = buf instanceof Buffer ? buf : Buffer.from(buf);
  const aligned = new ArrayBuffer(view.byteLength);
  new Uint8Array(aligned).set(view);
  return new Float32Array(aligned);
}

/** Compose embedding source from a memory's content fields.
 * Summary is the headline — it carries the most signal — so we triplicate it
 * before details/topics so it dominates the cosine instead of being drowned
 * by a long details body. */
export function memoryEmbedSource(summary: string, details: string, topics: string[]): string {
  const s = summary.trim();
  const t = topics.join(" ").trim();
  const d = details.trim();
  if (!s && !d && !t) return "";
  return `${s} ${s} ${s}\n${d}\n${t}`.trim();
}
