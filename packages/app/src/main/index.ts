import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { app, shell } from 'electron';
import { createGoogleAuthManager } from '../../../tools-mcp/src/google/auth';
import { ConfigStore } from './config';
import { WindowManager } from './windows';
import { registerInvokeHandlers, type IpcDeps } from './ipc';
import { setLaunchOnStartup } from './autostart';
import { resolveModelPaths } from './modelPaths';
import type { VoiceStatus } from '../shared/types';
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

    wm.createTray({
      onOpen: () => wm.showMain(),
      onNewSession: () => {
        // Wired to SessionStore/AgentRouter in the agent-backends task (startup step 4).
        void deps.newSession();
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

    // Keep the OS login-item registration in step with config.
    setLaunchOnStartup(config.get().ui.launchOnStartup);

    // Broadcast redacted config changes to every renderer.
    config.on('changed', (redacted) => wm.broadcast('config:changed', redacted));

    // -----------------------------------------------------------------------------------------
    // IPC: config/app:quit/voice channels are real. Agent/session/google handlers remain stubs
    // that later tasks replace by injecting real implementations through this same IpcDeps.
    // -----------------------------------------------------------------------------------------
    const deps: IpcDeps = {
      config,
      // Text bar entry: enters the state machine at the transcribing-equivalent point.
      // (Router lands in wire-and-converse; today the pipeline logs the utterance / echoes it
      // under --echo.) No-op in text-only mode until the router exists to receive text directly.
      sendTextCommand: async (text) => {
        voiceRuntime?.pipeline.injectText(text);
      },
      cancelPipeline: async () => {
        voiceRuntime?.pipeline.cancel();
      },
      // TODO(agent-backends task): back with SessionStore.
      listSessions: async () => [],
      loadSession: async () => [],
      newSession: async () => {},
      // Google OAuth (installed-app loopback). The flow runs in the app because it must open a
      // browser; the disposable MCP worker only ever reads the persisted token file. dataDir is
      // userData, matching what the tools-mcp launcher passes as JARVIS_DATA_DIR.
      connectGoogle: async () => {
        const { clientId, clientSecret } = config.get().google;
        if (!clientId || !clientSecret) {
          throw new Error(
            'Add your Google client ID and secret in Settings before connecting.'
          );
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
      },
      disconnectGoogle: async () => {
        const manager = createGoogleAuthManager({
          dataDir: app.getPath('userData'),
          openBrowser: () => {}
        });
        await manager.disconnect();
        config.set({ google: { ...config.get().google, connectedEmail: null } });
      },
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
      quit: async () => {
        app.quit();
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
    // -----------------------------------------------------------------------------------------
    const result = await startVoicePipeline(config, wm);
    if ('reason' in result) {
      voiceDisabledReason = result.reason;
      console.log(`[main] voice disabled (text-only mode): ${result.reason}`);
    } else {
      voiceRuntime = result;
      voiceDisabledReason = null;
      wm.setListening(true);
      console.log('[main] voice pipeline started');
    }

    // Startup step 6 (partial, per cdd/tasks/voice-pipeline.md acceptance: "router not wired
    // yet — pipeline emits `utterance`; log it"): utterances are logged inside
    // startVoicePipeline; wire-and-converse connects router.dispatch → pipeline.onAgentEvent.
  });

  app.on('window-all-closed', () => {
    // Jarvis is a resident tray app: closing all windows does NOT quit. Quit is explicit (tray →
    // Quit, or app:quit). On macOS this is the norm anyway.
  });

  app.on('will-quit', () => {
    // Tear down child processes (ffmpeg capture, whisper-server) — no orphans.
    voiceRuntime?.dispose();
    voiceRuntime = null;
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
  wm: WindowManager
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

  // Dev --echo flag (Gate A): the pipeline speaks the final transcript straight back.
  if (process.argv.includes('--echo')) {
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
  pipeline.on('utterance', (text) => {
    // Router not wired yet (Gate A acceptance): log the final utterance.
    console.log(`[voice] utterance: ${JSON.stringify(text)}`);
  });

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
