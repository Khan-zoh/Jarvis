# Task: google-tools

## Objective
Implement all Gmail, Calendar, and Drive tools in tools-mcp per the catalog, registered when
Google is connected.

## Read first
- cdd/plan/tools-and-google.md — tool catalog rows for gmail/calendar/drive (binding:
  names, inputs, behaviors, output-format rules).

## Deliverables
- `src/plugins/google/index.ts` — a `ToolPlugin` (id `google`, `settings` = client id (text) +
  client secret (secret); connection state comes from google-auth). `init` builds clients when
  connected, else returns stub tools with the not-connected message. Add `google` to `PLUGINS`.
- `src/plugins/google/gmail.ts`, `calendar.ts`, `drive.ts` — every catalog tool:
  - gmail_read: decode base64url multipart, prefer text/plain part, strip HTML otherwise;
    body capped 8k chars.
  - gmail_send: RFC2822 assembly + base64url; validate recipient emails with zod.
  - calendar_find_free_slots: freebusy query, compute gaps 08:00–22:00 local.
  - drive_read_doc: files.export for Docs (text/plain) and Sheets (text/csv), metadata-only
    fallback message for other types.
  - All list outputs: cap 10 + "and N more", one line per item, human dates
    ("tue jul 14, 3pm").
- GoogleAuthManager is constructed inside the plugin's `init` from its `PluginContext`; when
  `status().connected` build clients and return real tools, otherwise return stub tools whose
  handlers say "google account not connected — connect it in settings" (keeps the tool surface
  stable).
- Date util `src/plugins/google/dates.ts`: `humanDate(iso)`, `humanTimeRange(startIso,endIso)`.

## Tests
- Every handler with mocked googleapis clients: request params exact (q, maxResults,
  timeMin/timeMax, freebusy body, export mimeType, raw message b64), output text format
  (caps, human dates), unconnected-handler message.
- gmail body decoding: multipart fixture → plain text extracted; html-only fixture →
  tags stripped.
- Live smoke `scripts/smoke/smoke-google.ts` (manual): unread summary, today's events,
  drive search "resume".

## Acceptance
- `npm test` passes; live smoke returns real data from the connected account; MCP `tools/list`
  now includes the google plugin's tools alongside system + web.
