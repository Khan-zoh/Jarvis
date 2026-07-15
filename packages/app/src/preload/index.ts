import { contextBridge } from 'electron';

// The full typed `window.jarvis` API (buildPreloadApi) lands in the app-core task; the scaffold
// only proves that context isolation + a preload bridge are wired up end to end.
contextBridge.exposeInMainWorld('jarvis', {
  scaffold: true
});
