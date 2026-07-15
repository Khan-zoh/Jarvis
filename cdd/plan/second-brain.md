# Second Brain

A personal knowledge layer that gives the assistant continuity: it captures durable knowledge
automatically, keeps a small profile of you in mind at all times, and pulls relevant notes into
context when a request calls for it. Settled design choices (from consultation): **local markdown
vault**, **auto-capture with curation guardrails**, **smart-hybrid recall**.

## Where it lives — the vault

A plain folder of markdown files, **Obsidian-compatible** (YAML frontmatter, `[[wikilinks]]`,
`#tags`). Default `D:\JarvisBrain` on this user's machine (chosen to keep the vault off the
university OneDrive that `Documents` redirects to); configurable in settings. If the user has an
Obsidian/Logseq vault they point the setting at it. The user can open, edit, and prune the same
files in Obsidian — nothing is locked away.

```
JarvisBrain/
  profile.md            # small always-injected "who the user is" (name, prefs, key ongoing context)
  notes/                # curated durable notes (promoted or user-authored)
  memory/               # consolidated facts the assistant learned about you
  captured/YYYY-MM-DD.md# append-only auto-capture staging log, one file per day
```

The search index and vectors do NOT live in the vault (they'd pollute it) — they live in
`JARVIS_DATA_DIR/brain/index.sqlite`, rebuildable from the vault at any time.

Note frontmatter: `title, created, updated, tags[], source: voice|auto|manual, confidence?`.

## Engine — BrainStore

One module (`packages/tools-mcp/src/brain/store.ts`) owns the vault + index + embeddings and is
the single source of truth. It is a shared library used by BOTH processes:
- the **app** (for auto-capture, recall context injection, consolidation),
- the **tools-mcp brain plugin** (for the model's on-demand `brain_*` tools).

Concurrency: SQLite in **WAL mode** with a busy-timeout. The app process owns writes
(capture/consolidation); the MCP plugin does reads + its own query embeddings. Cross-process
reads under WAL are safe; the rare concurrent write serializes. Volume is personal-scale
(thousands of notes), so this is comfortable.

```ts
export interface Note { id: string; path: string; title: string; body: string; tags: string[];
  source: 'voice'|'auto'|'manual'; created: string; updated: string }
export interface SearchHit { note: Note; snippet: string; score: number }

export class BrainStore {
  constructor(cfg: { vaultDir: string; indexDir: string; embedder: Embedder });
  reindex(): Promise<{ notes: number }>;                 // rebuild index from vault
  search(query: string, opts?: { k?: number; minScore?: number }): Promise<SearchHit[]>;  // hybrid
  add(note: Omit<Note,'id'|'created'|'updated'|'path'>): Promise<Note>;                    // dedup-aware
  append(id: string, text: string): Promise<Note>;
  read(id: string): Promise<Note | null>;
  recent(limit: number): Promise<Note[]>;
  remove(id: string): Promise<void>;
  profile(): Promise<string>;                            // contents of profile.md
  consolidate(distill: DistillFn): Promise<ConsolidationReport>;   // merge/promote/prune
}
```

- **Hybrid search** = FTS5 keyword match ∪ semantic (cosine over stored vectors) — brute-force
  cosine in JS is instant at this scale, so **no native vector extension** (avoids a fragile
  Windows build dependency). Results merged and re-ranked; `minScore` gate keeps junk out.
- **Dedup on add**: embed the candidate, compare cosine to nearest existing note; if
  ≥ 0.92 similarity, `append`/refresh instead of creating a duplicate.
- Notes are chunked to ~512-token passages for embedding; a hit maps back to its note.

### Embedder
```ts
export interface Embedder { embed(texts: string[]): Promise<Float32Array[]>; readonly dim: number }
```
Production: a small ONNX sentence-embedding model (`bge-small-en-v1.5`, 384-dim, ~90MB) run via
`onnxruntime-node` — **already in the stack** for the voice VAD, so $0 and no new runtime. Added
to `fetch-models`. Fake embedder (hash-based deterministic vectors) for tests.

## Capture (auto, curated)

A **TurnObserver** (new generic agent-layer seam, see agent-backends.md) runs after every
completed turn:
1. Runs a cheap **extraction** pass via the current backend with a tight prompt: "from this
   exchange, list only durable facts worth remembering long-term (preferences, facts about
   people/projects, decisions, commitments). Return nothing if it's transient." (`DistillFn`.)
2. Each returned item → `BrainStore.add({ source:'auto', ... })` into today's `captured/` file,
   dedup-aware.
3. Emits a `brain:captured` event → UI shows "noted: <one line>" with an undo affordance. Never
   spoken aloud (that would be grating).

Guardrails against noise/creepiness:
- Auto-captured items are tagged `source: auto` and staged in `captured/`, never written straight
  into curated `notes/`.
- **Consolidation** (`brain_consolidate` tool + a scheduled/there's-a-lot trigger + manual
  "clean up my brain"): merges duplicates, promotes items that recur or are referenced into
  `memory/` and `profile.md`, prunes stale/low-value captures. Mirrors the app's own memory
  hygiene philosophy.
- **Off the record**: "don't remember this" / "off the record" sets a per-turn no-capture flag;
  a global "pause capture" toggle in settings.
- A **Recently captured** list in the main window with one-click delete.

## Recall (smart hybrid)

Two always-on mechanisms plus one on-demand:
1. **Profile injection (baseline "it knows me")**: `profile.md` (kept small — target ≤ ~500
   tokens, maintained by consolidation) is prepended to the system prompt every turn.
2. **Per-turn semantic retrieval**: a **ContextProvider** (new agent-layer seam) embeds the
   user's utterance and injects the top 3–5 note snippets **above a similarity threshold** as a
   "relevant notes from your second brain" preamble. Below threshold → nothing injected, so
   unrelated requests stay fast and clean.
3. **On-demand tool**: the model can still call `brain_search` to dig deeper mid-turn.

## Delivery split

| Piece | Lives in | Why |
|---|---|---|
| BrainStore, Embedder | `tools-mcp/src/brain/` (shared lib) | single source of truth, used by both processes |
| `brain_*` tools | brain plugin (`tools-mcp/src/plugins/brain/`) | model-facing on-demand access; fits plugin architecture |
| Auto-capture observer, recall provider, capture UI | app (`src/agents/` + renderer) | needs the live turn stream + system-prompt assembly + UI |

## brain plugin tools (catalog)

| name | input | behavior |
|---|---|---|
| `brain_search` | `{ query: string; max?: number }` | hybrid search; returns titles + snippets |
| `brain_add_note` | `{ title: string; body: string; tags?: string[] }` | curated note (`source: manual`) into `notes/` |
| `brain_append` | `{ query: string; text: string }` | find the best-matching note and append (else create) |
| `brain_read` | `{ query: string }` | full body of the best-matching note |
| `brain_recent` | `{ max?: number }` | recently added/updated notes |
| `brain_consolidate` | `{}` | run consolidation; returns a short report |

Plugin `settings`: `vaultDir` (text, default `D:\JarvisBrain`), `autoCapture` (toggle),
`recallMode` (text: hybrid|on-demand|proactive), `captureThreshold`/`recallThreshold` (advanced).

## Testing
- BrainStore with fake embedder + temp vault: add/search/dedup/append/remove round-trips;
  hybrid ranking (keyword-only hit, semantic-only hit, both); reindex reconstructs from files;
  consolidation with a fake DistillFn merges/promotes/prunes as scripted.
- ContextProvider: injects only above threshold; profile always included; token budget respected.
- TurnObserver: extraction result → staged capture + event; off-the-record suppresses; dedup.
- brain plugin: each tool with a fake BrainStore; MCP wire test lists the brain tools.
- Live: real ONNX embedder loads, embeds, and semantic search returns sane neighbors on a small
  seeded vault.
