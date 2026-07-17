import { z } from 'zod';
import type { gmail_v1 } from 'googleapis';
import type { ToolCall, ToolDef } from '../../plugin.js';
import { humanDate } from './dates.js';

/**
 * Gmail tools (binding catalog: cdd/plan/tools-and-google.md; effects per amendments.md §A4/A5).
 *
 *  - gmail_search          read     search syntax → from/subject/date/snippet per hit
 *  - gmail_read            read     full body (plain preferred, else HTML stripped), attachments
 *  - gmail_unread_summary  read     newest unread, sender + subject one-liner each
 *  - gmail_send            OUTWARD  RFC2822 assembly + base64url; recipients validated by zod
 *
 * `gmail` is null when Google isn't connected; every handler then returns the shared setup hint,
 * which keeps the tool surface identical whether connected or not (the loader turns the same defs
 * into stub tools). All googleapis calls thread the loader's per-call AbortSignal.
 */

const DISPLAY_CAP = 10;
const FETCH_HARD_MAX = 25;
const BODY_CHAR_CAP = 8_000;

/** Options object passed to every googleapis call — carries the abort signal (gaxios honours it). */
function opts(call?: ToolCall): { signal?: AbortSignal } {
  return call?.signal ? { signal: call.signal } : {};
}

function header(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  const found = headers?.find((h) => (h.name ?? '').toLowerCase() === name.toLowerCase());
  return found?.value ?? '';
}

/** Compact a Gmail "From" header to a spoken name: `Jane Doe <j@x.com>` → `Jane Doe`. */
function friendlyFrom(from: string): string {
  const named = from.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/);
  return (named?.[1] ?? from).trim() || from.trim();
}

export function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function stripHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line, i, arr) => line !== '' || arr[i - 1] !== '')
    .join('\n')
    .trim();
}

/**
 * Walks a message payload preferring text/plain; falls back to stripped text/html. Attachments
 * (parts with a filename + attachmentId) are collected by name, never inlined. Exported for tests.
 */
export function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): {
  text: string;
  attachments: string[];
} {
  const attachments: string[] = [];
  let plain = '';
  let html = '';
  const walk = (part: gmail_v1.Schema$MessagePart | undefined): void => {
    if (!part) return;
    const mime = part.mimeType ?? '';
    if (part.filename && part.body?.attachmentId) {
      attachments.push(part.filename);
      return;
    }
    const data = part.body?.data;
    if (data && mime === 'text/plain') plain += decodeBase64Url(data);
    else if (data && mime === 'text/html') html += decodeBase64Url(data);
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  const text = plain.trim() ? plain.trim() : stripHtml(html);
  return { text, attachments };
}

export function buildGmailTools(
  gmail: gmail_v1.Gmail | null,
  notConnected: string
): ToolDef<any>[] {
  const gmailSearch: ToolDef<{ query: string; max?: number }> = {
    name: 'gmail_search',
    description:
      'Search the connected Gmail account using Gmail search syntax (e.g. "from:alice is:unread ' +
      'newer_than:7d"). Returns sender, subject, date, and a snippet per hit. Use gmail_read with ' +
      'a message id to read the full email.',
    effect: 'read',
    inputSchema: z.object({
      query: z.string().min(1).describe('Gmail search query'),
      max: z
        .number()
        .int()
        .min(1)
        .max(FETCH_HARD_MAX)
        .optional()
        .describe(`how many results to fetch (default ${DISPLAY_CAP}, max ${FETCH_HARD_MAX})`)
    }),
    handler: async ({ query, max }, call) => {
      if (!gmail) return { text: notConnected };
      const maxResults = Math.min(max ?? DISPLAY_CAP, FETCH_HARD_MAX);
      const list = await gmail.users.messages.list(
        { userId: 'me', q: query, maxResults },
        opts(call)
      );
      const ids = (list.data.messages ?? []).map((m) => m.id!).filter(Boolean);
      if (ids.length === 0) return { text: `no emails match "${query}"` };
      const shownIds = ids.slice(0, DISPLAY_CAP);
      const metas = await Promise.all(
        shownIds.map((id) =>
          gmail.users.messages.get(
            {
              userId: 'me',
              id,
              format: 'metadata',
              metadataHeaders: ['From', 'Subject', 'Date']
            },
            opts(call)
          )
        )
      );
      const lines = metas.map((m, i) => {
        const headers = m.data.payload?.headers;
        const from = friendlyFrom(header(headers, 'From')) || '(unknown sender)';
        const subject = header(headers, 'Subject') || '(no subject)';
        const date = header(headers, 'Date');
        const when = date ? humanDate(new Date(date).toISOString()) : '';
        const snippet = (m.data.snippet ?? '').trim();
        const tail = snippet ? ` — ${snippet}` : '';
        return `${i + 1}. ${from}: ${subject}${when ? ` (${when})` : ''} [${shownIds[i]}]${tail}`;
      });
      const more = ids.length > shownIds.length ? `\nand ${ids.length - shownIds.length} more` : '';
      return { text: `emails matching "${query}":\n${lines.join('\n')}${more}` };
    }
  };

  const gmailRead: ToolDef<{ messageId: string }> = {
    name: 'gmail_read',
    description:
      'Read one email in full by its message id (from gmail_search / gmail_unread_summary). ' +
      'Returns sender, subject, date, the body as text, and any attachment names.',
    effect: 'read',
    inputSchema: z.object({
      messageId: z.string().min(1).describe('the Gmail message id to read')
    }),
    handler: async ({ messageId }, call) => {
      if (!gmail) return { text: notConnected };
      const res = await gmail.users.messages.get(
        { userId: 'me', id: messageId, format: 'full' },
        opts(call)
      );
      const headers = res.data.payload?.headers;
      const from = header(headers, 'From') || '(unknown sender)';
      const subject = header(headers, 'Subject') || '(no subject)';
      const date = header(headers, 'Date');
      const when = date ? humanDate(new Date(date).toISOString()) : '';
      const { text, attachments } = extractBody(res.data.payload ?? undefined);
      const body = text.length > BODY_CHAR_CAP ? `${text.slice(0, BODY_CHAR_CAP)}… (truncated)` : text;
      const parts = [
        `from: ${from}`,
        `subject: ${subject}`,
        when ? `date: ${when}` : '',
        attachments.length ? `attachments: ${attachments.join(', ')}` : '',
        '',
        body || '(no readable body)'
      ].filter((p, i) => p !== '' || i === 4);
      return { text: parts.join('\n') };
    }
  };

  const gmailUnreadSummary: ToolDef<{ max?: number }> = {
    name: 'gmail_unread_summary',
    description:
      'Summarize the newest unread emails in the inbox: sender and subject, one line each. ' +
      'Use gmail_read to open any of them.',
    effect: 'read',
    inputSchema: z.object({
      max: z
        .number()
        .int()
        .min(1)
        .max(FETCH_HARD_MAX)
        .optional()
        .describe(`how many unread to summarize (default ${DISPLAY_CAP}, max ${FETCH_HARD_MAX})`)
    }),
    handler: async ({ max }, call) => {
      if (!gmail) return { text: notConnected };
      const maxResults = Math.min(max ?? DISPLAY_CAP, FETCH_HARD_MAX);
      const list = await gmail.users.messages.list(
        { userId: 'me', q: 'is:unread in:inbox', maxResults },
        opts(call)
      );
      const ids = (list.data.messages ?? []).map((m) => m.id!).filter(Boolean);
      if (ids.length === 0) return { text: 'no unread emails' };
      const shownIds = ids.slice(0, DISPLAY_CAP);
      const metas = await Promise.all(
        shownIds.map((id) =>
          gmail.users.messages.get(
            { userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'Subject'] },
            opts(call)
          )
        )
      );
      const lines = metas.map((m, i) => {
        const headers = m.data.payload?.headers;
        const from = friendlyFrom(header(headers, 'From')) || '(unknown sender)';
        const subject = header(headers, 'Subject') || '(no subject)';
        return `${i + 1}. ${from}: ${subject} [${shownIds[i]}]`;
      });
      const more = ids.length > shownIds.length ? `\nand ${ids.length - shownIds.length} more` : '';
      const count = ids.length >= maxResults ? `${ids.length}+` : `${ids.length}`;
      return { text: `${count} unread:\n${lines.join('\n')}${more}` };
    }
  };

  const emailList = z
    .array(z.string().email('must be a valid email address'))
    .min(1, 'at least one recipient is required');

  const gmailSend: ToolDef<{ to: string[]; subject: string; body: string; cc?: string[] }> = {
    name: 'gmail_send',
    description:
      'Send an email from the connected Gmail account. Recipients must be valid email addresses. ' +
      'This sends immediately — confirm the recipients, subject, and body with the user first.',
    effect: 'outward',
    inputSchema: z.object({
      to: emailList.describe('recipient email addresses'),
      subject: z.string().describe('email subject line'),
      body: z.string().describe('plain-text email body'),
      cc: z.array(z.string().email('must be a valid email address')).optional().describe('cc addresses')
    }),
    handler: async ({ to, subject, body, cc }, call) => {
      if (!gmail) return { text: notConnected };
      const raw = buildRawMessage({ to, subject, body, cc });
      await gmail.users.messages.send({ userId: 'me', requestBody: { raw } }, opts(call));
      const recipients = [...to, ...(cc ?? [])].join(', ');
      return { text: `sent "${subject}" to ${recipients}` };
    }
  };

  return [gmailSearch, gmailRead, gmailUnreadSummary, gmailSend];
}

/** RFC2822 message → base64url, the shape gmail.users.messages.send expects. Exported for tests. */
export function buildRawMessage(msg: {
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
}): string {
  const headerLines = [
    `To: ${msg.to.join(', ')}`,
    ...(msg.cc && msg.cc.length ? [`Cc: ${msg.cc.join(', ')}`] : []),
    `Subject: ${encodeHeader(msg.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit'
  ];
  const mime = `${headerLines.join('\r\n')}\r\n\r\n${msg.body}`;
  return Buffer.from(mime, 'utf8').toString('base64url');
}

/** RFC2047-encode a header value only when it carries non-ASCII (keeps plain subjects readable). */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}
