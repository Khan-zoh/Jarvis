import { randomUUID } from 'node:crypto';
import type {
  AgentEvent,
  BackendId,
  CollaborationEvent,
  CollaborationMessage,
  CollaborationRequest,
  CollaborationSnapshot
} from '../shared/types';
import type { AgentBackend, TurnHandle } from './types';

export interface CollaborationManagerDeps {
  backends: Record<BackendId, AgentBackend>;
  emit: (event: CollaborationEvent) => void;
  normalTurnBusy?: () => boolean;
  now?: () => Date;
}

function roleFor(request: CollaborationRequest, backend: BackendId): string {
  return backend === 'claude' ? request.claudeRole : request.codexRole;
}

export function buildCollaborationPrompt(
  request: CollaborationRequest,
  backend: BackendId,
  partnerMessage: CollaborationMessage | null,
  turn: number,
  totalTurns: number
): string {
  const partner: BackendId = backend === 'claude' ? 'codex' : 'claude';
  const partnerContext = partnerMessage
    ? `\n\n${partner.toUpperCase()} (${partnerMessage.role}) just responded:\n---\n${partnerMessage.text}\n---\nRespond directly to that work: verify it, challenge weak assumptions, and advance the shared task.`
    : '\n\nYou are opening the collaboration. Produce a concrete first proposal for your partner to review.';
  return [
    'You are participating in a visible two-agent collaboration inside Jarvis.',
    `Shared task: ${request.task}`,
    `Your assigned role: ${roleFor(request, backend)}`,
    `Your partner is ${partner.toUpperCase()}, assigned role: ${roleFor(request, partner)}.`,
    `This is exchange ${turn} of ${totalTurns}.`,
    'Address your partner as a collaborator. State decisions and evidence clearly. Do not merely summarize.',
    'Use tools when they materially advance the task. Keep this turn focused enough for the partner to act on.',
    partnerContext
  ].join('\n');
}

export class CollaborationManager {
  private readonly backends: Record<BackendId, AgentBackend>;
  private readonly emitEvent: (event: CollaborationEvent) => void;
  private readonly normalTurnBusy: () => boolean;
  private readonly now: () => Date;
  private nativeSessions: Partial<Record<BackendId, string>> = {};
  private currentHandle: TurnHandle | null = null;
  private generation = 0;
  private state: CollaborationSnapshot = {
    id: null,
    status: 'idle',
    request: null,
    activeBackend: null,
    messages: []
  };

  constructor(deps: CollaborationManagerDeps) {
    this.backends = deps.backends;
    this.emitEvent = deps.emit;
    this.normalTurnBusy = deps.normalTurnBusy ?? (() => false);
    this.now = deps.now ?? (() => new Date());
  }

  get busy(): boolean {
    return this.state.status === 'running';
  }

  snapshot(): CollaborationSnapshot {
    return structuredClone(this.state);
  }

  start(input: CollaborationRequest): string {
    if (this.busy) throw new Error('A collaboration is already running.');
    if (this.normalTurnBusy()) throw new Error('Wait for the current assistant turn to finish.');
    const request = this.validate(input);
    const id = randomUUID();
    this.generation += 1;
    const generation = this.generation;
    this.nativeSessions = {};
    this.state = {
      id,
      status: 'running',
      request,
      activeBackend: null,
      messages: []
    };
    this.emitSnapshot();
    void this.run(generation).catch((err: unknown) => this.fail(generation, err));
    return id;
  }

  async cancel(): Promise<void> {
    if (!this.busy) return;
    this.generation += 1;
    await this.currentHandle?.interrupt().catch(() => {});
    this.currentHandle = null;
    this.state.status = 'cancelled';
    this.state.activeBackend = null;
    this.emitEvent({ kind: 'cancelled' });
    this.emitSnapshot();
  }

  private validate(input: CollaborationRequest): CollaborationRequest {
    const task = input.task.trim();
    if (!task) throw new Error('Describe a task for the agents.');
    const claudeRole = input.claudeRole.trim() || 'planner and reviewer';
    const codexRole = input.codexRole.trim() || 'implementer and verifier';
    const rounds = Math.max(1, Math.min(5, Math.floor(input.rounds || 1)));
    const firstSpeaker: BackendId = input.firstSpeaker === 'codex' ? 'codex' : 'claude';
    return { task, claudeRole, codexRole, rounds, firstSpeaker };
  }

  private async run(generation: number): Promise<void> {
    const request = this.state.request;
    if (!request) return;
    const totalTurns = request.rounds * 2;
    let backend = request.firstSpeaker;
    let partnerMessage: CollaborationMessage | null = null;

    for (let turn = 1; turn <= totalTurns; turn += 1) {
      if (generation !== this.generation) return;
      const role = roleFor(request, backend);
      this.state.activeBackend = backend;
      this.emitEvent({ kind: 'agent_started', backend, role, turn, totalTurns });
      this.emitSnapshot();

      const agent = this.backends[backend];
      const ready = await agent.init();
      if (!ready.ok) throw new Error(ready.problem ?? `${backend} is unavailable.`);
      if (generation !== this.generation) return;

      const updates: string[] = [];
      const tools: { toolName: string; ok: boolean }[] = [];
      const prompt = buildCollaborationPrompt(request, backend, partnerMessage, turn, totalTurns);
      const onEvent = (event: AgentEvent): void => {
        if (generation !== this.generation) return;
        if (event.kind === 'status_update') {
          updates.push(event.text);
          this.emitEvent({ kind: 'agent_update', backend, text: event.text });
        } else if (event.kind === 'tool_start') {
          this.emitEvent({ kind: 'tool_start', backend, toolName: event.toolName, summary: event.summary });
        } else if (event.kind === 'tool_end') {
          tools.push({ toolName: event.toolName, ok: event.ok });
          this.emitEvent({ kind: 'tool_end', backend, toolName: event.toolName, ok: event.ok });
        }
      };
      const started = await agent.startTurn({
        input: prompt,
        sessionId: this.nativeSessions[backend] ?? null,
        onEvent
      });
      this.currentHandle = started.handle;
      const result = await started.result;
      this.currentHandle = null;
      if (generation !== this.generation) return;
      this.nativeSessions[backend] = result.sessionId;

      const message: CollaborationMessage = {
        id: randomUUID(),
        at: this.now().toISOString(),
        backend,
        role,
        text: result.finalText,
        updates,
        tools
      };
      this.state.messages.push(message);
      partnerMessage = message;
      this.emitEvent({ kind: 'message', message: structuredClone(message) });
      this.emitSnapshot();
      backend = backend === 'claude' ? 'codex' : 'claude';
    }

    if (generation !== this.generation) return;
    this.state.status = 'completed';
    this.state.activeBackend = null;
    this.emitEvent({ kind: 'completed' });
    this.emitSnapshot();
  }

  private fail(generation: number, err: unknown): void {
    if (generation !== this.generation) return;
    const message = err instanceof Error ? err.message : String(err);
    this.currentHandle = null;
    this.state.status = 'error';
    this.state.activeBackend = null;
    this.state.error = message;
    this.emitEvent({ kind: 'error', message });
    this.emitSnapshot();
  }

  private emitSnapshot(): void {
    this.emitEvent({ kind: 'snapshot', snapshot: this.snapshot() });
  }
}
