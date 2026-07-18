import {
  isDefaultConfig,
  type AgentEvent,
  type AppConfig,
  type BackendId,
  type SessionSummary,
  type TurnRecord
} from '../../shared/types';
import type { JarvisApi, Unsubscribe } from '../shared/api';
import { buildSettingsPane, type SettingsPane } from './settings';

/** "3m ago" style relative time, lowercase and terse per the copy voice. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  const mins = Math.round((now.getTime() - then) / 60_000);
  if (!Number.isFinite(mins) || mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

/**
 * The transcript reducer: TurnRecord[] → editorial DOM. No chat bubbles — the user
 * line is bold body text with a `you —` prefix, the assistant reply a serif paragraph
 * beneath, tool calls small mono footnote lines (cdd/plan/ui-design.md).
 */
export function renderTranscript(turns: TurnRecord[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const turn of turns) {
    const article = document.createElement('article');
    article.className = 'turn';
    article.dataset['turnId'] = turn.id;

    const user = document.createElement('p');
    user.className = 'turn-user';
    const prefix = document.createElement('span');
    prefix.className = 'turn-prefix';
    prefix.textContent = 'you — ';
    user.append(prefix, document.createTextNode(turn.userText));

    const assistant = document.createElement('p');
    assistant.className = 'turn-assistant';
    assistant.textContent = turn.assistantText;

    article.append(user, assistant);
    for (const tool of turn.tools) {
      const line = document.createElement('p');
      line.className = 'turn-tool';
      line.textContent = `${tool.ok ? '✓' : '✕'} ${tool.toolName}`;
      article.appendChild(line);
    }
    frag.appendChild(article);
  }
  return frag;
}

/**
 * The main window: custom titlebar, session list + editorial transcript + command bar
 * on the left, settings pane on the right (toggled). Renders from the JarvisApi it is
 * handed — live in production, the fake api under ?demo=1 and in tests.
 */
export class MainView {
  private backend: BackendId = 'claude';
  private activeSession: string | null = null;
  private settingsShown = false;
  private settingsPane: SettingsPane;

  /** In-flight turn rendered live during streaming; replaced by the persisted TurnRecord on
   * session:updated. */
  private liveTurn: {
    el: HTMLElement;
    assistant: HTMLParagraphElement;
    text: string;
    lastTool: HTMLParagraphElement | null;
  } | null = null;

  private readonly agentName: HTMLSpanElement;
  private readonly settingsBtn: HTMLButtonElement;
  private readonly setupNotice: HTMLParagraphElement;
  private readonly sessionList: HTMLUListElement;
  private readonly transcript: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private readonly backendClaude: HTMLSpanElement;
  private readonly backendCodex: HTMLSpanElement;
  private readonly unsubs: Unsubscribe[] = [];
  private readonly onKeydown = (e: KeyboardEvent): void => {
    // Esc cancels the in-flight turn (pipeline:cancel → router.interrupt + pipeline.cancel).
    if (e.key === 'Escape') void this.api.cancel();
  };

  constructor(
    root: HTMLElement,
    private readonly api: JarvisApi
  ) {
    const app = document.createElement('div');
    app.className = 'app';

    /* ---- titlebar ---- */
    const titlebar = document.createElement('header');
    titlebar.className = 'titlebar';
    this.agentName = document.createElement('span');
    this.agentName.className = 'agent-name';
    this.agentName.textContent = 'jarvis';

    const actions = document.createElement('div');
    actions.className = 'titlebar-actions';
    this.settingsBtn = document.createElement('button');
    this.settingsBtn.type = 'button';
    this.settingsBtn.className = 'btn-settings';
    this.settingsBtn.textContent = 'settings';
    this.settingsBtn.addEventListener('click', () => {
      this.showSettings(!this.settingsShown);
    });
    const minBtn = document.createElement('button');
    minBtn.type = 'button';
    minBtn.className = 'btn-min';
    minBtn.textContent = '–';
    minBtn.title = 'minimize';
    minBtn.addEventListener('click', () => {
      void api.minimize();
    });
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn-close';
    closeBtn.textContent = '×';
    closeBtn.title = 'close';
    closeBtn.addEventListener('click', () => {
      window.close(); // main process decides hide-vs-quit
    });
    actions.append(this.settingsBtn, minBtn, closeBtn);
    titlebar.append(this.agentName, actions);

    /* ---- history pane ---- */
    const history = document.createElement('section');
    history.className = 'history';

    const sessions = document.createElement('nav');
    sessions.className = 'sessions';
    this.sessionList = document.createElement('ul');
    sessions.appendChild(this.sessionList);

    // Durable setup notice (voice disabled → text-only mode). NOT the 3s transient error path:
    // it stays until the underlying cause is fixed (cdd/plan/amendments.md, error-policy nuance).
    this.setupNotice = document.createElement('p');
    this.setupNotice.className = 'setup-notice';
    this.setupNotice.hidden = true;

    this.transcript = document.createElement('div');
    this.transcript.className = 'transcript';

    const bar = document.createElement('form');
    bar.className = 'command-bar';
    this.input = document.createElement('input');
    this.input.className = 'command-input';
    this.input.type = 'text';
    this.input.placeholder = "type, or say 'jarvis'";
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        this.setBackend(this.backend === 'claude' ? 'codex' : 'claude');
      }
    });
    const backendSwitch = document.createElement('span');
    backendSwitch.className = 'backend-switch';
    this.backendClaude = document.createElement('span');
    this.backendClaude.textContent = 'claude';
    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = '|';
    this.backendCodex = document.createElement('span');
    this.backendCodex.textContent = 'codex';
    backendSwitch.append(this.backendClaude, sep, this.backendCodex);
    bar.append(this.input, backendSwitch);
    bar.addEventListener('submit', (e) => {
      e.preventDefault();
      this.submit();
    });

    history.append(sessions, this.setupNotice, this.transcript, bar);

    /* ---- settings pane ---- */
    this.settingsPane = buildSettingsPane(api);

    const panes = document.createElement('div');
    panes.className = 'panes';
    panes.append(history, this.settingsPane.el);

    app.append(titlebar, panes);
    root.appendChild(app);

    this.setBackend('claude');

    /* ---- data ---- */
    void api.getConfig().then((c) => {
      this.applyConfig(c);
      this.setBackend(c.agents.defaultBackend);
      // First-run (settings-ui task): factory-default config AND missing models → open straight
      // onto the setup view (settings pane + numbered checklist). Items check off live as the
      // pane's statuses come in.
      return api
        .modelsStatus()
        .then((models) => {
          if (isDefaultConfig(c) && !models.ok) {
            this.settingsPane.setSetupMode(true);
            this.showSettings(true);
          }
        })
        .catch(() => {});
    });
    void this.refreshSessions(true);
    this.refreshVoiceStatus();

    this.unsubs.push(
      api.onSessionUpdated((turn) => {
        // The persisted record replaces the live streaming rendition of the same turn.
        this.clearLiveTurn();
        this.transcript.appendChild(renderTranscript([turn]));
        this.transcript.scrollTop = this.transcript.scrollHeight;
        void this.refreshSessions(false);
      }),
      api.onConfigChanged((c) => {
        this.applyConfig(c);
        this.refreshVoiceStatus();
      }),
      // Voice path: the final transcript announces a new in-flight turn.
      api.onTranscript((e) => {
        if (e.final && e.text !== '') this.beginLiveTurn(e.text);
      }),
      api.onAgentEvent((e) => {
        this.onAgentEvent(e);
      })
    );
    document.addEventListener('keydown', this.onKeydown);
  }

  showSettings(show: boolean): void {
    this.settingsShown = show;
    this.settingsPane.el.hidden = !show;
    this.settingsBtn.dataset['active'] = String(show);
  }

  private applyConfig(c: AppConfig): void {
    this.agentName.textContent = c.agentName.toLowerCase();
    this.input.placeholder = `type, or say '${c.agentName.toLowerCase()}'`;
    this.settingsPane.applyConfig(c);
  }

  private setBackend(b: BackendId): void {
    this.backend = b;
    this.backendClaude.dataset['active'] = String(b === 'claude');
    this.backendCodex.dataset['active'] = String(b === 'codex');
  }

  private submit(): void {
    const text = this.input.value.trim();
    if (text === '') return;
    this.beginLiveTurn(text);
    void this.api.sendText(text, this.backend);
    this.input.value = '';
  }

  /* ---- live streaming turn ---- */

  /** Starts the live rendition of an in-flight turn (text bar submit or final voice transcript). */
  private beginLiveTurn(userText: string): void {
    this.clearLiveTurn();
    const el = document.createElement('article');
    el.className = 'turn turn-live';
    const user = document.createElement('p');
    user.className = 'turn-user';
    const prefix = document.createElement('span');
    prefix.className = 'turn-prefix';
    prefix.textContent = 'you — ';
    user.append(prefix, document.createTextNode(userText));
    const assistant = document.createElement('p');
    assistant.className = 'turn-assistant';
    el.append(user, assistant);
    this.transcript.appendChild(el);
    this.transcript.scrollTop = this.transcript.scrollHeight;
    this.liveTurn = { el, assistant, text: '', lastTool: null };
  }

  private clearLiveTurn(): void {
    this.liveTurn?.el.remove();
    this.liveTurn = null;
  }

  /** Accumulates text_delta into the live turn; shows tool activity as footnote lines
   * (A5 confirmation-visibility: every tool call is visible in the main window too). */
  private onAgentEvent(e: AgentEvent): void {
    const live = this.liveTurn;
    if (!live) return;
    switch (e.kind) {
      case 'text_delta':
        live.text += e.text;
        live.assistant.textContent = live.text;
        break;
      case 'done':
        live.text = e.finalText;
        live.assistant.textContent = e.finalText;
        break;
      case 'error':
        live.assistant.textContent = e.message;
        live.el.classList.add('turn-error');
        break;
      case 'tool_start': {
        const line = document.createElement('p');
        line.className = 'turn-tool';
        line.textContent = `→ ${e.summary}…`;
        live.el.appendChild(line);
        live.lastTool = line;
        break;
      }
      case 'tool_end':
        if (live.lastTool) {
          live.lastTool.textContent = `${e.ok ? '✓' : '✕'} ${e.toolName}`;
          live.lastTool = null;
        }
        break;
    }
    this.transcript.scrollTop = this.transcript.scrollHeight;
  }

  /** Queries voice:status and shows/hides the durable setup notice. Copy voice per
   * cdd/plan/ui-design.md ("all UI copy lowercase, terse"): "voice off — <reason>". */
  private refreshVoiceStatus(): void {
    void this.api
      .voiceStatus()
      .then((s) => {
        const show = !s.enabled && s.reason !== null && s.reason !== '';
        if (show) {
          const reason = s.reason as string;
          this.setupNotice.textContent = `voice off — ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`;
        } else {
          this.setupNotice.textContent = '';
        }
        this.setupNotice.hidden = !show;
      })
      .catch(() => {
        /* status probe failing must never break the view */
      });
  }

  private async refreshSessions(loadFirst: boolean): Promise<void> {
    const sessions = await this.api.listSessions();
    this.renderSessionList(sessions);
    const first = sessions[0];
    if (loadFirst && this.activeSession === null && first) {
      await this.openSession(first.id);
    }
  }

  private renderSessionList(sessions: SessionSummary[]): void {
    this.sessionList.textContent = '';
    for (const s of sessions) {
      const li = document.createElement('li');
      li.dataset['sessionId'] = s.id;
      li.dataset['active'] = String(s.id === this.activeSession);
      const title = document.createElement('span');
      title.className = 'session-title';
      title.textContent = s.title.toLowerCase();
      const time = document.createElement('span');
      time.className = 'session-time';
      time.textContent = relativeTime(s.updatedAt);
      li.append(title, time);
      li.addEventListener('click', () => {
        void this.openSession(s.id);
      });
      this.sessionList.appendChild(li);
    }
  }

  private async openSession(id: string): Promise<void> {
    this.activeSession = id;
    const turns = await this.api.loadSession(id);
    this.transcript.textContent = '';
    this.transcript.appendChild(renderTranscript(turns));
    this.transcript.scrollTop = this.transcript.scrollHeight;
    for (const li of Array.from(this.sessionList.children)) {
      (li as HTMLElement).dataset['active'] = String(
        (li as HTMLElement).dataset['sessionId'] === id
      );
    }
  }

  dispose(): void {
    document.removeEventListener('keydown', this.onKeydown);
    this.unsubs.forEach((u) => u());
  }
}
