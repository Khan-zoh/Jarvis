import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  globalShortcut,
  Menu,
  nativeImage,
  screen,
  shell,
  Tray
} from 'electron';
import type { ConfigStore } from './config';
import type { PushChannels } from './ipc';

/** A rectangle in screen pixels (matches Electron's `Display.workArea`). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export const OVERLAY_SIZE: Size = { width: 520, height: 120 };
/** Gap between the overlay's bottom edge and the bottom of the work area. */
export const OVERLAY_BOTTOM_MARGIN = 48;

export interface WindowAssetPaths {
  rendererHtml: string;
  preload: string;
}

/**
 * Resolve built renderer/preload assets relative to the ESM main bundle. `__dirname` does not
 * exist in the packaged ESM runtime; deriving it from `import.meta.url` works in dev and inside
 * Electron's app.asar filesystem.
 */
export function resolveWindowAssetPaths(mainModuleUrl: string): WindowAssetPaths {
  const mainDir = dirname(fileURLToPath(mainModuleUrl));
  return {
    rendererHtml: join(mainDir, '../renderer/index.html'),
    preload: join(mainDir, '../preload/index.mjs')
  };
}

const WINDOW_ASSETS = resolveWindowAssetPaths(import.meta.url);

/**
 * Pure geometry: centre `size` horizontally in `workArea` and pin it near the bottom. Extracted so
 * the overlay placement can be unit-tested without constructing a BrowserWindow.
 */
export function computeOverlayBounds(
  workArea: Rect,
  size: Size = OVERLAY_SIZE,
  bottomMargin: number = OVERLAY_BOTTOM_MARGIN
): Rect {
  const x = Math.round(workArea.x + (workArea.width - size.width) / 2);
  const y = Math.round(workArea.y + workArea.height - size.height - bottomMargin);
  return { x, y, width: size.width, height: size.height };
}

/** Handlers invoked by the tray menu. All optional; app-core supplies safe defaults. */
export interface TrayActions {
  onOpen(): void;
  onNewSession(): void;
  onToggleListening(): void;
  onQuit(): void;
}

// 16x16 blue dot, generated at build time and embedded so the tray has an icon without shipping a
// binary asset. Replaced by the design task with a real icon.
const TRAY_ICON_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAO0lEQVR4nGPQrf3GQAnGJfEfBybKAFyasRpCqmYMQ8jRjGIIuZrhhowaQEUDKI5GqiQkqiRlqmQmkjAACRI7g//M0UQAAAAASUVORK5CYII=';

/**
 * Loads the single renderer entry into a window. The renderer routes on the `view` QUERY
 * parameter (`index.html?view=overlay` — see src/renderer/index.ts, which reads
 * `window.location.search`), so the overlay must be loaded with a query string, not a hash.
 */
function loadRenderer(win: BrowserWindow, view?: 'overlay'): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void win.loadURL(view ? `${devUrl}?view=${view}` : devUrl);
  } else {
    void win.loadFile(
      WINDOW_ASSETS.rendererHtml,
      view ? { query: { view } } : undefined
    );
  }
}

/**
 * Resolves the shipped `wakeword-setup.md` doc: packaged it is an extraResource under
 * `<resourcesPath>/docs/`; in dev it lives at the repo root `docs/` (app path is packages/app).
 */
function wakewordDocPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'docs', 'wakeword-setup.md')
    : join(app.getAppPath(), '..', '..', 'docs', 'wakeword-setup.md');
}

/**
 * Security + link hardening for a renderer's webContents: the app is a fixed local page, so it must
 * never navigate away in-window. External http(s)/mailto links open in the user's default browser;
 * the settings "how to train a wake word" link (href="docs/wakeword-setup.md") opens the shipped
 * markdown doc in the OS default handler. Everything else is denied.
 */
function wireExternalLinks(webContents: Electron.WebContents): void {
  const handle = (rawUrl: string): void => {
    if (/wakeword-setup\.md($|[?#])/.test(rawUrl)) {
      void shell.openPath(wakewordDocPath());
      return;
    }
    if (/^(https?|mailto):/.test(rawUrl)) {
      void shell.openExternal(rawUrl);
    }
  };
  // window.open / target=_blank / anchor clicks that would spawn a window.
  webContents.setWindowOpenHandler(({ url }) => {
    handle(url);
    return { action: 'deny' };
  });
  // In-window navigations (a plain <a href> click): never leave the app page.
  webContents.on('will-navigate', (event, url) => {
    if (webContents.getURL() === url) return; // allow initial load / reload
    event.preventDefault();
    handle(url);
  });
}

/**
 * Owns the tray, the always-on-top overlay, and the main history/settings window, plus the global
 * hotkey and typed IPC broadcast.
 */
export class WindowManager {
  private tray: Tray | null = null;
  private overlay: BrowserWindow | null = null;
  private mainWindow: BrowserWindow | null = null;
  private listening = false;
  private actions: TrayActions;

  constructor(private readonly config: ConfigStore) {
    this.actions = {
      onOpen: () => this.showMain(),
      onNewSession: () => {},
      onToggleListening: () => {
        this.listening = !this.listening;
        this.rebuildTrayMenu();
      },
      onQuit: () => app.quit()
    };
  }

  /** Creates the tray icon and context menu. Pass `actions` to override the defaults. */
  createTray(actions: Partial<TrayActions> = {}): void {
    this.actions = { ...this.actions, ...actions };
    const icon = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_PNG_BASE64, 'base64'));
    this.tray = new Tray(icon);
    this.tray.setToolTip(this.config.get().agentName);
    this.tray.on('click', () => this.actions.onOpen());
    this.rebuildTrayMenu();
  }

  private rebuildTrayMenu(): void {
    if (!this.tray) return;
    const menu = Menu.buildFromTemplate([
      { label: 'Open', click: () => this.actions.onOpen() },
      { label: 'New session', click: () => this.actions.onNewSession() },
      {
        label: this.listening ? 'Pause listening' : 'Resume listening',
        click: () => this.actions.onToggleListening()
      },
      { type: 'separator' },
      // Temporary debug affordance so the overlay can be exercised before the voice pipeline lands.
      { label: 'Show overlay (debug)', click: () => this.showOverlay() },
      { label: 'Hide overlay (debug)', click: () => this.hideOverlay() },
      { type: 'separator' },
      { label: 'Quit', click: () => this.actions.onQuit() }
    ]);
    this.tray.setContextMenu(menu);
  }

  /** Reflects listening state in the tray label without going through a tray click. */
  setListening(listening: boolean): void {
    this.listening = listening;
    this.rebuildTrayMenu();
  }

  private ensureOverlay(): BrowserWindow {
    if (this.overlay && !this.overlay.isDestroyed()) return this.overlay;
    const bounds = computeOverlayBounds(screen.getPrimaryDisplay().workArea);
    const win = new BrowserWindow({
      ...bounds,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      focusable: false,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: WINDOW_ASSETS.preload,
        contextIsolation: true,
        nodeIntegration: false,
        // sandbox: true is DESIRED but NOT enabled (amendments deferred item — attempted here).
        // Electron loads sandboxed preloads through its own CommonJS-only loader; an ESM preload
        // is unsupported in a sandbox. electron-vite emits the preload as `index.mjs` (ESM, forced
        // by this package's "type":"module"), so flipping sandbox:true makes the preload fail to
        // load and `window.jarvis` never gets exposed — the whole IPC bridge dies. Converting the
        // preload to a CJS artifact under an ESM package is non-trivial (extension/format juggling)
        // and would put the entire contextBridge surface at risk with no headless way to verify it.
        // The real boundaries — contextIsolation:true + nodeIntegration:false — are already on, and
        // the preload is small/trusted. Left off deliberately; revisit if the preload build moves
        // to CJS. See cdd/plan/amendments.md ("Renderer sandbox: true").
        sandbox: false
      }
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    // Click-through while idle; the pipeline flips this off when the overlay is interactive.
    win.setIgnoreMouseEvents(true);
    wireExternalLinks(win.webContents);
    loadRenderer(win, 'overlay');
    win.on('closed', () => {
      this.overlay = null;
    });
    this.overlay = win;
    return win;
  }

  showOverlay(): void {
    const win = this.ensureOverlay();
    const bounds = computeOverlayBounds(screen.getPrimaryDisplay().workArea);
    win.setBounds(bounds);
    win.showInactive();
  }

  hideOverlay(): void {
    if (this.overlay && !this.overlay.isDestroyed()) {
      this.overlay.hide();
    }
  }

  /** When idle the overlay ignores mouse events (click-through); pass false to make it interactive. */
  setOverlayClickThrough(clickThrough: boolean): void {
    if (this.overlay && !this.overlay.isDestroyed()) {
      this.overlay.setIgnoreMouseEvents(clickThrough);
    }
  }

  showMain(): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      if (this.mainWindow.isMinimized()) this.mainWindow.restore();
      this.mainWindow.show();
      this.mainWindow.focus();
      return;
    }
    const win = new BrowserWindow({
      width: 900,
      height: 670,
      show: false,
      backgroundColor: '#ffffff',
      webPreferences: {
        preload: WINDOW_ASSETS.preload,
        contextIsolation: true,
        nodeIntegration: false,
        // sandbox: true is DESIRED but NOT enabled (amendments deferred item — attempted here).
        // Electron loads sandboxed preloads through its own CommonJS-only loader; an ESM preload
        // is unsupported in a sandbox. electron-vite emits the preload as `index.mjs` (ESM, forced
        // by this package's "type":"module"), so flipping sandbox:true makes the preload fail to
        // load and `window.jarvis` never gets exposed — the whole IPC bridge dies. Converting the
        // preload to a CJS artifact under an ESM package is non-trivial (extension/format juggling)
        // and would put the entire contextBridge surface at risk with no headless way to verify it.
        // The real boundaries — contextIsolation:true + nodeIntegration:false — are already on, and
        // the preload is small/trusted. Left off deliberately; revisit if the preload build moves
        // to CJS. See cdd/plan/amendments.md ("Renderer sandbox: true").
        sandbox: false
      }
    });
    win.on('ready-to-show', () => win.show());
    win.on('closed', () => {
      this.mainWindow = null;
    });
    wireExternalLinks(win.webContents);
    loadRenderer(win);
    this.mainWindow = win;
  }

  /** Minimizes the main window (titlebar minimize glyph via the `window:minimize` invoke). */
  minimizeMain(): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.minimize();
    }
  }

  /** Toggles the main window's visibility. Used by the global hotkey by default. */
  toggleMain(): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed() && this.mainWindow.isVisible()) {
      this.mainWindow.hide();
    } else {
      this.showMain();
    }
  }

  /** Typed fan-out of a push channel to every open renderer. */
  broadcast<K extends keyof PushChannels>(ch: K, ...args: Parameters<PushChannels[K]>): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(ch, ...args);
      }
    }
  }

  /** Registers a global accelerator. Returns whether the OS accepted it. */
  registerHotkey(accelerator: string, onTrigger: () => void): boolean {
    if (!accelerator) return false;
    globalShortcut.unregister(accelerator);
    return globalShortcut.register(accelerator, onTrigger);
  }

  /** Tears down tray, windows, and global shortcuts. */
  dispose(): void {
    globalShortcut.unregisterAll();
    this.tray?.destroy();
    this.tray = null;
    if (this.overlay && !this.overlay.isDestroyed()) this.overlay.destroy();
    if (this.mainWindow && !this.mainWindow.isDestroyed()) this.mainWindow.destroy();
  }
}
