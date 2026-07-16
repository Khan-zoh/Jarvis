import { describe, expect, it } from 'vitest';
import {
  createWebPlugin,
  guardedFetch,
  htmlToText,
  isPrivateAddress,
  parseDdgHtml,
  readBodyCapped,
  unwrapDdgHref
} from '../src/plugins/web/index.js';
import type { ToolDef } from '../src/plugin.js';

function ddgResult(title: string, url: string, snippet: string): string {
  const wrapped = `//duckduckgo.com/l/?uddg=${encodeURIComponent(url)}&amp;rut=abc123`;
  return `
    <div class="result results_links results_links_deep web-result">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="${wrapped}">${title}</a>
      </h2>
      <a class="result__snippet" href="${wrapped}">${snippet}</a>
    </div>`;
}

function ddgPage(n: number): string {
  let body = '';
  for (let i = 1; i <= n; i++) {
    body += ddgResult(`Result ${i}`, `https://site${i}.example/page`, `Snippet number ${i}`);
  }
  return `<html><body><div id="links">${body}</div></body></html>`;
}

interface FakeBody {
  body: string;
  status?: number;
  contentType?: string;
  headers?: Record<string, string>;
}

function fakeFetch(bodies: FakeBody[]) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = bodies.shift() ?? { body: '' };
    return new Response(next.body, {
      status: next.status ?? 200,
      headers: {
        'content-type': next.contentType ?? 'text/html; charset=utf-8',
        ...(next.headers ?? {})
      }
    });
  }) as typeof fetch;
  return { calls, fetchFn };
}

/** DNS seam that resolves every hostname to a public address. */
const publicLookup = async () => ['93.184.216.34'];

async function toolsOf(
  fetchFn: typeof fetch,
  lookupFn: (h: string) => Promise<string[]> = publicLookup
): Promise<Map<string, ToolDef<any>>> {
  const plugin = createWebPlugin({ fetchFn, lookupFn });
  const res = await plugin.init({
    dataDir: 'X:\\nowhere',
    config: {},
    secret: () => null,
    logger: { info: () => {}, warn: () => {}, error: () => {} }
  });
  if (!('tools' in res)) throw new Error('web plugin unexpectedly inactive');
  return new Map(res.tools.map((t) => [t.name, t]));
}

describe('unwrapDdgHref', () => {
  it('unwraps the uddg redirect parameter', () => {
    const wrapped = '//duckduckgo.com/l/?uddg=' + encodeURIComponent('https://real.example/x?y=1');
    expect(unwrapDdgHref(wrapped)).toBe('https://real.example/x?y=1');
  });

  it('passes plain URLs through', () => {
    expect(unwrapDdgHref('https://plain.example/')).toBe('https://plain.example/');
  });
});

describe('parseDdgHtml', () => {
  it('extracts title, unwrapped url, and snippet per hit', () => {
    const hits = parseDdgHtml(ddgPage(2));
    expect(hits).toEqual([
      { title: 'Result 1', url: 'https://site1.example/page', snippet: 'Snippet number 1' },
      { title: 'Result 2', url: 'https://site2.example/page', snippet: 'Snippet number 2' }
    ]);
  });

  it('strips markup inside titles and snippets', () => {
    const html = ddgResult('Hello <b>World</b> &amp; co', 'https://x.example/', 'a <em>b</em> c');
    const hits = parseDdgHtml(html);
    expect(hits[0]!.title).toBe('Hello World & co');
    expect(hits[0]!.snippet).toBe('a b c');
  });
});

describe('web_search', () => {
  it('queries the DuckDuckGo html endpoint and formats a numbered list', async () => {
    const { calls, fetchFn } = fakeFetch([{ body: ddgPage(3) }]);
    const tool = (await toolsOf(fetchFn)).get('web_search')!;
    const res = await tool.handler({ query: 'weather today' });
    expect(calls[0]!.url).toBe('https://html.duckduckgo.com/html/?q=weather%20today');
    expect(res.text).toContain('results for "weather today":');
    expect(res.text).toContain('1. Result 1 — https://site1.example/page');
    expect(res.text).toContain('Snippet number 3');
  });

  it('caps at max and appends "and N more"', async () => {
    const { fetchFn } = fakeFetch([{ body: ddgPage(9) }]);
    const tool = (await toolsOf(fetchFn)).get('web_search')!;
    const res = await tool.handler({ query: 'q', max: 2 });
    expect(res.text).toContain('2. Result 2');
    expect(res.text).not.toContain('3. Result 3');
    expect(res.text).toContain('and 7 more');
  });

  it('defaults to 5 results', async () => {
    const { fetchFn } = fakeFetch([{ body: ddgPage(8) }]);
    const tool = (await toolsOf(fetchFn)).get('web_search')!;
    const res = await tool.handler({ query: 'q' });
    expect(res.text).toContain('5. Result 5');
    expect(res.text).not.toContain('6. Result 6');
    expect(res.text).toContain('and 3 more');
  });

  it('reports empty results readably', async () => {
    const { fetchFn } = fakeFetch([{ body: '<html><body>no results</body></html>' }]);
    const tool = (await toolsOf(fetchFn)).get('web_search')!;
    expect((await tool.handler({ query: 'xyzzy' })).text).toBe('no results for "xyzzy"');
  });

  it('sends a user-agent and an abort signal (timeout wiring)', async () => {
    const { calls, fetchFn } = fakeFetch([{ body: ddgPage(1) }]);
    const tool = (await toolsOf(fetchFn)).get('web_search')!;
    await tool.handler({ query: 'q' });
    const init = calls[0]!.init!;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.headers as Record<string, string>)['user-agent']).toContain('Mozilla');
  });

  it("threads the loader's per-call signal into fetch", async () => {
    const { calls, fetchFn } = fakeFetch([{ body: ddgPage(1) }]);
    const tool = (await toolsOf(fetchFn)).get('web_search')!;
    const outer = new AbortController();
    await tool.handler({ query: 'q' }, { signal: outer.signal });
    expect(calls[0]!.init!.signal).toBeInstanceOf(AbortSignal);
    // Aborting the loader's signal aborts the combined fetch signal.
    const { calls: calls2, fetchFn: fetchFn2 } = fakeFetch([{ body: ddgPage(1) }]);
    const tool2 = (await toolsOf(fetchFn2)).get('web_search')!;
    const outer2 = new AbortController();
    outer2.abort();
    await tool2.handler({ query: 'q' }, { signal: outer2.signal }).catch(() => {});
    expect(calls2[0]?.init?.signal?.aborted ?? true).toBe(true);
  });

  it('throws on HTTP errors (loader wraps this into an isError result)', async () => {
    const { fetchFn } = fakeFetch([{ body: 'nope', status: 500 }]);
    const tool = (await toolsOf(fetchFn)).get('web_search')!;
    await expect(tool.handler({ query: 'q' })).rejects.toThrow('HTTP 500');
  });
});

describe('isPrivateAddress (SSRF guard, amendments A5)', () => {
  it('flags private, loopback, link-local, and CGNAT IPv4 ranges', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255'
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('flags loopback, unique-local, link-local, and mapped IPv6', () => {
    for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:192.168.1.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('passes public addresses', () => {
    for (const ip of ['93.184.216.34', '8.8.8.8', '172.15.0.1', '172.32.0.1', '2606:2800:220:1:248:1893:25c8:1946']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});

describe('guardedFetch (SSRF guard + redirects)', () => {
  const accept = 'text/html';

  it('refuses literal private IPs without fetching', async () => {
    const { calls, fetchFn } = fakeFetch([]);
    await expect(
      guardedFetch('http://127.0.0.1:8080/admin', { fetchFn, lookupFn: publicLookup, accept })
    ).rejects.toThrow(/private or local/);
    expect(calls).toHaveLength(0);
  });

  it('refuses hostnames that resolve to private addresses', async () => {
    const { calls, fetchFn } = fakeFetch([]);
    const evilLookup = async () => ['192.168.1.5'];
    await expect(
      guardedFetch('https://internal.example/', { fetchFn, lookupFn: evilLookup, accept })
    ).rejects.toThrow(/resolves to a private/);
    expect(calls).toHaveLength(0);
  });

  it('follows public redirects manually, re-validating each hop', async () => {
    const { calls, fetchFn } = fakeFetch([
      { body: '', status: 302, headers: { location: 'https://next.example/page' } },
      { body: 'final' }
    ]);
    const res = await guardedFetch('https://first.example/', {
      fetchFn,
      lookupFn: publicLookup,
      accept
    });
    expect(await res.text()).toBe('final');
    expect(calls.map((c) => c.url)).toEqual(['https://first.example/', 'https://next.example/page']);
    expect(calls[0]!.init!.redirect).toBe('manual');
  });

  it('refuses a redirect hop that lands on a private address', async () => {
    const lookups: string[] = [];
    const lookupFn = async (h: string) => {
      lookups.push(h);
      return h === 'internal.example' ? ['10.0.0.9'] : ['93.184.216.34'];
    };
    const { fetchFn } = fakeFetch([
      { body: '', status: 302, headers: { location: 'http://internal.example/secret' } }
    ]);
    await expect(
      guardedFetch('https://public.example/', { fetchFn, lookupFn, accept })
    ).rejects.toThrow(/resolves to a private/);
    expect(lookups).toEqual(['public.example', 'internal.example']);
  });

  it('refuses non-http redirect targets', async () => {
    const { fetchFn } = fakeFetch([
      { body: '', status: 302, headers: { location: 'file:///C:/secrets.txt' } }
    ]);
    await expect(
      guardedFetch('https://public.example/', { fetchFn, lookupFn: publicLookup, accept })
    ).rejects.toThrow(/only http\(s\)/);
  });

  it('gives up after 3 redirects', async () => {
    const hop = (n: number): FakeBody => ({
      body: '',
      status: 302,
      headers: { location: `https://hop${n}.example/` }
    });
    const { calls, fetchFn } = fakeFetch([hop(1), hop(2), hop(3), hop(4), { body: 'never' }]);
    await expect(
      guardedFetch('https://start.example/', { fetchFn, lookupFn: publicLookup, accept })
    ).rejects.toThrow(/too many redirects/);
    expect(calls).toHaveLength(4); // initial + 3 followed hops, then refusal
  });
});

describe('readBodyCapped', () => {
  it('caps the raw body at the byte limit', async () => {
    const res = new Response('a'.repeat(1000));
    const { body, truncated } = await readBodyCapped(res, 100);
    expect(body).toHaveLength(100);
    expect(truncated).toBe(true);
  });

  it('passes small bodies through untouched', async () => {
    const res = new Response('hello');
    const { body, truncated } = await readBodyCapped(res, 100);
    expect(body).toBe('hello');
    expect(truncated).toBe(false);
  });
});

describe('htmlToText', () => {
  it('drops scripts/styles and keeps block structure', () => {
    const html = `
      <html><head><title>T</title><style>body{}</style></head>
      <body><script>var x = "<p>evil</p>";</script>
      <h1>Heading</h1><p>Para one &amp; more.</p><ul><li>a</li><li>b</li></ul></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain('Heading');
    expect(text).toContain('Para one & more.');
    expect(text).toContain('a\nb');
    expect(text).not.toContain('var x');
    expect(text).not.toContain('body{}');
    expect(text).not.toContain('<');
  });
});

describe('web_fetch', () => {
  it('fetches and strips a page to readable text', async () => {
    const { calls, fetchFn } = fakeFetch([
      { body: '<html><body><h1>Title</h1><p>Hello world.</p></body></html>' }
    ]);
    const tool = (await toolsOf(fetchFn)).get('web_fetch')!;
    const res = await tool.handler({ url: 'https://example.com/article' });
    expect(calls[0]!.url).toBe('https://example.com/article');
    expect(res.text).toBe('Title\nHello world.');
  });

  it('rejects non-http(s) URLs via schema (loader turns this into an isError result)', async () => {
    const { fetchFn } = fakeFetch([]);
    const tool = (await toolsOf(fetchFn)).get('web_fetch')!;
    const parsed = tool.inputSchema.safeParse({ url: 'file:///C:/secrets.txt' });
    expect(parsed.success).toBe(false);
  });

  it('refuses private targets (SSRF guard) before any fetch', async () => {
    const { calls, fetchFn } = fakeFetch([]);
    const tool = (await toolsOf(fetchFn)).get('web_fetch')!;
    await expect(tool.handler({ url: 'http://169.254.169.254/latest/meta-data/' })).rejects.toThrow(
      /private or local/
    );
    expect(calls).toHaveLength(0);
  });

  it('caps output at 15k characters with a truncation marker', async () => {
    const big = '<html><body><p>' + 'x'.repeat(40_000) + '</p></body></html>';
    const { fetchFn } = fakeFetch([{ body: big }]);
    const tool = (await toolsOf(fetchFn)).get('web_fetch')!;
    const res = await tool.handler({ url: 'https://example.com/big' });
    expect(res.text.length).toBeLessThanOrEqual(15_000 + '… (truncated)'.length);
    expect(res.text.endsWith('… (truncated)')).toBe(true);
  });

  it('returns plain text bodies as-is', async () => {
    const { fetchFn } = fakeFetch([{ body: 'just text\n', contentType: 'text/plain' }]);
    const tool = (await toolsOf(fetchFn)).get('web_fetch')!;
    expect((await tool.handler({ url: 'http://example.com/robots.txt' })).text).toBe('just text');
  });

  it('throws on HTTP errors', async () => {
    const { fetchFn } = fakeFetch([{ body: '', status: 404 }]);
    const tool = (await toolsOf(fetchFn)).get('web_fetch')!;
    await expect(tool.handler({ url: 'https://example.com/missing' })).rejects.toThrow('HTTP 404');
  });
});
