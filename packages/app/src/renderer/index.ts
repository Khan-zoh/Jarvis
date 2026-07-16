/// <reference types="vite/client" />
import { MainView } from './main/app';
import { OverlayView } from './overlay/overlay';
import type { JarvisApi } from './shared/api';

/**
 * Single renderer entry for both windows. The main process loads:
 *   index.html            → main window (history + settings)
 *   index.html?view=overlay → overlay window
 * Dev-only: append &demo=1 (or ?demo=1) to drive either view with fake events.
 */
const params = new URLSearchParams(window.location.search);
const view: 'overlay' | 'main' = params.get('view') === 'overlay' ? 'overlay' : 'main';
document.documentElement.dataset['view'] = view;

async function resolveApi(): Promise<JarvisApi> {
  if (import.meta.env.DEV && params.get('demo') === '1') {
    const { startDemo } = await import('./demo');
    return startDemo(view);
  }
  if (!window.jarvis) {
    throw new Error('window.jarvis missing — preload did not run');
  }
  return window.jarvis;
}

const root = document.getElementById('app');
if (root) {
  void resolveApi().then((api) => {
    if (view === 'overlay') {
      new OverlayView(root, api);
    } else {
      new MainView(root, api);
    }
  });
}
