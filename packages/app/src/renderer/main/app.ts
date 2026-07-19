import {
  isDefaultConfig,
  type AgentEvent,
  type AppConfig,
  type BackendId,
  type CapturedNote,
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

    article.appendChild(user);
    appendUpdates(article, turn.assistantUpdates ?? []);
    article.appendChild(assistant);
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

function appendUpdates(parent: HTMLElement, updates: string[]): void {
  if (updates.length === 0) return;
  const container = document.createElement('div');
  container.className = 'turn-updates';
  for (const update of updates) appendUpdate(container, update);
  parent.appendChild(container);
}

function appendUpdate(parent: HTMLElement, text: string): void {
  const line = document.createElement('p');
  line.className = 'turn-update';
  const label = document.createElement('span');
  label.className = 'turn-update-label';
  label.textContent = 'update — ';
  line.append(label, document.createTextNode(text));
  parent.appendChild(line);
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
    updates: HTMLDivElement;
    text: string;
    lastTool: HTMLParagraphElement | null;
  } | null = null;

  private readonly agentName: HTMLSpanElement;
  private readonly settingsBtn: HTMLButtonElement;
  private readonly conversationTitle: HTMLHeadingElement;
  private readonly stateText: HTMLSpanElement;
  private readonly setupNotice: HTMLParagraphElement;
  private readonly sessionList: HTMLUListElement;
  private readonly transcript: HTMLDivElement;
  /** Recently-captured strip (second brain) — hidden until the first capture. */
  private readonly capturedSection: HTMLElement;
  private readonly capturedList: HTMLUListElement;
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
    const brand = document.createElement('div');
    brand.className = 'brand';
    const brandMark = document.createElement('span');
    brandMark.className = 'brand-mark';
    brandMark.textContent = 'J';
    const brandCopy = document.createElement('div');
    brandCopy.className = 'brand-copy';
    this.agentName = document.createElement('span');
    this.agentName.className = 'agent-name';
    this.agentName.textContent = 'jarvis';
    const brandTagline = document.createElement('span');
    brandTagline.className = 'brand-tagline';
    brandTagline.textContent = 'second brain';
    brandCopy.append(this.agentName, brandTagline);
    brand.append(brandMark, brandCopy);

    const statePill = document.createElement('div');
    statePill.className = 'state-pill';
    const stateDot = document.createElement('span');
    stateDot.className = 'state-dot';
    this.stateText = document.createElement('span');
    this.stateText.className = 'state-text';
    this.stateText.textContent = 'ready';
    statePill.append(stateDot, this.stateText);

    const actions = document.createElement('div');
    actions.className = 'titlebar-actions';
    this.settingsBtn = document.createElement('button');
    this.settingsBtn.type = 'button';
    this.settingsBtn.className = 'btn-settings';
    this.settingsBtn.textContent = 'preferences';
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
    titlebar.append(brand, statePill, actions);

    /* ---- conversation rail ---- */
    const sidebar = document.createElement('aside');
    sidebar.className = 'sidebar';
    const sidebarHead = document.createElement('div');
    sidebarHead.className = 'sidebar-head';
    const sidebarLabel = document.createElement('span');
    sidebarLabel.className = 'sidebar-label';
    sidebarLabel.textContent = 'conversations';
    const newThread = document.createElement('button');
    newThread.type = 'button';
    newThread.className = 'btn-new-thread';
    newThread.innerHTML = '<span aria-hidden="true">＋</span> new conversation';
    newThread.addEventListener('click', () => {
      void this.api.newSession().then(async () => {
        this.activeSession = null;
        this.transcript.textContent = '';
        this.conversationTitle.textContent = 'new conversation';
        await this.refreshSessions(true);
        this.input.focus();
      });
    });
    sidebarHead.append(sidebarLabel, newThread);

    const sessions = document.createElement('nav');
    sessions.className = 'sessions';
    this.sessionList = document.createElement('ul');
    sessions.appendChild(this.sessionList);
    const privacy = document.createElement('div');
    privacy.className = 'sidebar-foot';
    privacy.innerHTML = '<span class="privacy-dot"></span><span>local memory</span>';
    sidebar.append(sidebarHead, sessions, privacy);

    /* ---- conversation workspace ---- */
    const history = document.createElement('section');
    history.className = 'history';
    const conversationHead = document.createElement('header');
    conversationHead.className = 'conversation-head';
    const headingGroup = document.createElement('div');
    headingGroup.className = 'conversation-heading';
    const eyebrow = document.createElement('span');
    eyebrow.className = 'conversation-eyebrow';
    eyebrow.textContent = 'active conversation';
    this.conversationTitle = document.createElement('h1');
    this.conversationTitle.textContent = 'new conversation';
    headingGroup.append(eyebrow, this.conversationTitle);
    const shortcut = document.createElement('span');
    shortcut.className = 'conversation-shortcut';
    shortcut.textContent = 'esc to stop';
    conversationHead.append(headingGroup, shortcut);

    // Durable setup notice (voice disabled → text-only mode). NOT the 3s transient error path:
    // it stays until the underlying cause is fixed (cdd/plan/amendments.md, error-policy nuance).
    this.setupNotice = document.createElement('p');
    this.setupNotice.className = 'setup-notice';
    this.setupNotice.hidden = true;

    this.transcript = document.createElement('div');
    this.transcript.className = 'transcript';

    // Recently captured strip (second brain): mono list of "noted: <title>" rows, each with a
    // one-click undo (× → brain:remove). Hidden until there is at least one capture.
    this.capturedSection = document.createElement('section');
    this.capturedSection.className = 'captured';
    this.capturedSection.hidden = true;
    const capturedHeading = document.createElement('span');
    capturedHeading.className = 'captured-heading';
    capturedHeading.textContent = 'recently captured';
    this.capturedList = document.createElement('ul');
    this.capturedList.className = 'captured-list';
    this.capturedSection.append(capturedHeading, this.capturedList);

    const bar = document.createElement('form');
    bar.className = 'command-bar';
    const composerLead = document.createElement('span');
    composerLead.className = 'composer-mark';
    composerLead.textContent = 'J';
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
    const send = document.createElement('button');
    send.type = 'submit';
    send.className = 'btn-send';
    send.title = 'send';
    send.setAttribute('aria-label', 'send message');
    send.textContent = '↑';
    bar.append(composerLead, this.input, backendSwitch, send);
    bar.addEventListener('submit', (e) => {
      e.preventDefault();
      this.submit();
    });

    const composerDock = document.createElement('div');
    composerDock.className = 'composer-dock';
    const composerHint = document.createElement('div');
    composerHint.className = 'composer-hint';
    composerHint.innerHTML = '<span>tab switches model</span><span>voice ready on “jarvis”</span>';
    composerDock.append(this.capturedSection, bar, composerHint);
    history.append(conversationHead, this.setupNotice, this.transcript, composerDock);

    /* ---- settings pane ---- */
    this.settingsPane = buildSettingsPane(api);

    const panes = document.createElement('div');
    panes.className = 'panes';
    panes.append(sidebar, history, this.settingsPane.el);

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

    // Second brain: load the recently-captured strip, then keep it live.
    void this.api
      .brainRecent()
      .then((notes) => {
        for (const n of notes) this.addCapturedRow(n, false);
      })
      .catch(() => {});

    this.unsubs.push(
      api.onSessionUpdated((turn) => {
        // The persisted record replaces the live streaming rendition of the same turn.
        this.clearLiveTurn();
        this.transcript.appendChild(renderTranscript([turn]));
        if (this.conversationTitle.textContent === 'new conversation') {
          this.conversationTitle.textContent = turn.userText.toLowerCase();
        }
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
      }),
      api.onStateChanged((state) => {
        this.stateText.textContent = state === 'idle' ? 'ready' : state;
        this.stateText.parentElement?.setAttribute('data-state', state);
      }),
      api.onBrainCaptured((n) => this.addCapturedRow(n, true)),
      api.onBrainRemoved((id) => this.removeCapturedRow(id))
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
    const updates = document.createElement('div');
    updates.className = 'turn-updates';
    el.append(user, updates, assistant);
    this.transcript.appendChild(el);
    this.transcript.scrollTop = this.transcript.scrollHeight;
    this.liveTurn = { el, assistant, updates, text: '', lastTool: null };
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
      case 'status_update':
        appendUpdate(live.updates, e.text);
        break;
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
      await this.openSession(first.id, first.title);
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
        void this.openSession(s.id, s.title);
      });
      this.sessionList.appendChild(li);
    }
  }

  private async openSession(id: string, title?: string): Promise<void> {
    this.activeSession = id;
    this.conversationTitle.textContent = title?.trim() ? title.toLowerCase() : 'new conversation';
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

  /* ---- recently captured strip (second brain) ---- */

  /** Adds (or prepends) a "noted: <title>" row with a one-click undo. Ignores duplicate ids. */
  private addCapturedRow(note: CapturedNote, prepend: boolean): void {
    if (this.capturedList.querySelector(`li[data-note-id="${note.id}"]`)) return;
    const li = document.createElement('li');
    li.className = 'captured-item';
    li.dataset['noteId'] = note.id;
    const label = document.createElement('span');
    label.className = 'captured-label';
    label.textContent = `noted: ${note.title}`;
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.className = 'captured-undo';
    undo.textContent = '×';
    undo.title = 'undo — remove this note';
    undo.addEventListener('click', () => {
      void this.api.brainRemove(note.id);
      this.removeCapturedRow(note.id);
    });
    li.append(label, undo);
    if (prepend) this.capturedList.prepend(li);
    else this.capturedList.appendChild(li);
    // Bounded strip: keep the 8 most recent.
    while (this.capturedList.childElementCount > 8) this.capturedList.lastElementChild?.remove();
    this.capturedSection.hidden = false;
  }

  private removeCapturedRow(id: string): void {
    this.capturedList.querySelector(`li[data-note-id="${id}"]`)?.remove();
    if (this.capturedList.childElementCount === 0) this.capturedSection.hidden = true;
  }

  dispose(): void {
    document.removeEventListener('keydown', this.onKeydown);
    this.unsubs.forEach((u) => u());
  }
}
