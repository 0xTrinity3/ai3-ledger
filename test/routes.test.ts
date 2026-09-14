/**
 * The manifest and the worker have to agree.
 *
 * A route declared in the manifest with no case in the worker answers 404 to
 * anybody who calls it; a case in the worker with no manifest entry can never
 * be reached at all, because the host mounts only what the manifest declares.
 * Both failures are silent and both are one typo away, which is exactly the
 * kind of thing a test should hold rather than a reviewer.
 */
import { describe, it, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import manifest from '../src/manifest.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function workerCases(): Promise<Set<string>> {
  const src = await readFile(path.join(ROOT, 'src', 'plugin', 'worker.ts'), 'utf8');
  const cases = new Set<string>();
  for (const m of src.matchAll(/case '([a-z][a-z.-]+)':/g)) cases.add(m[1]!);
  return cases;
}

describe('plugin api routes', () => {
  it('every declared route has a handler', async () => {
    const cases = await workerCases();
    const missing = manifest.apiRoutes.map((r) => r.routeKey).filter((k) => !cases.has(k));
    expect(missing, 'declared in the manifest, answered by nothing').toEqual([]);
  });

  it('every route a person needs to work on their books is published', () => {
    // ai3.co reads and writes these books over this API, so a company with a
    // Paperclip instance can be worked on from either window. Anything missing
    // here sends its owner back into Paperclip for that one screen.
    const keys = new Set(manifest.apiRoutes.map((r) => r.routeKey));
    for (const needed of [
      'position', 'accounts', 'transactions', 'entries',
      'reports.pnl', 'reports.balance-sheet', 'reports.trial-balance',
      'invoices.list', 'invoices.create', 'invoices.issue', 'invoices.payment',
      'bills.list', 'bills.create', 'bills.approve', 'bills.pay',
      'journals.list', 'journals.create', 'journals.post', 'journals.void',
      'banks.list', 'banks.create', 'banks.lines', 'banks.import',
      'reconcile.run', 'reconcile.decide', 'reconcile.rules', 'reconcile.rule',
      'settings.get', 'settings.update', 'payments.list', 'payments.create',
      'import.chart', 'import.opening', 'import.standing', 'import.undo', 'import.documents',
      'meter.balances', 'meter.fund', 'meter.reserve', 'meter.capture', 'meter.release', 'meter.events', 'meter.aggregate', 'meter.statement',
    ]) {
      expect(keys.has(needed), `${needed} is not published`).toBe(true);
    }
  });

  it('nothing that writes is open to an agent without a person', () => {
    // An agent may raise a draft — an invoice or a bill somebody then approves —
    // and may read. It may not issue, pay, post, reconcile or change settings:
    // those are the board's, and the worker enforces it case by case. This is
    // the manifest half of the same rule.
    //
    // The three subledger verbs are the deliberate exception. Reserving its own
    // budget before it acts, capturing what the work actually cost and giving
    // back what it did not spend is the agent's own half of the card-style
    // flow, and none of it can overspend: the balance refuses. Nothing here
    // reaches the general ledger — aggregation is the board's.
    const agentWritable = manifest.apiRoutes
      .filter((r) => r.method === 'POST' && r.auth === 'board-or-agent')
      .map((r) => r.routeKey)
      .sort();
    expect(agentWritable).toEqual(['bills.create', 'invoices.create', 'meter.capture', 'meter.release', 'meter.reserve', 'tools.invoke']);
  });

  it('a path is declared once', () => {
    const seen = new Map<string, string>();
    for (const r of manifest.apiRoutes) {
      const key = `${r.method} ${r.path}`;
      expect(seen.has(key), `${key} is declared twice: ${seen.get(key)} and ${r.routeKey}`).toBe(false);
      seen.set(key, r.routeKey);
    }
  });
});

/**
 * The two versions a plugin has, and the one that actually decides anything.
 *
 * The provisioner upgrades a tenant by comparing package.json's version;
 * Paperclip shows the manifest's. Bumping the manifest alone — which is the
 * natural thing to do when adding a route — ships new code under an old
 * version number, so every tenant reports "current" and never upgrades. That
 * is exactly how import.documents almost went out unreachable.
 */
test('the manifest version and the package version are the same', async () => {
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')) as { version: string };
  expect(manifest.version).toBe(pkg.version);
});
