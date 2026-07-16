import type { Embedder } from '../../src/brain/embedder.js';

/**
 * Deterministic hash→vector embedder for tests (no model, no network).
 *
 * Each lowercase word token is hashed (FNV-1a) into a fixed pseudo-random unit direction;
 * a text's vector is the L2-normalized sum of its token vectors. Identical token multisets
 * → cosine 1.0; disjoint token sets → cosine ≈ 0. An optional `synonyms` map lets tests
 * create "semantic-only" matches (e.g. automobile → car) that keyword search cannot see.
 */
export class FakeEmbedder implements Embedder {
  readonly dim: number;
  private readonly synonyms: Record<string, string>;

  constructor(opts?: { dim?: number; synonyms?: Record<string, string> }) {
    this.dim = opts?.dim ?? 384;
    this.synonyms = opts?.synonyms ?? {};
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.embedOne(t));
  }

  private embedOne(text: string): Float32Array {
    const vec = new Float32Array(this.dim);
    const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    for (const raw of tokens) {
      const token = this.synonyms[raw] ?? raw;
      // Spread each token over 8 deterministic (index, sign) pairs.
      let h = fnv1a(token);
      for (let i = 0; i < 8; i++) {
        h = fnv1aStep(h, i + 1);
        const idx = h % this.dim;
        vec[idx]! += (h & 1) === 0 ? 1 : -1;
      }
    }
    let norm = 0;
    for (let i = 0; i < this.dim; i++) norm += vec[i]! * vec[i]!;
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < this.dim; i++) vec[i]! /= norm;
    return vec;
  }
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function fnv1aStep(h: number, salt: number): number {
  h ^= salt;
  return Math.imul(h, 0x01000193) >>> 0;
}
