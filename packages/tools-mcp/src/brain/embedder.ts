import { readFileSync } from 'node:fs';
import ort from 'onnxruntime-node';

/**
 * Sentence embedder contract (cdd/plan/second-brain.md). Production is OnnxEmbedder below
 * (bge-small-en-v1.5, 384-dim); tests use the deterministic FakeEmbedder.
 */
export interface Embedder {
  embed(texts: string[]): Promise<Float32Array[]>;
  readonly dim: number;
}

export interface OnnxEmbedderConfig {
  /** Path to model.onnx (injected; provisioned by fetch-models). */
  modelPath: string;
  /** Path to tokenizer.json (HuggingFace tokenizers format, BERT WordPiece family). */
  tokenizerPath: string;
  /** Max tokens per input including [CLS]/[SEP] (default 512, the BERT limit). */
  maxTokens?: number;
  /** Inputs per ONNX run (default 16). */
  batchSize?: number;
}

/* ------------------------------- WordPiece tokenizer ------------------------------- */

/**
 * Minimal BERT-family tokenizer driven directly by tokenizer.json (BertNormalizer +
 * BertPreTokenizer + WordPiece). No external dependency — implements exactly the pipeline
 * declared by bge-small-en-v1.5's tokenizer.json.
 */
class WordPieceTokenizer {
  private readonly vocab = new Map<string, number>();
  private readonly unkId: number;
  private readonly clsId: number;
  private readonly sepId: number;
  private readonly prefix: string;
  private readonly maxInputCharsPerWord: number;
  private readonly lowercase: boolean;
  private readonly stripAccents: boolean;
  private readonly handleChineseChars: boolean;

  constructor(tokenizerJsonPath: string) {
    const raw = JSON.parse(readFileSync(tokenizerJsonPath, 'utf8')) as {
      normalizer?: {
        lowercase?: boolean;
        strip_accents?: boolean | null;
        handle_chinese_chars?: boolean;
      };
      model: {
        type: string;
        unk_token: string;
        continuing_subword_prefix: string;
        max_input_chars_per_word?: number;
        vocab: Record<string, number>;
      };
    };
    if (raw.model.type !== 'WordPiece') {
      throw new Error(`unsupported tokenizer model type: ${raw.model.type}`);
    }
    for (const [tok, id] of Object.entries(raw.model.vocab)) this.vocab.set(tok, id);
    const need = (tok: string): number => {
      const id = this.vocab.get(tok);
      if (id === undefined) throw new Error(`tokenizer vocab missing ${tok}`);
      return id;
    };
    this.unkId = need(raw.model.unk_token);
    this.clsId = need('[CLS]');
    this.sepId = need('[SEP]');
    this.prefix = raw.model.continuing_subword_prefix;
    this.maxInputCharsPerWord = raw.model.max_input_chars_per_word ?? 100;
    this.lowercase = raw.normalizer?.lowercase ?? true;
    // BertNormalizer semantics: strip_accents null → follow `lowercase`.
    this.stripAccents = raw.normalizer?.strip_accents ?? this.lowercase;
    this.handleChineseChars = raw.normalizer?.handle_chinese_chars ?? true;
  }

  /** [CLS] ... [SEP], truncated to maxTokens. */
  encode(text: string, maxTokens: number): number[] {
    const ids: number[] = [this.clsId];
    const budget = maxTokens - 2;
    outer: for (const word of this.preTokenize(this.normalize(text))) {
      for (const id of this.wordPiece(word)) {
        if (ids.length - 1 >= budget) break outer;
        ids.push(id);
      }
    }
    ids.push(this.sepId);
    return ids;
  }

  private normalize(text: string): string {
    let out = '';
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      // clean_text: drop NUL/replacement/control chars; map \t \n \r to space.
      if (cp === 0 || cp === 0xfffd) continue;
      if (ch === '\t' || ch === '\n' || ch === '\r') {
        out += ' ';
        continue;
      }
      if (/\p{Cc}|\p{Cf}/u.test(ch)) continue;
      if (this.handleChineseChars && isCjk(cp)) {
        out += ` ${ch} `;
        continue;
      }
      out += ch;
    }
    if (this.stripAccents) out = out.normalize('NFD').replace(/\p{Mn}/gu, '');
    if (this.lowercase) out = out.toLowerCase();
    return out;
  }

  /** BertPreTokenizer: split on whitespace, then isolate punctuation characters. */
  private preTokenize(text: string): string[] {
    const words: string[] = [];
    for (const chunk of text.split(/\s+/)) {
      if (!chunk) continue;
      let current = '';
      for (const ch of chunk) {
        if (isPunctuation(ch)) {
          if (current) words.push(current);
          words.push(ch);
          current = '';
        } else {
          current += ch;
        }
      }
      if (current) words.push(current);
    }
    return words;
  }

  /** Greedy longest-match-first subword split. */
  private wordPiece(word: string): number[] {
    if (word.length > this.maxInputCharsPerWord) return [this.unkId];
    const ids: number[] = [];
    let start = 0;
    while (start < word.length) {
      let end = word.length;
      let found = -1;
      while (end > start) {
        const piece = (start > 0 ? this.prefix : '') + word.slice(start, end);
        const id = this.vocab.get(piece);
        if (id !== undefined) {
          found = id;
          break;
        }
        end--;
      }
      if (found === -1) return [this.unkId];
      ids.push(found);
      start = end;
    }
    return ids;
  }
}

function isPunctuation(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  if (
    (cp >= 33 && cp <= 47) ||
    (cp >= 58 && cp <= 64) ||
    (cp >= 91 && cp <= 96) ||
    (cp >= 123 && cp <= 126)
  ) {
    return true;
  }
  return /\p{P}/u.test(ch);
}

function isCjk(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0x2a700 && cp <= 0x2ceaf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x2f800 && cp <= 0x2fa1f)
  );
}

/* ----------------------------------- OnnxEmbedder ---------------------------------- */

/**
 * bge-small-en-v1.5 via onnxruntime-node: WordPiece-tokenize, run the transformer,
 * attention-masked mean-pool over last_hidden_state, L2-normalize. 384-dim.
 * Inputs are processed in batches of `batchSize`, padded per batch.
 */
export class OnnxEmbedder implements Embedder {
  readonly dim = 384;
  private readonly modelPath: string;
  private readonly tokenizerPath: string;
  private readonly maxTokens: number;
  private readonly batchSize: number;
  private session: ort.InferenceSession | null = null;
  private tokenizer: WordPieceTokenizer | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(cfg: OnnxEmbedderConfig) {
    this.modelPath = cfg.modelPath;
    this.tokenizerPath = cfg.tokenizerPath;
    this.maxTokens = cfg.maxTokens ?? 512;
    this.batchSize = cfg.batchSize ?? 16;
  }

  private init(): Promise<void> {
    this.initPromise ??= (async () => {
      this.tokenizer = new WordPieceTokenizer(this.tokenizerPath);
      this.session = await ort.InferenceSession.create(this.modelPath, {
        logSeverityLevel: 3
      });
    })();
    return this.initPromise;
  }

  /**
   * Eagerly loads the tokenizer + ONNX session so the first real `embed()` doesn't pay the
   * cold-start cost (session creation dominates). Idempotent (shares the init promise); safe to
   * fire-and-forget at app startup when the second brain is enabled (amendments deferred item:
   * "cold-start ONNX embedder warm-up flag").
   */
  async warmUp(): Promise<void> {
    await this.init();
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    await this.init();
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      out.push(...(await this.embedBatch(batch)));
    }
    return out;
  }

  private async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const tokenizer = this.tokenizer!;
    const session = this.session!;
    const encoded = texts.map((t) => tokenizer.encode(t, this.maxTokens));
    const b = encoded.length;
    const t = Math.max(...encoded.map((e) => e.length));
    const inputIds = new BigInt64Array(b * t);
    const attentionMask = new BigInt64Array(b * t);
    const tokenTypeIds = new BigInt64Array(b * t); // all zeros
    for (let row = 0; row < b; row++) {
      const ids = encoded[row]!;
      for (let col = 0; col < ids.length; col++) {
        inputIds[row * t + col] = BigInt(ids[col]!);
        attentionMask[row * t + col] = 1n;
      }
    }
    const feeds: Record<string, ort.Tensor> = {
      input_ids: new ort.Tensor('int64', inputIds, [b, t]),
      attention_mask: new ort.Tensor('int64', attentionMask, [b, t]),
      token_type_ids: new ort.Tensor('int64', tokenTypeIds, [b, t])
    };
    const results = await session.run(feeds);
    const hidden = results['last_hidden_state'];
    if (!hidden) throw new Error('model returned no last_hidden_state');
    const [, seqLen, hiddenDim] = hidden.dims as [number, number, number];
    if (hiddenDim !== this.dim) {
      throw new Error(`model hidden dim ${hiddenDim} does not match expected ${this.dim}`);
    }
    const data = hidden.data as Float32Array;
    const vectors: Float32Array[] = [];
    for (let row = 0; row < b; row++) {
      const vec = new Float32Array(this.dim);
      const nTokens = encoded[row]!.length;
      for (let col = 0; col < nTokens; col++) {
        const base = (row * seqLen + col) * this.dim;
        for (let d = 0; d < this.dim; d++) vec[d]! += data[base + d]!;
      }
      let norm = 0;
      for (let d = 0; d < this.dim; d++) {
        vec[d]! /= nTokens; // mean-pool (attention mask is 1 exactly on the first nTokens)
        norm += vec[d]! * vec[d]!;
      }
      norm = Math.sqrt(norm) || 1;
      for (let d = 0; d < this.dim; d++) vec[d]! /= norm; // L2-normalize
      vectors.push(vec);
    }
    return vectors;
  }

  /** Release the ONNX session. Best-effort; safe to call more than once. */
  async dispose(): Promise<void> {
    const s = this.session;
    this.session = null;
    this.tokenizer = null;
    this.initPromise = null;
    if (s) await s.release();
  }
}
