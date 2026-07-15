import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fetchSpecs,
  computeSha256,
  type ModelSpec,
  type ArchiveSpec
} from '../../../scripts/fetch-models';

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jarvis-fetch-models-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('fetchSpecs — hash-verify + skip logic (no network)', () => {
  it('skips a file already present on disk with a matching hash, without calling download', async () => {
    const content = 'hello world';
    writeFileSync(join(dir, 'thing.txt'), content);
    const spec: ModelSpec = {
      name: 'thing',
      url: 'https://example.invalid/thing.txt',
      sha256: sha256(content),
      dest: 'thing.txt'
    };
    const download = vi.fn(async () => Buffer.from('should not be called'));

    const [result] = await fetchSpecs([spec], { modelsRoot: dir, download });

    expect(result?.status).toBe('skipped');
    expect(download).not.toHaveBeenCalled();
  });

  it('re-downloads when the on-disk file hash does not match the pinned hash', async () => {
    writeFileSync(join(dir, 'thing.txt'), 'stale content');
    const freshContent = 'fresh content';
    const spec: ModelSpec = {
      name: 'thing',
      url: 'https://example.invalid/thing.txt',
      sha256: sha256(freshContent),
      dest: 'thing.txt'
    };
    const download = vi.fn(async () => Buffer.from(freshContent));

    const [result] = await fetchSpecs([spec], { modelsRoot: dir, download });

    expect(result?.status).toBe('downloaded');
    expect(download).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(dir, 'thing.txt'), 'utf-8')).toBe(freshContent);
  });

  it('downloads when the destination file is entirely missing', async () => {
    const content = 'brand new';
    const spec: ModelSpec = {
      name: 'thing',
      url: 'https://example.invalid/thing.txt',
      sha256: sha256(content),
      dest: 'nested/thing.txt'
    };
    const download = vi.fn(async () => Buffer.from(content));

    const [result] = await fetchSpecs([spec], { modelsRoot: dir, download });

    expect(result?.status).toBe('downloaded');
    expect(readFileSync(join(dir, 'nested', 'thing.txt'), 'utf-8')).toBe(content);
  });

  it('fails the spec when the freshly downloaded content does not match the pinned hash', async () => {
    const spec: ModelSpec = {
      name: 'thing',
      url: 'https://example.invalid/thing.txt',
      sha256: sha256('expected content'),
      dest: 'thing.txt'
    };
    const download = vi.fn(async () => Buffer.from('actually different content'));

    const [result] = await fetchSpecs([spec], { modelsRoot: dir, download });

    expect(result?.status).toBe('failed');
    expect(result?.message).toMatch(/sha256 mismatch/);
  });

  it('force re-downloads even when the on-disk hash already matches', async () => {
    const content = 'unchanged';
    writeFileSync(join(dir, 'thing.txt'), content);
    const spec: ModelSpec = {
      name: 'thing',
      url: 'https://example.invalid/thing.txt',
      sha256: sha256(content),
      dest: 'thing.txt'
    };
    const download = vi.fn(async () => Buffer.from(content));

    const [result] = await fetchSpecs([spec], { modelsRoot: dir, force: true, download });

    expect(result?.status).toBe('downloaded');
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('accepts and records a download when sha256 is null (pending pin)', async () => {
    const content = 'not yet pinned';
    const spec: ModelSpec = {
      name: 'thing',
      url: 'https://example.invalid/thing.txt',
      sha256: null,
      dest: 'thing.txt'
    };
    const download = vi.fn(async () => Buffer.from(content));

    const [result] = await fetchSpecs([spec], { modelsRoot: dir, download });

    expect(result?.status).toBe('downloaded');
    expect(result?.sha256).toBe(sha256(content));
  });

  it('a null-sha256 spec whose file already exists is skipped without downloading', async () => {
    writeFileSync(join(dir, 'thing.txt'), 'already here');
    const spec: ModelSpec = {
      name: 'thing',
      url: 'https://example.invalid/thing.txt',
      sha256: null,
      dest: 'thing.txt'
    };
    const download = vi.fn(async () => Buffer.from('unused'));

    const [result] = await fetchSpecs([spec], { modelsRoot: dir, download });

    expect(result?.status).toBe('skipped');
    expect(download).not.toHaveBeenCalled();
  });

  it('skips brain-group specs by default and only fetches them with withBrain', async () => {
    const content = 'brain data';
    const spec: ModelSpec = {
      name: 'brain-thing',
      url: 'https://example.invalid/brain.bin',
      sha256: sha256(content),
      dest: 'brain.bin',
      group: 'brain'
    };
    const download = vi.fn(async () => Buffer.from(content));

    const withoutBrain = await fetchSpecs([spec], { modelsRoot: dir, download });
    expect(withoutBrain[0]?.status).toBe('skipped-brain');
    expect(download).not.toHaveBeenCalled();

    const withBrain = await fetchSpecs([spec], { modelsRoot: dir, withBrain: true, download });
    expect(withBrain[0]?.status).toBe('downloaded');
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('processes multiple specs independently and reports one result per spec', async () => {
    const a = 'content a';
    const b = 'content b';
    const specs: ModelSpec[] = [
      { name: 'a', url: 'https://example.invalid/a', sha256: sha256(a), dest: 'a.bin' },
      { name: 'b', url: 'https://example.invalid/b', sha256: sha256(b), dest: 'b.bin' }
    ];
    const download = vi.fn(async (url: string) => Buffer.from(url.endsWith('/a') ? a : b));

    const results = await fetchSpecs(specs, { modelsRoot: dir, download });

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === 'downloaded')).toBe(true);
    expect(readFileSync(join(dir, 'a.bin'), 'utf-8')).toBe(a);
    expect(readFileSync(join(dir, 'b.bin'), 'utf-8')).toBe(b);
  });

  it('routes archive specs through the injected extractZip instead of the real unzip', async () => {
    const zipBytes = 'fake-zip-bytes';
    const extractedContent = 'extracted-exe-content';
    const spec: ModelSpec = {
      name: 'archived-thing',
      url: 'https://example.invalid/thing.zip',
      sha256: sha256(extractedContent),
      dest: 'bin/thing.exe',
      archive: { zipEntry: 'Release/thing.exe' }
    };
    const download = vi.fn(async () => Buffer.from(zipBytes));
    const extractZip = vi.fn(async (_zipPath: string, _archive: ArchiveSpec, modelsRoot: string) => {
      mkdirSync(join(modelsRoot, 'bin'), { recursive: true });
      writeFileSync(join(modelsRoot, 'bin', 'thing.exe'), extractedContent);
    });

    const [result] = await fetchSpecs([spec], { modelsRoot: dir, download, extractZip });

    expect(extractZip).toHaveBeenCalledTimes(1);
    expect(result?.status).toBe('downloaded');
    expect(readFileSync(join(dir, 'bin', 'thing.exe'), 'utf-8')).toBe(extractedContent);
  });
});

describe('computeSha256', () => {
  it('matches an independently computed sha256 of the same bytes', async () => {
    const p = join(dir, 'x.bin');
    writeFileSync(p, 'known content');
    expect(await computeSha256(p)).toBe(sha256('known content'));
  });
});
