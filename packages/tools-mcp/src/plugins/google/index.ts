import type { PluginContext, ToolDef, ToolPlugin } from '../../plugin.js';
import { createGoogleAuthManager, type GoogleClients } from '../../google/auth.js';
import { buildGmailTools } from './gmail.js';
import { buildCalendarTools } from './calendar.js';
import { buildDriveTools } from './drive.js';

/**
 * Google Workspace plugin — Gmail, Calendar, and Drive tools (binding catalog:
 * cdd/plan/tools-and-google.md; effects per amendments.md §A4/A5).
 *
 * Connection state comes from google-auth (src/google/auth.ts), NOT from this plugin's own config:
 * the disposable MCP worker rebuilds refreshable API clients from the DPAPI-encrypted token file
 * under `JARVIS_DATA_DIR/google/` with no other input. When no token file exists, `getClients`
 * returns null and the plugin reports itself unavailable — the loader then registers the SAME tool
 * defs as stubs, so the google tool surface (names + schemas + effects) is identical whether or not
 * the account is connected; each stub replies with the setup hint.
 *
 * The `getClients` seam is injected so every unit test runs with fake googleapis clients — no
 * network and no real token file. Handlers thread the loader's per-call AbortSignal into every
 * googleapis call.
 */

const NOT_CONNECTED =
  'google account not connected — connect it in settings (Settings → Google: paste a client id ' +
  'and secret, then sign in).';

/** The seam: resolve authenticated googleapis clients, or null when Google isn't connected. */
export interface GooglePluginDeps {
  getClients(ctx: PluginContext): GoogleClients | null;
}

/** Production default: read + refresh clients from the encrypted token file (no browser needed). */
function defaultGetClients(ctx: PluginContext): GoogleClients | null {
  // getClients() only reads/refreshes tokens; the browser opener is never invoked here.
  const auth = createGoogleAuthManager({ dataDir: ctx.dataDir, openBrowser: () => {} });
  return auth.getClients();
}

export function createGooglePlugin(deps: Partial<GooglePluginDeps> = {}): ToolPlugin {
  const getClients = deps.getClients ?? defaultGetClients;

  return {
    id: 'google',
    displayName: 'Google Workspace',
    settings: [
      {
        key: 'clientId',
        label: 'Google client ID',
        kind: 'text',
        help:
          'From a Google Cloud desktop OAuth client. See docs/google-setup.md for the full ' +
          'walkthrough (enable Gmail/Calendar/Drive APIs → OAuth consent → desktop client).'
      },
      {
        key: 'clientSecret',
        label: 'Google client secret',
        kind: 'secret',
        help: 'The secret paired with the client ID above. Stored encrypted (DPAPI).'
      }
    ],
    async init(ctx) {
      const clients = getClients(ctx);
      const tools: ToolDef<any>[] = [
        ...buildGmailTools(clients?.gmail ?? null, NOT_CONNECTED),
        ...buildCalendarTools(clients?.calendar ?? null, NOT_CONNECTED),
        ...buildDriveTools(clients?.drive ?? null, NOT_CONNECTED)
      ];
      // Same tool defs either way (stable surface). When disconnected they're stubs whose handlers
      // short-circuit to NOT_CONNECTED; the loader logs the plugin as inactive.
      if (!clients) return { unavailable: NOT_CONNECTED, stubTools: tools };
      return { tools };
    }
  };
}

const googlePlugin: ToolPlugin = createGooglePlugin();
export default googlePlugin;
