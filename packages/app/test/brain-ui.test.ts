// @vitest-environment jsdom
// Typechecked under tsconfig.web.json (DOM lib); vitest runs it in jsdom via the docblock above.
import { beforeEach, describe, expect, it } from 'vitest';
import { MainView } from '../src/renderer/main/app';
import { buildSettingsPane } from '../src/renderer/main/settings';
import { createFakeApi, type FakeApi } from '../src/renderer/shared/fakeApi';
import { DEFAULT_APP_CONFIG } from '../src/shared/types';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('recently-captured strip', () => {
  let api: FakeApi;
  let root: HTMLElement;

  beforeEach(async () => {
    document.body.innerHTML = '<div id="app"></div>';
    root = document.getElementById('app') as HTMLElement;
    api = createFakeApi();
    api.capturedNotes = [{ id: 'n1', title: "sister's birthday", at: 'now' }];
    new MainView(root, api);
    await flush();
  });

  const rows = (): HTMLLIElement[] =>
    Array.from(root.querySelectorAll('.captured-list .captured-item')) as HTMLLIElement[];

  it('renders the initial captured notes as "noted:" rows', () => {
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.querySelector('.captured-label')!.textContent).toBe("noted: sister's birthday");
  });

  it('prepends a row when brain:captured fires', async () => {
    api.pushBrainCaptured({ id: 'n2', title: 'coffee is oat milk', at: 'now' });
    expect(rows()).toHaveLength(2);
    expect(rows()[0]!.dataset['noteId']).toBe('n2');
  });

  it('one-click undo calls brainRemove and drops the row', () => {
    const undo = rows()[0]!.querySelector('.captured-undo') as HTMLButtonElement;
    undo.click();
    expect(api.calls.brainRemove).toEqual(['n1']);
    expect(rows()).toHaveLength(0);
  });

  it('brain:removed push drops the matching row', () => {
    api.pushBrainRemoved('n1');
    expect(rows()).toHaveLength(0);
  });
});

describe('settings second-brain section', () => {
  let api: FakeApi;
  let pane: ReturnType<typeof buildSettingsPane>;

  const brainSection = (): HTMLElement =>
    Array.from(pane.el.querySelectorAll('section')).find(
      (s) => s.querySelector('h2')?.textContent === 'second brain'
    ) as HTMLElement;

  beforeEach(async () => {
    api = createFakeApi();
    pane = buildSettingsPane(api, { debounceMs: 0 });
    pane.applyConfig(structuredClone(DEFAULT_APP_CONFIG));
    await flush();
  });

  it('renders enabled, vault, auto-capture, recall mode + action buttons', () => {
    const sec = brainSection();
    expect(sec).toBeTruthy();
    expect(sec.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
    expect(sec.querySelector('select')).toBeTruthy();
    const btns = Array.from(sec.querySelectorAll('button')).map((b) => b.textContent);
    expect(btns).toContain('rebuild search index');
    expect(btns).toContain('clean up my brain');
  });

  it('the master toggle round-trips to config.secondBrain.enabled', async () => {
    const enabled = brainSection().querySelector('input[type="checkbox"]') as HTMLInputElement;
    enabled.checked = true;
    enabled.dispatchEvent(new Event('change'));
    await flush();
    const last = api.calls.setConfig.at(-1);
    expect(last?.secondBrain?.enabled).toBe(true);
  });

  it('recall mode round-trips to config', async () => {
    const select = brainSection().querySelector('select') as HTMLSelectElement;
    select.value = 'proactive';
    select.dispatchEvent(new Event('change'));
    await flush();
    const last = api.calls.setConfig.at(-1);
    expect(last?.secondBrain?.recallMode).toBe('proactive');
  });

  it('the reindex button invokes the brain plugin action', () => {
    const btn = Array.from(brainSection().querySelectorAll('button')).find(
      (b) => b.textContent === 'rebuild search index'
    ) as HTMLButtonElement;
    btn.click();
    expect(api.calls.pluginAction).toContainEqual(['brain', 'reindex']);
  });
});
