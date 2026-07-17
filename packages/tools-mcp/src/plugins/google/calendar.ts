import { z } from 'zod';
import type { calendar_v3 } from 'googleapis';
import type { ToolCall, ToolDef } from '../../plugin.js';
import { humanDate, humanTime, humanTimeRange } from './dates.js';

/**
 * Calendar tools (binding catalog: cdd/plan/tools-and-google.md; effects per amendments.md §A4/A5).
 *
 *  - calendar_list_events    read         events in a window: time, title, location, attendee count
 *  - calendar_create_event   OUTWARD      creates on the primary calendar, may invite attendees
 *  - calendar_delete_event   DESTRUCTIVE  removes an event by id
 *  - calendar_find_free_slots read        free gaps 08:00–22:00 local, given a day + duration
 *
 * `calendar` is null when Google isn't connected; handlers then return the shared setup hint,
 * keeping the tool surface stable. All googleapis calls thread the per-call AbortSignal.
 */

const DISPLAY_CAP = 10;
const DAY_START_HOUR = 8; // 08:00 local — free-slot window start (task spec)
const DAY_END_HOUR = 22; // 22:00 local — free-slot window end

function opts(call?: ToolCall): { signal?: AbortSignal } {
  return call?.signal ? { signal: call.signal } : {};
}

const isoString = z.string().min(1).describe('an ISO-8601 timestamp');

export function buildCalendarTools(
  calendar: calendar_v3.Calendar | null,
  notConnected: string
): ToolDef<any>[] {
  const listEvents: ToolDef<{ fromIso: string; toIso: string }> = {
    name: 'calendar_list_events',
    description:
      'List events on the primary calendar between two ISO timestamps. Returns each event with ' +
      'its time, title, location, and attendee count. Use the returned event id with ' +
      'calendar_delete_event.',
    effect: 'read',
    inputSchema: z.object({
      fromIso: isoString.describe('window start (ISO-8601)'),
      toIso: isoString.describe('window end (ISO-8601)')
    }),
    handler: async ({ fromIso, toIso }, call) => {
      if (!calendar) return { text: notConnected };
      const res = await calendar.events.list(
        {
          calendarId: 'primary',
          timeMin: new Date(fromIso).toISOString(),
          timeMax: new Date(toIso).toISOString(),
          singleEvents: true,
          orderBy: 'startTime'
        },
        opts(call)
      );
      const events = res.data.items ?? [];
      if (events.length === 0) {
        return { text: `no events between ${humanDate(fromIso)} and ${humanDate(toIso)}` };
      }
      const shown = events.slice(0, DISPLAY_CAP);
      const lines = shown.map((e, i) => {
        const start = e.start?.dateTime ?? e.start?.date ?? '';
        const end = e.end?.dateTime ?? e.end?.date ?? '';
        const when = start ? humanTimeRange(start, end) : '';
        const title = e.summary ?? '(no title)';
        const where = e.location ? `, at ${e.location}` : '';
        const count = e.attendees?.length ?? 0;
        const who = count ? `, ${count} attendee${count === 1 ? '' : 's'}` : '';
        return `${i + 1}. ${when ? `${when} — ` : ''}${title}${where}${who} [${e.id}]`;
      });
      const more = events.length > shown.length ? `\nand ${events.length - shown.length} more` : '';
      return { text: `events:\n${lines.join('\n')}${more}` };
    }
  };

  const createEvent: ToolDef<{
    title: string;
    startIso: string;
    endIso: string;
    description?: string;
    attendees?: string[];
    location?: string;
  }> = {
    name: 'calendar_create_event',
    description:
      'Create an event on the primary calendar. If attendees are given they are invited by email, ' +
      'so confirm the details with the user first. Returns a confirmation with the event link.',
    effect: 'outward',
    inputSchema: z.object({
      title: z.string().min(1).describe('event title'),
      startIso: isoString.describe('start time (ISO-8601)'),
      endIso: isoString.describe('end time (ISO-8601)'),
      description: z.string().optional().describe('event description / notes'),
      attendees: z
        .array(z.string().email('must be a valid email address'))
        .optional()
        .describe('attendee email addresses to invite'),
      location: z.string().optional().describe('event location')
    }),
    handler: async ({ title, startIso, endIso, description, attendees, location }, call) => {
      if (!calendar) return { text: notConnected };
      const res = await calendar.events.insert(
        {
          calendarId: 'primary',
          sendUpdates: attendees && attendees.length ? 'all' : 'none',
          requestBody: {
            summary: title,
            description,
            location,
            start: { dateTime: new Date(startIso).toISOString() },
            end: { dateTime: new Date(endIso).toISOString() },
            attendees: attendees?.map((email) => ({ email }))
          }
        },
        opts(call)
      );
      const link = res.data.htmlLink ? ` — ${res.data.htmlLink}` : '';
      const invited = attendees && attendees.length ? `, invited ${attendees.join(', ')}` : '';
      return { text: `created "${title}" ${humanTimeRange(startIso, endIso)}${invited}${link}` };
    }
  };

  const deleteEvent: ToolDef<{ eventId: string }> = {
    name: 'calendar_delete_event',
    description:
      'Delete an event from the primary calendar by its event id (from calendar_list_events). ' +
      'This cannot be undone — confirm with the user first.',
    effect: 'destructive',
    inputSchema: z.object({
      eventId: z.string().min(1).describe('the calendar event id to delete')
    }),
    handler: async ({ eventId }, call) => {
      if (!calendar) return { text: notConnected };
      await calendar.events.delete({ calendarId: 'primary', eventId }, opts(call));
      return { text: `deleted event ${eventId}` };
    }
  };

  const findFreeSlots: ToolDef<{ dateIso: string; durationMinutes: number }> = {
    name: 'calendar_find_free_slots',
    description:
      'Find free time slots on a given day that are at least N minutes long, searching between ' +
      '08:00 and 22:00 local time. Uses the primary calendar\'s busy times.',
    effect: 'read',
    inputSchema: z.object({
      dateIso: isoString.describe('any ISO timestamp on the target day'),
      durationMinutes: z.number().int().positive().describe('minimum slot length in minutes')
    }),
    handler: async ({ dateIso, durationMinutes }, call) => {
      if (!calendar) return { text: notConnected };
      const day = new Date(dateIso);
      const windowStart = new Date(day);
      windowStart.setHours(DAY_START_HOUR, 0, 0, 0);
      const windowEnd = new Date(day);
      windowEnd.setHours(DAY_END_HOUR, 0, 0, 0);

      const res = await calendar.freebusy.query(
        {
          requestBody: {
            timeMin: windowStart.toISOString(),
            timeMax: windowEnd.toISOString(),
            items: [{ id: 'primary' }]
          }
        },
        opts(call)
      );
      const busy = (res.data.calendars?.['primary']?.busy ?? [])
        .map((b) => ({ start: new Date(b.start!).getTime(), end: new Date(b.end!).getTime() }))
        .sort((a, b) => a.start - b.start);

      const slots = computeFreeSlots(
        windowStart.getTime(),
        windowEnd.getTime(),
        busy,
        durationMinutes * 60_000
      );
      if (slots.length === 0) {
        return {
          text: `no free slots of ${durationMinutes} min on ${humanDate(dateIso)} between 8am and 10pm`
        };
      }
      const shown = slots.slice(0, DISPLAY_CAP);
      const lines = shown.map(
        (s, i) => `${i + 1}. ${humanTime(new Date(s.start))}–${humanTime(new Date(s.end))}`
      );
      const more = slots.length > shown.length ? `\nand ${slots.length - shown.length} more` : '';
      return {
        text: `free on ${humanDate(dateIso)} (≥${durationMinutes} min):\n${lines.join('\n')}${more}`
      };
    }
  };

  return [listEvents, createEvent, deleteEvent, findFreeSlots];
}

/** Gaps ≥ minMs in [windowStart, windowEnd) not covered by (possibly overlapping) busy blocks. */
export function computeFreeSlots(
  windowStart: number,
  windowEnd: number,
  busy: { start: number; end: number }[],
  minMs: number
): { start: number; end: number }[] {
  const free: { start: number; end: number }[] = [];
  let cursor = windowStart;
  for (const block of busy) {
    const blockStart = Math.max(block.start, windowStart);
    if (blockStart - cursor >= minMs) free.push({ start: cursor, end: blockStart });
    cursor = Math.max(cursor, Math.min(block.end, windowEnd));
    if (cursor >= windowEnd) break;
  }
  if (windowEnd - cursor >= minMs) free.push({ start: cursor, end: windowEnd });
  return free;
}
