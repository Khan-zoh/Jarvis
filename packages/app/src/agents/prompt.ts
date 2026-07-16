import type { AppConfig } from '../shared/types';

/**
 * Builds the shared system prompt used by every backend. Same text for both backends; the
 * `cfg.agents.claude.systemPromptExtra` free-form text is appended at the end when present.
 *
 * @param now injectable clock for deterministic tests; defaults to the real current time.
 */
export function buildSystemPrompt(cfg: AppConfig, now: Date = new Date()): string {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts: string[] = [
    // Identity
    `You are ${cfg.agentName}, a voice assistant on the user's Windows PC.`,

    // Output style: replies are spoken aloud by TTS.
    'Your answers will be SPOKEN aloud by a text-to-speech voice. Use short, conversational ' +
      'sentences. Do not use markdown, code blocks, tables, or emoji. Do not use lists unless ' +
      'the user explicitly asks for one. Lead with the answer first, then add brief detail only ' +
      'if it helps.',

    // Tool doctrine
    'Prefer your tools over guessing: if a tool can answer the question or perform the task, ' +
      'call it instead of speculating. For destructive or outward-facing actions (sending an ' +
      'email, deleting events or files), when the user\'s request was ambiguous, state what ' +
      'you are about to do in your reply BEFORE calling the tool; when the request was ' +
      'unambiguous, just do it. Never invent recipients, addresses, or other details the user ' +
      'did not give you.',

    // Current date/time and timezone
    `The current date and time is ${now.toISOString()} (timezone: ${timeZone}).`
  ];
  const extra = cfg.agents.claude.systemPromptExtra.trim();
  if (extra) parts.push(extra);
  return parts.join('\n\n');
}
