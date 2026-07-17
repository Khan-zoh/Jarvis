import { describe, expect, it } from 'vitest';
import { stripMcpPrefix, summarizeToolCall } from '../src/agents/claude';

/**
 * Table for every jarvisTools tool name (cdd/plan/tools-and-google.md + second-brain.md) plus the
 * unknown fallback. Each row is [rawName, input, expectedSummary].
 */
const TABLE: Array<[string, unknown, string]> = [
  ['gmail_search', { query: 'from:amy' }, 'searching gmail for "from:amy"'],
  ['gmail_search', {}, 'searching your gmail'],
  ['gmail_read', { messageId: 'x' }, 'reading an email'],
  ['gmail_send', { to: ['a@b.com', 'c@d.com'] }, 'sending an email to a@b.com, c@d.com'],
  ['gmail_send', {}, 'sending an email'],
  ['gmail_unread_summary', {}, 'checking your unread email'],
  ['calendar_list_events', { fromIso: 'x', toIso: 'y' }, 'checking your calendar'],
  ['calendar_create_event', { title: 'Dentist' }, 'adding "Dentist" to your calendar'],
  ['calendar_create_event', {}, 'adding an event to your calendar'],
  ['calendar_delete_event', { eventId: 'e1' }, 'deleting a calendar event'],
  ['calendar_find_free_slots', { dateIso: 'x', durationMinutes: 30 }, 'finding free time on your calendar'],
  ['drive_search', { query: 'budget' }, 'searching your drive for "budget"'],
  ['drive_search', {}, 'searching your drive'],
  ['drive_read_doc', { fileId: 'f1' }, 'reading a document'],
  ['open_app_or_url', { target: 'notepad' }, 'opening notepad'],
  ['open_app_or_url', {}, 'opening an app or link'],
  ['system_media', { action: 'play_pause' }, 'media control: play pause'],
  ['system_media', {}, 'controlling media playback'],
  ['clipboard_read', {}, 'reading your clipboard'],
  ['clipboard_write', { text: 'hi' }, 'copying text to your clipboard'],
  ['window_focus', { titleContains: 'Chrome' }, 'focusing the Chrome window'],
  ['window_focus', {}, 'focusing a window'],
  ['timer_set', { minutes: 5, label: 'tea' }, 'setting a 5-minute timer for tea'],
  ['timer_set', { minutes: 10 }, 'setting a 10-minute timer'],
  ['timer_set', {}, 'setting a timer'],
  ['web_search', { query: 'ts docs' }, 'searching the web for "ts docs"'],
  ['web_search', {}, 'searching the web'],
  ['web_fetch', { url: 'https://x.com' }, 'fetching https://x.com'],
  ['web_fetch', {}, 'fetching a web page'],
  ['brain_add_note', { text: 'remember' }, 'saving a note'],
  ['brain_append', { id: 'n1', text: 'more' }, 'updating your notes'],
  ['brain_consolidate', {}, 'organizing your notes'],
  ['brain_search', { query: 'ideas' }, 'searching your notes for "ideas"'],
  ['brain_search', {}, 'searching your notes'],
  // Unknown tool → generic fallback.
  ['some_future_tool', { any: 1 }, 'using some_future_tool']
];

describe('summarizeToolCall', () => {
  it.each(TABLE)('%s %o → %s', (name, input, expected) => {
    expect(summarizeToolCall(name, input)).toBe(expected);
  });

  it('accepts the mcp__jarvisTools__ prefixed name form', () => {
    expect(summarizeToolCall('mcp__jarvisTools__gmail_search', { query: 'x' })).toBe(
      'searching gmail for "x"'
    );
    expect(summarizeToolCall('mcp__jarvisTools__some_future_tool', {})).toBe('using some_future_tool');
  });

  it('never throws on malformed / missing input', () => {
    expect(() => summarizeToolCall('gmail_send', undefined)).not.toThrow();
    expect(() => summarizeToolCall('gmail_send', null)).not.toThrow();
    expect(() => summarizeToolCall('gmail_send', 'not-an-object')).not.toThrow();
    expect(() => summarizeToolCall('gmail_send', { to: 'notanarray' })).not.toThrow();
    expect(summarizeToolCall('gmail_send', { to: [1, 2] })).toBe('sending an email');
  });
});

describe('stripMcpPrefix', () => {
  it('strips the mcp__<server>__ prefix', () => {
    expect(stripMcpPrefix('mcp__jarvisTools__gmail_search')).toBe('gmail_search');
  });
  it('leaves un-prefixed names untouched', () => {
    expect(stripMcpPrefix('gmail_search')).toBe('gmail_search');
  });
});
