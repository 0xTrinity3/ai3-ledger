/**
 * Bundle the manifest into one self-contained file.
 *
 * Paperclip re-reads dist/manifest.js on every upgrade and cache-busts the
 * import with the file's mtime — but only that file. Anything the manifest
 * imports resolves to a URL with no cache-buster, so a long-running host serves
 * those modules from the ESM cache it filled at install. The result is an
 * upgrade that picks up the manifest's own literals (the version bumps) while
 * the skill markdown and tool descriptions, which come from other modules,
 * silently stay at whatever the host first loaded.
 *
 * That is not hypothetical. The X agent shipped 0.4.3 and the host registered
 * it as 0.4.3 carrying 0.4.0's skill markdown, so every company on the tenant
 * went on reading instructions that had been wrong for two releases. This
 * plugin's manifest imports its tool declarations and skill the same way and
 * would fail the same way. Bundling means the one file Paperclip re-reads
 * contains everything the manifest says.
 *
 * The SDK stays external: it is a peer of the host, not ours to inline.
 */
import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist', 'manifest.js');

await build({
  entryPoints: [path.join(ROOT, 'src', 'manifest.ts')],
  outfile: OUT,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  packages: 'external',
  logLevel: 'warning',
});

// Fail loudly rather than shipping a manifest that imports anything of ours:
// one relative import is all it takes for the staleness to come back.
const bundled = await readFile(OUT, 'utf8');
const relative = [...bundled.matchAll(/^\s*import[^;]*from\s+["'](\.[^"']+)["']/gm)].map((m) => m[1]);
if (relative.length > 0) throw new Error(`dist/manifest.js still imports ${relative.join(', ')}; it must be self-contained`);
await writeFile(OUT, bundled);
console.log(`bundled dist/manifest.js (${bundled.length} bytes)`);
