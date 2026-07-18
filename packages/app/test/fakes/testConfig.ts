import type { AppConfig, BackendId } from '../../src/shared/types';

/**
 * A fully-populated AppConfig for agent-core tests. Built by hand (not imported from
 * src/main/config) so agent tests never touch a module that imports 'electron'.
 */
export function makeConfig(overrides?: {
  agentName?: string;
  defaultBackend?: BackendId;
  systemPromptExtra?: string;
  secondBrain?: Partial<AppConfig['secondBrain']>;
}): AppConfig {
  return {
    agentName: overrides?.agentName ?? 'Jarvis',
    voice: {
      picovoiceAccessKey: '',
      builtinKeyword: 'jarvis',
      customKeywordPath: null,
      sensitivity: 0.6,
      inputDeviceId: null,
      listenTimeoutMs: 8000,
      sttModelPath: '',
      ttsVoicePath: '',
      ttsEnabled: false
    },
    agents: {
      defaultBackend: overrides?.defaultBackend ?? 'claude',
      claude: { systemPromptExtra: overrides?.systemPromptExtra ?? '' },
      codex: { model: null }
    },
    google: { clientId: '', clientSecret: '', connectedEmail: null },
    ui: { launchOnStartup: false, hotkey: 'Ctrl+Shift+Space' },
    secondBrain: {
      enabled: overrides?.secondBrain?.enabled ?? false,
      vaultDir: overrides?.secondBrain?.vaultDir ?? 'D:\\JarvisBrain',
      autoCapture: overrides?.secondBrain?.autoCapture ?? true,
      recallMode: overrides?.secondBrain?.recallMode ?? 'hybrid'
    }
  };
}
