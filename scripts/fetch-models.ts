// Downloads and checksum-verifies every binary/model the voice stack needs into `models/`.
//
// Run via `npm run fetch-models` (add `--with-brain` to also pull the second-brain embedder).
// Idempotent: a second run with unchanged files is a fast no-op. `--force` re-downloads
// everything regardless of what's already on disk.
//
// Safety pipeline (per spec): download → (for zips) verify the pinned ARCHIVE sha256 → extract
// into a per-spec staging directory with a zip-slip guard → verify the pinned per-file sha256 in
// staging → only then atomically promote (rename) into the live models dir. On ANY failure the
// staging dir is deleted and the live dir is left untouched; a re-run after a crashed/partial
// promote self-heals via the existing on-disk hash check.
//
// See cdd/plan/voice-pipeline.md ("Model/binary provisioning") for the contract this
// implements, and cdd/tasks/fetch-models.md for the acceptance criteria.

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rename, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
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
  /** Expected sha256 of the downloaded zip itself, verified BEFORE extraction. This
   * authenticates every file the archive carries — including companions and extractAll trees
   * that have no individual per-file pin. Optional (additive field, legacy specs without it
   * still work); all shipped archive specs below pin it. */
  sha256?: string;
  /** Extra files pulled from the same zip, not individually hash-verified (they are covered by
   * the archive-level `sha256` pin above when present). */
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

/** One "extract this zip entry to this absolute path" instruction. Dest paths are always
 * computed in TypeScript (never derived from entry names inside PowerShell) and are containment-
 * checked against the staging root by `resolveUnderRoot` before extraction runs. */
export interface ZipEntryMapping {
  entry: string;
  dest: string;
}

export interface FetchModelsOptions {
  force?: boolean;
  withBrain?: boolean;
  /** Root directory models are written under. Defaults to `<repoRoot>/models`. */
  modelsRoot?: string;
  /** Injectable downloader, used by tests to avoid real network access. */
  download?: (url: string) => Promise<Buffer>;
  /** Injectable coarse zip extractor, used by tests to avoid spawning powershell. When provided
   * it replaces the whole list+guard+extract flow; the third argument is the STAGING root the
   * extracted files must be written under (they are hash-verified there and only then promoted
   * into the live models dir). */
  extractZip?: (zipPath: string, archive: ArchiveSpec, stagingRoot: string) => Promise<void>;
  /** Injectable zip entry lister (file entries only, zip-internal `/`-separated names), used by
   * tests to exercise the zip-slip guard without spawning powershell. */
  listZipEntries?: (zipPath: string) => Promise<string[]>;
  /** Injectable per-entry extractor, used by tests together with `listZipEntries`. */
  extractZipEntries?: (zipPath: string, mappings: ZipEntryMapping[]) => Promise<void>;
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
// Archive-level pins (`archive.sha256`, verified before extraction — authenticates every
// companion/tree file the zip carries, closing the "companions unauthenticated" gap):
//  - ffmpeg zip: matches gyan.dev's published ffmpeg-8.0.1-essentials_build.zip.sha256
//    (re-fetched and re-confirmed against a fresh download, 2026-07-18).
//  - whisper-bin-x64.zip v1.9.1 / piper_windows_amd64.zip 2023.11.14-2: upstream publishes no
//    archive checksum; hashes computed 2026-07-18 from direct downloads whose extracted
//    whisper-cli.exe / whisper-server.exe / piper.exe byte-matched the per-file pins recorded at
//    original authoring time — i.e. the same archives those pins were derived from.
// No hash below is a placeholder; every one traces to a real source.
// ---------------------------------------------------------------------------------------------

const WHISPER_CPP_VERSION = 'v1.9.1';
const WHISPER_CPP_ZIP_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_CPP_VERSION}/whisper-bin-x64.zip`;
const WHISPER_CPP_ZIP_SHA256 = '7d8be46ecd31828e1eb7a2ecdd0d6b314feafd82163038ab6092594b0a063539';

const PIPER_VERSION = '2023.11.14-2';
const PIPER_ZIP_URL = `https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_windows_amd64.zip`;
const PIPER_ZIP_SHA256 = 'f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea';

const SILERO_VAD_URL =
  'https://raw.githubusercontent.com/snakers4/silero-vad/v4.0/files/silero_vad.onnx';

// openWakeWord v0.5.1 is the latest upstream release that publishes the complete ONNX runtime
// chain used by the bundled hey_jarvis classifier. Pin every artifact by hash: the app executes
// these files locally and never downloads moving "latest" aliases.
const OPEN_WAKE_WORD_VERSION = 'v0.5.1';
const OPEN_WAKE_WORD_BASE_URL =
  `https://github.com/dscripka/openWakeWord/releases/download/${OPEN_WAKE_WORD_VERSION}`;

// Pinned to a specific gyan.dev release version (immutable filename — not the rolling
// "release-essentials"/"latest" alias) per cdd/plan/amendments.md A6: ffmpeg becomes a
// provisioned artifact, never resolved from PATH. The "essentials" build's zip packaging
// contains ffmpeg.exe, ffprobe.exe, and ffplay.exe (verified by inspecting the archive) — ffplay
// is required by the later TTS task for raw-PCM playback.
const FFMPEG_VERSION = '8.0.1';
const FFMPEG_ZIP_URL = `https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-${FFMPEG_VERSION}-essentials_build.zip`;
// Matches gyan.dev's published `${FFMPEG_ZIP_URL}.sha256`.
const FFMPEG_ZIP_SHA256 = 'e2aaeaa0fdbc397d4794828086424d4aaa2102cef1fb6874f6ffd29c0b88b673';

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
      sha256: WHISPER_CPP_ZIP_SHA256,
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
      zipEntry: 'Release/whisper-server.exe',
      sha256: WHISPER_CPP_ZIP_SHA256
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
      sha256: PIPER_ZIP_SHA256,
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
    name: 'openwakeword-melspectrogram',
    url: `${OPEN_WAKE_WORD_BASE_URL}/melspectrogram.onnx`,
    sha256: 'ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f',
    dest: 'wakeword/melspectrogram.onnx',
    group: 'core'
  },
  {
    name: 'openwakeword-embedding',
    url: `${OPEN_WAKE_WORD_BASE_URL}/embedding_model.onnx`,
    sha256: '70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f',
    dest: 'wakeword/embedding_model.onnx',
    group: 'core'
  },
  {
    name: 'openwakeword-hey-jarvis',
    url: `${OPEN_WAKE_WORD_BASE_URL}/hey_jarvis_v0.1.onnx`,
    sha256: '94a13cfe60075b132f6a472e7e462e8123ee70861bc3fb58434a73712ee0d2cb',
    dest: 'wakeword/hey_jarvis_v0.1.onnx',
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
      sha256: FFMPEG_ZIP_SHA256,
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

const STAGING_PREFIX = '.staging-';

function repoRoot(): string {
  // scripts/fetch-models.ts -> repo root is one directory up.
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

export async function computeSha256(filePath: string): Promise<string> {
  const buf = await readFile(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

function sha256OfBuffer(buf: Buffer): string {
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

/**
 * Zip-slip guard: resolves `relPath` under `root` and throws unless the result stays strictly
 * inside `root`. Rejects NUL bytes, absolute paths, drive-prefixed paths (`C:...`), UNC paths,
 * and any `..` traversal that would escape the root. Exported for direct testing.
 */
export function resolveUnderRoot(root: string, relPath: string): string {
  if (relPath.includes('\0')) {
    throw new Error(`unsafe zip entry path (NUL byte): ${JSON.stringify(relPath)}`);
  }
  // Zip entry names use '/', but be tolerant of '\' so a backslash-based traversal cannot slip
  // past the checks below on Windows.
  const unified = relPath.replaceAll('\\', '/');
  // ':' is illegal in Windows file names, so any occurrence means a drive-prefixed or otherwise
  // absolute path (C:\..., C:evil, //server/share via C:) — reject outright, even mid-path,
  // because callers may join a spec-controlled prefix in front of the entry name.
  if (unified.startsWith('/') || unified.includes(':')) {
    throw new Error(`unsafe zip entry path (absolute or drive-prefixed): ${relPath}`);
  }
  // Reject any `..` segment, even one that would happen to resolve back inside the root once a
  // prefix is joined — archive entries have no business containing `..` at all.
  if (unified.split('/').some((s) => s === '..')) {
    throw new Error(`unsafe zip entry path (.. traversal): ${relPath}`);
  }
  const rootAbs = resolve(root);
  const dest = resolve(rootAbs, unified);
  const rel = relative(rootAbs, dest);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`unsafe zip entry path (escapes extraction root): ${relPath}`);
  }
  return dest;
}

function psQuote(value: string): string {
  // Embed a literal value inside a single-quoted PowerShell string.
  return value.replace(/'/g, "''");
}

async function runPowerShell(script: string): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    const ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true }
    );
    let stdout = '';
    let stderr = '';
    ps.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    ps.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    const timeout = setTimeout(() => {
      ps.kill();
      reject(new Error('powershell zip extraction timed out after 120s'));
    }, 120_000);
    ps.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`powershell exited with code ${code}: ${stderr.trim()}`));
    });
    ps.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/** Lists the file entries (zip-internal `/`-separated names) of a zip via PowerShell. */
async function defaultListZipEntries(zipPath: string): Promise<string[]> {
  const script = `
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead('${psQuote(zipPath)}')
foreach ($e in $zip.Entries) {
  if ($e.Name -ne '') { [Console]::Out.WriteLine($e.FullName) }
}
$zip.Dispose()
`;
  const stdout = await runPowerShell(script);
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Extracts explicit entry→dest mappings via PowerShell (System.IO.Compression — Windows-only,
 * matches this project's target platform; avoids adding a zip-parsing npm dependency). Dest
 * paths are computed and containment-checked in TypeScript before this runs; PowerShell never
 * derives an output path from an entry name. Mappings travel through a JSON file to stay clear
 * of command-line length limits (piper's extractAll tree is hundreds of entries). */
async function defaultExtractZipEntries(
  zipPath: string,
  mappings: ZipEntryMapping[]
): Promise<void> {
  const mappingsPath = `${zipPath}.mappings.json`;
  await writeFile(mappingsPath, JSON.stringify(mappings));
  const script = `
Add-Type -AssemblyName System.IO.Compression.FileSystem
$mappings = Get-Content -Raw -LiteralPath '${psQuote(mappingsPath)}' | ConvertFrom-Json
$zip = [System.IO.Compression.ZipFile]::OpenRead('${psQuote(zipPath)}')
$byName = @{}
foreach ($e in $zip.Entries) { if ($e.Name -ne '') { $byName[$e.FullName] = $e } }
foreach ($m in $mappings) {
  $entry = $byName[$m.entry]
  if (-not $entry) { $zip.Dispose(); throw "Entry not found in zip: $($m.entry)" }
  [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $m.dest, $true)
}
$zip.Dispose()
`;
  await runPowerShell(script);
}

/** Extracts everything a spec's archive needs (primary file + companions, or a full tree) into
 * `stagingRoot`. Entry names from the (untrusted) zip only ever become output paths via
 * `resolveUnderRoot`, which rejects traversal/absolute/drive-prefixed entries before anything
 * is written. Tests inject either the coarse `extractZip` seam or the finer
 * `listZipEntries`/`extractZipEntries` pair so they never spawn a subprocess. */
async function extractArchiveForSpec(
  zipPath: string,
  spec: ModelSpec,
  stagingRoot: string,
  opts: Pick<FetchModelsOptions, 'extractZip' | 'listZipEntries' | 'extractZipEntries'>
): Promise<void> {
  const archive = spec.archive;
  if (!archive) return;

  if (opts.extractZip) {
    await opts.extractZip(zipPath, archive, stagingRoot);
    return;
  }

  const listEntries = opts.listZipEntries ?? defaultListZipEntries;
  const extractEntries = opts.extractZipEntries ?? defaultExtractZipEntries;

  let mappings: ZipEntryMapping[];
  if (archive.extractAll) {
    const destDirRel = dirname(spec.dest);
    const stripPrefix = archive.extractAll.stripPrefix;
    const entries = await listEntries(zipPath);
    mappings = [];
    for (const entryName of entries) {
      if (entryName.endsWith('/') || entryName.endsWith('\\')) continue; // directory entry
      let rel = entryName;
      if (stripPrefix && rel.startsWith(stripPrefix)) rel = rel.slice(stripPrefix.length);
      // Validate the RAW entry-derived path first: joining `destDirRel/` in front would
      // otherwise neutralize a leading '/' (e.g. `bin` + `/abs/evil` → `bin//abs/evil`).
      resolveUnderRoot(stagingRoot, rel);
      const relFromRoot = destDirRel === '.' ? rel : `${destDirRel}/${rel}`;
      mappings.push({ entry: entryName, dest: resolveUnderRoot(stagingRoot, relFromRoot) });
    }
  } else {
    mappings = [
      { entry: archive.zipEntry, dest: resolveUnderRoot(stagingRoot, spec.dest) },
      ...(archive.companions ?? []).map((c) => ({
        entry: c.zipEntry,
        dest: resolveUnderRoot(stagingRoot, c.dest)
      }))
    ];
  }

  for (const m of mappings) {
    await mkdir(dirname(m.dest), { recursive: true });
  }
  await extractEntries(zipPath, mappings);
}

/** Moves every staged file into the live models dir. Staging lives INSIDE the models root, so
 * each rename is an atomic same-volume move (overwriting any stale file at the target). */
async function promoteStagedFiles(stagedFilesRoot: string, modelsRoot: string): Promise<void> {
  const dirents = await readdir(stagedFilesRoot, { recursive: true, withFileTypes: true });
  for (const d of dirents) {
    if (!d.isFile()) continue;
    const from = join(d.parentPath, d.name);
    const rel = relative(stagedFilesRoot, from);
    const to = join(modelsRoot, rel);
    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
  }
}

async function processSpec(
  spec: ModelSpec,
  opts: Required<Pick<FetchModelsOptions, 'force' | 'withBrain' | 'modelsRoot'>> &
    Pick<
      FetchModelsOptions,
      'download' | 'extractZip' | 'listZipEntries' | 'extractZipEntries' | 'log'
    >
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

  // Everything below happens in a per-spec staging dir INSIDE the models root (same volume, so
  // the final promote is an atomic rename). Nothing touches the live tree until every pinned
  // hash has been verified in staging; any failure deletes the staging dir in `finally` and
  // leaves the live dir untouched.
  let stagingRoot: string | undefined;
  try {
    stagingRoot = await mkdtemp(join(opts.modelsRoot, STAGING_PREFIX));
    const stagedFiles = join(stagingRoot, 'files');
    await mkdir(stagedFiles, { recursive: true });

    const buf = await download(spec.url);

    if (spec.archive) {
      if (spec.archive.sha256) {
        const zipHash = sha256OfBuffer(buf);
        if (zipHash !== spec.archive.sha256) {
          return {
            name: spec.name,
            status: 'failed',
            dest: spec.dest,
            message: `archive sha256 mismatch (refusing to extract): expected ${spec.archive.sha256}, got ${zipHash}`
          };
        }
        log(`${spec.name}: archive sha256 verified`);
      }
      const zipPath = join(stagingRoot, 'download.zip');
      await writeFile(zipPath, buf);
      await extractArchiveForSpec(zipPath, spec, stagedFiles, opts);
    } else {
      const stagedDest = join(stagedFiles, spec.dest);
      await mkdir(dirname(stagedDest), { recursive: true });
      await writeFile(stagedDest, buf);
    }

    const stagedPrimary = join(stagedFiles, spec.dest);
    if (!(await fileExists(stagedPrimary))) {
      return {
        name: spec.name,
        status: 'failed',
        dest: spec.dest,
        message: `extraction did not produce ${spec.dest}`
      };
    }
    const finalHash = await computeSha256(stagedPrimary);
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

    await promoteStagedFiles(stagedFiles, opts.modelsRoot);
    return { name: spec.name, status: 'downloaded', dest: spec.dest, sha256: finalHash };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { name: spec.name, status: 'failed', dest: spec.dest, message };
  } finally {
    if (stagingRoot) {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  }
}

/** Removes leftover `.staging-*` dirs from a previous crashed/killed run. Safe: live model
 * files never live under a staging dir. */
async function cleanStaleStagingDirs(modelsRoot: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(modelsRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory() && e.name.startsWith(STAGING_PREFIX)) {
      await rm(join(modelsRoot, e.name), { recursive: true, force: true });
    }
  }
}

/**
 * Runs the fetch/verify/skip pipeline over an explicit spec list. `fetchModels` is a thin
 * wrapper around this that always passes `REQUIRED_MODELS` — tests call `fetchSpecs` directly
 * with a fake spec list and an injected `download` (plus `extractZip` or
 * `listZipEntries`/`extractZipEntries`) so no real network access or subprocess ever happens
 * headlessly.
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
  await cleanStaleStagingDirs(modelsRoot);

  const results: SpecResult[] = [];
  for (const spec of specs) {
    const result = await processSpec(spec, {
      force,
      withBrain,
      modelsRoot,
      download: opts.download,
      extractZip: opts.extractZip,
      listZipEntries: opts.listZipEntries,
      extractZipEntries: opts.extractZipEntries,
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
