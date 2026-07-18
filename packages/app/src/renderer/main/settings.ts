import {
  PORCUPINE_BUILTIN_KEYWORDS,
  type AccountsStatus,
  type AppConfig,
  type BackendId,
  type ModelsStatus,
  type PluginManifest
} from '../../shared/types';
import type { JarvisApi } from '../shared/api';

/**
 * The settings pane (right side of the main window): serif section headings over hairlines,
 * every control live against the IPC surface. Copy voice: lowercase, terse, human — no
 * exclamation marks (cdd/plan/ui-design.md). Saves are debounced and acknowledged with a
 * fading mono `saved ✓` tick (cdd/tasks/settings-ui.md).
 */
export interface SettingsPane {
  el: HTMLElement;
  /** re-binds every control to a (redacted) config snapshot */
  applyConfig(c: AppConfig): void;
  /** Shows/hides the first-run setup checklist header (settings-ui: "setup" view). */
  setSetupMode(show: boolean): void;
}

export interface SettingsPaneOptions {
  /** Debounce window for config saves (ms). Tests pass 0. */
  debounceMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 300;
/** How long the `saved ✓` tick stays before fading. */
const SAVED_TICK_MS = 1500;

/* ------------------------------------------------------------------------------------------ */
/* small DOM helpers                                                                          */
/* ------------------------------------------------------------------------------------------ */

function field(labelText: string, control: HTMLElement): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const label = document.createElement('label');
  label.textContent = labelText;
  wrap.append(label, control);
  return wrap;
}

function section(title: string, ...children: HTMLElement[]): HTMLElement {
  const sec = document.createElement('section');
  const h = document.createElement('h2');
  h.textContent = title;
  sec.append(h, ...children);
  return sec;
}

function textInput(): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'text';
  return input;
}

function statusLine(text: string): HTMLParagraphElement {
  const p = document.createElement('p');
  p.className = 'status-line';
  p.textContent = text;
  return p;
}

function textBtn(label: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'text-btn';
  btn.textContent = label;
  return btn;
}

/* ------------------------------------------------------------------------------------------ */
/* hotkey capture                                                                             */
/* ------------------------------------------------------------------------------------------ */

/** Maps a KeyboardEvent to an Electron accelerator string, or null while only modifiers are
 * down. Exported for direct unit testing. */
export function acceleratorFromEvent(e: KeyboardEvent): string | null {
  const key = e.key;
  if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Super');
  let main: string;
  if (key === ' ') main = 'Space';
  else if (key.length === 1) main = key.toUpperCase();
  else main = key; // 'F5', 'ArrowUp', 'Tab', ...
  parts.push(main);
  return parts.join('+');
}

/* ------------------------------------------------------------------------------------------ */
/* first-run setup checklist                                                                  */
/* ------------------------------------------------------------------------------------------ */

/** Everything the checklist derives from — assembled by the pane from its cached statuses,
 * or supplied directly as a fixture in tests. */
export interface SetupStatuses {
  modelsOk: boolean;
  /** At least one audio input device was detected. */
  micAvailable: boolean;
  picovoiceSet: boolean;
  claudeOk: boolean;
  codexOk: boolean;
  googleConnected: boolean;
}

export interface ChecklistItem {
  label: string;
  done: boolean;
  optional?: boolean;
}

/** Pure derivation of the numbered first-run checklist (models → mic → picovoice key →
 * accounts → google optional). Tested against a status fixture matrix. */
export function deriveSetupChecklist(s: SetupStatuses): ChecklistItem[] {
  return [
    { label: 'download voice models', done: s.modelsOk },
    { label: 'plug in a microphone', done: s.micAvailable },
    { label: 'add your picovoice access key', done: s.picovoiceSet },
    { label: 'sign in to claude or codex', done: s.claudeOk || s.codexOk },
    { label: 'connect google', done: s.googleConnected, optional: true }
  ];
}

/* ------------------------------------------------------------------------------------------ */
/* plugin sections (data-driven)                                                              */
/* ------------------------------------------------------------------------------------------ */

/** Plugins whose settings are already rendered by a dedicated, functionally-wired section
 * elsewhere in this pane (see buildPluginSection's doc comment). */
const PLUGIN_IDS_RENDERED_ELSEWHERE = new Set(['google']);

interface PluginSectionDeps {
  api: JarvisApi;
  onSaved: () => void;
}

/**
 * Renders one settings section per tools-mcp plugin manifest (amendments.md's deferred "generic
 * plugin settings IPC" — the extensibility payoff: a new plugin's `settings[]` shows up here with
 * zero edits to this file). `text`/`number`/`toggle` map to plain controls that round-trip through
 * `plugin:setConfig`; `secret` fields are write-only (`plugin:setSecret`) and only ever show the
 * '•set' placeholder — a fetched secret value is never rendered; `action` renders a button that
 * invokes `plugin:action(id, key)`.
 *
 * The Google plugin is deliberately skipped here: its client id/secret + connect/disconnect flow
 * is already fully wired through the dedicated Accounts section below (AppConfig's `google` slice,
 * via `config:set`/`secret:set`/`google:connect`/`google:disconnect`) — auto-rendering its manifest
 * fields too would write to a second, unread location (`JARVIS_DATA_DIR/plugins/google.json`) and
 * silently do nothing. Its declared `connect` ACTION still routes through the same generic
 * `plugin:action` handler in main, so the mechanism is fully exercised. Every other plugin —
 * including ones not yet written — renders automatically.
 */
async function buildPluginSection(
  deps: PluginSectionDeps,
  manifest: PluginManifest
): Promise<HTMLElement | null> {
  const { api, onSaved } = deps;
  if (manifest.settings.length === 0) return null;
  if (PLUGIN_IDS_RENDERED_ELSEWHERE.has(manifest.id)) return null;
  const { config, secretsSet } = await api.getPluginConfig(manifest.id);
  const children: HTMLElement[] = [];

  for (const setting of manifest.settings) {
    let control: HTMLElement | null = null;
    let ownRow: HTMLElement | null = null;

    switch (setting.kind) {
      case 'text': {
        const input = textInput();
        const value = config[setting.key];
        input.value = typeof value === 'string' ? value : '';
        if (setting.placeholder) input.placeholder = setting.placeholder;
        input.addEventListener('change', () => {
          void api.setPluginConfig(manifest.id, { [setting.key]: input.value }).then(onSaved);
        });
        control = input;
        break;
      }
      case 'number': {
        const input = document.createElement('input');
        input.type = 'number';
        const value = config[setting.key];
        input.value = typeof value === 'number' ? String(value) : '';
        input.addEventListener('change', () => {
          void api
            .setPluginConfig(manifest.id, { [setting.key]: Number(input.value) })
            .then(onSaved);
        });
        control = input;
        break;
      }
      case 'toggle': {
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = config[setting.key] === true;
        input.addEventListener('change', () => {
          void api.setPluginConfig(manifest.id, { [setting.key]: input.checked }).then(onSaved);
        });
        control = input;
        break;
      }
      case 'secret': {
        const input = document.createElement('input');
        input.type = 'password';
        // Write-only: never populated from a fetched value, only a masked placeholder.
        input.value = '';
        input.placeholder = secretsSet.includes(setting.key) ? '•set' : (setting.placeholder ?? '');
        input.addEventListener('change', () => {
          if (input.value === '') return;
          void api.setPluginSecret(manifest.id, setting.key, input.value).then(onSaved);
          input.value = '';
          input.placeholder = '•set';
        });
        control = input;
        break;
      }
      case 'action': {
        const btn = textBtn(setting.label.toLowerCase());
        btn.addEventListener('click', () => {
          void api.pluginAction(manifest.id, setting.key);
        });
        ownRow = btn;
        break;
      }
    }

    if (control) children.push(field(setting.label, control));
    if (ownRow) children.push(ownRow);
    if (setting.help) children.push(statusLine(setting.help));
  }

  return section(manifest.displayName, ...children);
}

/* ------------------------------------------------------------------------------------------ */
/* the pane                                                                                   */
/* ------------------------------------------------------------------------------------------ */

export function buildSettingsPane(api: JarvisApi, opts: SettingsPaneOptions = {}): SettingsPane {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  const el = document.createElement('aside');
  el.className = 'settings';
  el.hidden = true;

  let cfg: AppConfig | null = null;

  /* ---- saved ✓ tick + debounced save queue ---- */
  const savedTick = document.createElement('span');
  savedTick.className = 'saved-tick';
  savedTick.textContent = 'saved ✓';

  let tickTimer: ReturnType<typeof setTimeout> | null = null;
  const showSavedTick = (): void => {
    savedTick.classList.add('show');
    if (tickTimer) clearTimeout(tickTimer);
    tickTimer = setTimeout(() => savedTick.classList.remove('show'), SAVED_TICK_MS);
  };

  let pendingPatches: Partial<AppConfig>[] = [];
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const flushPatches = (): void => {
    saveTimer = null;
    const patches = pendingPatches;
    pendingPatches = [];
    void (async () => {
      for (const p of patches) await api.setConfig(p);
      showSavedTick();
    })();
  };
  /** Debounced config save: rapid edits collapse into one burst, every patch still lands (in
   * order), and the tick shows once the burst is persisted. */
  const patch = (p: Partial<AppConfig>): void => {
    pendingPatches.push(p);
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushPatches, debounceMs);
  };

  /* ---- first-run setup checklist ---- */
  const statuses: SetupStatuses = {
    modelsOk: false,
    micAvailable: false,
    picovoiceSet: false,
    claudeOk: false,
    codexOk: false,
    googleConnected: false
  };
  let setupMode = false;

  const setupSection = document.createElement('section');
  setupSection.className = 'setup-checklist';
  setupSection.hidden = true;
  const setupHeading = document.createElement('h2');
  setupHeading.textContent = 'setup';
  const setupIntro = statusLine('a few steps and the assistant is listening');
  const setupList = document.createElement('ol');
  setupSection.append(setupHeading, setupIntro, setupList);

  const renderChecklist = (): void => {
    if (!setupMode) return;
    setupList.textContent = '';
    for (const item of deriveSetupChecklist(statuses)) {
      const li = document.createElement('li');
      li.dataset['done'] = String(item.done);
      li.textContent = `${item.done ? '✓' : '·'} ${item.label}${item.optional ? ' (optional)' : ''}`;
      setupList.appendChild(li);
    }
  };

  const setSetupMode = (show: boolean): void => {
    setupMode = show;
    setupSection.hidden = !show;
    renderChecklist();
  };

  /* ---- agent ---- */
  const nameInput = textInput();
  nameInput.addEventListener('change', () => {
    if (cfg) {
      patch({ agentName: nameInput.value.trim() || cfg.agentName });
      updateRenameWarning(nameInput.value.trim() || cfg.agentName, cfg.voice);
    }
  });

  // Rename warning (settings-ui task): the built-in wake word does not follow the display name.
  const renameWarning = document.createElement('p');
  renameWarning.className = 'status-line rename-warning';
  renameWarning.hidden = true;
  renameWarning.append(
    document.createTextNode("built-in wake word stays 'jarvis' — train a custom keyword to match ")
  );
  const renameLink = document.createElement('a');
  renameLink.href = 'docs/wakeword-setup.md';
  renameLink.textContent = 'how';
  renameWarning.appendChild(renameLink);

  /** Shown only when the display name no longer matches the active built-in keyword AND no
   * custom .ppn keyword is configured (a custom keyword is presumed trained to match). */
  const updateRenameWarning = (name: string, voice: AppConfig['voice']): void => {
    const keyword = (voice.builtinKeyword ?? 'jarvis').toLowerCase();
    const mismatch = !voice.customKeywordPath && name.toLowerCase() !== keyword;
    renameWarning.hidden = !mismatch;
  };

  const backendSelect = document.createElement('select');
  for (const id of ['claude', 'codex'] as BackendId[]) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = id;
    backendSelect.appendChild(opt);
  }
  backendSelect.addEventListener('change', () => {
    if (cfg) patch({ agents: { ...cfg.agents, defaultBackend: backendSelect.value as BackendId } });
  });

  // Hotkey capture field: focus it and press the combination; the accelerator is captured from
  // the keydown itself (no typing). Not reactive — the global hotkey is registered once at
  // startup (src/main/index.ts), so a restart is required.
  const hotkeyInput = textInput();
  hotkeyInput.readOnly = true;
  hotkeyInput.placeholder = 'press keys';
  hotkeyInput.addEventListener('keydown', (e) => {
    e.preventDefault();
    const accel = acceleratorFromEvent(e);
    if (!accel || !cfg) return;
    hotkeyInput.value = accel;
    patch({ ui: { ...cfg.ui, hotkey: accel } });
  });

  const startupCheck = document.createElement('input');
  startupCheck.type = 'checkbox';
  startupCheck.addEventListener('change', () => {
    if (cfg) patch({ ui: { ...cfg.ui, launchOnStartup: startupCheck.checked } });
  });

  // Not reactive: CodexBackend is constructed once at startup with a config snapshot (unlike
  // ClaudeBackend, which reads config live). A restart is required for a model change to apply.
  const codexModelInput = textInput();
  codexModelInput.placeholder = 'default';
  codexModelInput.addEventListener('change', () => {
    if (cfg) {
      patch({
        agents: {
          ...cfg.agents,
          codex: { ...cfg.agents.codex, model: codexModelInput.value.trim() || null }
        }
      });
    }
  });

  /* ---- voice ---- */
  const deviceSelect = document.createElement('select');
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = 'system default';
  deviceSelect.appendChild(defaultOpt);
  void api
    .listAudioInputs()
    .then((inputs) => {
      statuses.micAvailable = inputs.length > 0;
      renderChecklist();
      for (const { id, label } of inputs) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = label.toLowerCase();
        deviceSelect.appendChild(opt);
      }
      if (cfg) deviceSelect.value = cfg.voice.inputDeviceId ?? '';
    })
    .catch(() => {});
  deviceSelect.addEventListener('change', () => {
    if (cfg) patch({ voice: { ...cfg.voice, inputDeviceId: deviceSelect.value || null } });
  });

  // Built-in keyword dropdown: the Porcupine builtins (settings-ui task). Choosing one also
  // clears any custom .ppn so the selection unambiguously wins.
  const keywordSelect = document.createElement('select');
  for (const kw of PORCUPINE_BUILTIN_KEYWORDS) {
    const opt = document.createElement('option');
    opt.value = kw;
    opt.textContent = kw;
    keywordSelect.appendChild(opt);
  }
  keywordSelect.addEventListener('change', () => {
    if (cfg) {
      patch({
        voice: { ...cfg.voice, builtinKeyword: keywordSelect.value, customKeywordPath: null }
      });
      customKeywordLine.hidden = true;
      updateRenameWarning(cfg.agentName, {
        ...cfg.voice,
        builtinKeyword: keywordSelect.value,
        customKeywordPath: null
      });
    }
  });

  // Custom .ppn picker: native dialog via dialog:pickKeywordFile; the custom path always wins
  // over the builtin (wakeword.ts contract).
  const customKeywordLine = statusLine('');
  customKeywordLine.hidden = true;
  const ppnBtn = textBtn('use a custom .ppn keyword');
  ppnBtn.addEventListener('click', () => {
    void api.pickKeywordFile().then((path) => {
      if (!path || !cfg) return;
      patch({ voice: { ...cfg.voice, customKeywordPath: path } });
      customKeywordLine.textContent = `custom keyword: ${path}`;
      customKeywordLine.hidden = false;
      renameWarning.hidden = true;
    });
  });

  const sensitivityRange = document.createElement('input');
  sensitivityRange.type = 'range';
  sensitivityRange.min = '0';
  sensitivityRange.max = '1';
  sensitivityRange.step = '0.05';
  sensitivityRange.addEventListener('change', () => {
    if (cfg) patch({ voice: { ...cfg.voice, sensitivity: Number(sensitivityRange.value) } });
  });

  const ttsCheck = document.createElement('input');
  ttsCheck.type = 'checkbox';
  ttsCheck.addEventListener('change', () => {
    if (cfg) patch({ voice: { ...cfg.voice, ttsEnabled: ttsCheck.checked } });
  });

  // Write-only, like every secret field: never populated from the redacted '•set' config value,
  // only the placeholder reflects whether a key is already stored.
  const picovoiceKeyInput = document.createElement('input');
  picovoiceKeyInput.type = 'password';
  picovoiceKeyInput.addEventListener('change', () => {
    if (picovoiceKeyInput.value === '') return;
    void api.setSecret('picovoiceAccessKey', picovoiceKeyInput.value).then(showSavedTick);
    picovoiceKeyInput.value = '';
    picovoiceKeyInput.placeholder = '•set';
  });

  /* ---- model status + download ---- */
  const modelStatus = statusLine('checking voice models…');
  const modelProgress = document.createElement('div');
  modelProgress.className = 'model-progress';
  modelProgress.hidden = true;
  const downloadBtn = textBtn('download models');
  downloadBtn.hidden = true;

  const applyModelsStatus = (s: ModelsStatus): void => {
    statuses.modelsOk = s.ok;
    renderChecklist();
    if (s.ok) {
      modelStatus.textContent = 'voice models present';
      downloadBtn.hidden = true;
    } else {
      modelStatus.textContent = `voice models missing: ${s.missing.join(', ')}`;
      downloadBtn.hidden = false;
    }
  };
  void api.modelsStatus().then(applyModelsStatus).catch(() => {});

  api.onModelsProgress((line) => {
    const p = document.createElement('p');
    p.className = 'status-line';
    p.textContent = line;
    modelProgress.appendChild(p);
    // Keep the stream bounded: only the last 6 lines stay visible.
    while (modelProgress.childElementCount > 6) modelProgress.firstElementChild?.remove();
  });

  downloadBtn.addEventListener('click', () => {
    downloadBtn.disabled = true;
    modelProgress.hidden = false;
    modelProgress.textContent = '';
    void api
      .fetchModels()
      .then((result) => {
        if (!result.ok) {
          modelStatus.textContent = `model download failed: ${result.failed.join(', ')}`;
          return;
        }
        return api.modelsStatus().then(applyModelsStatus);
      })
      .catch(() => {
        modelStatus.textContent = 'model download failed — check your connection and retry';
      })
      .finally(() => {
        downloadBtn.disabled = false;
      });
  });

  /* ---- accounts ---- */
  const claudeStatus = statusLine('claude: checking…');
  const codexStatus = statusLine('codex: checking…');

  const applyAccountsStatus = (s: AccountsStatus): void => {
    statuses.claudeOk = s.claude.ok;
    statuses.codexOk = s.codex.ok;
    renderChecklist();
    claudeStatus.textContent = s.claude.ok
      ? 'claude: ready'
      : `claude: ${s.claude.problem ?? 'not available'} — run \`claude /login\` in a terminal`;
    codexStatus.textContent = s.codex.ok
      ? 'codex: ready'
      : `codex: ${s.codex.problem ?? 'not logged in'} — run \`codex login\` in a terminal`;
  };
  void api.accountsStatus().then(applyAccountsStatus).catch(() => {});

  const googleStatus = statusLine('no google account connected — set up');
  const googleBtn = textBtn('connect google');
  googleBtn.addEventListener('click', () => {
    if (cfg?.google.connectedEmail) {
      void api.disconnectGoogle();
    } else {
      void api.connectGoogle();
    }
  });

  const clientIdInput = textInput();
  clientIdInput.addEventListener('change', () => {
    if (cfg) patch({ google: { ...cfg.google, clientId: clientIdInput.value.trim() } });
  });

  const clientSecretInput = document.createElement('input');
  clientSecretInput.type = 'password';
  clientSecretInput.addEventListener('change', () => {
    if (clientSecretInput.value === '') return;
    void api.setSecret('googleClientSecret', clientSecretInput.value).then(showSavedTick);
    clientSecretInput.value = '';
    clientSecretInput.placeholder = '•set';
  });

  const pluginSections = document.createElement('div');
  pluginSections.className = 'plugin-sections';

  el.append(
    savedTick,
    setupSection,
    section(
      'agent',
      field('name', nameInput),
      renameWarning,
      field('default backend', backendSelect),
      field('codex model (restart required)', codexModelInput),
      field('hotkey (restart required)', hotkeyInput),
      field('launch on startup', startupCheck)
    ),
    section(
      'voice',
      field('input device', deviceSelect),
      field('keyword', keywordSelect),
      ppnBtn,
      customKeywordLine,
      field('sensitivity', sensitivityRange),
      field('speak replies', ttsCheck),
      field('picovoice access key', picovoiceKeyInput),
      modelStatus,
      modelProgress,
      downloadBtn
    ),
    section(
      'accounts',
      claudeStatus,
      codexStatus,
      googleStatus,
      googleBtn,
      field('google client id', clientIdInput),
      field('google client secret', clientSecretInput)
    ),
    pluginSections
  );

  // Data-driven plugin sections (amendments.md): fetched once at pane construction. A plugin
  // added later shows up the next time the settings pane is built (app restart) — live re-fetch
  // while the pane is open is not required by the task.
  void api
    .listPluginManifests()
    .then(async (manifests) => {
      for (const manifest of manifests) {
        const built = await buildPluginSection({ api, onSaved: showSavedTick }, manifest);
        if (built) pluginSections.appendChild(built);
      }
    })
    .catch(() => {});

  const applyConfig = (c: AppConfig): void => {
    cfg = c;
    nameInput.value = c.agentName;
    backendSelect.value = c.agents.defaultBackend;
    codexModelInput.value = c.agents.codex.model ?? '';
    hotkeyInput.value = c.ui.hotkey;
    startupCheck.checked = c.ui.launchOnStartup;
    deviceSelect.value = c.voice.inputDeviceId ?? '';
    keywordSelect.value = c.voice.builtinKeyword ?? 'jarvis';
    if (c.voice.customKeywordPath) {
      customKeywordLine.textContent = `custom keyword: ${c.voice.customKeywordPath}`;
      customKeywordLine.hidden = false;
    } else {
      customKeywordLine.hidden = true;
    }
    updateRenameWarning(c.agentName, c.voice);
    sensitivityRange.value = String(c.voice.sensitivity);
    ttsCheck.checked = c.voice.ttsEnabled;
    picovoiceKeyInput.placeholder = c.voice.picovoiceAccessKey ? '•set' : '';
    clientIdInput.value = c.google.clientId;
    clientSecretInput.placeholder = c.google.clientSecret ? '•set' : '';
    if (c.google.connectedEmail) {
      googleStatus.textContent = `google: connected as ${c.google.connectedEmail}`;
      googleBtn.textContent = 'disconnect google';
    } else {
      googleStatus.textContent = 'no google account connected — set up';
      googleBtn.textContent = 'connect google';
    }
    // Live checklist inputs carried by config: the picovoice key (redacts to '•set' when
    // stored) and the google account.
    statuses.picovoiceSet = c.voice.picovoiceAccessKey !== '';
    statuses.googleConnected = c.google.connectedEmail !== null;
    renderChecklist();
  };

  return { el, applyConfig, setSetupMode };
}
