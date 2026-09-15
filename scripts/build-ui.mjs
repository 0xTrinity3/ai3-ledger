#!/usr/bin/env node
// Bundles the Paperclip page (ui-src/index.tsx) into dist/ui/index.js.
// React and the SDK UI kit are supplied by the host at runtime and stay external,
// matching createPluginBundlerPresets() in @paperclipai/plugin-sdk.
import { build } from 'esbuild';
import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [path.join(ROOT, 'ui-src', 'index.tsx')],
  outdir: path.join(ROOT, 'dist', 'ui'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: true,
  minify: false,
  logLevel: 'info',
  // The theme stylesheet is carried as text and injected into the host document.
  loader: { '.css': 'text' },
  external: ['@paperclipai/plugin-sdk/ui', '@paperclipai/plugin-sdk/ui/hooks', 'react', 'react-dom', 'react/jsx-runtime'],
});

// The same theme for the shell itself: a plain script the box links from
// Paperclip's index.html (deploy/paperclip-brand.sh on the site), so the
// sign-in page and the first paint are AI3's before the plugin has loaded.
// The stylesheet is copied beside it for the same reason.
await build({
  entryPoints: [path.join(ROOT, 'ui-src', 'brand.ts')],
  outfile: path.join(ROOT, 'dist', 'ui', 'brand.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  sourcemap: false,
  minify: true,
  logLevel: 'info',
  loader: { '.css': 'text' },
});
await copyFile(path.join(ROOT, 'ui-src', 'theme.css'), path.join(ROOT, 'dist', 'ui', 'theme.css'));
