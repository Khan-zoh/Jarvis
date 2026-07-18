import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { app, dialog, shell } from 'electron';
import { createGoogleAuthManager } from '@jarvis/tools-mcp/google/auth';
import { fetchModels } from '../../../../scripts/fetch-models';
import { pluginManifests } from '@jarvis/tools-mcp/loader';
import {
  readPluginConfig,
  readPluginSecrets,
  writePluginConfig,
  writePluginSecret
} from '@jarvis/tools-mcp/pluginConfig';
import { ConfigStore } from './config';
import { WindowManager } from './windows';
import { registerInvokeHandlers, type IpcDeps } from './ipc';
import { setLaunchOnStartup } from './autostart';
import { resolveModelPaths } from './modelPaths';
import { toolsMcpEntry } from './paths';
import { Conductor } from './conductor';
import { VoiceManager } from './voiceManager';
import type { VoiceStatus } from '../shared/types';
import { SessionStore } from '../agents/sessions';
import { AgentRouter } from '../agents/router';
import { ClaudeBackend } from '../agents/claude';
import { CodexBackend } from '../agents/codex';
import { createBrainRuntime, type BrainRuntime } from '../agents/brain/runtime';
import { detectOffTheRecord } from '../agents/brain/offTheRecord';
import type { AppConfig } from '../shared/types';
import { createAudioCapture, type AudioCapture } from '../voice/capture';
import { createWakeWordDetector } from '../voice/wakeword';
import { createVoiceActivityDetector } from '../voice/vad';
import { WhisperCppStt, type SpeechToText } from '../voice/stt';
import { FallbackStt, WhisperServerStt } from '../voice/stt-server';
import { createPcmPlayer } from '../voice/player';
import { PiperTts } from '../voice/tts';
import { VoicePipeline } from '../voice/pipeline';

/** How long the overlay stays visible after the pipeline returns to idle (overlay behavior
 * contract in cdd/plan/architecture.md: "fades out 4s after returning to idle"). */
const OVERLAY_LINGER_MS = 4000;

interface VoiceRuntime {
  pipeline: VoicePipeline;
  capture: AudioCapture;
  dispose: () => void;
}

// ---------------------------------------------------------------------------------------------
// Startup step 1: single-instance lock. A second launch focuses the existing main window and the
// duplicate process exits immediately.
// ---------------------------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let windows: WindowManager | null = null;
  let voiceRuntime: VoiceRuntime | null = null;
  let brainRuntime: BrainRuntime | null = null;

  app.on('second-instance', () => {
    windows?.showMain();
  });

  void app.whenReady().then(async () => {
    // -----------------------------------------------------------------------------------------
    // Startup step 2: load config, bring up the WindowManager, show the tray immediately.
    // -----------------------------------------------------------------------------------------
    const config = new ConfigStore(app.getPath('userData'));
    const wm = new WindowManager(config);
    windows = wm;

    // Voice state shared between the tray, the IPC handlers, and the pipeline built below.
    let voiceDisabledReason: string | null = 'Voice is still starting up.';
    let listeningPaused = false;

    // -----------------------------------------------------------------------------------------
    // Startup steps 3–4: tools-mcp launch spec → backends → AgentRouter with SessionStore.
    // Seams are empty arrays for now — the brain-integration task adds providers/observers.
    // -----------------------------------------------------------------------------------------
    const userData = app.getPath('userData');
    const sessions = new SessionStore(join(userData, 'sessions'));
    const toolsPaths = { entryJs: toolsMcpEntry(), dataDir: userData };
    // A1 defense-in-depth: the Claude SDK subprocess runs in a non-sensitive empty directory.
    const agentCwd = join(userData, 'agent-cwd');
    mkdirSync(agentCwd, { recursive: true });
    const claude = new ClaudeBackend({ getConfig: () => config.get(), toolsPaths, cwd: agentCwd });
    const codex = new CodexBackend(config.get(), toolsPaths);

    // Let the disposable tools-mcp worker resolve the embedding model (brain plugin) — its cwd is
    // not guaranteed to be the repo root, so it reads JARVIS_MODELS_DIR (see toolsLauncher).
    process.env['JARVIS_MODELS_DIR'] = modelsRootDir();

    // Second brain (cdd/plan/second-brain.md, amendments.md A8). The app owns ONE shared
    // BrainStore instance (the tools-mcp brain plugin opens the SAME vault/index in its own
    // process; the engine is multi-process safe). Built only when enabled AND the embedding model
    // is on disk; the recall provider + capture observer re-check `enabled` live each turn.
    // Mirror the app-authoritative secondBrain settings into plugins/brain.json so the MCP
    // worker's on-demand brain_* tools open the same vault the app writes.
    const mirrorBrainConfig = (c: AppConfig): void => {
      writePluginConfig(userData, 'brain', {
        vaultDir: c.secondBrain.vaultDir,
        autoCapture: c.secondBrain.autoCapture,
        recallMode: c.secondBrain.recallMode
      });
    };
    mirrorBrainConfig(config.get());
    config.on('changed', () => mirrorBrainConfig(config.get()));

    const getDefaultBackend = (): ClaudeBackend | CodexBackend =>
      config.get().agents.defaultBackend === 'codex' ? codex : claude;
    const brain: BrainRuntime | null = ((): BrainRuntime | null => {
      if (!config.get().secondBrain.enabled) return null;
      const built = createBrainRuntime({
        getConfig: () => config.get(),
        dataDir: userData,
        modelsRoot: modelsRootDir(),
        getBackend: getDefaultBackend,
        onCaptured: (note) => wm.broadcast('brain:captured', note)
      });
      if ('unavailable' in built) {
        console.log(`[main] second brain not started: ${built.unavailable}`);
        return null;
      }
      console.log('[main] second brain enabled');
      return built;
    })();
    brainRuntime = brain; // module-scoped handle so will-quit can dispose it

    const router = new AgentRouter({ claude, codex }, sessions, () => config.get(), {
      providers: brain ? [brain.provider] : [],
      observers: brain ? [brain.observer] : []
    });

    // -----------------------------------------------------------------------------------------
    // Startup step 6 seam: the Conductor fans agent events to the pipeline (TTS) + IPC, pushes
    // persisted turns on session:updated, and fans cancel out to router + pipeline. The pipeline
    // getter resolves lazily because voice comes up later (step 5) or not at all.
    // -----------------------------------------------------------------------------------------
    const conductor = new Conductor({
      router,
      sessions,
      pipeline: () => voiceRuntime?.pipeline ?? null,
      broadcast: (ch, ...args) => wm.broadcast(ch, ...args),
      // Off-the-record voice path (A8): only active when the brain runs. "forget that" also
      // removes the most recent auto-capture and syncs the UI.
      offTheRecord: brain
        ? {
            detect: detectOffTheRecord,
            forgetLast: async () => {
              const removed = await brain?.forgetLast();
              if (removed) wm.broadcast('brain:removed', removed);
            }
          }
        : undefined
    });

    wm.createTray({
      onOpen: () => wm.showMain(),
      onNewSession: () => {
        sessions.newSession();
      },
      onToggleListening: () => {
        // Startup step 5 deliverable: tray pause/resume listening = pipeline stop/start.
        // No-op while in text-only mode.
        const runtime = voiceRuntime;
        if (!runtime) return;
        listeningPaused = !listeningPaused;
        wm.setListening(!listeningPaused);
        if (listeningPaused) {
          void runtime.pipeline.stop();
        } else {
          void runtime.pipeline.start();
        }
      },
      onQuit: () => app.quit()
    });

    // Keep the OS login-item registration in step with config, both now and reactively.
    setLaunchOnStartup(config.get().ui.launchOnStartup);
    config.on('changed', (c) => setLaunchOnStartup(c.ui.launchOnStartup));

    // Broadcast redacted config changes to every renderer.
    config.on('changed', (redacted) => wm.broadcast('config:changed', redacted));

    // -----------------------------------------------------------------------------------------
    // IPC: config/app:quit/voice channels are real. Agent/session/google handlers remain stubs
    // that later tasks replace by injecting real implementations through this same IpcDeps.
    // -----------------------------------------------------------------------------------------
    // Google OAuth (installed-app loopback). The flow runs in the app because it must open a
    // browser; the disposable MCP worker only ever reads the persisted token file. dataDir is
    // userData, matching what the tools-mcp launcher passes as JARVIS_DATA_DIR. Named helpers
    // (not inline deps) because BOTH google:connect/disconnect AND the generic plugin:action
    // route here (the google plugin declares a `connect` action-kind setting).
    const connectGoogle = async (): Promise<{ email: string }> => {
      const { clientId, clientSecret } = config.get().google;
      if (!clientId || !clientSecret) {
        throw new Error('Add your Google client ID and secret in Settings before connecting.');
      }
      const manager = createGoogleAuthManager({
        dataDir: app.getPath('userData'),
        openBrowser: (url) => {
          void shell.openExternal(url);
        }
      });
      const { email } = await manager.beginAuthFlow(clientId, clientSecret);
      config.set({ google: { ...config.get().google, connectedEmail: email } });
      return { email };
    };
    const disconnectGoogle = async (): Promise<void> => {
      const manager = createGoogleAuthManager({
        dataDir: app.getPath('userData'),
        openBrowser: () => {}
      });
      await manager.disconnect();
      config.set({ google: { ...config.get().google, connectedEmail: null } });
    };

    const deps: IpcDeps = {
      config,
      // Text bar: same dispatch path as voice, but NEVER through the pipeline — text-bar turns
      // must not trigger TTS (cdd/tasks/wire-and-converse.md: TTS only for voice-initiated
      // turns). Events reach renderers via the agent:event broadcast only.
      sendTextCommand: async (text, backend) => conductor.handleText(text, backend),
      cancelPipeline: async () => conductor.cancel(),
      listSessions: async () => sessions.list(),
      loadSession: async (id) => sessions.turns(id),
      newSession: async () => {
        sessions.newSession();
      },
      connectGoogle,
      disconnectGoogle,
      listAudioInputs: async () => {
        if (voiceRuntime) return voiceRuntime.capture.listInputs();
        // Text-only mode: still enumerate devices when ffmpeg is provisioned, so the settings UI
        // can offer a device picker before voice is fully configured.
        const paths = resolveModelPaths({ modelsRoot: modelsRootDir() });
        return 'missing' in paths ? [] : createAudioCapture(paths.ffmpegExe).listInputs();
      },
      voiceStatus: async (): Promise<VoiceStatus> =>
        voiceRuntime
          ? { enabled: true, reason: null }
          : { enabled: false, reason: voiceDisabledReason },
      minimizeWindow: async () => {
        wm.minimizeMain();
      },
      quit: async () => {
        app.quit();
      },
      // Generic plugin settings IPC (amendments.md's deferred note): the manifest comes straight
      // from the tools-mcp workspace package — no hard-coded plugin list, so a new plugin's
      // settings[] appears here with zero changes to this file. Config/secrets persist under
      // JARVIS_DATA_DIR/plugins/<id>.{json,secrets} — the SAME files the disposable MCP worker's
      // PluginContext reads at boot (src/pluginConfig.ts), so a setting saved here is live for the
      // next turn's tools-mcp spawn without any extra plumbing.
      listPluginManifests: async () => pluginManifests(),
      getPluginConfig: async (id) => {
        const cfg = readPluginConfig(userData, id);
        const secrets = readPluginSecrets(userData, id);
        return { config: cfg, secretsSet: Object.keys(secrets) };
      },
      setPluginConfig: async (id, patch) => {
        writePluginConfig(userData, id, patch);
      },
      setPluginSecret: async (id, key, value) => {
        writePluginSecret(userData, id, key, value);
      },
      // Generic plugin actions: the manifest declares the (id, key); the app owns the handler.
      // google/connect toggles: connect when no account is linked, disconnect when one is —
      // exactly the behavior of the dedicated accounts-section button.
      pluginAction: async (id, key) => {
        if (id === 'google' && key === 'connect') {
          if (config.get().google.connectedEmail) await disconnectGoogle();
          else await connectGoogle();
          return;
        }
        if (id === 'brain') {
          if (!brain) throw new Error('second brain is off — enable it in settings and restart.');
          if (key === 'reindex') {
            await brain.reindex();
            return;
          }
          if (key === 'consolidate') {
            await brain.consolidate();
            return;
          }
        }
        throw new Error(`unknown plugin action: ${id}/${key}`);
      },
      // Second-brain capture UI: the recently-captured strip + one-click undo. Empty/no-op when
      // the brain is off.
      brainRecent: async () => (brain ? brain.recent(10) : []),
      brainRemove: async (id) => {
        if (!brain) return;
        await brain.remove(id);
        wm.broadcast('brain:removed', id);
      },
      // Both backends probed via their real init() (settings-ui task: the accounts section's
      // status lines + fix hints come from these results, not hard-coded copy).
      accountsStatus: async () => {
        const [claudeProbe, codexProbe] = await Promise.all([claude.init(), codex.init()]);
        return { claude: claudeProbe, codex: codexProbe };
      },
      modelsStatus: async () => {
        const paths = resolveModelPaths({ modelsRoot: modelsRootDir() });
        return 'missing' in paths ? { ok: false, missing: paths.missing } : { ok: true };
      },
      // Runs the real fetch-models pipeline in-process, streaming each log line to the settings
      // pane over models:progress. On success the voice pipeline is force-rebuilt: fresh models
      // can satisfy startup prerequisites that no config field reflects.
      fetchModels: async () => {
        const results = await fetchModels({
          modelsRoot: modelsRootDir(),
          log: (line) => wm.broadcast('models:progress', line)
        });
        const failed = results.filter((r) => r.status === 'failed');
        for (const f of failed) {
          wm.broadcast('models:progress', `${f.name}: failed — ${f.message ?? 'unknown error'}`);
        }
        const ok = failed.length === 0;
        if (ok) void voiceManager.refresh();
        return { ok, failed: failed.map((f) => f.name) };
      },
      pickKeywordFile: async () => {
        const picked = await dialog.showOpenDialog({
          title: 'choose a custom wake word (.ppn)',
          filters: [{ name: 'porcupine keyword', extensions: ['ppn'] }],
          properties: ['openFile']
        });
        return picked.canceled ? null : (picked.filePaths[0] ?? null);
      }
    };
    registerInvokeHandlers(deps);

    // Global hotkey toggles the main window (push-to-talk text bar hookup arrives with
    // wire-and-converse; for now it opens/focuses the window).
    wm.registerHotkey(config.get().ui.hotkey, () => wm.toggleMain());

    // Show the main window on first launch unless started hidden (login autostart).
    if (!process.argv.includes('--hidden')) {
      wm.showMain();
    }

    // -----------------------------------------------------------------------------------------
    // Startup step 5: construct the VoicePipeline with REAL components — only when
    // resolveModelPaths() is complete AND the Picovoice access key + a keyword are configured.
    // Otherwise stay in text-only mode and surface the reason via the 'voice:status' channel.
    // Missing prerequisites are NOT a transient error (cdd/plan/amendments.md, error-policy
    // nuance): they are a durable setup state until the user fixes the named cause.
    //
    // settings-ui task: this is no longer a one-shot startup gate. VoiceManager watches
    // config:changed and, when a voice-relevant field (Picovoice key/keyword/device/model paths)
    // actually changes, tears down the running pipeline and rebuilds it from scratch — no app
    // restart required. A change to an unrelated field (agent name, hotkey, google, …) is a no-op.
    // -----------------------------------------------------------------------------------------
    const applyVoiceResult = (result: VoiceRuntime | { reason: string }): void => {
      if ('reason' in result) {
        voiceRuntime = null;
        voiceDisabledReason = result.reason;
        wm.setListening(false);
        console.log(`[main] voice disabled (text-only mode): ${result.reason}`);
      } else {
        voiceRuntime = result;
        voiceDisabledReason = null;
        wm.setListening(true);
        console.log('[main] voice pipeline started');
      }
    };
    const voiceManager = new VoiceManager<VoiceRuntime>({
      build: () => startVoicePipeline(config, wm, conductor),
      dispose: (runtime) => runtime.dispose(),
      onChange: applyVoiceResult
    });
    applyVoiceResult(await voiceManager.init(config.get()));
    config.on('changed', (c) => voiceManager.onConfigChanged(c));
  });

  app.on('window-all-closed', () => {
    // Jarvis is a resident tray app: closing all windows does NOT quit. Quit is explicit (tray →
    // Quit, or app:quit). On macOS this is the norm anyway.
  });

  app.on('will-quit', () => {
    // Tear down child processes (ffmpeg capture, whisper-server) — no orphans.
    voiceRuntime?.dispose();
    voiceRuntime = null;
    brainRuntime?.dispose();
    brainRuntime = null;
    windows?.dispose();
  });
}

/** Models root: `<cwd>/models` (repo root in dev), matching scripts/fetch-models.ts and
 * resolveModelPaths' own default. Centralized here for the packaging task to re-point later. */
function modelsRootDir(): string {
  return join(process.cwd(), 'models');
}

/**
 * Builds, initializes, and starts the voice pipeline from real components. Returns the runtime,
 * or `{ reason }` (text-only mode) when a prerequisite is missing or a component fails to
 * initialize.
 */
async function startVoicePipeline(
  config: ConfigStore,
  wm: WindowManager,
  conductor: Conductor
): Promise<VoiceRuntime | { reason: string }> {
  const cfg = config.get();

  // Prerequisite 1: models + binaries on disk.
  const paths = resolveModelPaths({ modelsRoot: modelsRootDir() });
  if ('missing' in paths) {
    return {
      reason: `Voice models are missing (${paths.missing.join(', ')}) — run \`npm run fetch-models\`.`
    };
  }

  // Prerequisite 2: Picovoice access key + a wake keyword.
  if (!cfg.voice.picovoiceAccessKey) {
    return {
      reason: 'Picovoice access key is not set — add it in Settings to enable the wake word.'
    };
  }
  if (!cfg.voice.builtinKeyword && !cfg.voice.customKeywordPath) {
    return {
      reason: 'No wake word is configured — set a built-in keyword or a custom .ppn in Settings.'
    };
  }

  // Real components (paths always from resolveModelPaths, never PATH — amendments.md A6).
  const capture = createAudioCapture(paths.ffmpegExe);
  const wake = createWakeWordDetector();
  const vad = createVoiceActivityDetector(paths.sileroVad);
  const player = createPcmPlayer(paths.ffplayExe);
  const tts = new PiperTts({ piperExe: paths.piperExe, player });

  // STT: prefer the persistent whisper-server (amendments.md A6 — per-spawn whisper-cli costs
  // 3.1-3.4s in model reload, missing the 2.5s budget). FallbackStt degrades to the per-spawn
  // WhisperCppStt if the server binary is absent, fails to start, or dies mid-session.
  const cliStt = new WhisperCppStt({ whisperCliPath: paths.whisperCli });
  const serverStt = paths.whisperServer
    ? new WhisperServerStt({ whisperServerPath: paths.whisperServer })
    : null;
  const stt: SpeechToText = serverStt ? new FallbackStt(serverStt, cliStt) : cliStt;
  const disposeStt = (): void => serverStt?.dispose();

  const sttModelPath = cfg.voice.sttModelPath || paths.whisperModel;
  const ttsVoicePath = cfg.voice.ttsVoicePath || paths.piperVoice;

  // Wake acknowledgement sound: assets/wake.wav via the provisioned ffplay (fire-and-forget;
  // never resolved from PATH).
  const wakeWavPath = join(app.getAppPath(), 'assets', 'wake.wav');
  const playWakeSound = (): void => {
    try {
      const proc = spawn(
        paths.ffplayExe,
        ['-hide_banner', '-loglevel', 'error', '-autoexit', '-nodisp', wakeWavPath],
        { stdio: 'ignore', windowsHide: true }
      );
      proc.on('error', () => {});
    } catch {
      // The wake click is a nicety; never let it take the pipeline down.
    }
  };

  try {
    await wake.init({
      accessKey: cfg.voice.picovoiceAccessKey,
      builtinKeyword: cfg.voice.builtinKeyword,
      customKeywordPath: cfg.voice.customKeywordPath,
      sensitivity: cfg.voice.sensitivity
    });
    await vad.init();
    await stt.init({ modelPath: sttModelPath });
    await tts.init({ voicePath: ttsVoicePath });
  } catch (err) {
    wake.release();
    disposeStt();
    const message = err instanceof Error ? err.message : String(err);
    return { reason: `Voice setup failed: ${message}` };
  }

  const pipeline = new VoicePipeline({
    capture,
    wake,
    vad,
    stt,
    tts,
    config: () => config.get(),
    playWakeSound
  });

  // Dev --echo flag (Gate A): the pipeline speaks the final transcript straight back. Echo mode
  // replaces the router path entirely (utterances must not also dispatch to a backend).
  const echoMode = process.argv.includes('--echo');
  if (echoMode) {
    pipeline.setEchoMode(true);
    console.log('[main] --echo: pipeline will speak transcripts back');
  }

  // Broadcasts to renderer windows + overlay show/hide per the overlay behavior contract
  // (hidden in idle; visible on wake; lingers 4s after returning to idle).
  let overlayHideTimer: ReturnType<typeof setTimeout> | null = null;
  pipeline.on('state', (s) => {
    wm.broadcast('state:changed', s);
    if (s === 'idle') {
      if (overlayHideTimer) clearTimeout(overlayHideTimer);
      overlayHideTimer = setTimeout(() => wm.hideOverlay(), OVERLAY_LINGER_MS);
    } else {
      if (overlayHideTimer) {
        clearTimeout(overlayHideTimer);
        overlayHideTimer = null;
      }
      wm.showOverlay();
    }
  });
  pipeline.on('transcript', (e) => wm.broadcast('transcript', e));
  pipeline.on('micLevel', (level) => wm.broadcast('mic:level', level));
  // Startup step 6: final utterance → router.dispatch, with every agent event fanned to BOTH
  // pipeline.onAgentEvent (sentence chunker → TTS) and the agent:event broadcast, and the
  // persisted turn pushed on session:updated. All owned by the Conductor.
  if (!echoMode) {
    pipeline.on('utterance', (text) => {
      void conductor.handleUtterance(text);
    });
  }
  // Error policy: pipeline-internal failures (capture crash, STT death, …) are broadcast as
  // agent:event {kind:'error'} — previously they were console-only.
  pipeline.on('error', (message) => wm.broadcast('agent:event', { kind: 'error', message }));

  try {
    await pipeline.start();
  } catch (err) {
    wake.release();
    disposeStt();
    const message = err instanceof Error ? err.message : String(err);
    return { reason: `Voice capture failed to start: ${message}` };
  }

  return {
    pipeline,
    capture,
    dispose: () => {
      if (overlayHideTimer) clearTimeout(overlayHideTimer);
      void pipeline.stop();
      wake.release();
      disposeStt();
    }
  };
}
