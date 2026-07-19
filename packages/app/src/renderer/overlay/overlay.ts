import type { AssistantState } from '../../shared/types';
import type { JarvisApi, Unsubscribe } from '../shared/api';

/**
 * State word per AssistantState — the overlay's main status indicator, set in the
 * display italic. Lowercase, terse, no icons (cdd/plan/ui-design.md). `idle` renders
 * nothing: the window fades out.
 */
export const STATE_WORDS: Record<AssistantState, string> = {
  idle: '',
  listening: 'listening',
  transcribing: 'transcribing',
  thinking: 'thinking',
  speaking: 'speaking',
  error: 'something went wrong'
};

const BAR_COUNT = 5;
/** center-weighted height multipliers so the bar row reads as a soft peak */
const BAR_WEIGHTS = [0.55, 0.85, 1, 0.85, 0.55];
const BAR_MIN_PX = 2;
const BAR_MAX_PX = 14;

/**
 * The overlay window: state word + live line + tool ticker, per the layout contract in
 * cdd/plan/ui-design.md. Subscribes to state/transcript/agent events (and mic level,
 * when the api exposes it) and re-renders from its own small model.
 */
export class OverlayView {
  private state: AssistantState = 'idle';
  private userText = '';
  private userFinal = false;
  private replyText = '';
  private showingUpdate = false;
  private errorText = '';
  private toolText = '';

  private readonly card: HTMLDivElement;
  private readonly stateWord: HTMLSpanElement;
  private readonly micBars: HTMLSpanElement;
  private readonly bars: HTMLElement[] = [];
  private readonly liveLine: HTMLDivElement;
  private readonly toolTicker: HTMLDivElement;
  private readonly unsubs: Unsubscribe[] = [];

  constructor(root: HTMLElement, api: JarvisApi) {
    this.card = document.createElement('div');
    this.card.className = 'overlay';

    const head = document.createElement('div');
    head.className = 'overlay-head';
    this.stateWord = document.createElement('span');
    this.stateWord.className = 'state-word';
    this.micBars = document.createElement('span');
    this.micBars.className = 'mic-bars';
    for (let i = 0; i < BAR_COUNT; i++) {
      const bar = document.createElement('i');
      this.bars.push(bar);
      this.micBars.appendChild(bar);
    }
    head.append(this.stateWord, this.micBars);

    this.liveLine = document.createElement('div');
    this.liveLine.className = 'live-line';
    this.toolTicker = document.createElement('div');
    this.toolTicker.className = 'tool-ticker';

    this.card.append(head, this.liveLine, this.toolTicker);
    root.appendChild(this.card);

    this.unsubs.push(
      api.onStateChanged((s) => {
        this.onState(s);
      }),
      api.onTranscript((e) => {
        this.userText = e.text;
        this.userFinal = e.final;
        this.render();
      }),
      api.onAgentEvent((e) => {
        switch (e.kind) {
          case 'status_update':
            this.replyText = `update — ${e.text}`;
            this.showingUpdate = true;
            break;
          case 'text_delta':
            if (this.showingUpdate) this.replyText = '';
            this.showingUpdate = false;
            this.replyText += e.text;
            break;
          case 'tool_start':
            this.toolText = `→ ${e.summary.toLowerCase()}…`;
            break;
          case 'tool_end':
            this.toolText = e.ok ? `✓ ${e.toolName}` : `✕ ${e.toolName}`;
            break;
          case 'done':
            this.showingUpdate = false;
            this.replyText = e.finalText;
            break;
          case 'error':
            this.errorText = e.message;
            break;
        }
        this.render();
      })
    );
    if (api.onMicLevel) {
      this.unsubs.push(
        api.onMicLevel((level) => {
          this.setMicLevel(level);
        })
      );
    }

    this.render();
  }

  private onState(s: AssistantState): void {
    this.state = s;
    if (s === 'listening') {
      // a fresh utterance: clear the previous exchange
      this.userText = '';
      this.userFinal = false;
      this.replyText = '';
      this.showingUpdate = false;
      this.errorText = '';
      this.toolText = '';
    }
    if (s === 'idle') {
      this.userText = '';
      this.userFinal = false;
      this.replyText = '';
      this.showingUpdate = false;
      this.errorText = '';
      this.toolText = ''; // ticker clears when idle
      this.setMicLevel(0);
    }
    this.render();
  }

  /** cheap path: mic level only moves the bars, no re-render */
  private setMicLevel(level: number): void {
    const clamped = Math.max(0, Math.min(1, level));
    this.bars.forEach((bar, i) => {
      const weight = BAR_WEIGHTS[i] ?? 1;
      const px = BAR_MIN_PX + (BAR_MAX_PX - BAR_MIN_PX) * clamped * weight;
      bar.style.height = `${px.toFixed(1)}px`;
    });
  }

  render(): void {
    this.card.dataset['state'] = this.state;
    this.stateWord.textContent = STATE_WORDS[this.state];
    this.micBars.hidden = this.state !== 'listening';

    // live line: the user's words while listening/transcribing, then the streaming reply
    let live = '';
    let partial = false;
    if (this.state === 'error' && this.errorText !== '') {
      live = this.errorText;
    } else if (this.state === 'listening' || this.state === 'transcribing') {
      live = this.userText;
      partial = !this.userFinal;
    } else {
      live = this.replyText !== '' ? this.replyText : this.userText;
    }
    this.liveLine.textContent = live;
    this.liveLine.classList.toggle('partial', partial);
    this.liveLine.hidden = live === '';

    this.toolTicker.textContent = this.toolText;
    this.toolTicker.hidden = this.toolText === '';
  }

  dispose(): void {
    this.unsubs.forEach((u) => u());
    this.card.remove();
  }
}
