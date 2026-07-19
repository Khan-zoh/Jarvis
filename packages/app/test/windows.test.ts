import { describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
// windows.ts imports many electron main-process symbols at module scope; none are touched by the
// pure computeOverlayBounds function, but the import must resolve headlessly.
vi.mock('electron', () => ({
  app: {},
  BrowserWindow: class {},
  globalShortcut: {},
  Menu: {},
  nativeImage: {},
  screen: {},
  Tray: class {}
}));
import {
  computeOverlayBounds,
  resolveWindowAssetPaths,
  OVERLAY_SIZE,
  OVERLAY_BOTTOM_MARGIN,
  type Rect
} from '../src/main/windows';

describe('resolveWindowAssetPaths', () => {
  it('resolves packaged assets from an ESM main-module URL without CommonJS __dirname', () => {
    const mainFile = join('C:\\example', 'resources', 'app.asar', 'out', 'main', 'index.js');
    const mainDir = dirname(mainFile);
    expect(resolveWindowAssetPaths(pathToFileURL(mainFile).href)).toEqual({
      rendererHtml: join(mainDir, '../renderer/index.html'),
      preload: join(mainDir, '../preload/index.mjs')
    });
  });
});

describe('computeOverlayBounds', () => {
  it('horizontally centers and bottom-pins on a primary display at origin', () => {
    const workArea: Rect = { x: 0, y: 0, width: 1920, height: 1040 }; // 1080 minus a taskbar
    const b = computeOverlayBounds(workArea);
    expect(b.width).toBe(OVERLAY_SIZE.width);
    expect(b.height).toBe(OVERLAY_SIZE.height);
    expect(b.x).toBe(Math.round((1920 - OVERLAY_SIZE.width) / 2));
    expect(b.y).toBe(1040 - OVERLAY_SIZE.height - OVERLAY_BOTTOM_MARGIN);
  });

  it('respects a work area offset (secondary display / taskbar inset)', () => {
    const workArea: Rect = { x: 1920, y: 24, width: 2560, height: 1400 };
    const b = computeOverlayBounds(workArea);
    expect(b.x).toBe(Math.round(1920 + (2560 - OVERLAY_SIZE.width) / 2));
    expect(b.y).toBe(24 + 1400 - OVERLAY_SIZE.height - OVERLAY_BOTTOM_MARGIN);
    // stays inside the work area horizontally
    expect(b.x).toBeGreaterThanOrEqual(workArea.x);
    expect(b.x + b.width).toBeLessThanOrEqual(workArea.x + workArea.width);
  });

  it('honors custom size and margin overrides', () => {
    const workArea: Rect = { x: 0, y: 0, width: 1000, height: 1000 };
    const b = computeOverlayBounds(workArea, { width: 400, height: 100 }, 10);
    expect(b).toEqual({ x: 300, y: 890, width: 400, height: 100 });
  });
});
