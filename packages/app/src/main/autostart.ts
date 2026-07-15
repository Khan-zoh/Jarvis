import { app } from 'electron';

/**
 * Enables or disables launching Jarvis when the user logs in, via the OS login-item registry
 * (Windows: Run key / DPAPI-free). Keep this in sync with `config.ui.launchOnStartup`.
 */
export function setLaunchOnStartup(enabled: boolean): void {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    // Start minimized to the tray rather than popping a window on every login.
    args: ['--hidden']
  });
}

/** Reports whether the OS currently has Jarvis registered to launch at login. */
export function getLaunchOnStartup(): boolean {
  return app.getLoginItemSettings().openAtLogin;
}
