import { describe, expect, it } from 'vitest';
import {
  createSystemPlugin,
  fuzzyScore,
  parseLnkList,
  psQuote
} from '../src/plugins/system/index.js';
import type { ToolDef } from '../src/plugin.js';

interface FakePs {
  scripts: string[];
  runPs(script: string): Promise<string>;
}

/** Fake PowerShell: records scripts, replies from a per-call queue (default ''). */
function fakePs(replies: Array<string | Error> = []): FakePs {
  const scripts: string[] = [];
  return {
    scripts,
    async runPs(script: string) {
      scripts.push(script);
      const reply = replies.shift() ?? '';
      if (reply instanceof Error) throw reply;
      return reply;
    }
  };
}

async function toolsOf(
  deps: Parameters<typeof createSystemPlugin>[0],
  config: Record<string, unknown> = {}
): Promise<Map<string, ToolDef<any>>> {
  const plugin = createSystemPlugin(deps);
  const res = await plugin.init({
    dataDir: 'X:\\nowhere',
    config,
    secret: () => null,
    logger: { info: () => {}, warn: () => {}, error: () => {} }
  });
  if (!('tools' in res)) throw new Error('system plugin unexpectedly inactive');
  return new Map(res.tools.map((t) => [t.name, t]));
}

const LNK_LIST = [
  'Spotify|C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Spotify.lnk',
  'Spotify Web Helper|C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Spotify Web Helper.lnk',
  'Visual Studio Code|C:\\Users\\x\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Visual Studio Code.lnk',
  'Visual Studio 2022|C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Visual Studio 2022.lnk',
  'Word|C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Word.lnk'
].join('\r\n');

describe('psQuote', () => {
  it('escapes single quotes PowerShell-style', () => {
    expect(psQuote("it's a 'test'")).toBe("'it''s a ''test'''");
  });
});

describe('parseLnkList / fuzzyScore', () => {
  it('parses BaseName|FullName lines and ignores junk', () => {
    const entries = parseLnkList('A|C:\\a.lnk\r\nnot-a-line\r\n\r\nB|C:\\b.lnk\n');
    expect(entries).toEqual([
      { name: 'A', path: 'C:\\a.lnk' },
      { name: 'B', path: 'C:\\b.lnk' }
    ]);
  });

  it('ranks exact > prefix > substring > token match', () => {
    expect(fuzzyScore('word', 'Word')).toBe(100);
    expect(fuzzyScore('visual', 'Visual Studio Code')).toBe(85);
    expect(fuzzyScore('studio', 'Visual Studio Code')).toBe(70);
    expect(fuzzyScore('visual code', 'Visual Studio Code')).toBe(60);
    expect(fuzzyScore('zzz', 'Visual Studio Code')).toBe(0);
  });
});

describe('open_app_or_url', () => {
  it('starts http(s) URLs directly without scanning the Start Menu', async () => {
    const ps = fakePs();
    const tool = (await toolsOf({ runPs: ps.runPs })).get('open_app_or_url')!;
    const res = await tool.handler({ target: 'https://example.com/a?b=1' });
    expect(res.text).toBe('opened https://example.com/a?b=1');
    expect(ps.scripts).toHaveLength(1);
    expect(ps.scripts[0]).toBe("Start-Process 'https://example.com/a?b=1'");
  });

  it('upgrades bare www. targets to https', async () => {
    const ps = fakePs();
    const tool = (await toolsOf({ runPs: ps.runPs })).get('open_app_or_url')!;
    const res = await tool.handler({ target: 'www.example.com' });
    expect(res.text).toBe('opened https://www.example.com');
  });

  it('refuses non-http schemes outright (A5)', async () => {
    const ps = fakePs();
    const tool = (await toolsOf({ runPs: ps.runPs })).get('open_app_or_url')!;
    const res = await tool.handler({ target: 'ms-settings:network' });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('only http/https URLs');
    expect(ps.scripts).toHaveLength(0);
  });

  it('refuses file paths by default (A5 gate)', async () => {
    const ps = fakePs();
    const tool = (await toolsOf({ runPs: ps.runPs })).get('open_app_or_url')!;
    const res = await tool.handler({ target: 'C:\\Users\\x\\report.pdf' });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('disabled');
    expect(ps.scripts).toHaveLength(0); // nothing executed
  });

  it('opens file paths when allowUnsafePaths is enabled', async () => {
    const ps = fakePs();
    const tool = (await toolsOf({ runPs: ps.runPs }, { allowUnsafePaths: true })).get(
      'open_app_or_url'
    )!;
    const res = await tool.handler({ target: 'C:\\Users\\x\\report.pdf' });
    expect(res.text).toBe('opened C:\\Users\\x\\report.pdf');
    expect(ps.scripts[0]).toBe("Start-Process 'C:\\Users\\x\\report.pdf'");
  });

  it('resolves an app name via Start-Menu .lnk scan and launches the winner', async () => {
    const ps = fakePs([LNK_LIST, '']);
    const tool = (await toolsOf({ runPs: ps.runPs })).get('open_app_or_url')!;
    const res = await tool.handler({ target: 'word' });
    expect(res.text).toBe('opening Word');
    expect(ps.scripts[0]).toContain('Start Menu');
    expect(ps.scripts[0]).toContain('*.lnk');
    expect(ps.scripts[0]).toContain('$env:ProgramData');
    expect(ps.scripts[0]).toContain('$env:AppData');
    expect(ps.scripts[1]).toBe(
      "Start-Process 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Word.lnk'"
    );
  });

  it('prefix beats substring: "spotify" launches Spotify, not the helper', async () => {
    const ps = fakePs([LNK_LIST, '']);
    const tool = (await toolsOf({ runPs: ps.runPs })).get('open_app_or_url')!;
    const res = await tool.handler({ target: 'spotify' });
    expect(res.text).toBe('opening Spotify');
  });

  it('ambiguous matches list the top candidates instead of launching', async () => {
    const ps = fakePs([LNK_LIST]);
    const tool = (await toolsOf({ runPs: ps.runPs })).get('open_app_or_url')!;
    const res = await tool.handler({ target: 'visual studio' });
    expect(res.text).toContain('multiple apps match "visual studio"');
    expect(res.text).toContain('Visual Studio Code');
    expect(res.text).toContain('Visual Studio 2022');
    expect(ps.scripts).toHaveLength(1); // scan only — nothing launched
  });

  it('refuses the PATH fallback by default when no shortcut matches (A5 gate)', async () => {
    const ps = fakePs(['']);
    const tool = (await toolsOf({ runPs: ps.runPs })).get('open_app_or_url')!;
    const res = await tool.handler({ target: 'notepad' });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('no Start Menu app matches "notepad"');
    expect(ps.scripts).toHaveLength(1); // scan only, no Start-Process
  });

  it('allows the PATH fallback when allowUnsafePaths is enabled', async () => {
    const ps = fakePs(['', '']);
    const tool = (await toolsOf({ runPs: ps.runPs }, { allowUnsafePaths: true })).get(
      'open_app_or_url'
    )!;
    const res = await tool.handler({ target: 'notepad' });
    expect(res.text).toBe('opened notepad');
    expect(ps.scripts[1]).toBe("Start-Process 'notepad'");
  });

  it('reports not-found when the opt-in fallback launch also fails', async () => {
    const ps = fakePs(['', new Error('not recognized')]);
    const tool = (await toolsOf({ runPs: ps.runPs }, { allowUnsafePaths: true })).get(
      'open_app_or_url'
    )!;
    const res = await tool.handler({ target: 'no such app' });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('could not find');
  });
});

describe('system_media', () => {
  it('presses the media key via keybd_event P/Invoke (down + up)', async () => {
    const ps = fakePs();
    const tool = (await toolsOf({ runPs: ps.runPs })).get('system_media')!;
    const res = await tool.handler({ action: 'play_pause' });
    expect(res.text).toBe('pressed play/pause');
    const script = ps.scripts[0]!;
    expect(script).toContain('keybd_event');
    expect(script).toContain('user32.dll');
    expect(script).toContain('0xB3, 0, 0');
    expect(script).toContain('0xB3, 0, 2');
  });

  it('maps every action to its virtual-key code', async () => {
    const cases: Array<[string, string]> = [
      ['next', '0xB0'],
      ['previous', '0xB1'],
      ['volume_up', '0xAF'],
      ['volume_down', '0xAE'],
      ['mute', '0xAD']
    ];
    for (const [action, vk] of cases) {
      const ps = fakePs();
      const tool = (await toolsOf({ runPs: ps.runPs })).get('system_media')!;
      await tool.handler({ action });
      expect(ps.scripts[0]).toContain(vk);
    }
  });
});

describe('clipboard tools', () => {
  it('clipboard_read uses Get-Clipboard -Raw and reports contents', async () => {
    const ps = fakePs(['hello there\r\n']);
    const tool = (await toolsOf({ runPs: ps.runPs })).get('clipboard_read')!;
    const res = await tool.handler({});
    expect(ps.scripts[0]).toBe('Get-Clipboard -Raw');
    expect(res.text).toBe('clipboard contents: hello there');
  });

  it('clipboard_read reports an empty clipboard', async () => {
    const ps = fakePs(['']);
    const tool = (await toolsOf({ runPs: ps.runPs })).get('clipboard_read')!;
    expect((await tool.handler({})).text).toBe('clipboard is empty');
  });

  it('clipboard_write quotes the payload into Set-Clipboard', async () => {
    const ps = fakePs();
    const tool = (await toolsOf({ runPs: ps.runPs })).get('clipboard_write')!;
    const res = await tool.handler({ text: "bob's data" });
    expect(ps.scripts[0]).toBe("Set-Clipboard -Value 'bob''s data'");
    expect(res.text).toBe('copied to clipboard');
  });
});

describe('window_focus', () => {
  it('uses EnumWindows/SetForegroundWindow P/Invoke and reports the focused title', async () => {
    const ps = fakePs(['Untitled - Notepad']);
    const tool = (await toolsOf({ runPs: ps.runPs })).get('window_focus')!;
    const res = await tool.handler({ titleContains: 'notepad' });
    const script = ps.scripts[0]!;
    expect(script).toContain('EnumWindows');
    expect(script).toContain('SetForegroundWindow');
    expect(script).toContain('IsWindowVisible');
    expect(script).toContain("FocusFirst('notepad')");
    expect(res.text).toBe('focused window "Untitled - Notepad"');
  });

  it('reports when no window matches', async () => {
    const ps = fakePs(['']);
    const tool = (await toolsOf({ runPs: ps.runPs })).get('window_focus')!;
    expect((await tool.handler({ titleContains: 'zzz' })).text).toBe(
      'no window with a title containing "zzz"'
    );
  });
});

describe('timer_set (durable scheduled task, amendments A3)', () => {
  it('registers a self-deleting one-shot scheduled task with the toast payload', async () => {
    const ps = fakePs();
    const fixedNow = new Date(2026, 6, 15, 14, 0, 0);
    const tool = (
      await toolsOf({ runPs: ps.runPs, now: () => fixedNow, uniqueId: () => 'test1' })
    ).get('timer_set')!;

    const res = await tool.handler({ minutes: 10, label: 'tea' });
    expect(res.text).toBe('timer set for "tea" — I\'ll notify you at 14:10');
    expect(ps.scripts).toHaveLength(1);

    const script = ps.scripts[0]!;
    // Durable one-shot scheduled task, unique name, correct fire time.
    expect(script).toContain('Register-ScheduledTask');
    expect(script).toContain('New-ScheduledTaskTrigger -Once');
    expect(script).toContain("'JarvisTimer_test1'");
    expect(script).toContain("[datetime]'2026-07-15T14:10:00'");
    expect(script).toContain('-WindowStyle Hidden');

    // The payload rides as -EncodedCommand: decode and verify toast + self-delete.
    const encoded = script.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)?.[1];
    expect(encoded).toBeTruthy();
    const payload = Buffer.from(encoded!, 'base64').toString('utf16le');
    expect(payload).toContain('ToastNotificationManager');
    expect(payload).toContain('Jarvis timer');
    expect(payload).toContain('tea');
    expect(payload).toContain("Unregister-ScheduledTask -TaskName 'JarvisTimer_test1'");
  });

  it('supports fractional minutes with second precision', async () => {
    const ps = fakePs();
    const fixedNow = new Date(2026, 0, 1, 8, 30, 0);
    const tool = (
      await toolsOf({ runPs: ps.runPs, now: () => fixedNow, uniqueId: () => 'abc' })
    ).get('timer_set')!;
    const res = await tool.handler({ minutes: 0.5 });
    expect(res.text).toContain('08:30'); // 30s after 08:30:00 is still 08:30
    expect(ps.scripts[0]).toContain("[datetime]'2026-01-01T08:30:30'"); // seconds preserved
  });

  it('a failed task registration propagates (loader wraps it as an isError result)', async () => {
    const tool = (
      await toolsOf({
        runPs: async () => {
          throw new Error('access denied');
        },
        now: () => new Date(2026, 0, 1, 8, 30, 0),
        uniqueId: () => 'x'
      })
    ).get('timer_set')!;
    await expect(tool.handler({ minutes: 1 })).rejects.toThrow('access denied');
  });
});
