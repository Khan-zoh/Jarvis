import type {
  BackendId,
  CollaborationEvent,
  CollaborationMessage,
  CollaborationSnapshot
} from '../../shared/types';
import type { JarvisApi, Unsubscribe } from '../shared/api';

export interface CollaborationPane {
  el: HTMLElement;
  dispose(): void;
}

function label(text: string, control: HTMLElement): HTMLLabelElement {
  const el = document.createElement('label');
  const caption = document.createElement('span');
  caption.textContent = text;
  el.append(caption, control);
  return el;
}

function appendMessage(feed: HTMLElement, message: CollaborationMessage): void {
  if (feed.querySelector(`[data-collaboration-message="${message.id}"]`)) return;
  const article = document.createElement('article');
  article.className = `collab-message collab-${message.backend}`;
  article.dataset['collaborationMessage'] = message.id;
  const head = document.createElement('header');
  const name = document.createElement('strong');
  name.textContent = message.backend;
  const role = document.createElement('span');
  role.textContent = message.role;
  head.append(name, role);
  const text = document.createElement('p');
  text.textContent = message.text;
  article.append(head, text);
  if (message.updates.length > 0) {
    const updates = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = `${message.updates.length} progress update${message.updates.length === 1 ? '' : 's'}`;
    const body = document.createElement('p');
    body.textContent = message.updates.join('\n\n');
    updates.append(summary, body);
    article.append(updates);
  }
  if (message.tools.length > 0) {
    const tools = document.createElement('p');
    tools.className = 'collab-tools';
    tools.textContent = message.tools.map((tool) => `${tool.ok ? '✓' : '✕'} ${tool.toolName}`).join('  ·  ');
    article.append(tools);
  }
  feed.append(article);
  feed.scrollTop = feed.scrollHeight;
}

export function buildCollaborationPane(api: JarvisApi): CollaborationPane {
  const el = document.createElement('section');
  el.className = 'collaboration-pane';
  el.hidden = true;

  const header = document.createElement('header');
  const heading = document.createElement('div');
  const eyebrow = document.createElement('span');
  eyebrow.className = 'conversation-eyebrow';
  eyebrow.textContent = 'multi-agent workspace';
  const title = document.createElement('h1');
  title.textContent = 'Claude ↔ Codex';
  const description = document.createElement('p');
  description.textContent = 'assign roles, give them one shared task, and watch every handoff';
  heading.append(eyebrow, title, description);
  const status = document.createElement('span');
  status.className = 'collab-status';
  status.textContent = 'ready';
  header.append(heading, status);

  const form = document.createElement('form');
  form.className = 'collab-form';
  const task = document.createElement('textarea');
  task.rows = 3;
  task.placeholder = 'what should they work on together?';
  const claudeRole = document.createElement('input');
  claudeRole.type = 'text';
  claudeRole.value = 'architect and critical reviewer';
  const codexRole = document.createElement('input');
  codexRole.type = 'text';
  codexRole.value = 'implementer and test owner';
  const rounds = document.createElement('select');
  for (let value = 1; value <= 5; value += 1) {
    const option = document.createElement('option');
    option.value = String(value);
    option.textContent = `${value} exchange${value === 1 ? '' : 's'}`;
    if (value === 2) option.selected = true;
    rounds.append(option);
  }
  const first = document.createElement('select');
  for (const backend of ['claude', 'codex'] as BackendId[]) {
    const option = document.createElement('option');
    option.value = backend;
    option.textContent = `${backend} speaks first`;
    first.append(option);
  }
  const controls = document.createElement('div');
  controls.className = 'collab-controls';
  const start = document.createElement('button');
  start.type = 'submit';
  start.className = 'collab-start';
  start.textContent = 'start collaboration';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'text-btn';
  cancel.textContent = 'stop';
  cancel.disabled = true;
  cancel.addEventListener('click', () => void api.cancelCollaboration());
  controls.append(start, cancel);
  const roleGrid = document.createElement('div');
  roleGrid.className = 'collab-role-grid';
  roleGrid.append(label('claude’s role', claudeRole), label('codex’s role', codexRole));
  const optionGrid = document.createElement('div');
  optionGrid.className = 'collab-option-grid';
  optionGrid.append(label('length', rounds), label('opening', first));
  form.append(label('shared task', task), roleGrid, optionGrid, controls);

  const activity = document.createElement('p');
  activity.className = 'collab-activity';
  activity.hidden = true;
  const feed = document.createElement('div');
  feed.className = 'collab-feed';
  const empty = document.createElement('p');
  empty.className = 'collab-empty';
  empty.textContent = 'their responses and tool activity will appear here in order';
  feed.append(empty);

  const applySnapshot = (snapshot: CollaborationSnapshot): void => {
    status.textContent = snapshot.status;
    const running = snapshot.status === 'running';
    start.disabled = running;
    cancel.disabled = !running;
    task.disabled = running;
    claudeRole.disabled = running;
    codexRole.disabled = running;
    rounds.disabled = running;
    first.disabled = running;
    if (snapshot.messages.length > 0) empty.remove();
    for (const message of snapshot.messages) appendMessage(feed, message);
  };

  const onEvent = (event: CollaborationEvent): void => {
    switch (event.kind) {
      case 'snapshot':
        applySnapshot(event.snapshot);
        break;
      case 'agent_started':
        activity.hidden = false;
        activity.textContent = `${event.backend} is working as ${event.role} · turn ${event.turn}/${event.totalTurns}`;
        break;
      case 'agent_update':
        activity.hidden = false;
        activity.textContent = `${event.backend} update — ${event.text}`;
        break;
      case 'tool_start':
        activity.hidden = false;
        activity.textContent = `${event.backend} → ${event.summary}`;
        break;
      case 'tool_end':
        activity.textContent = `${event.backend} ${event.ok ? 'finished' : 'failed'} ${event.toolName}`;
        break;
      case 'message':
        empty.remove();
        appendMessage(feed, event.message);
        break;
      case 'completed':
        activity.hidden = false;
        activity.textContent = 'collaboration complete';
        break;
      case 'cancelled':
        activity.textContent = 'collaboration stopped';
        break;
      case 'error':
        activity.hidden = false;
        activity.textContent = `stopped — ${event.message}`;
        break;
    }
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = task.value.trim();
    if (!text) {
      task.focus();
      return;
    }
    feed.textContent = '';
    activity.hidden = false;
    activity.textContent = 'starting both agents…';
    void api
      .startCollaboration({
        task: text,
        claudeRole: claudeRole.value,
        codexRole: codexRole.value,
        rounds: Number(rounds.value),
        firstSpeaker: first.value as BackendId
      })
      .catch((err: unknown) => {
        activity.textContent = err instanceof Error ? err.message : String(err);
      });
  });

  el.append(header, form, activity, feed);
  const unsub: Unsubscribe = api.onCollaborationEvent(onEvent);
  void api.collaborationSnapshot().then(applySnapshot).catch(() => {});
  return { el, dispose: unsub };
}
