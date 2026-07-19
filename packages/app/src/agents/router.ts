import { randomUUID } from 'node:crypto';
import type { AgentEvent, AppConfig, BackendId, TurnRecord } from '../shared/types';
import type { AgentBackend, TurnHandle } from './types';
import type { ContextProvider, TurnObserver } from './seams';
import { SessionStore } from './sessions';

export interface RouteDecision {
  backend: BackendId;
  cleanedInput: string;
}

/** Spoken refusal when a turn is already in flight. */
const BUSY_REFUSAL = 'One moment, still working.';

/** Default per-provider budget for ContextProvider.contribute before it is dropped. */
const DEFAULT_PROVIDER_TIMEOUT_MS = 1500;

/** Backend-switch context note: how many recent turns to summarize, and the per-text cap. */
const SWITCH_NOTE_TURNS = 3;
const SWITCH_NOTE_CHARS = 160;

/**
 * One-line context note injected when a backend starts a FRESH native thread inside a session
 * that already has history (i.e. the first turn after a mid-session backend switch —
 * cdd/plan/amendments.md non-blocking list). Kept cheap: the last 3 turns' user/assistant text,
 * each capped at 160 chars. Exported for tests.
 */
export function buildSwitchNote(turns: TurnRecord[]): string {
  const cap = (s: string): string =>
    s.length > SWITCH_NOTE_CHARS ? `${s.slice(0, SWITCH_NOTE_CHARS - 1)}…` : s;
  const lines = turns
    .slice(-SWITCH_NOTE_TURNS)
    .map((t) => `user: "${cap(t.userText)}" / you: "${cap(t.assistantText)}"`);
  return `(Note: you are taking over an ongoing conversation mid-session. Recent turns — ${lines.join(' | ')})`;
}

/**
 * Leading-directive matcher. Matches only at the start of the utterance (mid-sentence mentions
 * are NOT routed):
 *   "ask codex …" / "use codex …" / "codex, …"  → codex   (same for claude)
 */
const DIRECTIVE_RE = /^\s*(?:(?:ask|use)\s+(claude|codex)\b|(claude|codex)\s*,)/i;

/**
 * Decides which backend handles an utterance. First match wins:
 * 1. Leading directive ("ask codex …" / "use codex …" / "codex, …", case-insensitive) → that
 *    backend, with the directive stripped — plus any following comma/whitespace and a leading
 *    "to " connective ("ask codex to refactor this" → "refactor this").
 * 2. Otherwise `cfg.agents.defaultBackend` with the input untouched (trimmed).
 */
export function routeUtterance(text: string, cfg: AppConfig): RouteDecision {
  const m = DIRECTIVE_RE.exec(text);
  if (m) {
    const name = m[1] ?? m[2];
    if (name) {
      const backend = name.toLowerCase() as BackendId;
      let rest = text.slice(m[0].length);
      rest = rest.replace(/^[\s,]+/, ''); // directive's trailing comma/space
      rest = rest.replace(/^to\s+/i, ''); // "ask codex to refactor" → "refactor"
      return { backend, cleanedInput: rest.trim() };
    }
  }
  return { backend: cfg.agents.defaultBackend, cleanedInput: text.trim() };
}

export interface RouterSeams {
  providers?: ContextProvider[];
  observers?: TurnObserver[];
  /** Per-provider contribute() budget in ms; defaults to 1500. Exposed mainly for tests. */
  providerTimeoutMs?: number;
}

/**
 * Backend-agnostic turn orchestrator. Owns the busy guard, directive routing, context-provider
 * preamble, session persistence, and post-turn observers. Knows nothing about any concrete
 * backend or about what a provider/observer actually does.
 */
export class AgentRouter {
  private readonly backends: Record<BackendId, AgentBackend>;
  private readonly sessions: SessionStore;
  private readonly cfg: () => AppConfig;
  private readonly providers: ContextProvider[];
  private readonly observers: TurnObserver[];
  private readonly providerTimeoutMs: number;

  private inFlight = false;
  private currentHandle: TurnHandle | null = null;
  private offTheRecord = false;

  constructor(
    backends: Record<BackendId, AgentBackend>,
    sessions: SessionStore,
    cfg: () => AppConfig,
    seams?: RouterSeams
  ) {
    this.backends = backends;
    this.sessions = sessions;
    this.cfg = cfg;
    this.providers = seams?.providers ?? [];
    this.observers = seams?.observers ?? [];
    this.providerTimeoutMs = seams?.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  }

  get busy(): boolean {
    return this.inFlight;
  }

  /** "off the record" flag applied to the next turn: observers skip capture for that turn. */
  setOffTheRecord(next: boolean): void {
    this.offTheRecord = next;
  }

  /** Interrupts the in-flight turn, if any. */
  async interrupt(): Promise<void> {
    await this.currentHandle?.interrupt();
  }

  async dispatch(
    text: string,
    onEvent: (e: AgentEvent) => void,
    backendOverride?: BackendId
  ): Promise<TurnRecord> {
    const cfg = this.cfg();
    const route = routeUtterance(text, cfg);
    const backendId = backendOverride ?? route.backend;

    // Busy guard: refuse with a synthetic spoken reply; never touches a backend or the store.
    if (this.inFlight) {
      onEvent({ kind: 'text_delta', text: BUSY_REFUSAL });
      onEvent({ kind: 'done', finalText: BUSY_REFUSAL });
      return {
        id: randomUUID(),
        at: new Date().toISOString(),
        backend: backendId,
        userText: route.cleanedInput,
        assistantText: BUSY_REFUSAL,
        tools: []
      };
    }

    // Consume the off-the-record flag now: it applies to exactly this (the "next") turn.
    const offTheRecord = this.offTheRecord;
    this.offTheRecord = false;
    this.inFlight = true;

    // Pre-turn cancellation (B2): the handle is live from the very start of the dispatch, so an
    // interrupt() during init/context — before the backend turn exists — flags `cancelled` and
    // the turn never starts. Once the real handle exists, interrupt() also forwards to it.
    let cancelled = false;
    let realHandle: TurnHandle | null = null;
    this.currentHandle = {
      interrupt: async (): Promise<void> => {
        cancelled = true;
        await realHandle?.interrupt();
      }
    };
    /** Emits the canonical cancelled error event and returns a synthetic unpersisted record. */
    const cancelledRecord = (): TurnRecord => {
      onEvent({ kind: 'error', message: 'cancelled' });
      return {
        id: randomUUID(),
        at: new Date().toISOString(),
        backend: backendId,
        userText: route.cleanedInput,
        assistantText: '',
        tools: []
      };
    };

    try {
      const backend = this.backends[backendId];

      const initResult = await backend.init();
      if (cancelled) return cancelledRecord();
      if (!initResult.ok) {
        const message = initResult.problem ?? `The ${backendId} backend is not available.`;
        onEvent({ kind: 'error', message });
        return {
          id: randomUUID(),
          at: new Date().toISOString(),
          backend: backendId,
          userText: route.cleanedInput,
          assistantText: '',
          tools: []
        };
      }

      // Context providers: all in parallel, each with a short timeout so a slow provider can
      // never stall the reply. Failures and timeouts contribute nothing.
      const contributions = await Promise.all(
        this.providers.map((p) =>
          withTimeout(
            p.contribute(route.cleanedInput, cfg).catch(() => null),
            this.providerTimeoutMs
          )
        )
      );
      // Last pre-turn cancellation check: interrupt() may have landed while init resolved from
      // cache instantly but the context providers were still running. Everything from here to
      // startTurn is synchronous, so this single check covers the whole remaining pre-turn
      // phase — the backend never sees the turn, and no session is created for it.
      if (cancelled) return cancelledRecord();

      const preamble = contributions.filter((c): c is string => typeof c === 'string' && c.length > 0);
      let input =
        preamble.length > 0
          ? `Context:\n${preamble.join('\n\n')}\n\n${route.cleanedInput}`
          : route.cleanedInput;

      const session = this.sessions.activeSession();
      const nativeId = this.sessions.backendSessionId(session.id, backendId);

      // Backend switch mid-session: this backend is starting a fresh native thread while the
      // session already has history, so prepend a bounded cross-backend summary
      // (cdd/plan/amendments.md non-blocking list).
      if (nativeId === null) {
        const prior = this.sessions.turns(session.id);
        if (prior.length > 0) input = `${buildSwitchNote(prior)}\n\n${input}`;
      }

      const tools: { toolName: string; ok: boolean }[] = [];
      const updates: string[] = [];
      let streamedText = '';
      const forward = (e: AgentEvent): void => {
        if (e.kind === 'tool_end') tools.push({ toolName: e.toolName, ok: e.ok });
        if (e.kind === 'status_update') updates.push(e.text);
        if (e.kind === 'text_delta') streamedText += e.text;
        onEvent(e);
      };

      const { handle, result } = await backend.startTurn({
        input,
        sessionId: nativeId,
        onEvent: forward
      });
      realHandle = handle;
      // interrupt() raced with startTurn itself: forward it now so the just-started turn dies.
      if (cancelled) await handle.interrupt();

      let finalText: string;
      try {
        const r = await result;
        finalText = r.finalText;
        this.sessions.setBackendSessionId(session.id, backendId, r.sessionId);
      } catch {
        // Errored or cancelled turn: the backend already emitted its `error` event; keep
        // whatever text streamed before the failure.
        finalText = streamedText;
      }

      const record: TurnRecord = {
        id: randomUUID(),
        at: new Date().toISOString(),
        backend: backendId,
        userText: route.cleanedInput,
        assistantText: finalText,
        ...(updates.length > 0 ? { assistantUpdates: updates } : {}),
        tools
      };
      this.sessions.appendTurn(session.id, record);

      // Observers fire detached after persistence — never delay the spoken reply — and are
      // skipped entirely when this turn is off the record.
      if (!offTheRecord) {
        for (const observer of this.observers) {
          void Promise.resolve()
            .then(() => observer.onTurn(record, { offTheRecord }))
            .catch((err: unknown) => {
              console.error(`[router] observer ${observer.id} failed:`, err);
            });
        }
      }

      return record;
    } finally {
      this.currentHandle = null;
      this.inFlight = false;
    }
  }
}

/** Resolves with `p`'s value, or null after `ms` — never rejects; always clears its timer. */
function withTimeout(p: Promise<string | null>, ms: number): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}
