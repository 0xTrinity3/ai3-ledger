/**
 * Test databases: an in-process PostgreSQL (pglite) with the real migration
 * applied, exposed through the same `SqlClient` shape the plugin gets from
 * Paperclip. No mocks of the database anywhere.
 *
 * Two flavours:
 *  - openTestDb(): the full schema from migrations/0001_init.sql (functions,
 *    triggers) in a throwaway schema on the search_path. Function-mode posting.
 *  - openPluginTestDb(): the generated plugin migration in a schema named
 *    exactly as Paperclip would name it, with a fake `public.cost_events`,
 *    statements-mode posting, and every statement first run through
 *    Paperclip's own SQL validators when the runtime is checked out next door.
 */
import { PGlite } from '@electric-sql/pglite';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { LedgerDb, SqlClient } from '../src/core/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const MIGRATIONS = path.join(ROOT, 'migrations');
const PLUGIN_MIGRATIONS = path.join(ROOT, 'plugin-migrations');

/** Must match derivePluginDatabaseNamespace('ai3.ledger', 'ai3_ledger') in @paperclipai/server. */
export const PLUGIN_NAMESPACE = 'plugin_ai3_ledger_2571fd243c';

export interface TestDb extends LedgerDb {
  raw: PGlite;
  close(): Promise<void>;
}

function clientFor(pg: PGlite, validate?: Validators): SqlClient {
  return {
    async query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
      validate?.query(text);
      const r = await pg.query<T>(text, params);
      return r.rows;
    },
    async execute(text: string, params: unknown[] = []): Promise<{ rowCount: number }> {
      validate?.execute(text);
      const r = await pg.query(text, params);
      return { rowCount: r.affectedRows ?? 0 };
    },
  };
}

export async function openTestDb(schema = `ledger_test_${Math.random().toString(36).slice(2, 8)}`): Promise<TestDb> {
  const pg = new PGlite();
  await pg.waitReady;
  await pg.exec(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}", public;`);
  const sql = await readFile(path.join(MIGRATIONS, '0001_init.sql'), 'utf8');
  await pg.exec(sql);
  return { sql: clientFor(pg), schema, raw: pg, async close() { await pg.close(); } };
}

// ---------------------------------------------------------------------------
// Plugin flavour
// ---------------------------------------------------------------------------

interface Validators {
  migration(statement: string): void;
  query(statement: string): void;
  execute(statement: string): void;
}

const PAPERCLIP_VALIDATORS =
  process.env['PAPERCLIP_PLUGIN_DATABASE_JS'] ??
  path.join(ROOT, '..', 'paperclip-runtime', 'node_modules', '@paperclipai', 'server', 'dist', 'services', 'plugin-database.js');

/** Paperclip's real validators when the runtime is available; otherwise null and the test says so once. */
export async function loadPaperclipValidators(coreReadTables: string[] = ['cost_events']): Promise<Validators | null> {
  if (!existsSync(PAPERCLIP_VALIDATORS)) return null;
  const mod = (await import(pathToFileURL(PAPERCLIP_VALIDATORS).href)) as {
    validatePluginMigrationStatement(statement: string, namespace: string, coreReadTables?: string[]): void;
    validatePluginRuntimeQuery(query: string, namespace: string, coreReadTables?: string[]): void;
    validatePluginRuntimeExecute(query: string, namespace: string): void;
  };
  return {
    migration: (s) => mod.validatePluginMigrationStatement(s, PLUGIN_NAMESPACE, coreReadTables),
    query: (s) => mod.validatePluginRuntimeQuery(s, PLUGIN_NAMESPACE, coreReadTables),
    execute: (s) => mod.validatePluginRuntimeExecute(s, PLUGIN_NAMESPACE),
  };
}

/** Same splitting rule as the host: on semicolons, ignoring blank fragments. The plugin SQL has no $$ bodies. */
export function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter((s) => s.length > 0);
}

export interface PluginTestDb extends TestDb {
  validated: boolean;
}

export async function openPluginTestDb(): Promise<PluginTestDb> {
  const validators = await loadPaperclipValidators();
  const pg = new PGlite();
  await pg.waitReady;

  // The host's shape of the one core table the plugin reads.
  await pg.exec(`
    CREATE TABLE public.cost_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL,
      agent_id uuid NULL,
      issue_id uuid NULL,
      project_id uuid NULL,
      goal_id uuid NULL,
      heartbeat_run_id uuid NULL,
      billing_code text NULL,
      provider text NULL,
      biller text NULL,
      billing_type text NULL,
      cost_status text NOT NULL DEFAULT 'reported',
      model text NULL,
      input_tokens integer NULL,
      cached_input_tokens integer NULL,
      output_tokens integer NULL,
      cost_cents integer NULL,
      occurred_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE SCHEMA "${PLUGIN_NAMESPACE}";
  `);

  const file = path.join(PLUGIN_MIGRATIONS, '0001_init.sql');
  if (!existsSync(file)) throw new Error(`missing ${file}; run npm run build first`);
  const sql = await readFile(file, 'utf8');
  for (const statement of splitStatements(sql)) {
    validators?.migration(statement);
    await pg.exec(statement);
  }

  return {
    sql: clientFor(pg, validators ?? undefined),
    schema: PLUGIN_NAMESPACE,
    posting: 'statements',
    validated: validators !== null,
    raw: pg,
    async close() {
      await pg.close();
    },
  };
}
