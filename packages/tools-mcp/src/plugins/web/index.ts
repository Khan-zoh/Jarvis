import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { z } from 'zod';
import type { ToolCall, ToolDef, ToolPlugin } from '../../plugin.js';

/**
 * Web plugin — search + page fetch, no API keys (binding catalog: cdd/plan/tools-and-google.md,
 * as amended by cdd/plan/amendments.md A5).
 *
 * - web_search: DuckDuckGo HTML endpoint scrape → title/url/snippet, capped list.
 * - web_fetch:  fetch + tag-strip to readable text, 15k char cap, 10s timeout, http(s) only,
 *   with an SSRF guard: hostnames are resolved and private/loopback/link-local addresses are
 *   refused; at most 3 redirects, each hop re-validated; response bodies byte-capped.
 *
 * `fetch` and DNS lookup are injectable so unit tests never touch the network. Handlers thread
 * the loader's per-call AbortSignal into every network operation.
 */

export interface WebDeps {
  fetchFn: typeof fetch;
  /** Resolves a hostname to all its addresses. Injectable for SSRF-guard tests. */
  lookupFn(hostname: string): Promise<string[]>;
}

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 10_000;
const FETCH_TEXT_CAP = 15_000;
const BODY_BYTE_CAP = 2_000_000; // raw response cap, applied before any text processing
const MAX_REDIRECTS = 3;
const SEARCH_DEFAULT_MAX = 5;
const SEARCH_HARD_MAX = 10;

const defaultLookup = async (hostname: string): Promise<string[]> => {
  const results = await lookup(hostname, { all: true });
  return results.map((r) => r.address);
};

// ---------------------------------------------------------------------------
// SSRF guard (amendments A5)
// ---------------------------------------------------------------------------

/** True for loopback, private, link-local, CGNAT, unspecified, and other non-public ranges. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const parts = ip.split('.').map(Number);
    const [a, b] = [parts[0] ?? -1, parts[1] ?? -1];
    if (a === 0 || a === 10 || a === 127) return true; // unspecified / 10/8 / loopback
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a === 192 && b === 0) return true; // 192.0.0/24 + 192.0.2/24 doc range
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true; // multicast + reserved + broadcast
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    // IPv4-mapped (::ffff:a.b.c.d) → check the embedded IPv4.
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    if (lower === '::' || lower === '::1') return true; // unspecified / loopback
    if (/^f[cd]/.test(lower)) return true; // fc00::/7 unique-local
    if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
    if (/^ff/.test(lower)) return true; // multicast
    return false;
  }
  return true; // not a parseable IP → refuse
}

async function assertPublicHost(hostname: string, lookupFn: WebDeps['lookupFn']): Promise<void> {
  // URL keeps IPv6 literals bracketed — strip for isIP/lookup.
  const host = hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new Error(`refusing to fetch ${host}: private or local address`);
    }
    return;
  }
  const addresses = await lookupFn(host);
  if (addresses.length === 0) throw new Error(`could not resolve ${host}`);
  if (addresses.some((a) => isPrivateAddress(a))) {
    throw new Error(`refusing to fetch ${host}: resolves to a private or local address`);
  }
}

function combineSignals(outer: AbortSignal | undefined, inner: AbortSignal): AbortSignal {
  return outer ? AbortSignal.any([outer, inner]) : inner;
}

async function fetchOnce(
  fetchFn: typeof fetch,
  url: string,
  accept: string,
  outerSignal: AbortSignal | undefined,
  redirect: 'follow' | 'manual'
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetchFn(url, {
      signal: combineSignals(outerSignal, controller.signal),
      redirect,
      headers: { 'user-agent': USER_AGENT, accept }
    });
  } catch (err) {
    if (controller.signal.aborted) throw new Error(`request timed out after 10s: ${url}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * SSRF-guarded fetch: validates scheme + public address for the initial URL and for EVERY
 * redirect hop (redirects are followed manually, max 3). Exported for unit tests.
 */
export async function guardedFetch(
  url: string,
  opts: { fetchFn: typeof fetch; lookupFn: WebDeps['lookupFn']; accept: string; signal?: AbortSignal }
): Promise<Response> {
  let current = url;
  for (let hop = 0; ; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      throw new Error(`invalid URL: ${current}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`only http(s) URLs are allowed, got ${parsed.protocol}//`);
    }
    await assertPublicHost(parsed.hostname, opts.lookupFn);
    const res = await fetchOnce(opts.fetchFn, parsed.href, opts.accept, opts.signal, 'manual');
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location) throw new Error(`redirect without a location header from ${parsed.href}`);
      if (hop >= MAX_REDIRECTS) throw new Error(`too many redirects (max ${MAX_REDIRECTS})`);
      current = new URL(location, parsed).href;
      continue;
    }
    return res;
  }
}

/** Reads a response body up to `maxBytes`; anything past the cap is dropped. */
export async function readBodyCapped(
  res: Response,
  maxBytes: number
): Promise<{ body: string; truncated: boolean }> {
  if (!res.body) return { body: await res.text(), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength >= maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total));
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return { body: Buffer.concat(chunks).toString('utf8'), truncated };
}

// ---------------------------------------------------------------------------
// HTML parsing / text extraction
// ---------------------------------------------------------------------------

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** DuckDuckGo result links point through /l/?uddg=<encoded-real-url>; unwrap them. */
export function unwrapDdgHref(href: string): string {
  try {
    const abs = href.startsWith('//') ? `https:${href}` : href;
    const u = new URL(abs, 'https://duckduckgo.com');
    if (u.pathname === '/l/' || u.pathname.startsWith('/l/')) {
      const real = u.searchParams.get('uddg');
      if (real) return real;
    }
    return abs;
  } catch {
    return href;
  }
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** Parses the DuckDuckGo html.duckduckgo.com/html result page. Exported for unit tests. */
export function parseDdgHtml(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const linkRe =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets: string[] = [];
  for (let m = snippetRe.exec(html); m !== null; m = snippetRe.exec(html)) {
    snippets.push(stripTags(m[1] ?? ''));
  }
  let i = 0;
  for (let m = linkRe.exec(html); m !== null; m = linkRe.exec(html)) {
    const url = unwrapDdgHref(decodeEntities(m[1] ?? ''));
    const title = stripTags(m[2] ?? '');
    if (!title || !url) {
      i++;
      continue;
    }
    hits.push({ title, url, snippet: snippets[i] ?? '' });
    i++;
  }
  return hits;
}

/** Readability-style text extraction: drop non-content blocks, keep block breaks. */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|head|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article|\/blockquote)[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  return decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line, idx, arr) => line !== '' || arr[idx - 1] !== '')
    .join('\n')
    .trim();
}

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

export function createWebPlugin(deps: Partial<WebDeps> = {}): ToolPlugin {
  const fetchFn = deps.fetchFn ?? fetch;
  const lookupFn = deps.lookupFn ?? defaultLookup;

  const webSearch: ToolDef<{ query: string; max?: number }> = {
    name: 'web_search',
    description:
      'Search the web (DuckDuckGo). Returns the top results as title, URL, and snippet. ' +
      'Use web_fetch on a result URL to read the full page.',
    effect: 'read',
    openWorld: true,
    inputSchema: z.object({
      query: z.string().min(1).describe('search query'),
      max: z
        .number()
        .int()
        .min(1)
        .max(SEARCH_HARD_MAX)
        .optional()
        .describe(`how many results (default ${SEARCH_DEFAULT_MAX}, max ${SEARCH_HARD_MAX})`)
    }),
    handler: async ({ query, max }, call?: ToolCall) => {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      // Fixed, known-public host — the SSRF host check is unnecessary here, but the loader's
      // per-call signal and the 10s timeout still apply.
      const res = await fetchOnce(fetchFn, url, 'text/html', call?.signal, 'follow');
      if (!res.ok) throw new Error(`search failed: HTTP ${res.status}`);
      const hits = parseDdgHtml(await res.text());
      if (hits.length === 0) return { text: `no results for "${query}"` };
      const cap = Math.min(max ?? SEARCH_DEFAULT_MAX, SEARCH_HARD_MAX);
      const shown = hits.slice(0, cap);
      const lines = shown.map((h, idx) => {
        const snippet = h.snippet ? `\n   ${h.snippet}` : '';
        return `${idx + 1}. ${h.title} — ${h.url}${snippet}`;
      });
      const more = hits.length > shown.length ? `\nand ${hits.length - shown.length} more` : '';
      return { text: `results for "${query}":\n${lines.join('\n')}${more}` };
    }
  };

  const webFetch: ToolDef<{ url: string }> = {
    name: 'web_fetch',
    description:
      'Fetch a public web page and return its readable text content (tags stripped, capped at ' +
      `${FETCH_TEXT_CAP} characters). Only http/https URLs to public hosts.`,
    effect: 'read',
    openWorld: true,
    inputSchema: z.object({
      url: z
        .string()
        .min(1)
        .refine((u) => /^https?:\/\//i.test(u), 'only http(s) URLs are allowed')
        .describe('the http(s) URL to fetch')
    }),
    handler: async ({ url }, call?: ToolCall) => {
      const res = await guardedFetch(url, {
        fetchFn,
        lookupFn,
        accept: 'text/html,text/plain;q=0.9,*/*;q=0.5',
        signal: call?.signal
      });
      if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status} for ${url}`);
      const contentType = res.headers.get('content-type') ?? '';
      const { body } = await readBodyCapped(res, BODY_BYTE_CAP);
      const text = /html/i.test(contentType) || /^\s*</.test(body) ? htmlToText(body) : body.trim();
      if (!text) return { text: `page at ${url} had no readable text` };
      const capped =
        text.length > FETCH_TEXT_CAP ? `${text.slice(0, FETCH_TEXT_CAP)}… (truncated)` : text;
      return { text: capped };
    }
  };

  return {
    id: 'web',
    displayName: 'Web',
    async init() {
      return { tools: [webSearch, webFetch] };
    }
  };
}

const webPlugin: ToolPlugin = createWebPlugin();
export default webPlugin;
