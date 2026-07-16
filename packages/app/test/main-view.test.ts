// @vitest-environment jsdom
/// <reference lib="dom" />
// The lib reference gives the renderer modules DOM types under tsc -p tsconfig.node.json
// (which includes test/**); vitest runs this file in jsdom via the docblock above.
import { beforeEach, describe, expect, it } from 'vitest';
import { MainView, relativeTime, renderTranscript } from '../src/renderer/main/app';
import { createFakeApi, type FakeApi } from '../src/renderer/shared/fakeApi';
import type { TurnRecord } from '../src/shared/types';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const TURNS: TurnRecord[] = [
  {
    id: 'a',
    at: '2026-07-15T09:00:00Z',
    backend: 'claude',
    userText: 'first question',
    assistantText: 'first answer',
    tools: [{ toolName: 'gcal.list', ok: true }]
  },
  {
    id: 'b',
    at: '2026-07-15T09:05:00Z',
    backend: 'codex',
    userText: 'second question',
    assistantText: 'second answer',
    tools: [
      { toolName: 'gmail.search', ok: true },
      { toolName: 'gmail.send', ok: false }
    ]
  }
];

describe('renderTranscript', () => {
  it('turns TurnRecord[] into the expected editorial DOM order', () => {
    const host = document.createElement('div');
    host.appendChild(renderTranscript(TURNS));

    const classes = Array.from(host.querySelectorAll('article.turn > p')).map(
      (el) => el.className
    );
    expect(classes).toEqual([
      'turn-user',
      'turn-assistant',
      'turn-tool',
      'turn-user',
      'turn-assistant',
      'turn-tool',
      'turn-tool'
    ]);

    const first = host.querySelector('article.turn') as HTMLElement;
    expect(first.dataset['turnId']).toBe('a');
    expect(first.querySelector('.turn-user')?.textContent).toBe('you — first question');
    expect(first.querySelector('.turn-prefix')?.textContent).toBe('you — ');
    expect(first.querySelector('.turn-assistant')?.textContent).toBe('first answer');
    expect(first.querySelector('.turn-tool')?.textContent).toBe('✓ gcal.list');

    const toolLines = Array.from(host.querySelectorAll('article.turn:last-child .turn-tool')).map(
      (el) => el.textContent
    );
    expect(toolLines).toEqual(['✓ gmail.search', '✕ gmail.send']);

    // editorial, not chat: no bubble-ish structure beyond flat paragraphs
    expect(host.querySelector('.bubble')).toBeNull();
  });
});

describe('MainView command bar', () => {
  let api: FakeApi;
  let root: HTMLElement;
  let view: MainView;

  beforeEach(async () => {
    document.body.innerHTML = '<div id="app"></div>';
    root = document.getElementById('app') as HTMLElement;
    api = createFakeApi();
    api.sessions = [{ id: 's1', title: 'a session', updatedAt: new Date().toISOString(), backend: 'claude' }];
    api.turnsBySession = { s1: TURNS };
    view = new MainView(root, api);
    await flush();
  });

  const input = (): HTMLInputElement => root.querySelector('.command-input') as HTMLInputElement;
  const form = (): HTMLFormElement => root.querySelector('.command-bar') as HTMLFormElement;
  const pressTab = (): void => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  };
  const submit = (): void => {
    form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  };

  it('submit calls command:text with the default backend and clears the input', () => {
    input().value = 'hello there';
    submit();
    expect(api.calls.sendText).toEqual([['hello there', 'claude']]);
    expect(input().value).toBe('');
  });

  it('Tab toggles the backend switch; submit uses the picked backend', () => {
    pressTab();
    input().value = 'use the other one';
    submit();
    expect(api.calls.sendText).toEqual([['use the other one', 'codex']]);

    const active = Array.from(root.querySelectorAll('.backend-switch [data-active="true"]')).map(
      (el) => el.textContent
    );
    expect(active).toEqual(['codex']);

    pressTab(); // back to claude
    input().value = 'and back';
    submit();
    expect(api.calls.sendText[1]).toEqual(['and back', 'claude']);
  });

  it('does not submit empty text', () => {
    input().value = '   ';
    submit();
    expect(api.calls.sendText).toEqual([]);
  });

  it('renders the seeded session transcript and appends on session:updated', () => {
    expect(root.querySelectorAll('article.turn')).toHaveLength(2);
    api.pushTurn({
      id: 'c',
      at: new Date().toISOString(),
      backend: 'claude',
      userText: 'third question',
      assistantText: 'third answer',
      tools: []
    });
    expect(root.querySelectorAll('article.turn')).toHaveLength(3);
  });

  it('titlebar shows the agent name and toggles the settings pane', () => {
    expect(root.querySelector('.agent-name')?.textContent).toBe('jarvis');
    const pane = root.querySelector('.settings') as HTMLElement;
    expect(pane.hidden).toBe(true);
    view.showSettings(true);
    expect(pane.hidden).toBe(false);
    view.showSettings(false);
    expect(pane.hidden).toBe(true);
  });
});

describe('relativeTime', () => {
  it('is lowercase and terse', () => {
    const now = new Date('2026-07-15T12:00:00Z');
    expect(relativeTime('2026-07-15T11:59:40Z', now)).toBe('just now');
    expect(relativeTime('2026-07-15T11:15:00Z', now)).toBe('45m ago');
    expect(relativeTime('2026-07-15T07:00:00Z', now)).toBe('5h ago');
    expect(relativeTime('2026-07-14T10:00:00Z', now)).toBe('yesterday');
    expect(relativeTime('2026-07-11T12:00:00Z', now)).toBe('4d ago');
  });
});
