import type { AppConfig, BackendId } from '../../shared/types';
import type { JarvisApi } from '../shared/api';

/**
 * The settings pane (right side of the main window): serif section headings over
 * hairlines, static controls bound to config:get/set. Copy voice: lowercase, terse,
 * human — no exclamation marks (cdd/plan/ui-design.md).
 */
export interface SettingsPane {
  el: HTMLElement;
  /** re-binds every control to a (redacted) config snapshot */
  applyConfig(c: AppConfig): void;
}

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

export function buildSettingsPane(api: JarvisApi): SettingsPane {
  const el = document.createElement('aside');
  el.className = 'settings';
  el.hidden = true;

  let cfg: AppConfig | null = null;
  const patch = (p: Partial<AppConfig>): void => {
    void api.setConfig(p);
  };

  /* ---- agent ---- */
  const nameInput = textInput();
  nameInput.addEventListener('change', () => {
    if (cfg) patch({ agentName: nameInput.value.trim() || cfg.agentName });
  });

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

  const hotkeyInput = textInput();
  hotkeyInput.addEventListener('change', () => {
    if (cfg) patch({ ui: { ...cfg.ui, hotkey: hotkeyInput.value.trim() } });
  });

  const startupCheck = document.createElement('input');
  startupCheck.type = 'checkbox';
  startupCheck.addEventListener('change', () => {
    if (cfg) patch({ ui: { ...cfg.ui, launchOnStartup: startupCheck.checked } });
  });

  /* ---- voice ---- */
  const deviceSelect = document.createElement('select');
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = 'system default';
  deviceSelect.appendChild(defaultOpt);
  void api.listAudioInputs().then((inputs) => {
    for (const { id, label } of inputs) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = label.toLowerCase();
      deviceSelect.appendChild(opt);
    }
    if (cfg) deviceSelect.value = cfg.voice.inputDeviceId ?? '';
  });
  deviceSelect.addEventListener('change', () => {
    if (cfg) patch({ voice: { ...cfg.voice, inputDeviceId: deviceSelect.value || null } });
  });

  const keywordInput = textInput();
  keywordInput.addEventListener('change', () => {
    if (cfg) patch({ voice: { ...cfg.voice, builtinKeyword: keywordInput.value.trim() || null } });
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

  const modelStatus = statusLine('voice models not checked');
  const downloadBtn = document.createElement('button');
  downloadBtn.type = 'button';
  downloadBtn.className = 'text-btn';
  downloadBtn.textContent = 'download models';
  downloadBtn.disabled = true;
  downloadBtn.title = 'arrives with the voice pipeline';

  /* ---- accounts ---- */
  const claudeStatus = statusLine('claude: not detected — install claude code and sign in');
  const codexStatus = statusLine("codex not logged in. run `codex login` in a terminal.");

  const googleStatus = statusLine('no google account connected — set up');
  const googleBtn = document.createElement('button');
  googleBtn.type = 'button';
  googleBtn.className = 'text-btn';
  googleBtn.textContent = 'connect google';
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
    void api.setSecret('googleClientSecret', clientSecretInput.value);
    clientSecretInput.value = '';
    clientSecretInput.placeholder = '•set';
  });

  el.append(
    section(
      'agent',
      field('name', nameInput),
      field('default backend', backendSelect),
      field('hotkey', hotkeyInput),
      field('launch on startup', startupCheck)
    ),
    section(
      'voice',
      field('input device', deviceSelect),
      field('keyword', keywordInput),
      field('sensitivity', sensitivityRange),
      field('speak replies', ttsCheck),
      modelStatus,
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
    )
  );

  const applyConfig = (c: AppConfig): void => {
    cfg = c;
    nameInput.value = c.agentName;
    backendSelect.value = c.agents.defaultBackend;
    hotkeyInput.value = c.ui.hotkey;
    startupCheck.checked = c.ui.launchOnStartup;
    deviceSelect.value = c.voice.inputDeviceId ?? '';
    keywordInput.value = c.voice.builtinKeyword ?? '';
    sensitivityRange.value = String(c.voice.sensitivity);
    ttsCheck.checked = c.voice.ttsEnabled;
    clientIdInput.value = c.google.clientId;
    if (c.google.connectedEmail) {
      googleStatus.textContent = `google: connected as ${c.google.connectedEmail}`;
      googleBtn.textContent = 'disconnect google';
    } else {
      googleStatus.textContent = 'no google account connected — set up';
      googleBtn.textContent = 'connect google';
    }
  };

  return { el, applyConfig };
}
