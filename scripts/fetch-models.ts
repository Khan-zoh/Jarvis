// Downloads and checksum-verifies every binary/model the voice stack needs into `models/`.
//
// Run via `npm run fetch-models` (add `--with-brain` to also pull the second-brain embedder).
// Idempotent: a second run with unchanged files is a fast no-op. `--force` re-downloads
// everything regardless of what's already on disk.
//
// See cdd/plan/voice-pipeline.md ("Model/binary provisioning") for the contract this
// implements, and cdd/tasks/fetch-models.md for the acceptance criteria.

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------------------------
// Types (ModelSpec matches the interface pinned in cdd/plan/voice-pipeline.md; the `archive`
// and `group` fields are additive extensions used only by this script).
// ---------------------------------------------------------------------------------------------

/** One entry extracted from a zip archive alongside the spec's primary `dest` file. */
export interface ArchiveCompanion {
  /** Path of the file inside the zip. */
  zipEntry: string;
  /** Destination path, relative to the models root. */
  dest: string;
}

/** How to turn a downloaded zip into the file(s) on disk. */
export interface ArchiveSpec {
  /** Path inside the zip that corresponds to the spec's `dest` field. */
  zipEntry: string;
  /** Extra files pulled from the same zip, not individually hash-verified. */
  companions?: ArchiveCompanion[];
  /** When set, extract the *entire* zip tree (minus `stripPrefix`) into `dest`'s directory
   * instead of extracting individual entries. Used for piper's runtime tree (espeak-ng-data
   * etc.) where enumerating every file would be unwieldy. */
  extractAll?: { stripPrefix: string };
}

export interface ModelSpec {
  name: string;
  url: string;
  /** Expected sha256 of the file at `dest` once downloaded/extracted. `null` means "not yet
   * pinned" — the script accepts the download and logs the computed hash instead of failing,
   * so it can be pinned here later. */
  sha256: string | null;
  /** Path relative to the models root (e.g. `models/`) this spec resolves to. */
  dest: string;
  /** Selects which specs `fetchModels` pulls by default. `brain` specs are skipped unless
   * `--with-brain` / `{ withBrain: true }` is passed. */
  group?: 'core' | 'brain';
  /** Present when `url` points at a zip that needs extracting rather than a plain file. */
  archive?: ArchiveSpec;
}

export interface FetchModelsOptions {
  force?: boolean;
  withBrain?: boolean;
  /** Root directory models are written under. Defaults to `<repoRoot>/models`. */
  modelsRoot?: string;
  /** Injectable downloader, used by tests to avoid real network access. */
  download?: (url: string) => Promise<Buffer>;
  /** Injectable zip extractor, used by tests to avoid spawning powershell. */
  extractZip?: (zipPath: string, archive: ArchiveSpec, modelsRoot: string) => Promise<void>;
  log?: (msg: string) => void;
}

export type SpecStatus = 'downloaded' | 'skipped' | 'skipped-brain' | 'failed';

export interface SpecResult {
  name: string;
  status: SpecStatus;
  dest: string;
  sha256?: string;
  message?: string;
}

// ---------------------------------------------------------------------------------------------
// REQUIRED_MODELS
//
// Hash provenance (see the task report for the full table):
//  - VERIFIED (direct download+hash in this environment): whisper-cli.exe + its DLLs, piper.exe,
//    the piper voice .onnx.json, silero_vad.onnx, the bge tokenizer.json, ffmpeg.exe (also
//    cross-checked against gyan.dev's own published .zip.sha256, which matched).
//  - VERIFIED (official HuggingFace LFS API checksum, not re-downloaded here because the files
//    are 100+ MB): ggml-small.en.bin, the piper voice .onnx, the bge model.onnx.
// No hash below is a placeholder; every one traces to a real source.
// ---------------------------------------------------------------------------------------------

const WHISPER_CPP_VERSION = 'v1.9.1';
const WHISPER_CPP_ZIP_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_CPP_VERSION}/whisper-bin-x64.zip`;

const PIPER_VERSION = '2023.11.14-2';
const PIPER_ZIP_URL = `https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_windows_amd64.zip`;

const SILERO_VAD_URL =
  'https://raw.githubusercontent.com/snakers4/silero-vad/v4.0/files/silero_vad.onnx';

// Pinned to a specific gyan.dev release version (immutable filename — not the rolling
// "release-essentials"/"latest" alias) per cdd/plan/amendments.md A6: ffmpeg becomes a
// provisioned artifact, never resolved from PATH. The "essentials" build's zip packaging
// contains ffmpeg.exe, ffprobe.exe, and ffplay.exe (verified by inspecting the archive) — ffplay
// is required by the later TTS task for raw-PCM playback.
const FFMPEG_VERSION = '8.0.1';
const FFMPEG_ZIP_URL = `https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-${FFMPEG_VERSION}-essentials_build.zip`;

// Pinned HF commit SHAs so `/resolve/<rev>/...` URLs never move out from under a recorded hash.
const WHISPER_CPP_HF_REV = '5359861c739e955e79d9a303bcbc70fb988958b1';
const PIPER_VOICES_HF_REV = 'e21c7de8d4eab79b902f0d61e662b3f21664b8d2';
const BGE_SMALL_HF_REV = '5c38ec7c405ec4b44b94cc5a9bb96e735b38267a';

const WHISPER_MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_CPP_HF_REV}/ggml-small.en.bin`;
const PIPER_VOICE_ONNX_URL = `https://huggingface.co/rhasspy/piper-voices/resolve/${PIPER_VOICES_HF_REV}/en/en_US/lessac/medium/en_US-lessac-medium.onnx`;
const PIPER_VOICE_JSON_URL = `https://huggingface.co/rhasspy/piper-voices/resolve/${PIPER_VOICES_HF_REV}/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json`;
const BGE_MODEL_URL = `https://huggingface.co/BAAI/bge-small-en-v1.5/resolve/${BGE_SMALL_HF_REV}/onnx/model.onnx`;
const BGE_TOKENIZER_URL = `https://huggingface.co/BAAI/bge-small-en-v1.5/resolve/${BGE_SMALL_HF_REV}/tokenizer.json`;

export const REQUIRED_MODELS: ModelSpec[] = [
  {
    name: 'whisper-cli',
    url: WHISPER_CPP_ZIP_URL,
    sha256: '58245314fb73b30fbd0cf0542c5c172e23f02b6eb7cad7b51e792439cf5e1755',
    dest: 'bin/whisper-cli.exe',
    group: 'core',
    archive: {
      zipEntry: 'Release/whisper-cli.exe',
      companions: [
        { zipEntry: 'Release/ggml.dll', dest: 'bin/ggml.dll' },
        { zipEntry: 'Release/ggml-base.dll', dest: 'bin/ggml-base.dll' },
        { zipEntry: 'Release/ggml-cpu-alderlake.dll', dest: 'bin/ggml-cpu-alderlake.dll' },
        { zipEntry: 'Release/ggml-cpu-cannonlake.dll', dest: 'bin/ggml-cpu-cannonlake.dll' },
        { zipEntry: 'Release/ggml-cpu-cascadelake.dll', dest: 'bin/ggml-cpu-cascadelake.dll' },
        { zipEntry: 'Release/ggml-cpu-haswell.dll', dest: 'bin/ggml-cpu-haswell.dll' },
        { zipEntry: 'Release/ggml-cpu-icelake.dll', dest: 'bin/ggml-cpu-icelake.dll' },
        { zipEntry: 'Release/ggml-cpu-sandybridge.dll', dest: 'bin/ggml-cpu-sandybridge.dll' },
        { zipEntry: 'Release/ggml-cpu-skylakex.dll', dest: 'bin/ggml-cpu-skylakex.dll' },
        { zipEntry: 'Release/ggml-cpu-sse42.dll', dest: 'bin/ggml-cpu-sse42.dll' },
        { zipEntry: 'Release/ggml-cpu-x64.dll', dest: 'bin/ggml-cpu-x64.dll' },
        { zipEntry: 'Release/whisper.dll', dest: 'bin/whisper.dll' }
      ]
    }
  },
  {
    // whisper-server.exe ships in the SAME whisper.cpp release zip as whisper-cli.exe (both under
    // Release/). It is a SEPARATE spec (not a companion of whisper-cli) on purpose: processSpec
    // skips a spec entirely when its primary `dest` already exists, and companions are only
    // extracted as a side effect of downloading the primary — so a machine that already has
    // whisper-cli.exe would never get whisper-server.exe from a companion entry. Keyed on its own
    // `dest`, a plain `npm run fetch-models` extracts just this file, and re-runs are a no-op.
    // Reuses the ggml*.dll set already extracted alongside whisper-cli.exe in bin/.
    // sha256: computed from Release/whisper-server.exe in whisper-bin-x64.zip v1.9.1.
    name: 'whisper-server',
    url: WHISPER_CPP_ZIP_URL,
    sha256: '2c1ef08694756eda280e79b8217da63ee2af33c87ac3d5f27d68f9f3f966fd32',
    dest: 'bin/whisper-server.exe',
    group: 'core',
    archive: {
      zipEntry: 'Release/whisper-server.exe'
    }
  },
  {
    name: 'whisper-model-small.en',
    url: WHISPER_MODEL_URL,
    sha256: 'c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d',
    dest: 'whisper/ggml-small.en.bin',
    group: 'core'
  },
  {
    name: 'piper-exe',
    url: PIPER_ZIP_URL,
    sha256: '96f3da3811151580073e40bb4dd20eb0fb8115f5f5f76e2fb54282b3edfa5c1f',
    dest: 'bin/piper/piper.exe',
    group: 'core',
    archive: {
      zipEntry: 'piper/piper.exe',
      extractAll: { stripPrefix: 'piper/' }
    }
  },
  {
    name: 'piper-voice-lessac-medium-onnx',
    url: PIPER_VOICE_ONNX_URL,
    sha256: '5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f',
    dest: 'piper/en_US-lessac-medium.onnx',
    group: 'core'
  },
  {
    name: 'piper-voice-lessac-medium-json',
    url: PIPER_VOICE_JSON_URL,
    sha256: 'efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0',
    dest: 'piper/en_US-lessac-medium.onnx.json',
    group: 'core'
  },
  {
    name: 'silero-vad',
    url: SILERO_VAD_URL,
    sha256: 'a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28',
    dest: 'vad/silero_vad.onnx',
    group: 'core'
  },
  {
    name: 'ffmpeg-exe',
    url: FFMPEG_ZIP_URL,
    sha256: '5af82a0d4fe2b9eae211b967332ea97edfc51c6b328ca35b827e73eac560dc0d',
    dest: 'bin/ffmpeg/ffmpeg.exe',
    group: 'core',
    archive: {
      zipEntry: `ffmpeg-${FFMPEG_VERSION}-essentials_build/bin/ffmpeg.exe`,
      companions: [
        {
          zipEntry: `ffmpeg-${FFMPEG_VERSION}-essentials_build/bin/ffplay.exe`,
          dest: 'bin/ffmpeg/ffplay.exe'
        }
      ]
    }
  },
  {
    name: 'bge-small-en-v1.5-onnx',
    url: BGE_MODEL_URL,
    sha256: '828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35',
    dest: 'embed/model.onnx',
    group: 'brain'
  },
  {
    name: 'bge-small-en-v1.5-tokenizer',
    url: BGE_TOKENIZER_URL,
    sha256: 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66',
    dest: 'embed/tokenizer.json',
    group: 'brain'
  }
];

// ---------------------------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------------------------

function repoRoot(): string {
  // scripts/fetch-models.ts -> repo root is one directory up.
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

export async function computeSha256(filePath: string): Promise<string> {
  const buf = await readFile(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function defaultDownload(url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
    }
    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  } finally {
    clearTimeout(timeout);
  }
}

function psQuote(value: string): string {
  // Embed a literal value inside a single-quoted PowerShell string.
  return value.replace(/'/g, "''");
}

async function runPowerShell(script: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true }
    );
    let stderr = '';
    ps.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    const timeout = setTimeout(() => {
      ps.kill();
      reject(new Error('powershell zip extraction timed out after 120s'));
    }, 120_000);
    ps.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolvePromise();
      else reject(new Error(`powershell exited with code ${code}: ${stderr.trim()}`));
    });
    ps.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/** Extracts everything a spec's archive needs (primary file + companions, or a full tree).
 * Default implementation shells out to PowerShell's System.IO.Compression (Windows-only,
 * matches this project's target platform — avoids adding a zip-parsing npm dependency). Tests
 * inject `extractZip` instead so they never spawn a subprocess. */
async function extractArchiveForSpec(
  zipPath: string,
  spec: ModelSpec,
  modelsRoot: string,
  extractZip?: FetchModelsOptions['extractZip']
): Promise<void> {
  const archive = spec.archive;
  if (!archive) return;

  if (extractZip) {
    await extractZip(zipPath, archive, modelsRoot);
    return;
  }

  if (archive.extractAll) {
    const destDir = dirname(resolve(modelsRoot, spec.dest));
    await mkdir(destDir, { recursive: true });
    const script = `
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead('${psQuote(zipPath)}')
$destDir = '${psQuote(destDir)}'
$stripPrefix = '${psQuote(archive.extractAll.stripPrefix)}'
foreach ($e in $zip.Entries) {
  if ($e.Name -eq '') { continue }
  $rel = $e.FullName
  if ($stripPrefix -and $rel.StartsWith($stripPrefix)) { $rel = $rel.Substring($stripPrefix.Length) }
  $outPath = Join-Path $destDir $rel
  $outDir = Split-Path -Parent $outPath
  if ($outDir -and -not (Test-Path $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }
  [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, $outPath, $true)
}
$zip.Dispose()
`;
    await runPowerShell(script);
    return;
  }

  const mappings = [
    { entry: archive.zipEntry, dest: resolve(modelsRoot, spec.dest) },
    ...(archive.companions ?? []).map((c) => ({ entry: c.zipEntry, dest: resolve(modelsRoot, c.dest) }))
  ];
  for (const m of mappings) {
    await mkdir(dirname(m.dest), { recursive: true });
  }
  const mappingsJson = JSON.stringify(mappings);
  const script = `
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead('${psQuote(zipPath)}')
$mappings = '${psQuote(mappingsJson)}' | ConvertFrom-Json
foreach ($m in $mappings) {
  $entry = $zip.Entries | Where-Object { $_.FullName -eq $m.entry } | Select-Object -First 1
  if (-not $entry) { throw "Entry not found in zip: $($m.entry)" }
  [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $m.dest, $true)
}
$zip.Dispose()
`;
  await runPowerShell(script);
}

async function processSpec(
  spec: ModelSpec,
  opts: Required<Pick<FetchModelsOptions, 'force' | 'withBrain' | 'modelsRoot'>> &
    Pick<FetchModelsOptions, 'download' | 'extractZip' | 'log'>
): Promise<SpecResult> {
  const log = opts.log ?? (() => {});
  const group = spec.group ?? 'core';
  if (group === 'brain' && !opts.withBrain) {
    return { name: spec.name, status: 'skipped-brain', dest: spec.dest };
  }

  const destPath = resolve(opts.modelsRoot, spec.dest);

  if (!opts.force && (await fileExists(destPath))) {
    const currentHash = await computeSha256(destPath);
    if (spec.sha256 === null) {
      log(`${spec.name}: already present (hash not pinned yet: ${currentHash})`);
      return { name: spec.name, status: 'skipped', dest: spec.dest, sha256: currentHash };
    }
    if (currentHash === spec.sha256) {
      log(`${spec.name}: already present, hash verified`);
      return { name: spec.name, status: 'skipped', dest: spec.dest, sha256: currentHash };
    }
    log(`${spec.name}: hash mismatch on disk (expected ${spec.sha256}, got ${currentHash}) — re-downloading`);
  }

  const download = opts.download ?? defaultDownload;

  try {
    await mkdir(dirname(destPath), { recursive: true });

    if (spec.archive) {
      const buf = await download(spec.url);
      const tmpDir = await mkdtemp(join(tmpdir(), 'jarvis-fetch-models-'));
      const zipPath = join(tmpDir, 'download.zip');
      try {
        await writeFile(zipPath, buf);
        await extractArchiveForSpec(zipPath, spec, opts.modelsRoot, opts.extractZip);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    } else {
      const buf = await download(spec.url);
      await writeFile(destPath, buf);
    }

    const finalHash = await computeSha256(destPath);
    if (spec.sha256 !== null && finalHash !== spec.sha256) {
      return {
        name: spec.name,
        status: 'failed',
        dest: spec.dest,
        sha256: finalHash,
        message: `sha256 mismatch after download: expected ${spec.sha256}, got ${finalHash}`
      };
    }
    if (spec.sha256 === null) {
      log(`${spec.name}: downloaded, computed sha256 ${finalHash} (PENDING — pin this in REQUIRED_MODELS)`);
    }
    return { name: spec.name, status: 'downloaded', dest: spec.dest, sha256: finalHash };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { name: spec.name, status: 'failed', dest: spec.dest, message };
  }
}

/**
 * Runs the fetch/verify/skip pipeline over an explicit spec list. `fetchModels` is a thin
 * wrapper around this that always passes `REQUIRED_MODELS` — tests call `fetchSpecs` directly
 * with a fake spec list and an injected `download` (and optionally `extractZip`) so no real
 * network access or subprocess ever happens headlessly.
 */
export async function fetchSpecs(
  specs: ModelSpec[],
  opts: FetchModelsOptions = {}
): Promise<SpecResult[]> {
  const modelsRoot = opts.modelsRoot ?? join(repoRoot(), 'models');
  const force = opts.force ?? false;
  const withBrain = opts.withBrain ?? false;
  const log = opts.log ?? ((msg: string) => console.log(msg));

  await mkdir(modelsRoot, { recursive: true });

  const results: SpecResult[] = [];
  for (const spec of specs) {
    const result = await processSpec(spec, {
      force,
      withBrain,
      modelsRoot,
      download: opts.download,
      extractZip: opts.extractZip,
      log
    });
    results.push(result);
  }
  return results;
}

export async function fetchModels(
  forceOrOptions?: boolean | FetchModelsOptions
): Promise<SpecResult[]> {
  const opts: FetchModelsOptions =
    typeof forceOrOptions === 'boolean' ? { force: forceOrOptions } : forceOrOptions ?? {};
  return fetchSpecs(REQUIRED_MODELS, opts);
}

// ---------------------------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------------------------

function printSummaryTable(results: SpecResult[]): void {
  const nameWidth = Math.max(4, ...results.map((r) => r.name.length));
  const statusWidth = Math.max(6, ...results.map((r) => r.status.length));
  const header = `${'NAME'.padEnd(nameWidth)}  ${'STATUS'.padEnd(statusWidth)}  DEST`;
  console.log(header);
  console.log('-'.repeat(header.length + 20));
  for (const r of results) {
    const line = `${r.name.padEnd(nameWidth)}  ${r.status.padEnd(statusWidth)}  ${r.dest}`;
    console.log(line);
    if (r.message) console.log(`  -> ${r.message}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const withBrain = args.includes('--with-brain');

  const results = await fetchModels({ force, withBrain });
  console.log('');
  printSummaryTable(results);

  const failed = results.filter((r) => r.status === 'failed');
  if (failed.length > 0) {
    console.error(`\n${failed.length} model(s) failed to fetch.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll models present.');
  }
}

const isMainModule = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
