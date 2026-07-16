import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { ToolDef, ToolPlugin } from '../../plugin.js';

/**
 * System plugin — local Windows control (binding catalog: cdd/plan/tools-and-google.md, as
 * amended by cdd/plan/amendments.md A3/A5).
 *
 * Six tools: open_app_or_url, system_media, clipboard_read, clipboard_write, window_focus,
 * timer_set. Everything shells out through a single injectable `runPs(script)` seam so unit
 * tests can fake PowerShell entirely. Deliberately absent: shell-exec / file-write / file-delete
 * — the safety model is "the model can only do what the tool surface allows".
 *
 * A5 guard: open_app_or_url opens http/https URLs and Start-Menu-resolved apps only; arbitrary
 * paths/executables are refused unless the `allowUnsafePaths` setting (default off) is enabled.
 * A3 durability: timer_set registers a one-shot Windows Scheduled Task (self-deleting), NOT an
 * in-process setTimeout — server instances are disposable and may not outlive the timer.
 */

export interface SystemDeps {
  /** Runs a PowerShell script, resolves with stdout. Injectable for tests. */
  runPs(script: string): Promise<string>;
  /** Clock seam for timer_set's fire-time computation. */
  now(): Date;
  /** Unique-suffix seam for scheduled-task names. */
  uniqueId(): string;
}

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

/** Default PowerShell runner: hidden window, 15s hard timeout, never leaves a hanging process. */
export const defaultRunPs = (script: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [...PS_ARGS, script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('powershell timed out after 15s'));
    }, 15_000);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`powershell failed to start: ${err.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`powershell failed: ${(stderr.trim() || `exit code ${code}`).slice(0, 500)}`));
    });
  });

/** Single-quote a value for safe embedding in a PowerShell script ('' escapes '). */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ---------------------------------------------------------------------------
// Embedded PowerShell scripts
// ---------------------------------------------------------------------------

/** Lists every Start-Menu shortcut as "BaseName|FullName" lines (ProgramData + AppData). */
const LIST_START_MENU_LNK_SCRIPT = [
  '$dirs = @("$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs",',
  '          "$env:AppData\\Microsoft\\Windows\\Start Menu\\Programs");',
  'foreach ($d in $dirs) {',
  '  if (Test-Path $d) {',
  '    Get-ChildItem -Path $d -Recurse -Filter *.lnk -ErrorAction SilentlyContinue |',
  "      ForEach-Object { $_.BaseName + '|' + $_.FullName }",
  '  }',
  '}'
].join('\n');

const MEDIA_VK: Record<string, { vk: number; label: string }> = {
  play_pause: { vk: 0xb3, label: 'play/pause' },
  next: { vk: 0xb0, label: 'next track' },
  previous: { vk: 0xb1, label: 'previous track' },
  volume_up: { vk: 0xaf, label: 'volume up' },
  volume_down: { vk: 0xae, label: 'volume down' },
  mute: { vk: 0xad, label: 'mute' }
};

/** Presses a virtual media key via keybd_event P/Invoke (key down, then key up). */
function mediaKeyScript(vk: number): string {
  const hex = '0x' + vk.toString(16).toUpperCase();
  return [
    "$sig = '[DllImport(\"user32.dll\")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);';",
    '$kb = Add-Type -MemberDefinition $sig -Name KbEvent -Namespace JarvisMedia -PassThru;',
    `$kb::keybd_event(${hex}, 0, 0, [UIntPtr]::Zero);`,
    `$kb::keybd_event(${hex}, 0, 2, [UIntPtr]::Zero)`
  ].join('\n');
}

/** EnumWindows + SetForegroundWindow P/Invoke: focuses first visible window whose title matches. */
function windowFocusScript(titleContains: string): string {
  const csharp = [
    'using System;',
    'using System.Runtime.InteropServices;',
    'using System.Text;',
    'public class JarvisWin {',
    '  delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);',
    '  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);',
    '  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);',
    '  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);',
    '  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);',
    '  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
    '  public static string FocusFirst(string needle) {',
    '    string found = null;',
    '    EnumWindows(delegate(IntPtr h, IntPtr l) {',
    '      if (!IsWindowVisible(h)) return true;',
    '      StringBuilder sb = new StringBuilder(512);',
    '      GetWindowText(h, sb, 512);',
    '      string t = sb.ToString();',
    '      if (t.Length > 0 && t.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) {',
    '        ShowWindow(h, 9);', // SW_RESTORE
    '        SetForegroundWindow(h);',
    '        found = t;',
    '        return false;',
    '      }',
    '      return true;',
    '    }, IntPtr.Zero);',
    '    return found;',
    '  }',
    '}'
  ].join('\n');
  return [
    "$code = @'",
    csharp,
    "'@",
    'Add-Type -TypeDefinition $code -ErrorAction Stop;',
    `$r = [JarvisWin]::FocusFirst(${psQuote(titleContains)});`,
    'if ($null -ne $r) { [Console]::Out.Write($r) }'
  ].join('\n');
}

/** The toast payload a fired timer runs (inside the scheduled task's own PowerShell). */
function toastScript(title: string, body: string): string {
  const xml =
    '<toast><visual><binding template="ToastText02">' +
    `<text id="1">${xmlEscape(title)}</text>` +
    `<text id="2">${xmlEscape(body)}</text>` +
    '</binding></visual></toast>';
  // PowerShell's own AppUserModelID — reliably registered on every Windows box, so the toast
  // actually shows without us registering an AUMID of our own.
  const appId =
    '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
  return [
    '$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime];',
    '$null = [Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime];',
    '$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime];',
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument;',
    `$xml.LoadXml(${psQuote(xml)});`,
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $xml;',
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${psQuote(appId)}).Show($toast)`
  ].join('\n');
}

/** Formats a Date as a local-time ISO string PowerShell's [datetime] parses (no timezone). */
function psLocalDateTime(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/**
 * Registers a durable, self-deleting one-shot Scheduled Task that fires the toast (amendments
 * A3: schtasks-style durability — implemented via the Register-ScheduledTask cmdlets because
 * schtasks.exe /ST only has minute granularity). The task's payload (toast + self-delete) rides
 * as a base64 UTF-16LE -EncodedCommand, so labels never hit quoting or codepage issues.
 */
function scheduleTimerScript(taskName: string, fireAt: Date, title: string, body: string): string {
  const payload = [
    toastScript(title, body),
    `Unregister-ScheduledTask -TaskName ${psQuote(taskName)} -Confirm:$false`
  ].join('\n');
  const encoded = Buffer.from(payload, 'utf16le').toString('base64');
  return [
    `$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encoded}';`,
    `$trigger = New-ScheduledTaskTrigger -Once -At ([datetime]${psQuote(psLocalDateTime(fireAt))});`,
    `Register-ScheduledTask -TaskName ${psQuote(taskName)} -Action $action -Trigger $trigger -Force | Out-Null`
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Start-Menu fuzzy matching (open_app_or_url)
// ---------------------------------------------------------------------------

interface LnkEntry {
  name: string;
  path: string;
}

export function parseLnkList(stdout: string): LnkEntry[] {
  const out: LnkEntry[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const sep = line.indexOf('|');
    if (sep <= 0) continue;
    const name = line.slice(0, sep).trim();
    const path = line.slice(sep + 1).trim();
    if (name && path) out.push({ name, path });
  }
  return out;
}

/** Higher = better match; 0 = no match. Exported for direct unit testing. */
export function fuzzyScore(query: string, candidate: string): number {
  const q = query.toLowerCase().trim();
  const c = candidate.toLowerCase().trim();
  if (!q || !c) return 0;
  if (c === q) return 100;
  if (c.startsWith(q)) return 85;
  if (c.includes(q)) return 70;
  const qTokens = q.split(/\s+/);
  if (qTokens.length > 0 && qTokens.every((t) => c.includes(t))) return 60;
  if (q.includes(c)) return 55;
  return 0;
}

function looksLikeHttpUrl(target: string): boolean {
  return /^https?:\/\//i.test(target);
}

function looksLikePath(target: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(target) || /^\\\\/.test(target) || /[\\/]/.test(target);
}

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

export function createSystemPlugin(deps: Partial<SystemDeps> = {}): ToolPlugin {
  const runPs = deps.runPs ?? defaultRunPs;
  const now = deps.now ?? (() => new Date());
  const uniqueId =
    deps.uniqueId ?? (() => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);

  function buildTools(allowUnsafePaths: boolean): ToolDef<any>[] {
    const openAppOrUrl: ToolDef<{ target: string }> = {
      name: 'open_app_or_url',
      description:
        'Open an http/https URL in the default browser, or launch an installed app by name ' +
        '(e.g. "spotify", "notepad"). App names are matched against Start Menu shortcuts; if ' +
        'several apps match, replies with the candidates instead of launching.' +
        (allowUnsafePaths
          ? ' File/folder paths and PATH commands are also allowed.'
          : ' File/folder paths are disabled unless the user enables "unsafe paths" in settings.'),
      effect: 'local-write',
      inputSchema: z.object({
        target: z.string().min(1).describe('http/https URL or installed app name to open')
      }),
      handler: async ({ target }) => {
        let trimmed = target.trim();
        if (/^www\.[^\s/]+\.[^\s]+$/i.test(trimmed)) trimmed = `https://${trimmed}`;
        if (looksLikeHttpUrl(trimmed)) {
          await runPs(`Start-Process ${psQuote(trimmed)}`);
          return { text: `opened ${trimmed}` };
        }
        if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !looksLikePath(trimmed)) {
          // Non-http scheme (file:, ms-settings:, javascript:, ...) — refuse outright (A5).
          return {
            text: `only http/https URLs can be opened — refusing "${trimmed}"`,
            isError: true
          };
        }
        if (looksLikePath(trimmed)) {
          if (!allowUnsafePaths) {
            return {
              text:
                'opening file paths is disabled — enable "Allow launching file paths" in ' +
                'System settings to allow it',
              isError: true
            };
          }
          await runPs(`Start-Process ${psQuote(trimmed)}`);
          return { text: `opened ${trimmed}` };
        }
        // App name: fuzzy-match Start Menu shortcuts (ProgramData + AppData) — the only
        // default launch path for apps (A5).
        const entries = parseLnkList(await runPs(LIST_START_MENU_LNK_SCRIPT));
        const scored = entries
          .map((e) => ({ ...e, score: fuzzyScore(trimmed, e.name) }))
          .filter((e) => e.score > 0)
          .sort((a, b) => b.score - a.score || a.name.length - b.name.length);
        const best = scored[0];
        const second = scored[1];
        if (best && (best.score === 100 || !second || best.score - second.score >= 15)) {
          await runPs(`Start-Process ${psQuote(best.path)}`);
          return { text: `opening ${best.name}` };
        }
        if (best && second) {
          const names = scored.slice(0, 3).map((e) => e.name);
          return {
            text: `multiple apps match "${trimmed}": ${names.join(', ')} — which one did you mean?`
          };
        }
        if (allowUnsafePaths) {
          // Opt-in only: fall back to Start-Process (PATH apps like notepad/calc).
          try {
            await runPs(`Start-Process ${psQuote(trimmed)}`);
            return { text: `opened ${trimmed}` };
          } catch {
            return { text: `could not find an app or command matching "${trimmed}"`, isError: true };
          }
        }
        return {
          text:
            `no Start Menu app matches "${trimmed}" — launching arbitrary commands is disabled ` +
            '(enable "Allow launching file paths" in System settings to allow PATH commands)',
          isError: true
        };
      }
    };

    const systemMedia: ToolDef<{ action: string }> = {
      name: 'system_media',
      description:
        'Press a system media key: play_pause, next, previous, volume_up, volume_down, or mute. ' +
        'Controls whatever app is currently playing.',
      effect: 'local-write',
      inputSchema: z.object({
        action: z
          .enum(['play_pause', 'next', 'previous', 'volume_up', 'volume_down', 'mute'])
          .describe('media key to press')
      }),
      handler: async ({ action }) => {
        const key = MEDIA_VK[action];
        if (!key) return { text: `error: unknown media action "${action}"`, isError: true };
        await runPs(mediaKeyScript(key.vk));
        return { text: `pressed ${key.label}` };
      }
    };

    const clipboardRead: ToolDef<Record<string, never>> = {
      name: 'clipboard_read',
      description: 'Read the current text content of the Windows clipboard.',
      effect: 'read',
      inputSchema: z.object({}),
      handler: async () => {
        const out = (await runPs('Get-Clipboard -Raw')).replace(/\r\n/g, '\n').replace(/\n+$/, '');
        if (!out) return { text: 'clipboard is empty' };
        const capped = out.length > 4000 ? `${out.slice(0, 4000)}… (truncated)` : out;
        return { text: `clipboard contents: ${capped}` };
      }
    };

    const clipboardWrite: ToolDef<{ text: string }> = {
      name: 'clipboard_write',
      description: 'Replace the Windows clipboard with the given text.',
      effect: 'local-write',
      inputSchema: z.object({ text: z.string().describe('text to place on the clipboard') }),
      handler: async ({ text }) => {
        await runPs(`Set-Clipboard -Value ${psQuote(text)}`);
        return { text: 'copied to clipboard' };
      }
    };

    const windowFocus: ToolDef<{ titleContains: string }> = {
      name: 'window_focus',
      description:
        'Bring the first visible window whose title contains the given text to the foreground ' +
        '(case-insensitive), restoring it if minimized.',
      effect: 'local-write',
      inputSchema: z.object({
        titleContains: z.string().min(1).describe('substring of the window title to focus')
      }),
      handler: async ({ titleContains }) => {
        const found = (await runPs(windowFocusScript(titleContains))).trim();
        if (!found) return { text: `no window with a title containing "${titleContains}"` };
        return { text: `focused window "${found}"` };
      }
    };

    const timerSet: ToolDef<{ minutes: number; label?: string }> = {
      name: 'timer_set',
      description:
        'Set a timer for N minutes (fractions allowed). Registers a one-shot Windows scheduled ' +
        'task that shows a toast notification when it expires — the timer survives assistant ' +
        'restarts.',
      effect: 'local-write',
      inputSchema: z.object({
        minutes: z
          .number()
          .positive()
          .max(24 * 60)
          .describe('duration in minutes (e.g. 0.5 = 30 seconds)'),
        label: z.string().optional().describe('what the timer is for, spoken back in the toast')
      }),
      handler: async ({ minutes, label }) => {
        const ms = Math.round(minutes * 60_000);
        const fireAt = new Date(now().getTime() + ms);
        const body = label?.trim() ? label.trim() : `${minutes} minute timer is done`;
        const taskName = `JarvisTimer_${uniqueId()}`;
        // Durable one-shot Scheduled Task (self-deleting) — survives this disposable server
        // instance (amendments A3). Creation is awaited so failures surface as tool errors.
        await runPs(scheduleTimerScript(taskName, fireAt, 'Jarvis timer', body));
        const hh = String(fireAt.getHours()).padStart(2, '0');
        const mm = String(fireAt.getMinutes()).padStart(2, '0');
        const what = label?.trim() ? ` for "${label.trim()}"` : '';
        return { text: `timer set${what} — I'll notify you at ${hh}:${mm}` };
      }
    };

    return [openAppOrUrl, systemMedia, clipboardRead, clipboardWrite, windowFocus, timerSet];
  }

  return {
    id: 'system',
    displayName: 'System',
    settings: [
      {
        key: 'allowUnsafePaths',
        label: 'Allow launching file paths',
        kind: 'toggle',
        help:
          'Off by default. When on, open_app_or_url may also open file/folder paths and PATH ' +
          'commands, not just Start Menu apps and http(s) URLs.'
      }
    ],
    async init(ctx) {
      const allowUnsafePaths = ctx.config['allowUnsafePaths'] === true;
      return { tools: buildTools(allowUnsafePaths) };
    }
  };
}

const systemPlugin: ToolPlugin = createSystemPlugin();
export default systemPlugin;
