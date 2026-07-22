import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../src/agents/prompt';
import { makeConfig } from './fakes/testConfig';

const FIXED_NOW = new Date('2026-07-15T09:30:00.000Z');

describe('buildSystemPrompt', () => {
  it('matches the snapshot for a default config at a fixed time', () => {
    const prompt = buildSystemPrompt(makeConfig(), FIXED_NOW).replace(
      /\(timezone: [^)]+\)/,
      '(timezone: <local>)'
    );
    expect(prompt).toMatchSnapshot();
  });

  it('contains the identity line with the configured agent name', () => {
    const prompt = buildSystemPrompt(makeConfig({ agentName: 'Friday' }), FIXED_NOW);
    expect(prompt).toContain("You are Friday, a voice assistant on the user's Windows PC.");
  });

  it('contains the ISO date, time, and a timezone', () => {
    const prompt = buildSystemPrompt(makeConfig(), FIXED_NOW);
    expect(prompt).toContain('2026-07-15');
    expect(prompt).toContain(FIXED_NOW.toISOString());
    expect(prompt).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('covers spoken style and tool doctrine', () => {
    const prompt = buildSystemPrompt(makeConfig(), FIXED_NOW);
    expect(prompt).toContain('SPOKEN');
    expect(prompt).toContain('markdown');
    expect(prompt).toContain('Lead with the answer');
    expect(prompt).toContain('Never invent recipients');
    expect(prompt.toLowerCase()).toContain('tools over guessing');
  });

  it('appends systemPromptExtra when set and omits it when blank', () => {
    const withExtra = buildSystemPrompt(
      makeConfig({ systemPromptExtra: 'Always answer in French.' }),
      FIXED_NOW
    );
    expect(withExtra.endsWith('Always answer in French.')).toBe(true);

    const withoutExtra = buildSystemPrompt(makeConfig({ systemPromptExtra: '   ' }), FIXED_NOW);
    expect(withoutExtra.trim().endsWith('Always answer in French.')).toBe(false);
  });
});
