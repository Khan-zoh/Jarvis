import { z } from 'zod';
import type { drive_v3 } from 'googleapis';
import type { ToolCall, ToolDef } from '../../plugin.js';
import { humanDate } from './dates.js';

/**
 * Drive tools (binding catalog: cdd/plan/tools-and-google.md; drive.readonly scope, so both are
 * read-only).
 *
 *  - drive_search    read  name/fullText search → name, type, modified, link
 *  - drive_read_doc  read  Google Docs → text/plain; Sheets → CSV; other types → metadata only
 *
 * `drive` is null when Google isn't connected; handlers then return the shared setup hint. All
 * googleapis calls thread the per-call AbortSignal.
 */

const DISPLAY_CAP = 10;
const FETCH_HARD_MAX = 25;
const DOC_CHAR_CAP = 20_000;

const DOC_MIME = 'application/vnd.google-apps.document';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';

function opts(call?: ToolCall): { signal?: AbortSignal } {
  return call?.signal ? { signal: call.signal } : {};
}

/** A short spoken type label from a Drive/Google mime type. Exported for tests. */
export function friendlyType(mimeType: string | null | undefined): string {
  const mt = mimeType ?? '';
  const map: Record<string, string> = {
    [DOC_MIME]: 'doc',
    [SHEET_MIME]: 'sheet',
    'application/vnd.google-apps.presentation': 'slides',
    'application/vnd.google-apps.folder': 'folder',
    'application/pdf': 'pdf'
  };
  if (map[mt]) return map[mt]!;
  const slash = mt.lastIndexOf('/');
  return slash >= 0 ? mt.slice(slash + 1) : mt || 'file';
}

/** Escape a value for embedding in a Drive query string literal (single quotes + backslashes). */
function escapeQuery(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function buildDriveTools(
  drive: drive_v3.Drive | null,
  notConnected: string
): ToolDef<any>[] {
  const driveSearch: ToolDef<{ query: string; max?: number }> = {
    name: 'drive_search',
    description:
      'Search Google Drive by name and full-text content. Returns each file with its name, type, ' +
      'last-modified date, and link. Use drive_read_doc with a file id to read a Doc or Sheet.',
    effect: 'read',
    inputSchema: z.object({
      query: z.string().min(1).describe('text to find in file names or contents'),
      max: z
        .number()
        .int()
        .min(1)
        .max(FETCH_HARD_MAX)
        .optional()
        .describe(`how many files to fetch (default ${DISPLAY_CAP}, max ${FETCH_HARD_MAX})`)
    }),
    handler: async ({ query, max }, call) => {
      if (!drive) return { text: notConnected };
      const pageSize = Math.min(max ?? DISPLAY_CAP, FETCH_HARD_MAX);
      const escaped = escapeQuery(query);
      const res = await drive.files.list(
        {
          q: `(name contains '${escaped}' or fullText contains '${escaped}') and trashed = false`,
          pageSize,
          orderBy: 'modifiedTime desc',
          fields: 'files(id,name,mimeType,modifiedTime,webViewLink)'
        },
        opts(call)
      );
      const files = res.data.files ?? [];
      if (files.length === 0) return { text: `no Drive files match "${query}"` };
      const shown = files.slice(0, DISPLAY_CAP);
      const lines = shown.map((f, i) => {
        const type = friendlyType(f.mimeType);
        const when = f.modifiedTime ? humanDate(f.modifiedTime) : '';
        const link = f.webViewLink ? ` — ${f.webViewLink}` : '';
        return `${i + 1}. ${f.name} (${type}${when ? `, ${when}` : ''}) [${f.id}]${link}`;
      });
      const more = files.length > shown.length ? `\nand ${files.length - shown.length} more` : '';
      return { text: `Drive files matching "${query}":\n${lines.join('\n')}${more}` };
    }
  };

  const driveReadDoc: ToolDef<{ fileId: string }> = {
    name: 'drive_read_doc',
    description:
      'Read a Google Drive file by id. Google Docs are returned as text and Google Sheets as CSV ' +
      `(capped at ${DOC_CHAR_CAP} characters). Other file types return metadata only.`,
    effect: 'read',
    inputSchema: z.object({
      fileId: z.string().min(1).describe('the Drive file id to read')
    }),
    handler: async ({ fileId }, call) => {
      if (!drive) return { text: notConnected };
      const meta = await drive.files.get(
        { fileId, fields: 'id,name,mimeType,modifiedTime,size,webViewLink' },
        opts(call)
      );
      const name = meta.data.name ?? '(unnamed)';
      const mime = meta.data.mimeType ?? '';
      if (mime !== DOC_MIME && mime !== SHEET_MIME) {
        const when = meta.data.modifiedTime ? `, modified ${humanDate(meta.data.modifiedTime)}` : '';
        const link = meta.data.webViewLink ? ` — ${meta.data.webViewLink}` : '';
        return {
          text:
            `"${name}" is a ${friendlyType(mime)} file, which can't be read as text here` +
            `${when}${link}`
        };
      }
      const exportMime = mime === DOC_MIME ? 'text/plain' : 'text/csv';
      const res = await drive.files.export(
        { fileId, mimeType: exportMime },
        { ...opts(call), responseType: 'text' }
      );
      const raw = typeof res.data === 'string' ? res.data : String(res.data ?? '');
      const text = raw.trim();
      if (!text) return { text: `"${name}" is empty` };
      const capped = text.length > DOC_CHAR_CAP ? `${text.slice(0, DOC_CHAR_CAP)}… (truncated)` : text;
      return { text: `"${name}":\n${capped}` };
    }
  };

  return [driveSearch, driveReadDoc];
}
