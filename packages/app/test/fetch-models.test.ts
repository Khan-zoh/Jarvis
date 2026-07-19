import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fetchSpecs,
  computeSha256,
  resolveUnderRoot,
  type ModelSpec,
  type ArchiveSpec,
  type ZipEntryMapping
} from '../../../scripts/fetch-models';
import { readdirSync, existsSync } from 'node:fs';

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Names of leftover staging dirs inside a models root (must be [] after every run). */
function stagingDirsIn(root: string): string[] {
  return readdirSync(root).filter((n) => n.startsWith('.staging-'));
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

describe('fetchSpecs — staged pipeline (B7: zip-slip, staging isolation, atomic promote)', () => {
  it('extracts through the zip-slip guard: a ../ traversal entry fails the spec, extracts nothing, and cleans staging', async () => {
    const spec: ModelSpec = {
      name: 'evil-archive',
      url: 'https://example.invalid/evil.zip',
      sha256: sha256('whatever'),
      dest: 'bin/tool.exe',
      archive: { zipEntry: 'tree/tool.exe', extractAll: { stripPrefix: 'tree/' } }
    };
    const download = vi.fn(async () => Buffer.from('zip-bytes'));
    const listZipEntries = vi.fn(async () => ['tree/tool.exe', 'tree/../../evil.txt']);
    const extractZipEntries = vi.fn(async () => {});

    const [result] = await fetchSpecs([spec], { modelsRoot: dir, download, listZipEntries, extractZipEntries });

    expect(result?.status).toBe('failed');
    expect(result?.message).toMatch(/unsafe zip entry/);
    expect(extractZipEntries).not.toHaveBeenCalled();
    expect(stagingDirsIn(dir)).toEqual([]);
    expect(existsSync(join(dir, '..', 'evil.txt'))).toBe(false);
    expect(existsSync(join(dir, 'bin'))).toBe(false);
  });

  it.each([
    ['absolute path', '/abs/evil.txt'],
    ['drive-letter path', 'C:\\evil.txt'],
    ['backslash traversal', '..\\evil.txt']
  ])('rejects a zip entry with an %s and cleans staging', async (_label, entryName) => {
    const spec: ModelSpec = {
      name: 'evil-archive',
      url: 'https://example.invalid/evil.zip',
      sha256: sha256('whatever'),
      dest: 'bin/tool.exe',
      archive: { zipEntry: 'tool.exe', extractAll: { stripPrefix: '' } }
    };
    const download = vi.fn(async () => Buffer.from('zip-bytes'));
    const listZipEntries = vi.fn(async () => [entryName]);
    const extractZipEntries = vi.fn(async () => {});

    const [result] = await fetchSpecs([spec], { modelsRoot: dir, download, listZipEntries, extractZipEntries });

    expect(result?.status).toBe('failed');
    expect(result?.message).toMatch(/unsafe zip entry/);
    expect(extractZipEntries).not.toHaveBeenCalled();
    expect(stagingDirsIn(dir)).toEqual([]);
  });

  it('verifies a pinned archive sha256 before extraction and refuses to extract on mismatch', async () => {
    const spec: ModelSpec = {
      name: 'tampered-archive',
      url: 'https://example.invalid/thing.zip',
      sha256: sha256('inner'),
      dest: 'bin/thing.exe',
      archive: { zipEntry: 'thing.exe', sha256: sha256('the real zip bytes') }
    };
    const download = vi.fn(async () => Buffer.from('tampered zip bytes'));
    const listZipEntries = vi.fn(async () => ['thing.exe']);
    const extractZipEntries = vi.fn(async () => {});

    const [result] = await fetchSpecs([spec], { modelsRoot: dir, download, listZipEntries, extractZipEntries });

    expect(result?.status).toBe('failed');
    expect(result?.message).toMatch(/archive sha256 mismatch/);
    expect(listZipEntries).not.toHaveBeenCalled();
    expect(extractZipEntries).not.toHaveBeenCalled();
    expect(stagingDirsIn(dir)).toEqual([]);
    expect(existsSync(join(dir, 'bin'))).toBe(false);
  });

  it('stages, verifies, then atomically promotes an archive (primary + companion) into the live dir', async () => {
    const zipBytes = 'real zip bytes';
    const primary = 'primary-exe-bytes';
    const companion = 'companion-dll-bytes';
    const spec: ModelSpec = {
      name: 'staged-archive',
      url: 'https://example.invalid/thing.zip',
      sha256: sha256(primary),
      dest: 'bin/thing.exe',
      archive: {
        zipEntry: 'Release/thing.exe',
        sha256: sha256(zipBytes),
        companions: [{ zipEntry: 'Release/helper.dll', dest: 'bin/helper.dll' }]
      }
    };
    const download = vi.fn(async () => Buffer.from(zipBytes));
    const extractZipEntries = vi.fn(async (_zipPath: string, mappings: ZipEntryMapping[]) => {
      for (const m of mappings) {
        // Every dest the pipeline hands the extractor must already sit inside a staging dir,
        // never in the live tree.
        expect(m.dest).toContain('.staging-');
        writeFileSync(m.dest, m.entry.endsWith('.exe') ? primary : companion);
      }
    });

    const [result] = await fetchSpecs([spec], { modelsRoot: dir, download, extractZipEntries });

    expect(result?.status).toBe('downloaded');
    expect(result?.sha256).toBe(sha256(primary));
    expect(readFileSync(join(dir, 'bin', 'thing.exe'), 'utf-8')).toBe(primary);
    expect(readFileSync(join(dir, 'bin', 'helper.dll'), 'utf-8')).toBe(companion);
    expect(stagingDirsIn(dir)).toEqual([]);
  });

  it('a staged hash mismatch promotes nothing: live dir untouched, staging cleaned', async () => {
    // Pre-existing GOOD file for another spec must survive a failing sibling spec untouched.
    writeFileSync(join(dir, 'existing.bin'), 'existing good content');
    const spec: ModelSpec = {
      name: 'bad-archive',
      url: 'https://example.invalid/thing.zip',
      sha256: sha256('expected exe bytes'),
      dest: 'bin/thing.exe',
      archive: { zipEntry: 'Release/thing.exe' }
    };
    const download = vi.fn(async () => Buffer.from('zip bytes'));
    const extractZipEntries = vi.fn(async (_zipPath: string, mappings: ZipEntryMapping[]) => {
      for (const m of mappings) writeFileSync(m.dest, 'corrupted exe bytes');
    });

    const [result] = await fetchSpecs([spec], { modelsRoot: dir, download, extractZipEntries });

    expect(result?.status).toBe('failed');
    expect(result?.message).toMatch(/sha256 mismatch/);
    expect(existsSync(join(dir, 'bin', 'thing.exe'))).toBe(false);
    expect(readFileSync(join(dir, 'existing.bin'), 'utf-8')).toBe('existing good content');
    expect(stagingDirsIn(dir)).toEqual([]);
  });

  it('a plain-file hash mismatch leaves no partial file at dest (staged, never promoted)', async () => {
    const spec: ModelSpec = {
      name: 'thing',
      url: 'https://example.invalid/thing.bin',
      sha256: sha256('expected content'),
      dest: 'nested/thing.bin'
    };
    const download = vi.fn(async () => Buffer.from('corrupted content'));

    const [result] = await fetchSpecs([spec], { modelsRoot: dir, download });

    expect(result?.status).toBe('failed');
    expect(existsSync(join(dir, 'nested', 'thing.bin'))).toBe(false);
    expect(stagingDirsIn(dir)).toEqual([]);
  });

  it('self-heals on re-run after a failed/partial promote: bad on-disk file is re-fetched and replaced', async () => {
    // Simulate the aftermath of a crash mid-promote: dest exists but with wrong bytes.
    mkdirSync(join(dir, 'bin'), { recursive: true });
    writeFileSync(join(dir, 'bin', 'thing.exe'), 'partial/corrupt bytes');
    const good = 'good exe bytes';
    const spec: ModelSpec = {
      name: 'healed-archive',
      url: 'https://example.invalid/thing.zip',
      sha256: sha256(good),
      dest: 'bin/thing.exe',
      archive: { zipEntry: 'Release/thing.exe' }
    };
    const download = vi.fn(async () => Buffer.from('zip bytes'));
    const extractZipEntries = vi.fn(async (_zipPath: string, mappings: ZipEntryMapping[]) => {
      for (const m of mappings) writeFileSync(m.dest, good);
    });

    const [result] = await fetchSpecs([spec], { modelsRoot: dir, download, extractZipEntries });

    expect(result?.status).toBe('downloaded');
    expect(readFileSync(join(dir, 'bin', 'thing.exe'), 'utf-8')).toBe(good);
    expect(stagingDirsIn(dir)).toEqual([]);
  });

  it('removes stale .staging-* dirs left behind by a crashed previous run', async () => {
    mkdirSync(join(dir, '.staging-stale123', 'files'), { recursive: true });
    writeFileSync(join(dir, '.staging-stale123', 'files', 'junk.bin'), 'junk');
    const content = 'fine';
    writeFileSync(join(dir, 'thing.txt'), content);
    const spec: ModelSpec = {
      name: 'thing',
      url: 'https://example.invalid/thing.txt',
      sha256: sha256(content),
      dest: 'thing.txt'
    };

    await fetchSpecs([spec], { modelsRoot: dir, download: vi.fn(async () => Buffer.from(content)) });

    expect(stagingDirsIn(dir)).toEqual([]);
  });
});

describe('resolveUnderRoot — zip-slip guard', () => {
  it('accepts a normal nested relative path', () => {
    expect(resolveUnderRoot(dir, 'bin/piper/piper.exe')).toBe(join(dir, 'bin', 'piper', 'piper.exe'));
  });

  it.each([
    ['parent traversal', '../evil.txt'],
    ['nested traversal escaping the root', 'ok/../../evil.txt'],
    ['backslash traversal', '..\\evil.txt'],
    ['absolute posix path', '/etc/evil'],
    ['absolute windows path', 'C:\\Windows\\evil.dll'],
    ['drive-relative path', 'C:evil.dll'],
    ['NUL byte', 'evil\0.txt'],
    ['the root itself', '.']
  ])('rejects %s', (_label, p) => {
    expect(() => resolveUnderRoot(dir, p)).toThrow(/unsafe zip entry/);
  });
});

describe('computeSha256', () => {
  it('matches an independently computed sha256 of the same bytes', async () => {
    const p = join(dir, 'x.bin');
    writeFileSync(p, 'known content');
    expect(await computeSha256(p)).toBe(sha256('known content'));
  });
});
