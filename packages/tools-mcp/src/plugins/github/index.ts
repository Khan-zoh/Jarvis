import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { ToolDef, ToolPlugin } from '../../plugin.js';

type GhRunner = (args: string[]) => Promise<string>;

const defaultRunGh: GhRunner = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn('gh', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('GitHub CLI timed out'));
    }, 25_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 250_000) stdout = stdout.slice(0, 250_000);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`GitHub CLI could not start: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error((stderr.trim() || `GitHub CLI exited ${code}`).slice(0, 1000)));
    });
  });

const repository = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'use owner/repository format');

function summarizeJson(raw: string, maxChars = 12_000): string {
  if (!raw) return 'no results';
  try {
    const formatted = JSON.stringify(JSON.parse(raw), null, 2);
    return formatted.length > maxChars ? `${formatted.slice(0, maxChars)}\n… truncated` : formatted;
  } catch {
    return raw.length > maxChars ? `${raw.slice(0, maxChars)}\n… truncated` : raw;
  }
}

export function createGitHubPlugin(runGh: GhRunner = defaultRunGh): ToolPlugin {
  return {
    id: 'github',
    displayName: 'GitHub',
    settings: [
      {
        key: 'allowWrites',
        label: 'Allow creating issues and comments',
        kind: 'toggle',
        help: 'Requires GitHub CLI authentication. Leave off for read-only repository access.'
      }
    ],
    async init(ctx) {
      const allowWrites = ctx.config['allowWrites'] === true;
      const status: ToolDef<Record<string, never>> = {
        name: 'github_status',
        description: 'Check whether the local GitHub CLI is authenticated and ready for GitHub tools.',
        effect: 'read',
        inputSchema: z.object({}),
        handler: async () => ({ text: (await runGh(['auth', 'status'])).slice(0, 3000) })
      };
      const issues: ToolDef<{ repository: string; state: 'open' | 'closed' | 'all'; limit: number }> = {
        name: 'github_list_issues',
        description: 'List issues in a GitHub repository. The repository must be owner/name.',
        effect: 'read',
        openWorld: true,
        inputSchema: z.object({
          repository,
          state: z.enum(['open', 'closed', 'all']).default('open'),
          limit: z.number().int().min(1).max(50).default(20)
        }),
        handler: async ({ repository: repo, state, limit }) => ({
          text: summarizeJson(
            await runGh([
              'issue',
              'list',
              '--repo',
              repo,
              '--state',
              state,
              '--limit',
              String(limit),
              '--json',
              'number,title,state,author,labels,updatedAt,url'
            ])
          )
        })
      };
      const pullRequests: ToolDef<{ repository: string; state: 'open' | 'closed' | 'merged' | 'all'; limit: number }> = {
        name: 'github_list_pull_requests',
        description: 'List pull requests in a GitHub repository.',
        effect: 'read',
        openWorld: true,
        inputSchema: z.object({
          repository,
          state: z.enum(['open', 'closed', 'merged', 'all']).default('open'),
          limit: z.number().int().min(1).max(50).default(20)
        }),
        handler: async ({ repository: repo, state, limit }) => ({
          text: summarizeJson(
            await runGh([
              'pr',
              'list',
              '--repo',
              repo,
              '--state',
              state,
              '--limit',
              String(limit),
              '--json',
              'number,title,state,author,isDraft,reviewDecision,updatedAt,url'
            ])
          )
        })
      };
      const view: ToolDef<{ repository: string; number: number; kind: 'issue' | 'pr' }> = {
        name: 'github_view_item',
        description: 'Read one GitHub issue or pull request, including its discussion and metadata.',
        effect: 'read',
        openWorld: true,
        inputSchema: z.object({ repository, number: z.number().int().positive(), kind: z.enum(['issue', 'pr']) }),
        handler: async ({ repository: repo, number, kind }) => ({
          text: summarizeJson(
            await runGh([
              kind,
              'view',
              String(number),
              '--repo',
              repo,
              '--json',
              kind === 'pr'
                ? 'number,title,body,state,author,comments,reviews,files,statusCheckRollup,url'
                : 'number,title,body,state,author,comments,labels,url'
            ]),
            20_000
          )
        })
      };
      const comment: ToolDef<{ repository: string; number: number; body: string }> = {
        name: 'github_comment',
        description: 'Post a comment to a GitHub issue or pull request. Disabled unless enabled in GitHub settings.',
        effect: 'outward',
        openWorld: true,
        inputSchema: z.object({ repository, number: z.number().int().positive(), body: z.string().min(1).max(20_000) }),
        handler: async ({ repository: repo, number, body }) => {
          if (!allowWrites) return { text: 'GitHub writes are disabled in Jarvis settings.', isError: true };
          const result = await runGh(['issue', 'comment', String(number), '--repo', repo, '--body', body]);
          return { text: result || `commented on ${repo}#${number}` };
        }
      };
      return { tools: [status, issues, pullRequests, view, comment] };
    }
  };
}

export default createGitHubPlugin();
