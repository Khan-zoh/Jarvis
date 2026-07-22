import { describe, expect, it, vi } from 'vitest';
import { createGitHubPlugin } from '../src/plugins/github/index';

async function tools(allowWrites = false) {
  const run = vi.fn(async () => '[]');
  const plugin = createGitHubPlugin(run);
  const initialized = await plugin.init({
    dataDir: 'C:/data',
    config: { allowWrites },
    secret: () => null,
    logger: { info: () => {}, warn: () => {}, error: () => {} }
  });
  if (!('tools' in initialized)) throw new Error('plugin unexpectedly inactive');
  return { run, tools: initialized.tools };
}

describe('GitHub plugin', () => {
  it('lists issues through argument-safe gh invocation', async () => {
    const fixture = await tools();
    const tool = fixture.tools.find((item) => item.name === 'github_list_issues');
    await tool?.handler({ repository: 'Khan-zoh/Jarvis', state: 'open', limit: 10 });
    expect(fixture.run).toHaveBeenCalledWith([
      'issue', 'list', '--repo', 'Khan-zoh/Jarvis', '--state', 'open', '--limit', '10', '--json',
      'number,title,state,author,labels,updatedAt,url'
    ]);
  });

  it('keeps outward writes disabled until the user opts in', async () => {
    const fixture = await tools(false);
    const tool = fixture.tools.find((item) => item.name === 'github_comment');
    const result = await tool?.handler({ repository: 'Khan-zoh/Jarvis', number: 1, body: 'hello' });
    expect(result?.isError).toBe(true);
    expect(fixture.run).not.toHaveBeenCalled();
  });
});
