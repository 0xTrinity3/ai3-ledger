#!/usr/bin/env node
// Bundles the Paperclip page (ui-src/index.tsx) into dist/ui/index.js.
// React and the SDK UI kit are supplied by the host at runtime and stay external,
// matching createPluginBundlerPresets() in @paperclipai/plugin-sdk.
import { build } from 'esbuild';
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
  external: ['@paperclipai/plugin-sdk/ui', '@paperclipai/plugin-sdk/ui/hooks', 'react', 'react-dom', 'react/jsx-runtime'],
});
