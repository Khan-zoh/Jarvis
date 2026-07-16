import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BackendId, SessionSummary, TurnRecord } from '../shared/types';

/** `list()` never returns more than this many sessions (most recent first). */
const MAX_LISTED = 100;
/** Session title = first user utterance truncated to this many characters. */
const TITLE_MAX = 48;

/**
 * On-disk shape of one session: `<dir>/<id>.json`. A session groups turns; each backend keeps
 * its own native thread id per session (switching backends mid-session starts a fresh native
 * thread but keeps UI history together).
 */
interface SessionFile {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Backend of the most recent turn (defaults to 'claude' until a turn lands). */
  backend: BackendId;
  /** Monotonic most-recently-used counter — persisted so ordering survives restarts. */
  seq: number;
  backendSessionIds: Partial<Record<BackendId, string>>;
  turns: TurnRecord[];
}

/**
 * Stores sessions as individual JSON files in a directory (usually `userData/sessions`).
 * Plain Node (no Electron imports) so it is unit-testable against a temp dir.
 */
export class SessionStore {
  private readonly dir: string;
  private readonly byId = new Map<string, SessionFile>();
  private nextSeq = 1;
  private activeId: string | null = null;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(dir, name), 'utf-8')) as SessionFile;
        if (parsed && typeof parsed.id === 'string') {
          this.byId.set(parsed.id, parsed);
        }
      } catch {
        // Corrupt session file: skip it rather than crash the store.
      }
    }
    for (const s of this.byId.values()) {
      if (typeof s.seq === 'number' && s.seq >= this.nextSeq) this.nextSeq = s.seq + 1;
    }
    this.activeId = this.sorted()[0]?.id ?? null;
  }

  /** The current session; creates one if none exists yet. */
  activeSession(): SessionSummary {
    if (this.activeId) {
      const s = this.byId.get(this.activeId);
      if (s) return toSummary(s);
    }
    return this.newSession();
  }

  /** Creates a fresh session and makes it active. */
  newSession(): SessionSummary {
    const now = new Date().toISOString();
    const s: SessionFile = {
      id: randomUUID(),
      title: '',
      createdAt: now,
      updatedAt: now,
      backend: 'claude',
      seq: this.nextSeq++,
      backendSessionIds: {},
      turns: []
    };
    this.byId.set(s.id, s);
    this.activeId = s.id;
    this.persist(s);
    return toSummary(s);
  }

  /** All sessions, most recent first, capped at 100. */
  list(): SessionSummary[] {
    return this.sorted()
      .slice(0, MAX_LISTED)
      .map(toSummary);
  }

  turns(id: string): TurnRecord[] {
    return structuredClone(this.must(id).turns);
  }

  appendTurn(id: string, t: TurnRecord): void {
    const s = this.must(id);
    if (s.turns.length === 0) {
      s.title = t.userText.slice(0, TITLE_MAX);
    }
    s.turns.push(structuredClone(t));
    s.backend = t.backend;
    s.updatedAt = new Date().toISOString();
    s.seq = this.nextSeq++;
    this.persist(s);
  }

  /** The backend-native thread/session id previously recorded for this session, or null. */
  backendSessionId(id: string, backend: BackendId): string | null {
    return this.must(id).backendSessionIds[backend] ?? null;
  }

  setBackendSessionId(id: string, backend: BackendId, native: string): void {
    const s = this.must(id);
    s.backendSessionIds[backend] = native;
    s.updatedAt = new Date().toISOString();
    this.persist(s);
  }

  private sorted(): SessionFile[] {
    return [...this.byId.values()].sort((a, b) => b.seq - a.seq);
  }

  private must(id: string): SessionFile {
    const s = this.byId.get(id);
    if (!s) throw new Error(`Unknown session: ${id}`);
    return s;
  }

  private persist(s: SessionFile): void {
    writeFileSync(join(this.dir, `${s.id}.json`), JSON.stringify(s, null, 2), 'utf-8');
  }
}

function toSummary(s: SessionFile): SessionSummary {
  return { id: s.id, title: s.title, updatedAt: s.updatedAt, backend: s.backend };
}
