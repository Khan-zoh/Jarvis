# Gate C2 — second brain live checklist (manual, run by the user)

Gate C2 proves the wired second brain: the assistant captures durable facts automatically, recalls
them in a later turn, honors "off the record", and lets you undo captures. Run Gate C first — this
builds on the same voice/text/tool wiring.

## Prerequisites

1. `npm install && npm run build` at the repo root (the backends launch
   `packages/tools-mcp/dist/index.js`, which now includes the `brain` plugin).
2. **Embedding model fetched**: `npm run fetch-models -- --with-brain` (pulls
   `models/embed/model.onnx` + `tokenizer.json`, ~90 MB). Without it the brain stays off and the
   `brain_*` tools stub out with a setup hint.
3. **Turn the brain on**: Settings → **second brain** → toggle **enabled** on. Confirm the vault
   folder (default `D:\JarvisBrain`), leave **auto-capture** on, recall mode **hybrid**.
   Enabling takes effect on the **next app start** (the store + recall/capture seams are built once
   at startup), so **restart the app**.
4. Claude (or Codex) signed in — auto-capture and consolidation distillation run on the current
   default backend.

Verify on startup: the main-process log prints `[main] second brain enabled`. If it prints
`second brain not started: embedding model missing`, redo step 2.

## 1. Capture — "remember this"

- Say (or type): **"remember that my sister's birthday is March 3rd."**
- Expect:
  - the assistant answers normally (spoken for voice);
  - shortly after, a **`noted: sister's birthday`** row appears in the **recently captured** strip
    above the command bar (capture runs detached, so it lands a beat after the reply);
  - a new file appears in the vault under `captured/2026-…-sisters-birthday-<id>.md` — open the
    vault in Explorer/Obsidian to confirm. Frontmatter says `source: auto`.

## 2. Recall — a later turn

- In a **later** turn ask: **"when is my sister's birthday?"**
- Expect: the assistant answers **March 3rd**, pulled from the note via recall — with `hybrid`
  mode it is injected as context automatically (no visible `brain_search` tool call needed). Ask
  something unrelated ("what's 12 times 12") and note the reply is just as fast — below-threshold
  turns inject nothing.
- Cross-check on-demand recall: ask **"search my notes for my sister"** — the model calls
  `brain_search` (tool footnote `→ searching your notes…` / `✓ brain_search`).

## 3. Off the record

- Say: **"off the record — my bank PIN is 1234."**
- Expect: the assistant acknowledges with roughly *"okay — off the record. I won't save that to
  your second brain, but it stays in this conversation."* **No** `noted:` row appears and **no**
  file lands in `captured/`. The turn IS still in the session transcript/history (A8).
- Standalone **"off the record"** alone → just the acknowledgment, no backend call.
- **"forget that"** right after a capture → the most recent captured row disappears (and its file
  is removed) plus the acknowledgment.

## 4. Undo a capture

- Trigger a capture (step 1), then click the **×** on its `noted:` row.
- Expect: the row disappears and the vault file is deleted (`brain:remove`).

## 5. Pause capture

- Settings → **second brain** → turn **auto-capture** off (this is live — no restart).
- Have a turn with a clearly durable fact ("remember I prefer window seats"). Expect **no**
  `noted:` row. Turn it back on and confirm capture resumes.

## 6. Consolidate — "clean up my brain"

- After several captures (some near-duplicates), either say **"clean up my brain"** (the model
  calls `brain_consolidate` — a mechanical merge of duplicates) or click Settings → **second
  brain** → **clean up my brain** (the app-side, model-assisted pass that can also **promote**
  durable facts into `memory/` and refresh `profile.md`).
- Expect: duplicate `captured/` files collapse; promoted facts appear under `memory/`; if the
  distiller updated the profile, `profile.md` reflects it (and profile content shows up in recall
  preambles on later turns). Use **rebuild search index** if you edited vault files by hand in
  Obsidian and want the index re-synced.

## 7. Obsidian round-trip

- Open the vault folder in Obsidian: notes render with YAML frontmatter and are freely editable.
  The SQLite index lives under `userData/brain/index.sqlite` (NOT in the vault) and is rebuildable
  via **rebuild search index**.

## Notes / known scope

- **Restart to enable/disable**: the `enabled` master toggle and `vaultDir` are read once at
  startup for the app-side store + seams. `auto-capture` and `recall mode` are re-read live each
  turn.
- **Two processes, one vault (A8)**: the app writes captures/recall; the tools-mcp `brain_*` tools
  open the same vault/index in the disposable worker. Safety is in the engine (SQLite WAL +
  busy-timeout + atomic file writes), so concurrent access is safe.
- The `noted:` toast currently surfaces in the **main window** recently-captured strip; a
  dedicated overlay toast is a follow-up.
