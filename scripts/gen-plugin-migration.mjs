#!/usr/bin/env node
// Writes plugin-migrations/*.sql from plugin-sql/*.sql with __NS__ replaced by
// the namespace Paperclip derives for this plugin. Mirrors
// derivePluginDatabaseNamespace() in @paperclipai/server (plugin-database.js).
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'plugin-sql');
const OUT = path.join(ROOT, 'plugin-migrations');

export function deriveNamespace(pluginKey, namespaceSlug) {
  const hash = createHash('sha256').update(pluginKey).digest('hex').slice(0, 10);
  const slug =
    (namespaceSlug ?? pluginKey)
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/_+/g, '_')
      .slice(0, 36) || 'plugin';
  return `plugin_${slug}_${hash}`.slice(0, 63);
}

async function main() {
  const { default: manifest } = await import(path.join(ROOT, 'dist', 'manifest.js'));
  const ns = deriveNamespace(manifest.id, manifest.database?.namespaceSlug);
  if (!/^[a-z_][a-z0-9_]*$/.test(ns)) throw new Error(`bad namespace ${ns}`);
  await mkdir(OUT, { recursive: true });
  const files = (await readdir(SRC)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = await readFile(path.join(SRC, f), 'utf8');
    // Comments are stripped: the host scans string literals before comments, so an
    // apostrophe in prose would swallow the statement that follows it.
    const body = sql
      .replaceAll('__NS__', ns)
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    const out = `-- Generated from plugin-sql/${f} for namespace ${ns}. Do not edit.\n\n${body}\n`;
    await writeFile(path.join(OUT, f), out);
    process.stdout.write(`${f} -> ${ns}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
