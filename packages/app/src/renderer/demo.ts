import type { TurnRecord } from '../shared/types';
import { createFakeApi, type FakeApi } from './shared/fakeApi';

/**
 * Dev-only demo driver (?demo=1): feeds the views a fake JarvisApi so the design can
 * be judged with no voice pipeline. The overlay cycles through every AssistantState
 * with fake transcript/tool events; the main window gets seeded sessions plus a live
 * turn on each cycle.
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const NOW = Date.now();
const iso = (minsAgo: number): string => new Date(NOW - minsAgo * 60_000).toISOString();

const SEED_TURNS: TurnRecord[] = [
  {
    id: 't1',
    at: iso(190),
    backend: 'claude',
    userText: 'what does my morning look like tomorrow?',
    assistantText:
      'three things: standup at 9:30, a dentist hold at 11, and the design review moved to 11:45. the first two overlap by nothing — you have a clear gap from 10 to 11.',
    tools: [{ toolName: 'gcal.list', ok: true }]
  },
  {
    id: 't2',
    at: iso(185),
    backend: 'claude',
    userText: 'move the design review to the afternoon',
    assistantText: 'done — design review now sits at 2pm, invitees notified.',
    tools: [
      { toolName: 'gcal.list', ok: true },
      { toolName: 'gcal.update', ok: true }
    ]
  },
  {
    id: 't3',
    at: iso(42),
    backend: 'codex',
    userText: 'any mail from the landlord this week?',
    assistantText:
      'one message, tuesday: the inspection is confirmed for friday at 10am. nothing needs a reply.',
    tools: [{ toolName: 'gmail.search', ok: true }]
  }
];

function seedMain(api: FakeApi): void {
  api.sessions = [
    { id: 's1', title: 'tomorrow morning, rearranged', updatedAt: iso(42), backend: 'claude' },
    { id: 's2', title: 'trip notes and packing', updatedAt: iso(60 * 26), backend: 'claude' },
    { id: 's3', title: 'that pdf about the lease', updatedAt: iso(60 * 24 * 4), backend: 'codex' }
  ];
  api.turnsBySession = { s1: SEED_TURNS, s2: [], s3: [] };
}

async function driveOverlay(api: FakeApi): Promise<void> {
  const utterance = "what's on my calendar tomorrow morning";
  const reply =
    'three things tomorrow morning: standup at 9:30, a dentist hold at 11, and the design review at 11:45.';

  // demo loop runs forever; each pass shows every state in order, then the error state
  for (;;) {
    // listening — mic bars + partial transcript
    api.pushState('listening');
    const listenMs = 2600;
    const step = 50;
    for (let t = 0; t < listenMs; t += step) {
      const level =
        0.25 + 0.4 * Math.abs(Math.sin(t / 180)) + 0.3 * Math.abs(Math.sin(t / 47 + 1.3));
      api.pushMicLevel(Math.min(1, level));
      const words = Math.floor((t / listenMs) * utterance.split(' ').length) + 1;
      api.pushTranscript({ text: utterance.split(' ').slice(0, words).join(' '), final: false });
      await sleep(step);
    }
    api.pushTranscript({ text: utterance, final: true });

    // transcribing
    api.pushState('transcribing');
    await sleep(700);

    // thinking — tool ticker
    api.pushState('thinking');
    await sleep(500);
    api.pushAgentEvent({ kind: 'tool_start', toolName: 'gcal.list', summary: 'checking calendar' });
    await sleep(1100);
    api.pushAgentEvent({ kind: 'tool_end', toolName: 'gcal.list', ok: true });
    await sleep(500);

    // speaking — streaming reply
    api.pushState('speaking');
    for (const word of reply.split(' ')) {
      api.pushAgentEvent({ kind: 'text_delta', text: `${word} ` });
      await sleep(55);
    }
    api.pushAgentEvent({ kind: 'done', finalText: reply });
    await sleep(1200);

    api.pushState('idle');
    await sleep(1800);

    // error showcase
    api.pushState('error');
    api.pushAgentEvent({
      kind: 'error',
      message: 'codex not logged in. run `codex login` in a terminal.'
    });
    await sleep(2400);
    api.pushState('idle');
    await sleep(1600);
  }
}

async function driveMain(api: FakeApi): Promise<void> {
  // push a fresh turn periodically so session:updated handling is visible
  let n = 0;
  for (;;) {
    await sleep(9000);
    n += 1;
    api.pushTurn({
      id: `live-${n}`,
      at: new Date().toISOString(),
      backend: n % 2 === 0 ? 'codex' : 'claude',
      userText: 'remind me to water the plants at six',
      assistantText: 'set — a quiet nudge at 6pm today.',
      tools: [{ toolName: 'system.notify', ok: true }]
    });
  }
}

export function startDemo(view: 'overlay' | 'main'): FakeApi {
  const api = createFakeApi();
  seedMain(api);
  if (view === 'overlay') {
    void driveOverlay(api);
  } else {
    void driveMain(api);
  }
  return api;
}
