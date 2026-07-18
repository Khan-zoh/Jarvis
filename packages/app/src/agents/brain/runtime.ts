import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BrainStore } from '@jarvis/tools-mcp/brain/store';
import { OnnxEmbedder } from '@jarvis/tools-mcp/brain/embedder';
import type { ConsolidationReport } from '@jarvis/tools-mcp/brain/types';
import type { AppConfig, CapturedNote } from '../../shared/types';
import type { AgentBackend } from '../types';
import type { ContextProvider, TurnObserver } from '../seams';
import { createRecallProvider } from './recallProvider';
import { createCaptureObserver } from './captureObserver';
import { backendComplete, createConsolidationDistiller, createDistillExtractor } from './distill';

/**
 * The app-side second-brain runtime: the single shared BrainStore instance (A8 — the tools-mcp
 * brain plugin opens the SAME vault/index in its own process; safety is in the engine), plus the
 * recall ContextProvider and auto-capture TurnObserver wired into the router, and the actions the
 * IPC/settings surface drive (recent/remove/forget/reindex/consolidate).
 *
 * Auto-capture and consolidation distillation run on the CURRENT default backend via a minimal
 * one-shot completion (distill.ts backendComplete) — never through the router, so they neither
 * persist a turn nor re-trigger observers.
 */

export interface BrainRuntime {
  store: BrainStore;
  provider: ContextProvider;
  observer: TurnObserver;
  recent(limit: number): Promise<CapturedNote[]>;
  remove(id: string): Promise<void>;
  /** Removes the most recent auto-capture (for "forget that"). Returns its id, or null. */
  forgetLast(): Promise<string | null>;
  reindex(): Promise<{ notes: number }>;
  consolidate(): Promise<ConsolidationReport>;
  dispose(): void;
}

export interface BrainRuntimeDeps {
  getConfig: () => AppConfig;
  /** JARVIS_DATA_DIR — the index (index.sqlite) lives under `<dataDir>/brain`. */
  dataDir: string;
  /** Where fetch-models put the embedding model (`<modelsRoot>/embed/*`). */
  modelsRoot: string;
  /** The backend used for distillation/consolidation (the current default backend). */
  getBackend: () => AgentBackend;
  /** Emits a `brain:captured` event for the "noted:" UI. */
  onCaptured: (note: CapturedNote) => void;
}

/** Resolve + verify the embedding model files. */
function resolveEmbedPaths(modelsRoot: string): { modelPath: string; tokenizerPath: string } | null {
  const modelPath = join(modelsRoot, 'embed', 'model.onnx');
  const tokenizerPath = join(modelsRoot, 'embed', 'tokenizer.json');
  return existsSync(modelPath) && existsSync(tokenizerPath) ? { modelPath, tokenizerPath } : null;
}

/**
 * Builds the runtime, or returns `{ unavailable }` when the embedding model is not on disk yet
 * (the caller keeps the router seams empty and surfaces the reason). Constructing this does NOT
 * check `secondBrain.enabled` — the caller decides whether to build it at all — but the provider
 * and observer both re-check `enabled` live on every turn, so a config flip is honored without a
 * rebuild for the disable direction.
 */
export function createBrainRuntime(deps: BrainRuntimeDeps): BrainRuntime | { unavailable: string } {
  const paths = resolveEmbedPaths(deps.modelsRoot);
  if (!paths) {
    return {
      unavailable: 'embedding model missing — run `npm run fetch-models -- --with-brain`.'
    };
  }

  const cfg = deps.getConfig();
  const embedder = new OnnxEmbedder(paths);
  const store = new BrainStore({
    vaultDir: cfg.secondBrain.vaultDir,
    indexDir: join(deps.dataDir, 'brain'),
    embedder
  });

  const complete = (prompt: string): Promise<string> => backendComplete(deps.getBackend(), prompt);

  const provider = createRecallProvider({ store });
  const observer = createCaptureObserver({
    store,
    getConfig: deps.getConfig,
    extract: createDistillExtractor(complete),
    onCaptured: deps.onCaptured
  });

  const toDto = (n: { id: string; title: string; updated: string }): CapturedNote => ({
    id: n.id,
    title: n.title,
    at: n.updated
  });

  return {
    store,
    provider,
    observer,
    recent: async (limit) => (await store.recent(limit)).map(toDto),
    remove: (id) => store.remove(id),
    forgetLast: async () => {
      const [last] = await store.recent(1);
      if (last && last.source === 'auto') {
        await store.remove(last.id);
        return last.id;
      }
      return null;
    },
    reindex: () => store.reindex(),
    consolidate: () => store.consolidate(createConsolidationDistiller(complete)),
    dispose: () => {
      try {
        store.close();
      } catch {
        // best-effort
      }
      void embedder.dispose();
    }
  };
}
