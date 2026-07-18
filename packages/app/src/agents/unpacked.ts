import { sep } from 'node:path';

/**
 * Translates a path that points INSIDE an Electron `app.asar` archive to its real on-disk
 * `app.asar.unpacked` twin (packaging-smoke finding, cdd/plan/amendments.md §A7).
 *
 * Why this exists: in a packaged build, `require.resolve()` / `createRequire().resolve()` are
 * asar-aware and happily return `…\resources\app.asar\node_modules\…\foo.exe`. Node's patched
 * `fs.existsSync` says such a path exists — but the OS cannot execute a file inside an archive,
 * so `spawn()` on it fails with ENOENT. electron-builder places every `asarUnpack`ed file at the
 * SAME relative path under `app.asar.unpacked/`, and Electron's own module loader uses exactly
 * this substitution for native modules. We apply it to the executables we spawn ourselves
 * (bundled Claude/Codex CLIs — see resolveBundledCodex / resolveClaudeCli).
 *
 * VERIFIED in the packaged smoke: the asar-addressed CLI path spawn → ENOENT; the substituted
 * path runs (`codex-cli 0.144.5`, `2.1.212 (Claude Code)`).
 *
 * No-op for dev paths (no `app.asar` segment). Only the first occurrence is substituted, and the
 * trailing separator in the needle means an already-unpacked path (`app.asar.unpacked${sep}`)
 * is left alone (`.` follows `app.asar`, not a separator).
 */
export function toUnpackedPath(p: string): string {
  return p.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
}
