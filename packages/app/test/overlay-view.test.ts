// @vitest-environment jsdom
// Typechecked under tsconfig.web.json (DOM lib); vitest runs it in jsdom via the docblock above.
import { beforeEach, describe, expect, it } from 'vitest';
import { OverlayView, STATE_WORDS } from '../src/renderer/overlay/overlay';
import { createFakeApi, type FakeApi } from '../src/renderer/shared/fakeApi';
import type { AssistantState } from '../src/shared/types';

describe('OverlayView', () => {
  let api: FakeApi;
  let root: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
    root = document.getElementById('app') as HTMLElement;
    api = createFakeApi();
    new OverlayView(root, api);
  });

  const stateWord = (): string => root.querySelector('.state-word')?.textContent ?? '';
  const ticker = (): HTMLElement => root.querySelector('.tool-ticker') as HTMLElement;

  it('shows the correct state word for every AssistantState', () => {
    const cases: [AssistantState, string][] = [
      ['listening', 'listening'],
      ['transcribing', 'transcribing'],
      ['thinking', 'thinking'],
      ['speaking', 'speaking'],
      ['error', 'something went wrong'],
      ['idle', '']
    ];
    for (const [state, word] of cases) {
      api.pushState(state);
      expect(stateWord(), state).toBe(word);
      expect(STATE_WORDS[state]).toBe(word);
      expect((root.querySelector('.overlay') as HTMLElement).dataset['state']).toBe(state);
    }
  });

  it('shows the mic bars only while listening', () => {
    const bars = root.querySelector('.mic-bars') as HTMLElement;
    expect(bars.querySelectorAll('i')).toHaveLength(5);
    api.pushState('listening');
    expect(bars.hidden).toBe(false);
    api.pushMicLevel(1);
    const first = bars.querySelector('i') as HTMLElement;
    expect(first.style.height).not.toBe('');
    api.pushState('thinking');
    expect(bars.hidden).toBe(true);
  });

  it('renders the tool ticker on tool_start and clears it on idle', () => {
    api.pushState('thinking');
    expect(ticker().hidden).toBe(true);

    api.pushAgentEvent({ kind: 'tool_start', toolName: 'gmail.search', summary: 'Searching Gmail' });
    expect(ticker().hidden).toBe(false);
    expect(ticker().textContent).toBe('→ searching gmail…');

    api.pushAgentEvent({ kind: 'tool_end', toolName: 'gmail.search', ok: true });
    expect(ticker().textContent).toBe('✓ gmail.search');

    api.pushState('idle');
    expect(ticker().hidden).toBe(true);
    expect(ticker().textContent).toBe('');
  });

  it('shows the live transcript while listening, then the streaming reply', () => {
    const live = (): HTMLElement => root.querySelector('.live-line') as HTMLElement;
    api.pushState('listening');
    api.pushTranscript({ text: 'what does my', final: false });
    expect(live().textContent).toBe('what does my');
    expect(live().classList.contains('partial')).toBe(true);
    api.pushTranscript({ text: 'what does my morning look like', final: true });
    expect(live().classList.contains('partial')).toBe(false);

    api.pushState('speaking');
    api.pushAgentEvent({ kind: 'status_update', text: 'checking your calendar' });
    expect(live().textContent).toBe('update — checking your calendar');
    api.pushAgentEvent({ kind: 'text_delta', text: 'three things ' });
    api.pushAgentEvent({ kind: 'text_delta', text: 'tomorrow' });
    expect(live().textContent).toBe('three things tomorrow');

    api.pushState('idle');
    expect(live().hidden).toBe(true);
  });
});
