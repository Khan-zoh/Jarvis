import { describe, expect, it } from 'vitest';
import type { calendar_v3, drive_v3, gmail_v1 } from 'googleapis';
import type { PluginContext, ToolDef } from '../../src/plugin.js';
import type { GoogleClients } from '../../src/google/auth.js';
import {
  buildGmailTools,
  buildRawMessage,
  decodeBase64Url,
  extractBody
} from '../../src/plugins/google/gmail.js';
import { buildCalendarTools, computeFreeSlots } from '../../src/plugins/google/calendar.js';
import { buildDriveTools, friendlyType } from '../../src/plugins/google/drive.js';
import { createGooglePlugin } from '../../src/plugins/google/index.js';
import { humanDate, humanTime, humanTimeRange } from '../../src/plugins/google/dates.js';

const b64url = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

function byName(tools: ToolDef<any>[]): Map<string, ToolDef<any>> {
  return new Map(tools.map((t) => [t.name, t]));
}

// ---------------------------------------------------------------------------
// dates
// ---------------------------------------------------------------------------

describe('dates', () => {
  it('humanTime drops :00 and uses 12h am/pm', () => {
    expect(humanTime(new Date(2025, 6, 14, 15, 0))).toBe('3pm');
    expect(humanTime(new Date(2025, 6, 14, 15, 30))).toBe('3:30pm');
    expect(humanTime(new Date(2025, 6, 14, 0, 0))).toBe('12am');
    expect(humanTime(new Date(2025, 6, 14, 12, 0))).toBe('12pm');
  });

  it('humanDate formats a local timestamp as "wd mon d, time"', () => {
    // No offset → parsed as local time; 2025-07-14 is a Monday.
    expect(humanDate('2025-07-14T15:00:00')).toBe('mon jul 14, 3pm');
  });

  it('humanDate renders a date-only value with no clock and no tz drift', () => {
    expect(humanDate('2025-07-14')).toBe('mon jul 14');
  });

  it('humanTimeRange collapses a same-day window and marks all-day', () => {
    expect(humanTimeRange('2025-07-14T15:00:00', '2025-07-14T16:00:00')).toBe('mon jul 14, 3pm–4pm');
    expect(humanTimeRange('2025-07-14T23:00:00', '2025-07-15T01:00:00')).toBe(
      'mon jul 14, 11pm – tue jul 15, 1am'
    );
    expect(humanTimeRange('2025-07-14', '2025-07-15')).toBe('mon jul 14 (all day)');
  });
});

// ---------------------------------------------------------------------------
// gmail helpers
// ---------------------------------------------------------------------------

describe('extractBody', () => {
  it('prefers the text/plain part of a multipart message', () => {
    const { text } = extractBody({
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: b64url('Hello plain body') } },
        { mimeType: 'text/html', body: { data: b64url('<p>Hello <b>html</b></p>') } }
      ]
    });
    expect(text).toBe('Hello plain body');
  });

  it('strips tags from an html-only message', () => {
    const { text } = extractBody({
      mimeType: 'text/html',
      body: { data: b64url('<p>Hi <b>there</b></p><script>evil()</script>') }
    });
    expect(text).toBe('Hi there');
    expect(text).not.toContain('evil');
  });

  it('lists attachment filenames instead of inlining them', () => {
    const { attachments } = extractBody({
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', body: { data: b64url('see attached') } },
        { mimeType: 'application/pdf', filename: 'report.pdf', body: { attachmentId: 'a1' } }
      ]
    });
    expect(attachments).toEqual(['report.pdf']);
  });
});

describe('buildRawMessage', () => {
  it('assembles RFC2822 headers + body and base64url-encodes it', () => {
    const raw = buildRawMessage({
      to: ['a@x.com', 'b@x.com'],
      cc: ['c@x.com'],
      subject: 'Hi there',
      body: 'line one\nline two'
    });
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    expect(decoded).toContain('To: a@x.com, b@x.com');
    expect(decoded).toContain('Cc: c@x.com');
    expect(decoded).toContain('Subject: Hi there');
    expect(decoded).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(decoded.endsWith('line one\nline two')).toBe(true);
    // raw must be URL-safe base64 (no + / =)
    expect(raw).not.toMatch(/[+/=]/);
  });

  it('RFC2047-encodes a non-ASCII subject', () => {
    const raw = buildRawMessage({ to: ['a@x.com'], subject: 'café ☕', body: 'x' });
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    expect(decoded).toContain('Subject: =?UTF-8?B?');
  });
});

// ---------------------------------------------------------------------------
// gmail tools (fake client)
// ---------------------------------------------------------------------------

interface GmailScript {
  list?: (params: any) => gmail_v1.Schema$ListMessagesResponse;
  get?: (params: any) => gmail_v1.Schema$Message;
}

function fakeGmail(script: GmailScript) {
  const calls = { list: [] as any[], get: [] as any[], send: [] as any[] };
  const client = {
    users: {
      messages: {
        list: async (params: any, options: any) => {
          calls.list.push({ params, options });
          return { data: script.list?.(params) ?? {} };
        },
        get: async (params: any, options: any) => {
          calls.get.push({ params, options });
          return { data: script.get?.(params) ?? {} };
        },
        send: async (params: any, options: any) => {
          calls.send.push({ params, options });
          return { data: { id: 'sent1' } };
        }
      }
    }
  };
  return { calls, client: client as unknown as gmail_v1.Gmail };
}

function metaMessage(id: string, from: string, subject: string, snippet: string): gmail_v1.Schema$Message {
  return {
    id,
    snippet,
    payload: {
      headers: [
        { name: 'From', value: from },
        { name: 'Subject', value: subject },
        { name: 'Date', value: 'Mon, 14 Jul 2025 15:00:00 +0000' }
      ]
    }
  };
}

describe('gmail_search', () => {
  it('sends the exact list + metadata-get requests and formats hits with ids', async () => {
    const { calls, client } = fakeGmail({
      list: () => ({ messages: [{ id: 'm1' }, { id: 'm2' }] }),
      get: ({ id }) => metaMessage(id, `Jane Doe <jane@x.com>`, `Subject ${id}`, `snippet ${id}`)
    });
    const tool = byName(buildGmailTools(client, 'NC')).get('gmail_search')!;
    const outer = new AbortController();
    const res = await tool.handler({ query: 'is:unread', max: 5 }, { signal: outer.signal });

    expect(calls.list[0].params).toEqual({ userId: 'me', q: 'is:unread', maxResults: 5 });
    expect(calls.list[0].options.signal).toBe(outer.signal); // per-call signal threaded
    expect(calls.get[0].params).toEqual({
      userId: 'me',
      id: 'm1',
      format: 'metadata',
      metadataHeaders: ['From', 'Subject', 'Date']
    });
    expect(res.text).toContain('1. Jane Doe: Subject m1');
    expect(res.text).toContain('[m1]');
    expect(res.text).toContain('snippet m1');
  });

  it('caps display at 10 and appends "and N more"', async () => {
    const ids = Array.from({ length: 14 }, (_, i) => ({ id: `m${i + 1}` }));
    const { client } = fakeGmail({
      list: () => ({ messages: ids }),
      get: ({ id }) => metaMessage(id, 'a@x.com', `S ${id}`, '')
    });
    const tool = byName(buildGmailTools(client, 'NC')).get('gmail_search')!;
    const res = await tool.handler({ query: 'q', max: 25 });
    expect(res.text).toContain('10. ');
    expect(res.text).not.toContain('11. ');
    expect(res.text).toContain('and 4 more');
  });

  it('reports no matches readably', async () => {
    const { client } = fakeGmail({ list: () => ({ messages: [] }) });
    const tool = byName(buildGmailTools(client, 'NC')).get('gmail_search')!;
    expect((await tool.handler({ query: 'zzz' })).text).toBe('no emails match "zzz"');
  });
});

describe('gmail_read', () => {
  it('fetches the full message and returns headers + decoded body + attachments', async () => {
    const { calls, client } = fakeGmail({
      get: () => ({
        id: 'm1',
        payload: {
          mimeType: 'multipart/mixed',
          headers: [
            { name: 'From', value: 'Bob <bob@x.com>' },
            { name: 'Subject', value: 'Report' },
            { name: 'Date', value: 'Mon, 14 Jul 2025 15:00:00 +0000' }
          ],
          parts: [
            { mimeType: 'text/plain', body: { data: b64url('the body text') } },
            { mimeType: 'application/pdf', filename: 'q3.pdf', body: { attachmentId: 'a1' } }
          ]
        }
      })
    });
    const tool = byName(buildGmailTools(client, 'NC')).get('gmail_read')!;
    const res = await tool.handler({ messageId: 'm1' });
    expect(calls.get[0].params).toEqual({ userId: 'me', id: 'm1', format: 'full' });
    expect(res.text).toContain('from: Bob <bob@x.com>');
    expect(res.text).toContain('subject: Report');
    expect(res.text).toContain('attachments: q3.pdf');
    expect(res.text).toContain('the body text');
  });

  it('caps the body at 8k characters', async () => {
    const { client } = fakeGmail({
      get: () => ({
        payload: { mimeType: 'text/plain', headers: [], body: { data: b64url('x'.repeat(9000)) } }
      })
    });
    const tool = byName(buildGmailTools(client, 'NC')).get('gmail_read')!;
    const res = await tool.handler({ messageId: 'm1' });
    expect(res.text).toContain('… (truncated)');
    expect(res.text.length).toBeLessThan(8200);
  });
});

describe('gmail_unread_summary', () => {
  it('queries unread inbox and lists sender + subject one-liners', async () => {
    const { calls, client } = fakeGmail({
      list: () => ({ messages: [{ id: 'u1' }, { id: 'u2' }] }),
      get: ({ id }) => metaMessage(id, `Al <al@x.com>`, `Unread ${id}`, '')
    });
    const tool = byName(buildGmailTools(client, 'NC')).get('gmail_unread_summary')!;
    const res = await tool.handler({});
    expect(calls.list[0].params).toEqual({ userId: 'me', q: 'is:unread in:inbox', maxResults: 10 });
    expect(res.text).toContain('2 unread:');
    expect(res.text).toContain('1. Al: Unread u1 [u1]');
  });

  it('says so when nothing is unread', async () => {
    const { client } = fakeGmail({ list: () => ({ messages: [] }) });
    const tool = byName(buildGmailTools(client, 'NC')).get('gmail_unread_summary')!;
    expect((await tool.handler({})).text).toBe('no unread emails');
  });
});

describe('gmail_send', () => {
  it('is annotated outward and sends a base64url raw message', async () => {
    const { calls, client } = fakeGmail({});
    const tool = byName(buildGmailTools(client, 'NC')).get('gmail_send')!;
    expect(tool.effect).toBe('outward');
    const res = await tool.handler({
      to: ['x@y.com'],
      cc: ['z@y.com'],
      subject: 'Hi',
      body: 'hello'
    });
    const raw = calls.send[0].params.requestBody.raw as string;
    expect(Buffer.from(raw, 'base64url').toString('utf8')).toContain('To: x@y.com');
    expect(res.text).toBe('sent "Hi" to x@y.com, z@y.com');
  });

  it('rejects invalid recipient emails at the schema', () => {
    const tool = byName(buildGmailTools(null, 'NC')).get('gmail_send')!;
    expect(tool.inputSchema.safeParse({ to: ['not-an-email'], subject: 's', body: 'b' }).success).toBe(
      false
    );
    expect(tool.inputSchema.safeParse({ to: [], subject: 's', body: 'b' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// calendar tools
// ---------------------------------------------------------------------------

function fakeCalendar(script: {
  list?: (p: any) => calendar_v3.Schema$Events;
  insert?: (p: any) => calendar_v3.Schema$Event;
  freebusy?: (p: any) => calendar_v3.Schema$FreeBusyResponse;
}) {
  const calls = { list: [] as any[], insert: [] as any[], delete: [] as any[], freebusy: [] as any[] };
  const client = {
    events: {
      list: async (params: any, options: any) => {
        calls.list.push({ params, options });
        return { data: script.list?.(params) ?? {} };
      },
      insert: async (params: any, options: any) => {
        calls.insert.push({ params, options });
        return { data: script.insert?.(params) ?? {} };
      },
      delete: async (params: any, options: any) => {
        calls.delete.push({ params, options });
        return { data: {} };
      }
    },
    freebusy: {
      query: async (params: any, options: any) => {
        calls.freebusy.push({ params, options });
        return { data: script.freebusy?.(params) ?? {} };
      }
    }
  };
  return { calls, client: client as unknown as calendar_v3.Calendar };
}

describe('calendar_list_events', () => {
  it('requests singleEvents ordered by start time and formats each event', async () => {
    const { calls, client } = fakeCalendar({
      list: () => ({
        items: [
          {
            id: 'e1',
            summary: 'Standup',
            location: 'Room 2',
            start: { dateTime: '2025-07-14T15:00:00' },
            end: { dateTime: '2025-07-14T15:30:00' },
            attendees: [{ email: 'a@x.com' }, { email: 'b@x.com' }]
          }
        ]
      })
    });
    const tool = byName(buildCalendarTools(client, 'NC')).get('calendar_list_events')!;
    const res = await tool.handler({ fromIso: '2025-07-14T00:00:00', toIso: '2025-07-14T23:59:59' });
    const p = calls.list[0].params;
    expect(p.calendarId).toBe('primary');
    expect(p.singleEvents).toBe(true);
    expect(p.orderBy).toBe('startTime');
    expect(res.text).toContain('mon jul 14, 3pm–3:30pm — Standup, at Room 2, 2 attendees [e1]');
  });

  it('reports an empty window', async () => {
    const { client } = fakeCalendar({ list: () => ({ items: [] }) });
    const tool = byName(buildCalendarTools(client, 'NC')).get('calendar_list_events')!;
    expect((await tool.handler({ fromIso: '2025-07-14', toIso: '2025-07-15' })).text).toContain(
      'no events between'
    );
  });
});

describe('calendar_create_event', () => {
  it('is outward, inserts with sendUpdates=all when attendees are present, returns the link', async () => {
    const { calls, client } = fakeCalendar({
      insert: () => ({ htmlLink: 'https://cal/e9' })
    });
    const tool = byName(buildCalendarTools(client, 'NC')).get('calendar_create_event')!;
    expect(tool.effect).toBe('outward');
    const res = await tool.handler({
      title: 'Sync',
      startIso: '2025-07-14T15:00:00',
      endIso: '2025-07-14T16:00:00',
      attendees: ['a@x.com']
    });
    const body = calls.insert[0].params.requestBody;
    expect(calls.insert[0].params.sendUpdates).toBe('all');
    expect(body.summary).toBe('Sync');
    expect(body.attendees).toEqual([{ email: 'a@x.com' }]);
    expect(res.text).toContain('created "Sync" mon jul 14, 3pm–4pm');
    expect(res.text).toContain('https://cal/e9');
  });

  it('uses sendUpdates=none without attendees', async () => {
    const { calls, client } = fakeCalendar({ insert: () => ({}) });
    const tool = byName(buildCalendarTools(client, 'NC')).get('calendar_create_event')!;
    await tool.handler({ title: 'Solo', startIso: '2025-07-14T15:00:00', endIso: '2025-07-14T16:00:00' });
    expect(calls.insert[0].params.sendUpdates).toBe('none');
  });
});

describe('calendar_delete_event', () => {
  it('is destructive and deletes by id', async () => {
    const { calls, client } = fakeCalendar({});
    const tool = byName(buildCalendarTools(client, 'NC')).get('calendar_delete_event')!;
    expect(tool.effect).toBe('destructive');
    const res = await tool.handler({ eventId: 'e1' });
    expect(calls.delete[0].params).toEqual({ calendarId: 'primary', eventId: 'e1' });
    expect(res.text).toBe('deleted event e1');
  });
});

describe('computeFreeSlots', () => {
  const H = (h: number) => new Date(2025, 6, 14, h, 0).getTime();

  it('returns gaps between busy blocks meeting the minimum', () => {
    const slots = computeFreeSlots(
      H(8),
      H(22),
      [
        { start: H(9), end: H(10) },
        { start: H(13), end: H(14) }
      ],
      60 * 60_000
    );
    expect(slots).toEqual([
      { start: H(8), end: H(9) },
      { start: H(10), end: H(13) },
      { start: H(14), end: H(22) }
    ]);
  });

  it('merges overlapping busy blocks and drops sub-minimum gaps', () => {
    const slots = computeFreeSlots(
      H(8),
      H(12),
      [
        { start: H(9), end: H(11) },
        { start: H(10), end: H(11) } // overlaps the previous
      ],
      90 * 60_000
    );
    // 8–9 is only 60 min (< 90), dropped; 11–12 is 60 min, dropped → nothing qualifies.
    expect(slots).toEqual([]);
  });
});

describe('calendar_find_free_slots', () => {
  it('queries freebusy for the 08:00–22:00 window and lists free times', async () => {
    const { calls, client } = fakeCalendar({
      freebusy: () => ({ calendars: { primary: { busy: [] } } })
    });
    const tool = byName(buildCalendarTools(client, 'NC')).get('calendar_find_free_slots')!;
    const res = await tool.handler({ dateIso: '2025-07-14T12:00:00', durationMinutes: 30 });
    const body = calls.freebusy[0].params.requestBody;
    expect(body.items).toEqual([{ id: 'primary' }]);
    expect(new Date(body.timeMin).getHours()).toBe(8);
    expect(new Date(body.timeMax).getHours()).toBe(22);
    expect(res.text).toContain('free on mon jul 14');
    expect(res.text).toContain('8am–10pm');
  });
});

// ---------------------------------------------------------------------------
// drive tools
// ---------------------------------------------------------------------------

function fakeDrive(script: {
  list?: (p: any) => drive_v3.Schema$FileList;
  get?: (p: any) => drive_v3.Schema$File;
  export?: (p: any) => string;
}) {
  const calls = { list: [] as any[], get: [] as any[], export: [] as any[] };
  const client = {
    files: {
      list: async (params: any, options: any) => {
        calls.list.push({ params, options });
        return { data: script.list?.(params) ?? {} };
      },
      get: async (params: any, options: any) => {
        calls.get.push({ params, options });
        return { data: script.get?.(params) ?? {} };
      },
      export: async (params: any, options: any) => {
        calls.export.push({ params, options });
        return { data: script.export?.(params) ?? '' };
      }
    }
  };
  return { calls, client: client as unknown as drive_v3.Drive };
}

describe('friendlyType', () => {
  it('maps google types and falls back to the mime subtype', () => {
    expect(friendlyType('application/vnd.google-apps.document')).toBe('doc');
    expect(friendlyType('application/vnd.google-apps.spreadsheet')).toBe('sheet');
    expect(friendlyType('image/png')).toBe('png');
  });
});

describe('drive_search', () => {
  it('builds a name+fullText query excluding trashed and formats results', async () => {
    const { calls, client } = fakeDrive({
      list: () => ({
        files: [
          {
            id: 'f1',
            name: 'Resume',
            mimeType: 'application/vnd.google-apps.document',
            modifiedTime: '2025-07-14T15:00:00',
            webViewLink: 'https://drive/f1'
          }
        ]
      })
    });
    const tool = byName(buildDriveTools(client, 'NC')).get('drive_search')!;
    const res = await tool.handler({ query: 'resume' });
    expect(calls.list[0].params.q).toBe(
      "(name contains 'resume' or fullText contains 'resume') and trashed = false"
    );
    expect(calls.list[0].params.orderBy).toBe('modifiedTime desc');
    expect(res.text).toContain('1. Resume (doc');
    expect(res.text).toContain('[f1]');
    expect(res.text).toContain('https://drive/f1');
  });

  it('escapes quotes in the query', async () => {
    const { calls, client } = fakeDrive({ list: () => ({ files: [] }) });
    const tool = byName(buildDriveTools(client, 'NC')).get('drive_search')!;
    await tool.handler({ query: "o'brien" });
    expect(calls.list[0].params.q).toContain("name contains 'o\\'brien'");
  });
});

describe('drive_read_doc', () => {
  it('exports a Google Doc as text/plain', async () => {
    const { calls, client } = fakeDrive({
      get: () => ({ name: 'Notes', mimeType: 'application/vnd.google-apps.document' }),
      export: () => 'the document text'
    });
    const tool = byName(buildDriveTools(client, 'NC')).get('drive_read_doc')!;
    const res = await tool.handler({ fileId: 'f1' });
    expect(calls.export[0].params).toEqual({ fileId: 'f1', mimeType: 'text/plain' });
    expect(res.text).toBe('"Notes":\nthe document text');
  });

  it('exports a Google Sheet as CSV', async () => {
    const { calls, client } = fakeDrive({
      get: () => ({ name: 'Budget', mimeType: 'application/vnd.google-apps.spreadsheet' }),
      export: () => 'a,b\n1,2'
    });
    const tool = byName(buildDriveTools(client, 'NC')).get('drive_read_doc')!;
    await tool.handler({ fileId: 'f2' });
    expect(calls.export[0].params.mimeType).toBe('text/csv');
  });

  it('returns metadata only for a non-exportable type', async () => {
    const { calls, client } = fakeDrive({
      get: () => ({ name: 'photo.png', mimeType: 'image/png', webViewLink: 'https://drive/p' })
    });
    const tool = byName(buildDriveTools(client, 'NC')).get('drive_read_doc')!;
    const res = await tool.handler({ fileId: 'p1' });
    expect(calls.export).toHaveLength(0);
    expect(res.text).toContain("\"photo.png\" is a png file, which can't be read as text here");
  });

  it('caps exported text at 20k characters', async () => {
    const { client } = fakeDrive({
      get: () => ({ name: 'Big', mimeType: 'application/vnd.google-apps.document' }),
      export: () => 'y'.repeat(25_000)
    });
    const tool = byName(buildDriveTools(client, 'NC')).get('drive_read_doc')!;
    const res = await tool.handler({ fileId: 'f9' });
    expect(res.text).toContain('… (truncated)');
    expect(res.text.length).toBeLessThan(20_200);
  });
});

// ---------------------------------------------------------------------------
// plugin wiring (seam)
// ---------------------------------------------------------------------------

function ctx(): PluginContext {
  return {
    dataDir: 'X:\\nowhere',
    config: {},
    secret: () => null,
    logger: { info: () => {}, warn: () => {}, error: () => {} }
  };
}

const ALL_GOOGLE_TOOLS = [
  'gmail_search',
  'gmail_read',
  'gmail_unread_summary',
  'gmail_send',
  'calendar_list_events',
  'calendar_create_event',
  'calendar_delete_event',
  'calendar_find_free_slots',
  'drive_search',
  'drive_read_doc'
];

describe('createGooglePlugin', () => {
  it('declares clientId (text) + clientSecret (secret) settings', () => {
    const plugin = createGooglePlugin();
    expect(plugin.id).toBe('google');
    const keys = (plugin.settings ?? []).map((s) => `${s.key}:${s.kind}`);
    expect(keys).toEqual(['clientId:text', 'clientSecret:secret']);
  });

  it('when connected, returns the full real tool surface', async () => {
    const clients = {
      gmail: fakeGmail({}).client,
      calendar: fakeCalendar({}).client,
      drive: fakeDrive({}).client
    } as GoogleClients;
    const plugin = createGooglePlugin({ getClients: () => clients });
    const res = await plugin.init(ctx());
    if (!('tools' in res)) throw new Error('expected active plugin');
    expect(res.tools.map((t) => t.name)).toEqual(ALL_GOOGLE_TOOLS);
  });

  it('when not connected, returns identical tool names as stubs that reply with the setup hint', async () => {
    const plugin = createGooglePlugin({ getClients: () => null });
    const res = await plugin.init(ctx());
    if (!('unavailable' in res)) throw new Error('expected inactive plugin');
    expect(res.unavailable).toContain('not connected');
    expect(res.stubTools.map((t) => t.name)).toEqual(ALL_GOOGLE_TOOLS);
    const send = byName(res.stubTools).get('gmail_send')!;
    expect((await send.handler({ to: ['a@x.com'], subject: 's', body: 'b' })).text).toContain(
      'not connected'
    );
    // effects survive on stubs so annotations stay stable
    expect(send.effect).toBe('outward');
  });
});

describe('decodeBase64Url', () => {
  it('round-trips url-safe base64', () => {
    expect(decodeBase64Url(b64url('hi <there> & you'))).toBe('hi <there> & you');
  });
});
