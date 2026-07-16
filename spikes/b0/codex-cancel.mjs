// Focused: prove AbortSignal terminates a Codex turn mid-generation, and that a partial
// result is/ isn't retrievable. Aborts ~1.2s after the stream starts (before completion).
import { Codex } from '@openai/codex-sdk';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, 'out');
const codex = new Codex();
const thread = codex.startThread({ skipGitRepoCheck: true, workingDirectory: OUT,
  sandboxMode: 'read-only', approvalPolicy: 'never' });

const ac = new AbortController();
const obs = { events: [], completed: false, agentText: '', err: null, threadId: null };
setTimeout(() => { console.error('[cancel] firing abort'); ac.abort(); }, 1200);
const hardTimer = setTimeout(() => ac.abort(), 60000);
try {
  const { events } = await thread.runStreamed(
    'Write a detailed 500-word essay about the history of clocks. Take your time.',
    { signal: ac.signal });
  for await (const ev of events) {
    obs.events.push(ev.type + (ev.item ? ':' + ev.item.type : ''));
    if (ev.type === 'thread.started') obs.threadId = ev.thread_id;
    if (ev.item?.type === 'agent_message') obs.agentText = ev.item.text || obs.agentText;
    if (ev.type === 'turn.completed') obs.completed = true;
  }
} catch (e) {
  obs.err = String(e?.name || '') + ': ' + String(e?.message || e);
} finally { clearTimeout(hardTimer); }
console.error('[cancel] result:', JSON.stringify({
  events: obs.events, completed: obs.completed, gotText: obs.agentText.length,
  err: obs.err, threadId: obs.threadId }));
process.exit(0);
