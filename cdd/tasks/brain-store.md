# Task: brain-store

## Objective
Build `BrainStore` and the ONNX `Embedder` — the shared engine that owns the markdown vault, the
SQLite index, hybrid (keyword + semantic) search, dedup-aware writes, and consolidation. This is
the single source of truth used by both the brain plugin and the app-side hooks.

## Read first
- cdd/plan/second-brain.md — vault layout, BrainStore/Embedder/Note interfaces, hybrid search,
  dedup, consolidation. Binding.

## Deliverables
- `packages/tools-mcp/src/brain/embedder.ts` — `Embedder` interface + `OnnxEmbedder`
  (onnxruntime-node, bge-small-en-v1.5, 384-dim; mean-pool + L2-normalize; tokenizer via the
  fetched tokenizer files). Model/tokenizer paths injected. Batches inputs.
- `packages/tools-mcp/src/brain/store.ts` — `BrainStore` per plan:
  - Vault IO: read/write markdown with YAML frontmatter (use `gray-matter` or hand-rolled),
    file naming `notes/<slug>-<shortid>.md`, `captured/<YYYY-MM-DD>.md` append.
  - Index: SQLite (better-sqlite3) in WAL mode, busy-timeout; tables for notes, chunks
    (chunk text + Float32 vector blob), FTS5 virtual table over chunk text. `reindex()`
    rebuilds from the vault.
  - `search`: run FTS5 keyword query AND brute-force cosine over chunk vectors; merge, re-rank
    (normalize+sum), apply `k`/`minScore`; map chunks → notes; build snippets.
  - `add`: dedup — embed candidate, nearest-neighbor cosine ≥ 0.92 → append/refresh existing
    and return it; else write note + index it.
  - `append`, `read`, `recent`, `remove`, `profile`.
  - `consolidate(distill)`: group near-duplicate captured notes, call `distill` to merge/label,
    promote recurring/high-value into `memory/` + update `profile.md` (respecting the ~500-token
    profile budget), prune the rest; return a `ConsolidationReport { merged, promoted, pruned }`.
- `packages/tools-mcp/src/brain/types.ts` — Note, SearchHit, ConsolidationReport, DistillFn.
- `test/fakes/fakeEmbedder.ts` — deterministic hash→vector embedder (no model needed).

## Tests
- With FakeEmbedder + temp vault: add→search round-trip; keyword-only hit (semantic miss) and
  semantic-only hit (keyword miss) both surface via hybrid; dedup merges a near-duplicate;
  append targets the right note; remove drops it from index; recent ordering; reindex from files
  reconstructs identical results; consolidation with a scripted DistillFn merges/promotes/prunes
  and keeps profile within budget.
- Frontmatter round-trip byte-stability for a known note.
- OnnxEmbedder integration (real model, `skipIf` not present): embeds two paraphrases → high
  cosine; unrelated sentences → low cosine; dim === 384.

## Acceptance
- `npm test` passes (fake-embedder tests always; real-model tests when `models/embed` present).
- A seeded temp vault of ~20 notes returns sane semantic neighbors for a natural-language query.
