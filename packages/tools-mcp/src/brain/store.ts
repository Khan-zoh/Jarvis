import { randomBytes, createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import matter from 'gray-matter';
import type { Embedder } from './embedder.js';
import type {
  ConsolidationReport,
  DistillDecision,
  DistillFn,
  Note,
  NoteSource,
  SearchHit
} from './types.js';

/**
 * BrainStore — the shared second-brain engine (binding: cdd/plan/second-brain.md as amended
 * by cdd/plan/amendments.md A8). Owns the markdown vault + the SQLite index + embeddings and
 * is the single source of truth for BOTH processes (app and tools-mcp brain plugin).
 *
 * Cross-process safety (A8): BOTH processes may write. SQLite runs in WAL mode with a
 * busy-timeout; every index mutation happens inside an IMMEDIATE transaction; every vault
 * file write is atomic (temp file + rename). The engine is safe wherever it is instantiated.
 *
 * Vault layout: `notes/<slug>-<shortid>.md` (curated), `memory/<slug>-<shortid>.md`
 * (consolidated), `captured/YYYY-MM-DD-<slug>-<shortid>.md` — ONE FILE PER CAPTURED ITEM
 * (A8; preserves per-item identity, dedup, deletion, undo), `profile.md`.
 *
 * The index (`<indexDir>/index.sqlite`) never lives in the vault and is rebuildable from it
 * via reindex().
 */

export interface BrainStoreConfig {
  vaultDir: string;
  indexDir: string;
  embedder: Embedder;
  /** Cosine similarity at/above which add() merges into the nearest existing note. Default 0.92. */
  dedupThreshold?: number;
  /** Approximate token budget enforced on profile.md writes during consolidation. Default 500. */
  profileTokenBudget?: number;
}

/** ~512-token passages, approximated at 4 chars/token. */
const CHUNK_CHARS = 1600;
const SNIPPET_CHARS = 240;
const CHARS_PER_TOKEN = 4;
/** Max score boost the keyword leg can add on top of the semantic cosine. The keyword leg
 *  exists for recall (rare terms, names, identifiers the embedder misses), not to outrank
 *  genuinely closer semantic neighbors, so it is a bounded bonus rather than an equal vote. */
const KEYWORD_BONUS = 0.15;

/* --------------------------------- frontmatter IO ---------------------------------- */

export interface NoteFileData {
  title: string;
  created: string;
  updated: string;
  tags: string[];
  source: NoteSource;
}

/**
 * Serialize a note to its on-disk markdown form. Deterministic: fixed key order, timestamps
 * kept as (quoted) strings, one blank line between frontmatter and body, trailing newline.
 * `serializeNoteFile(parseNoteFile(raw)...)` is byte-identical for files this store wrote.
 */
export function serializeNoteFile(data: NoteFileData, body: string): string {
  const front = {
    title: data.title,
    created: data.created,
    updated: data.updated,
    tags: data.tags,
    source: data.source
  };
  return matter.stringify(`\n${normalizeBody(body)}\n`, front);
}

/** Parse an on-disk note file into frontmatter data + normalized body. */
export function parseNoteFile(raw: string): { data: NoteFileData; body: string } {
  const parsed = matter(raw);
  const d = parsed.data as Record<string, unknown>;
  const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);
  const data: NoteFileData = {
    title: str(d['title'], 'Untitled'),
    created: toIso(d['created']),
    updated: toIso(d['updated']),
    tags: Array.isArray(d['tags']) ? d['tags'].map((t) => String(t)) : [],
    source: d['source'] === 'voice' || d['source'] === 'auto' ? d['source'] : 'manual'
  };
  return { data, body: normalizeBody(parsed.content) };
}

function toIso(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Date) return v.toISOString();
  return new Date(0).toISOString();
}

function normalizeBody(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\s+$/, '');
}

/* ------------------------------------ helpers -------------------------------------- */

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || 'note';
}

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const paragraph of text.split(/\n{2,}/)) {
    let para = paragraph.trim();
    if (!para) continue;
    while (para.length > CHUNK_CHARS) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      chunks.push(para.slice(0, CHUNK_CHARS));
      para = para.slice(CHUNK_CHARS).trim();
    }
    if (!para) continue;
    if (current && current.length + para.length + 2 > CHUNK_CHARS) {
      chunks.push(current);
      current = para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [text.trim() || 'empty'];
}

function vecToBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

function blobToVec(buf: Buffer): Float32Array {
  // Copy into a fresh, 0-aligned ArrayBuffer (better-sqlite3 buffers may be unaligned).
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

function normalizedMean(vecs: Float32Array[]): Float32Array {
  const first = vecs[0];
  if (!first) return new Float32Array(0);
  if (vecs.length === 1) return first;
  const out = new Float32Array(first.length);
  for (const v of vecs) for (let i = 0; i < out.length; i++) out[i]! += v[i]!;
  let norm = 0;
  for (let i = 0; i < out.length; i++) norm += out[i]! * out[i]!;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i++) out[i]! /= norm;
  return out;
}

/** ~4 chars per token — the same heuristic used for the profile budget. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function embeddingText(title: string, body: string): string {
  return body ? `${title}\n\n${body}` : title;
}

/** Common English words excluded from the keyword leg — matching them is pure noise and
 *  lets stop-word overlap outrank genuinely relevant notes on natural-language queries. */
const STOP_WORDS = new Set(
  ('a an and are as at be but by do does for from had has have how i in is it its me my of on ' +
    'or our so that the their them they this to was we what when where which who will with you your').split(' ')
);

/** Turn free text into a safe FTS5 query: quoted non-stop-word terms OR-ed together. */
function ftsQuery(query: string): string | null {
  const tokens = query.match(/[A-Za-z0-9_]+/g);
  if (!tokens || tokens.length === 0) return null;
  const terms = [...new Set(tokens.map((t) => t.toLowerCase()))].filter((t) => !STOP_WORDS.has(t));
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"`).join(' OR ');
}

interface NoteRow {
  id: string;
  path: string;
  title: string;
  body: string;
  tags: string;
  source: NoteSource;
  created: string;
  updated: string;
}

function rowToNote(row: NoteRow): Note {
  return {
    id: row.id,
    path: row.path,
    title: row.title,
    body: row.body,
    tags: JSON.parse(row.tags) as string[],
    source: row.source,
    created: row.created,
    updated: row.updated
  };
}

/* ------------------------------------ BrainStore ----------------------------------- */

export class BrainStore {
  private readonly vaultDir: string;
  private readonly embedder: Embedder;
  private readonly dedupThreshold: number;
  private readonly profileTokenBudget: number;
  private readonly db: Database;
  private lastTsMs = 0;

  constructor(cfg: BrainStoreConfig) {
    this.vaultDir = cfg.vaultDir;
    this.embedder = cfg.embedder;
    this.dedupThreshold = cfg.dedupThreshold ?? 0.92;
    this.profileTokenBudget = cfg.profileTokenBudget ?? 500;
    for (const dir of ['notes', 'captured', 'memory']) {
      mkdirSync(join(this.vaultDir, dir), { recursive: true });
    }
    mkdirSync(cfg.indexDir, { recursive: true });
    this.db = new Database(join(cfg.indexDir, 'index.sqlite'));
    // A8: WAL + busy-timeout; every write below runs in an IMMEDIATE transaction.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id      TEXT PRIMARY KEY,
        path    TEXT NOT NULL UNIQUE,
        title   TEXT NOT NULL,
        body    TEXT NOT NULL,
        tags    TEXT NOT NULL,
        source  TEXT NOT NULL,
        created TEXT NOT NULL,
        updated TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chunks (
        id      INTEGER PRIMARY KEY,
        note_id TEXT NOT NULL,
        seq     INTEGER NOT NULL,
        text    TEXT NOT NULL,
        vector  BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chunks_note ON chunks(note_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, chunk_id UNINDEXED);
    `);
  }

  /** Close the SQLite handle (needed on Windows before removing temp dirs in tests). */
  close(): void {
    this.db.close();
  }

  /* ------------------------------------ reindex ------------------------------------ */

  /** Rebuild the whole index from the vault's markdown files. */
  async reindex(): Promise<{ notes: number }> {
    const notes: Note[] = [];
    for (const dir of ['notes', 'captured', 'memory']) {
      const abs = join(this.vaultDir, dir);
      if (!existsSync(abs)) continue;
      for (const name of readdirSync(abs).sort()) {
        if (!name.endsWith('.md')) continue;
        const relPath = `${dir}/${name}`;
        const { data, body } = parseNoteFile(readFileSync(join(this.vaultDir, relPath), 'utf8'));
        notes.push({
          id: idFromRelPath(relPath),
          path: relPath,
          title: data.title,
          body,
          tags: data.tags,
          source: data.source,
          created: data.created,
          updated: data.updated
        });
      }
    }
    const chunkLists = notes.map((n) => chunkText(embeddingText(n.title, n.body)));
    const vectors = await this.embedder.embed(chunkLists.flat());
    const tx = this.db.transaction(() => {
      this.db.exec('DELETE FROM chunks_fts; DELETE FROM chunks; DELETE FROM notes;');
      let cursor = 0;
      for (let i = 0; i < notes.length; i++) {
        const chunks = chunkLists[i]!;
        this.insertNoteWithChunks(notes[i]!, chunks, vectors.slice(cursor, cursor + chunks.length));
        cursor += chunks.length;
      }
    });
    tx.immediate();
    return { notes: notes.length };
  }

  /* ------------------------------------- search ------------------------------------ */

  /**
   * Hybrid search: FTS5 keyword match ∪ brute-force cosine over chunk vectors. Each leg is
   * normalized to [0, 1] (semantic: clamped cosine; keyword: bm25 min-max over the matched
   * set, floored at 0.25 so any keyword match contributes), then combined as
   * `score = min(1, semantic + KEYWORD_BONUS * keyword)` — the semantic cosine is the base
   * and keyword matches add a bounded boost, so `minScore` stays interpretable in cosine
   * terms while keyword-only hits (rare terms the embedder misses) still surface. Chunks map
   * back to their note (best chunk wins); snippets come from the FTS match when available,
   * else the best chunk's head.
   */
  async search(query: string, opts?: { k?: number; minScore?: number }): Promise<SearchHit[]> {
    const k = opts?.k ?? 8;
    const minScore = opts?.minScore ?? 0;
    const q = query.trim();
    if (!q) return [];
    const qvec = (await this.embedder.embed([q]))[0]!;

    interface Cand {
      noteId: string;
      sem: number;
      kw: number;
      text: string;
      kwSnippet?: string;
    }
    const byChunk = new Map<number, Cand>();

    // Semantic leg: brute-force cosine over every chunk vector (instant at personal scale).
    const chunkRows = this.db
      .prepare('SELECT id, note_id, text, vector FROM chunks')
      .all() as { id: number; note_id: string; text: string; vector: Buffer }[];
    for (const row of chunkRows) {
      const sem = Math.max(0, cosine(qvec, blobToVec(row.vector)));
      if (sem > 0) byChunk.set(row.id, { noteId: row.note_id, sem, kw: 0, text: row.text });
    }

    // Keyword leg: FTS5 with bm25 rank + snippet.
    const fq = ftsQuery(q);
    if (fq) {
      const kwRows = this.db
        .prepare(
          `SELECT chunk_id AS id, bm25(chunks_fts) AS rank,
                  snippet(chunks_fts, 0, '', '', '…', 16) AS snip
           FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT 64`
        )
        .all(fq) as { id: number; rank: number; snip: string }[];
      if (kwRows.length > 0) {
        const goods = kwRows.map((r) => -r.rank);
        const min = Math.min(...goods);
        const max = Math.max(...goods);
        for (let i = 0; i < kwRows.length; i++) {
          const row = kwRows[i]!;
          const kw = max === min ? 1 : 0.25 + (0.75 * (goods[i]! - min)) / (max - min);
          const existing = byChunk.get(row.id);
          if (existing) {
            existing.kw = kw;
            existing.kwSnippet = row.snip;
          } else {
            const chunk = this.db
              .prepare('SELECT note_id, text FROM chunks WHERE id = ?')
              .get(row.id) as { note_id: string; text: string } | undefined;
            if (chunk) {
              byChunk.set(row.id, {
                noteId: chunk.note_id,
                sem: 0,
                kw,
                text: chunk.text,
                kwSnippet: row.snip
              });
            }
          }
        }
      }
    }

    // Merge chunks → notes: best-scoring chunk represents the note.
    const byNote = new Map<string, { score: number; snippet: string }>();
    for (const cand of byChunk.values()) {
      const score = Math.min(1, cand.sem + KEYWORD_BONUS * cand.kw);
      const snippet =
        cand.kwSnippet && cand.kwSnippet.length > 0
          ? cand.kwSnippet
          : cand.text.length > SNIPPET_CHARS
            ? `${cand.text.slice(0, SNIPPET_CHARS)}…`
            : cand.text;
      const prev = byNote.get(cand.noteId);
      if (!prev || score > prev.score) byNote.set(cand.noteId, { score, snippet });
    }

    const hits: SearchHit[] = [];
    for (const [noteId, { score, snippet }] of byNote) {
      if (score < minScore) continue;
      const row = this.db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId) as
        | NoteRow
        | undefined;
      if (row) hits.push({ note: rowToNote(row), snippet, score });
    }
    hits.sort(
      (a, b) =>
        b.score - a.score ||
        b.note.updated.localeCompare(a.note.updated) ||
        a.note.id.localeCompare(b.note.id)
    );
    return hits.slice(0, k);
  }

  /* -------------------------------------- add -------------------------------------- */

  /**
   * Dedup-aware add. Embeds the candidate; if the nearest indexed chunk's cosine is at or
   * above the dedup threshold, appends to / refreshes that note instead of creating a
   * duplicate. Otherwise writes a new file — `notes/` for manual/voice, `captured/` (one
   * file per item, A8) for auto — and indexes it.
   */
  async add(note: Omit<Note, 'id' | 'created' | 'updated' | 'path'>): Promise<Note> {
    const chunks = chunkText(embeddingText(note.title, note.body));
    const vectors = await this.embedder.embed(chunks);
    const nearest = this.nearestChunk(normalizedMean(vectors));
    if (nearest && nearest.score >= this.dedupThreshold) {
      return this.mergeIntoExisting(nearest.noteId, note);
    }
    return this.createNote(note.source === 'auto' ? 'captured' : 'notes', note);
  }

  /** Append text to an existing note's body (with a blank-line separator). */
  async append(id: string, text: string): Promise<Note> {
    const note = await this.read(id);
    if (!note) throw new Error(`note not found: ${id}`);
    note.body = note.body ? `${note.body}\n\n${normalizeBody(text)}` : normalizeBody(text);
    note.updated = this.now();
    await this.persist(note);
    return note;
  }

  async read(id: string): Promise<Note | null> {
    const row = this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as
      | NoteRow
      | undefined;
    return row ? rowToNote(row) : null;
  }

  async recent(limit: number): Promise<Note[]> {
    const rows = this.db
      .prepare('SELECT * FROM notes ORDER BY updated DESC, id LIMIT ?')
      .all(Math.max(0, limit)) as NoteRow[];
    return rows.map(rowToNote);
  }

  async remove(id: string): Promise<void> {
    const row = this.db.prepare('SELECT path FROM notes WHERE id = ?').get(id) as
      | { path: string }
      | undefined;
    if (!row) return;
    rmSync(join(this.vaultDir, row.path), { force: true });
    const tx = this.db.transaction(() => {
      this.deleteFromIndex(id);
    });
    tx.immediate();
  }

  /** Contents of profile.md (empty string if absent). */
  async profile(): Promise<string> {
    const p = join(this.vaultDir, 'profile.md');
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
  }

  /* ---------------------------------- consolidate ---------------------------------- */

  /**
   * Groups near-duplicate captured notes (cosine ≥ dedupThreshold on note vectors), hands
   * each group to `distill`, and applies its decision: merge → one captured note; promote →
   * one durable note under `memory/`; prune → delete; keep → untouched. A profile update
   * returned by the distiller replaces profile.md, clamped to the profile token budget.
   */
  async consolidate(distill: DistillFn): Promise<ConsolidationReport> {
    const report: ConsolidationReport = { merged: 0, promoted: 0, pruned: 0 };
    const rows = this.db
      .prepare("SELECT * FROM notes WHERE path LIKE 'captured/%' ORDER BY created, id")
      .all() as NoteRow[];
    const captured = rows.map(rowToNote);
    const groups = this.groupNearDuplicates(captured);
    const profile = await this.profile();
    let profileUpdate: string | null = null;

    for (const group of groups) {
      const decision = await distill({ notes: group, profile });
      if (decision.profile !== undefined) profileUpdate = decision.profile;
      switch (decision.action) {
        case 'keep':
          break;
        case 'prune':
          for (const n of group) await this.remove(n.id);
          report.pruned += group.length;
          break;
        case 'merge':
        case 'promote': {
          const replacement = buildReplacement(group, decision);
          for (const n of group) await this.remove(n.id);
          await this.createNote(
            decision.action === 'merge' ? 'captured' : 'memory',
            replacement,
            replacement.created
          );
          if (decision.action === 'merge') report.merged += 1;
          else report.promoted += 1;
          break;
        }
      }
    }

    if (profileUpdate !== null) {
      this.writeFileAtomic(join(this.vaultDir, 'profile.md'), this.clampProfile(profileUpdate));
    }
    return report;
  }

  /* ----------------------------------- internals ----------------------------------- */

  private now(): string {
    let t = Date.now();
    if (t <= this.lastTsMs) t = this.lastTsMs + 1;
    this.lastTsMs = t;
    return new Date(t).toISOString();
  }

  private freshId(): string {
    for (;;) {
      const id = randomBytes(4).toString('hex');
      const clash = this.db.prepare('SELECT 1 FROM notes WHERE id = ?').get(id);
      if (!clash) return id;
    }
  }

  private nearestChunk(vec: Float32Array): { noteId: string; score: number } | null {
    if (vec.length === 0) return null;
    const rows = this.db.prepare('SELECT note_id, vector FROM chunks').all() as {
      note_id: string;
      vector: Buffer;
    }[];
    let best: { noteId: string; score: number } | null = null;
    for (const row of rows) {
      const score = cosine(vec, blobToVec(row.vector));
      if (!best || score > best.score) best = { noteId: row.note_id, score };
    }
    return best;
  }

  private async mergeIntoExisting(
    noteId: string,
    incoming: Omit<Note, 'id' | 'created' | 'updated' | 'path'>
  ): Promise<Note> {
    const note = await this.read(noteId);
    if (!note) throw new Error(`dedup target vanished: ${noteId}`);
    const body = normalizeBody(incoming.body);
    if (body && !note.body.includes(body)) {
      note.body = note.body ? `${note.body}\n\n${body}` : body;
    }
    note.tags = [...new Set([...note.tags, ...incoming.tags])];
    note.updated = this.now();
    await this.persist(note);
    return note;
  }

  /** Create a brand-new note file in `dir` and index it (no dedup — callers decide). */
  private async createNote(
    dir: 'notes' | 'captured' | 'memory',
    input: Omit<Note, 'id' | 'created' | 'updated' | 'path'>,
    created?: string
  ): Promise<Note> {
    const now = this.now();
    const id = this.freshId();
    const createdAt = created ?? now;
    const slug = slugify(input.title);
    const name =
      dir === 'captured' ? `${createdAt.slice(0, 10)}-${slug}-${id}.md` : `${slug}-${id}.md`;
    const note: Note = {
      id,
      path: `${dir}/${name}`,
      title: input.title,
      body: normalizeBody(input.body),
      tags: input.tags,
      source: input.source,
      created: createdAt,
      updated: now
    };
    await this.persist(note);
    return note;
  }

  /** Write the note's file atomically, then (re)index it in an immediate transaction. */
  private async persist(note: Note): Promise<void> {
    const chunks = chunkText(embeddingText(note.title, note.body));
    const vectors = await this.embedder.embed(chunks);
    this.writeFileAtomic(
      join(this.vaultDir, note.path),
      serializeNoteFile(
        {
          title: note.title,
          created: note.created,
          updated: note.updated,
          tags: note.tags,
          source: note.source
        },
        note.body
      )
    );
    const tx = this.db.transaction(() => {
      this.deleteFromIndex(note.id);
      this.insertNoteWithChunks(note, chunks, vectors);
    });
    tx.immediate();
  }

  /** Must run inside a transaction. */
  private insertNoteWithChunks(note: Note, chunks: string[], vectors: Float32Array[]): void {
    this.db
      .prepare(
        `INSERT INTO notes (id, path, title, body, tags, source, created, updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        note.id,
        note.path,
        note.title,
        note.body,
        JSON.stringify(note.tags),
        note.source,
        note.created,
        note.updated
      );
    const insChunk = this.db.prepare(
      'INSERT INTO chunks (note_id, seq, text, vector) VALUES (?, ?, ?, ?)'
    );
    const insFts = this.db.prepare('INSERT INTO chunks_fts (text, chunk_id) VALUES (?, ?)');
    for (let i = 0; i < chunks.length; i++) {
      const { lastInsertRowid } = insChunk.run(note.id, i, chunks[i]!, vecToBlob(vectors[i]!));
      insFts.run(chunks[i]!, Number(lastInsertRowid));
    }
  }

  /** Must run inside a transaction. */
  private deleteFromIndex(noteId: string): void {
    this.db
      .prepare('DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE note_id = ?)')
      .run(noteId);
    this.db.prepare('DELETE FROM chunks WHERE note_id = ?').run(noteId);
    this.db.prepare('DELETE FROM notes WHERE id = ?').run(noteId);
  }

  private writeFileAtomic(absPath: string, content: string): void {
    mkdirSync(dirname(absPath), { recursive: true });
    const tmp = `${absPath}.tmp-${randomBytes(4).toString('hex')}`;
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, absPath);
  }

  private groupNearDuplicates(notes: Note[]): Note[][] {
    // Note vector = normalized mean of its chunk vectors (from the index).
    const vecs = new Map<string, Float32Array>();
    for (const note of notes) {
      const rows = this.db
        .prepare('SELECT vector FROM chunks WHERE note_id = ? ORDER BY seq')
        .all(note.id) as { vector: Buffer }[];
      vecs.set(note.id, normalizedMean(rows.map((r) => blobToVec(r.vector))));
    }
    // Union-find over pairs with cosine ≥ dedupThreshold.
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let root = x;
      while (parent.get(root) !== root) root = parent.get(root)!;
      parent.set(x, root);
      return root;
    };
    for (const n of notes) parent.set(n.id, n.id);
    for (let i = 0; i < notes.length; i++) {
      for (let j = i + 1; j < notes.length; j++) {
        const a = vecs.get(notes[i]!.id)!;
        const b = vecs.get(notes[j]!.id)!;
        if (cosine(a, b) >= this.dedupThreshold) {
          parent.set(find(notes[i]!.id), find(notes[j]!.id));
        }
      }
    }
    const groups = new Map<string, Note[]>();
    for (const n of notes) {
      const root = find(n.id);
      const list = groups.get(root);
      if (list) list.push(n);
      else groups.set(root, [n]);
    }
    return [...groups.values()];
  }

  private clampProfile(text: string): string {
    const budgetChars = this.profileTokenBudget * CHARS_PER_TOKEN;
    if (text.length <= budgetChars) return text;
    const cut = text.slice(0, budgetChars);
    const lastSpace = cut.lastIndexOf(' ');
    return (lastSpace > budgetChars / 2 ? cut.slice(0, lastSpace) : cut).replace(/\s+$/, '');
  }
}

/** Stable note id: the trailing `-<8 hex>` of the filename, else a hash of the vault path. */
function idFromRelPath(relPath: string): string {
  const m = /-([0-9a-f]{8})\.md$/.exec(relPath);
  if (m) return m[1]!;
  return createHash('sha1').update(relPath).digest('hex').slice(0, 8);
}

function buildReplacement(
  group: Note[],
  decision: DistillDecision
): Omit<Note, 'id' | 'updated' | 'path'> {
  const first = group[0]!;
  return {
    title: decision.title ?? first.title,
    body: decision.body ?? group.map((n) => n.body).filter(Boolean).join('\n\n'),
    tags: decision.tags ?? [...new Set(group.flatMap((n) => n.tags))],
    source: 'auto',
    created: group.reduce((min, n) => (n.created < min ? n.created : min), first.created)
  };
}
