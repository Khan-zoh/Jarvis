import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { PluginContext, ToolDef, ToolPlugin } from '../../plugin.js';
import { BrainStore } from '../../brain/store.js';
import { OnnxEmbedder, type Embedder } from '../../brain/embedder.js';
import type { DistillFn } from '../../brain/types.js';

/**
 * Brain plugin — the model-facing, on-demand `brain_*` tools over the shared BrainStore engine
 * (binding: cdd/plan/second-brain.md "brain plugin tools" catalog + cdd/plan/amendments.md A8).
 *
 * Six tools: brain_search, brain_add_note, brain_append, brain_read, brain_recent,
 * brain_consolidate. Everything runs against a BrainStore built from this plugin's settings
 * (vaultDir, thresholds) plus an OnnxEmbedder resolved from the fetched embedding model.
 *
 * DISPOSABILITY (A3): this plugin lives in the disposable tools-mcp worker. All durable state is
 * in the vault + the SQLite index under JARVIS_DATA_DIR/brain; the engine itself is multi-process
 * safe (WAL + atomic writes, A8), so the app process may be writing the same vault concurrently.
 *
 * INACTIVE when the embedding model is not on disk (the second brain is not set up yet): the six
 * tools become stubs that tell the user how to enable it — the tool surface stays stable so the
 * model can explain the setup step instead of hard-failing.
 *
 * CONSOLIDATION NOTE: this process has no model backend, so `brain_consolidate` here runs a
 * *mechanical* consolidation — it collapses near-duplicate captures (dedup groups) but never
 * rewrites profile.md or model-judges a promote/prune. The model-assisted consolidation
 * (promote into memory/, refresh profile.md) is the app-side "clean up my brain" settings action,
 * which drives BrainStore.consolidate with a backend-backed distiller.
 */

const DEFAULT_VAULT_DIR = 'D:\\JarvisBrain';
/** Minimum hybrid score for an on-demand search/append/read to treat a note as a real match. */
const SEARCH_MIN_SCORE = 0.2;
const APPEND_MIN_SCORE = 0.3;
const RECENT_DEFAULT = 5;
const SEARCH_DEFAULT_MAX = 5;
const LIST_CAP = 10;

/** Resolve the fetched embedding model dir: JARVIS_MODELS_DIR override, else <cwd>/models. */
function modelsRoot(): string {
  const env = process.env['JARVIS_MODELS_DIR'];
  return env && env.length > 0 ? env : join(process.cwd(), 'models');
}

function embedModelPaths(): { modelPath: string; tokenizerPath: string } {
  const root = modelsRoot();
  return {
    modelPath: join(root, 'embed', 'model.onnx'),
    tokenizerPath: join(root, 'embed', 'tokenizer.json')
  };
}

/** The mechanical distiller used by the plugin-side brain_consolidate (no model available):
 *  collapse near-duplicate groups (size > 1) into one captured note; leave singletons alone. */
const mechanicalDistill: DistillFn = async ({ notes }) =>
  notes.length > 1 ? { action: 'merge' } : { action: 'keep' };

function num(config: Record<string, unknown>, key: string): number | undefined {
  const v = config[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function str(config: Record<string, unknown>, key: string, fallback: string): string {
  const v = config[key];
  return typeof v === 'string' && v.trim() ? v : fallback;
}

/** Builds the six tools over a live BrainStore. Exported for unit testing with a fake store. */
export function buildBrainTools(store: BrainStore): ToolDef<any>[] {
  const search: ToolDef<{ query: string; max?: number }> = {
    name: 'brain_search',
    description:
      'Search the user\'s second brain (personal notes/memory) for anything relevant. Returns ' +
      'matching note titles with a short snippet each. Use when the user asks about something ' +
      'they may have told you before.',
    effect: 'read',
    inputSchema: z.object({
      query: z.string().min(1).describe('what to look for'),
      max: z.number().int().positive().max(LIST_CAP).optional().describe('max results (default 5)')
    }),
    handler: async ({ query, max }) => {
      const hits = await store.search(query, { k: max ?? SEARCH_DEFAULT_MAX, minScore: SEARCH_MIN_SCORE });
      if (hits.length === 0) return { text: `no notes found for "${query}"` };
      const lines = hits.slice(0, LIST_CAP).map((h) => `- ${h.note.title}: ${h.snippet}`);
      return { text: `found ${hits.length} note${hits.length === 1 ? '' : 's'}:\n${lines.join('\n')}` };
    }
  };

  const addNote: ToolDef<{ title: string; body: string; tags?: string[] }> = {
    name: 'brain_add_note',
    description:
      'Save a new durable note into the user\'s second brain (a curated note they can find later ' +
      'in Obsidian). Use for things worth keeping: preferences, facts, decisions, references.',
    effect: 'local-write',
    inputSchema: z.object({
      title: z.string().min(1).describe('short note title'),
      body: z.string().describe('the note content'),
      tags: z.array(z.string()).optional().describe('optional tags')
    }),
    handler: async ({ title, body, tags }) => {
      const note = await store.add({ title, body, tags: tags ?? [], source: 'manual' });
      return { text: `saved note "${note.title}"` };
    }
  };

  const append: ToolDef<{ query: string; text: string }> = {
    name: 'brain_append',
    description:
      'Add a line to the best-matching existing note in the second brain (found by searching for ' +
      '`query`). If nothing matches, a new note is created instead.',
    effect: 'local-write',
    inputSchema: z.object({
      query: z.string().min(1).describe('which note to add to (searched by meaning)'),
      text: z.string().min(1).describe('the text to append')
    }),
    handler: async ({ query, text }) => {
      const [best] = await store.search(query, { k: 1, minScore: APPEND_MIN_SCORE });
      if (best) {
        const note = await store.append(best.note.id, text);
        return { text: `updated "${note.title}"` };
      }
      const note = await store.add({ title: query, body: text, tags: [], source: 'manual' });
      return { text: `no matching note — created "${note.title}"` };
    }
  };

  const read: ToolDef<{ query: string }> = {
    name: 'brain_read',
    description:
      'Read back the full body of the best-matching note in the second brain (found by searching ' +
      'for `query`).',
    effect: 'read',
    inputSchema: z.object({ query: z.string().min(1).describe('which note to read (searched by meaning)') }),
    handler: async ({ query }) => {
      const [best] = await store.search(query, { k: 1, minScore: SEARCH_MIN_SCORE });
      if (!best) return { text: `no note matches "${query}"` };
      const note = await store.read(best.note.id);
      if (!note) return { text: `no note matches "${query}"` };
      const body = note.body.length > 2000 ? `${note.body.slice(0, 2000)}… (truncated)` : note.body;
      return { text: `"${note.title}"\n${body}` };
    }
  };

  const recent: ToolDef<{ max?: number }> = {
    name: 'brain_recent',
    description: 'List the most recently added or updated notes in the second brain.',
    effect: 'read',
    inputSchema: z.object({
      max: z.number().int().positive().max(LIST_CAP).optional().describe('how many (default 5)')
    }),
    handler: async ({ max }) => {
      const notes = await store.recent(max ?? RECENT_DEFAULT);
      if (notes.length === 0) return { text: 'no notes yet' };
      const lines = notes.map((n) => `- ${n.title}`);
      return { text: `recent notes:\n${lines.join('\n')}` };
    }
  };

  const consolidate: ToolDef<Record<string, never>> = {
    name: 'brain_consolidate',
    description:
      'Tidy up the second brain: collapse duplicate captured notes. Use when the user asks to ' +
      '"clean up my brain" or "organize my notes".',
    effect: 'local-write',
    inputSchema: z.object({}),
    handler: async () => {
      const report = await store.consolidate(mechanicalDistill);
      return {
        text: `cleaned up your notes — merged ${report.merged}, pruned ${report.pruned}`
      };
    }
  };

  return [search, addNote, append, read, recent, consolidate];
}

const STUB_NAMES = [
  'brain_search',
  'brain_add_note',
  'brain_append',
  'brain_read',
  'brain_recent',
  'brain_consolidate'
] as const;

const UNAVAILABLE =
  'the second brain is not set up — turn it on in settings and download the embedding model.';

function stubTools(message: string): ToolDef<any>[] {
  return STUB_NAMES.map((name) => ({
    name,
    description: `${message} (${name})`,
    effect: 'read' as const,
    inputSchema: z.object({}).passthrough(),
    handler: async () => ({ text: message, isError: true })
  }));
}

export interface BrainPluginDeps {
  /** Injectable embedder (tests pass a fake; production builds an OnnxEmbedder). */
  makeEmbedder?: (paths: { modelPath: string; tokenizerPath: string }) => Embedder;
  /** Injectable existence check for the embed model files (tests override). */
  modelPresent?: () => boolean;
  /** Injectable store factory (tests inject a fake BrainStore). */
  makeStore?: (ctx: PluginContext) => BrainStore;
}

export function createBrainPlugin(deps: BrainPluginDeps = {}): ToolPlugin {
  let store: BrainStore | null = null;
  let embedder: Embedder | null = null;

  const modelPresent =
    deps.modelPresent ??
    (() => {
      const { modelPath, tokenizerPath } = embedModelPaths();
      return existsSync(modelPath) && existsSync(tokenizerPath);
    });

  return {
    id: 'brain',
    displayName: 'Second Brain',
    settings: [
      {
        key: 'vaultDir',
        label: 'vault folder',
        kind: 'text',
        placeholder: DEFAULT_VAULT_DIR,
        help: 'where your markdown notes live (Obsidian-compatible). default D:\\JarvisBrain.'
      },
      {
        key: 'autoCapture',
        label: 'auto-capture durable facts',
        kind: 'toggle',
        help: 'after each turn, quietly note things worth remembering. you can undo any capture.'
      },
      {
        key: 'recallMode',
        label: 'recall mode (hybrid | on-demand | proactive)',
        kind: 'text',
        help: 'hybrid injects your profile plus relevant notes; on-demand only when it searches.'
      },
      {
        key: 'captureThreshold',
        label: 'dedup threshold (advanced)',
        kind: 'number',
        help: 'similarity at/above which a new capture merges into an existing note. default 0.92.'
      },
      {
        key: 'recallThreshold',
        label: 'recall threshold (advanced)',
        kind: 'number',
        help: 'minimum similarity for a note to be pulled into context. default 0.4.'
      },
      {
        key: 'reindex',
        label: 'rebuild search index',
        kind: 'action'
      },
      {
        key: 'consolidate',
        label: 'clean up my brain',
        kind: 'action'
      }
    ],
    async init(ctx) {
      if (!modelPresent()) {
        return { unavailable: UNAVAILABLE, stubTools: stubTools(UNAVAILABLE) };
      }
      try {
        if (deps.makeStore) {
          store = deps.makeStore(ctx);
        } else {
          const vaultDir = str(ctx.config, 'vaultDir', DEFAULT_VAULT_DIR);
          const indexDir = join(ctx.dataDir, 'brain');
          const paths = embedModelPaths();
          embedder = deps.makeEmbedder ? deps.makeEmbedder(paths) : new OnnxEmbedder(paths);
          store = new BrainStore({
            vaultDir,
            indexDir,
            embedder,
            dedupThreshold: num(ctx.config, 'captureThreshold')
          });
        }
        return { tools: buildBrainTools(store) };
      } catch (err) {
        const message = `second brain failed to open: ${err instanceof Error ? err.message : String(err)}`;
        ctx.logger.error(message);
        return { unavailable: message, stubTools: stubTools(UNAVAILABLE) };
      }
    },
    dispose() {
      try {
        store?.close();
      } catch {
        // best-effort — the worker may be exiting
      }
      const e = embedder;
      if (e && 'dispose' in e && typeof (e as { dispose?: unknown }).dispose === 'function') {
        void (e as { dispose(): Promise<void> }).dispose();
      }
      store = null;
      embedder = null;
    }
  };
}

const brainPlugin: ToolPlugin = createBrainPlugin();
export default brainPlugin;
