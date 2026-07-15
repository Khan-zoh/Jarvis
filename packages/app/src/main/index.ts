import { app } from 'electron';
import { ConfigStore } from './config';
import { WindowManager } from './windows';
import { registerInvokeHandlers, type IpcDeps } from './ipc';
import { setLaunchOnStartup } from './autostart';

// ---------------------------------------------------------------------------------------------
// Startup step 1: single-instance lock. A second launch focuses the existing main window and the
// duplicate process exits immediately.
// ---------------------------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let windows: WindowManager | null = null;

  app.on('second-instance', () => {
    windows?.showMain();
  });

  void app.whenReady().then(() => {
    // -----------------------------------------------------------------------------------------
    // Startup step 2: load config, bring up the WindowManager, show the tray immediately.
    // -----------------------------------------------------------------------------------------
    const config = new ConfigStore(app.getPath('userData'));
    const wm = new WindowManager(config);
    windows = wm;

    wm.createTray({
      onOpen: () => wm.showMain(),
      onNewSession: () => {
        // Wired to SessionStore/AgentRouter in the agent-backends task (startup step 4).
        void deps.newSession();
      },
      onToggleListening: () => {
        // Wired to VoicePipeline in the voice task (startup step 5).
        void deps.cancelPipeline();
      },
      onQuit: () => app.quit()
    });

    // Keep the OS login-item registration in step with config.
    setLaunchOnStartup(config.get().ui.launchOnStartup);

    // Broadcast redacted config changes to every renderer.
    config.on('changed', (redacted) => wm.broadcast('config:changed', redacted));

    // -----------------------------------------------------------------------------------------
    // IPC: config + app:quit are real now. Voice/agent/session/google handlers are stubs that
    // later tasks replace by injecting real implementations through this same IpcDeps object.
    // -----------------------------------------------------------------------------------------
    const deps: IpcDeps = {
      config,
      // TODO(voice task): route text into the pipeline at the transcribing stage.
      sendTextCommand: async () => {},
      // TODO(voice task): cancel listening/speaking/current turn.
      cancelPipeline: async () => {},
      // TODO(agent-backends task): back with SessionStore.
      listSessions: async () => [],
      loadSession: async () => [],
      newSession: async () => {},
      // TODO(google task): run the OAuth flow.
      connectGoogle: async () => {
        throw new Error('Google connect is not implemented yet.');
      },
      disconnectGoogle: async () => {},
      // TODO(voice task): enumerate real audio input devices.
      listAudioInputs: async () => [],
      quit: async () => {
        app.quit();
      }
    };
    registerInvokeHandlers(deps);

    // Global hotkey toggles the main window (push-to-talk text bar hookup arrives with the voice
    // task; for now it opens/focuses the window).
    wm.registerHotkey(config.get().ui.hotkey, () => wm.toggleMain());

    // Show the main window on first launch unless started hidden (login autostart).
    if (!process.argv.includes('--hidden')) {
      wm.showMain();
    }

    // -----------------------------------------------------------------------------------------
    // Startup steps 3–6 (owned by later tasks):
    //   3. Construct tools-mcp launch spec (command + args) from config.        [tools-mcp task]
    //   4. Construct AgentRouter (Claude + Codex) + SessionStore.               [agent-backends]
    //   5. Construct VoicePipeline; start only if wake-word prerequisites are   [voice task]
    //      configured, else stay text-only and surface a setup notice.
    //   6. Wire pipeline finalTranscript → router.dispatch → agent events →     [voice task]
    //      TTS sentence queue + IPC broadcast.
    // Each replaces the matching stub above rather than adding new IPC surface.
    // -----------------------------------------------------------------------------------------
  });

  app.on('window-all-closed', () => {
    // Jarvis is a resident tray app: closing all windows does NOT quit. Quit is explicit (tray →
    // Quit, or app:quit). On macOS this is the norm anyway.
  });

  app.on('will-quit', () => {
    windows?.dispose();
  });
}
