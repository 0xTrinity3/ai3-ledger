/**
 * The only database surface the ledger core is allowed to touch.
 *
 * It is shaped exactly like Paperclip's `ctx.db` (raw parameterised SQL,
 * `query` for reads and `execute` for writes, no transaction API) so the same
 * core runs unchanged inside the plugin, against a test database, and against
 * a hosted PostgreSQL in connected mode.
 *
 * Two posting strategies exist because hosts differ in what SQL they accept:
 *
 *  - `function`   (default) calls `ledger_post(...)`, one atomic statement.
 *                 Used wherever we own the database (tests, connected mode).
 *  - `statements` never calls a function and never runs more than one plain
 *                 INSERT/UPDATE/DELETE per call. Paperclip's plugin sandbox
 *                 forbids functions, triggers and multi-statement SQL, so the
 *                 transaction row is written as 'pending', its entries follow,
 *                 and a final UPDATE flips it to 'posted'. Reports only ever
 *                 count 'posted' rows, so a half-written transaction is
 *                 invisible and is swept away later.
 */
import { randomUUID } from 'node:crypto';

export interface SqlClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
}

export type PostingMode = 'function' | 'statements';

/** Where the ledger's tables live. `schema` is optional: the host may set search_path instead. */
export interface LedgerDb {
  sql: SqlClient;
  schema?: string;
  posting?: PostingMode;
}

/** Qualify a table name with the schema when one is configured. */
export function table(db: LedgerDb, name: string): string {
  return db.schema ? `"${db.schema.replace(/"/g, '""')}".${name}` : name;
}

/** A fresh v4 UUID for hosts that cannot return generated ids (execute reports only rowCount). */
export function newId(): string {
  return randomUUID();
}

// ---------------------------------------------------------------------------
// Money. Integer minor units, always bigint, never floats.
// ---------------------------------------------------------------------------

/** Minor units (cents, pence). Positive or negative; use `direction` for accounting sign. */
export type Minor = bigint;

const DIGITS = /^-?\d+$/;

/** Parse a database bigint (which drivers return as string or number) into a bigint. */
export function toMinor(value: unknown): Minor {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new TypeError(`ledger: non-integer amount ${value}`);
    return BigInt(value);
  }
  if (typeof value === 'string' && DIGITS.test(value)) return BigInt(value);
  throw new TypeError(`ledger: cannot read amount from ${String(value)}`);
}

/** Serialise a bigint for a query parameter. Drivers accept the decimal string for bigint columns. */
export function fromMinor(value: Minor): string {
  return value.toString();
}

/** Guard: a posting amount must be a positive integer. */
export function assertPositiveMinor(value: unknown, label: string): Minor {
  const m = toMinor(value);
  if (m <= 0n) throw new RangeError(`ledger: ${label} must be positive, got ${m}`);
  return m;
}

/** ISO-4217-ish currency code guard. Uppercase, 3 letters. */
export function assertCurrency(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) {
    throw new TypeError(`ledger: currency must be a three-letter code, got ${String(value)}`);
  }
  return value;
}

/** Normalise a Date or ISO string to an ISO string for a timestamptz parameter. */
export function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
