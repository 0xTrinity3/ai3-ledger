/**
 * Test database: an in-process PostgreSQL (pglite) with the real migration
 * applied inside a throwaway schema, exposed through the same `SqlClient`
 * shape the plugin gets from Paperclip. No mocks of the database anywhere.
 */
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LedgerDb, SqlClient } from '../src/core/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.join(HERE, '..', 'migrations');

export interface TestDb extends LedgerDb {
  raw: PGlite;
  close(): Promise<void>;
}

export async function openTestDb(schema = `ledger_test_${Math.random().toString(36).slice(2, 8)}`): Promise<TestDb> {
  const pg = new PGlite();
  await pg.waitReady;
  await pg.exec(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}", public;`);
  const sql = await readFile(path.join(MIGRATIONS, '0001_init.sql'), 'utf8');
  await pg.exec(sql);

  const client: SqlClient = {
    async query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
      const r = await pg.query<T>(text, params);
      return r.rows;
    },
    async execute(text: string, params: unknown[] = []): Promise<{ rowCount: number }> {
      const r = await pg.query(text, params);
      return { rowCount: r.affectedRows ?? 0 };
    },
  };

  return {
    sql: client,
    schema,
    raw: pg,
    async close() {
      await pg.close();
    },
  };
}
