/**
 * The cost sweep: pull platform costs through a `CostSource`, post each one
 * as debit expense / credit treasury, advance the cursor. Idempotent by
 * construction: `source_ref` is the platform's own record id, so a replay,
 * a double run or a lost cursor posts nothing twice.
 */
import { ACCOUNT } from './accounts.js';
import { expenseAccountFor, type CostCursor, type CostSource } from './adapter.js';
import { postTransaction } from './ledger.js';
import { table, type LedgerDb } from './sql.js';

export interface SweepOptions {
  /** Currency the platform reports in. Costs in another currency are skipped and counted. */
  currency: string;
  /** Records per read. */
  batchLimit?: number;
  /** Upper bound on reads per sweep so one company cannot monopolise a job run. */
  maxBatches?: number;
  createdBy?: string;
}

export interface SweepResult {
  companyId: string;
  platform: string;
  read: number;
  posted: number;
  duplicates: number;
  skipped: number;
  cursor: CostCursor;
}

export async function readCursor(db: LedgerDb, companyId: string, platform: string): Promise<CostCursor> {
  const rows = await db.sql.query<{ last_event_ref: string | null; last_occurred_at: string | null }>(
    `SELECT last_event_ref, last_occurred_at::text AS last_occurred_at FROM ${table(db, 'sweep_cursor')} WHERE company_id = $1 AND source_platform = $2`,
    [companyId, platform],
  );
  const r = rows[0];
  if (!r) return { lastEventRef: null, lastOccurredAt: null };
  return { lastEventRef: r.last_event_ref, lastOccurredAt: r.last_occurred_at };
}

export async function writeCursor(db: LedgerDb, companyId: string, platform: string, cursor: CostCursor): Promise<void> {
  await db.sql.execute(
    `INSERT INTO ${table(db, 'sweep_cursor')} (company_id, source_platform, last_event_ref, last_occurred_at, updated_at)
     VALUES ($1, $2, $3, $4::timestamptz, now())
     ON CONFLICT (company_id, source_platform)
     DO UPDATE SET last_event_ref = EXCLUDED.last_event_ref, last_occurred_at = EXCLUDED.last_occurred_at, updated_at = now()`,
    [companyId, platform, cursor.lastEventRef, cursor.lastOccurredAt],
  );
}

export async function sweepCosts(db: LedgerDb, source: CostSource, companyId: string, opts: SweepOptions): Promise<SweepResult> {
  const batchLimit = opts.batchLimit ?? 200;
  const maxBatches = opts.maxBatches ?? 20;
  const result: SweepResult = {
    companyId,
    platform: source.platform,
    read: 0,
    posted: 0,
    duplicates: 0,
    skipped: 0,
    cursor: await readCursor(db, companyId, source.platform),
  };

  for (let i = 0; i < maxBatches; i++) {
    const batch = await source.read(companyId, result.cursor, batchLimit);
    if (batch.records.length === 0) break;
    result.read += batch.records.length;

    for (const rec of batch.records) {
      if (rec.amountMinor <= 0n || rec.currency !== opts.currency) {
        result.skipped += 1;
        continue;
      }
      const subject = rec.subject ?? {};
      const posted = await postTransaction(db, {
        companyId,
        occurredAt: rec.occurredAt,
        description: rec.description ?? `${rec.category} cost${rec.biller ? ` · ${rec.biller}` : ''}${rec.estimated ? ' (estimated)' : ''}`,
        sourcePlatform: source.platform,
        sourceKind: 'cost_sweep',
        sourceRef: rec.ref,
        currency: rec.currency,
        createdBy: opts.createdBy ?? 'sweep',
        entries: [
          { accountCode: expenseAccountFor(rec.category), direction: 'debit', amountMinor: rec.amountMinor, subject },
          { accountCode: ACCOUNT.TREASURY, direction: 'credit', amountMinor: rec.amountMinor, subject },
        ],
      });
      if (posted.inserted) result.posted += 1;
      else result.duplicates += 1;
    }

    result.cursor = batch.next;
    await writeCursor(db, companyId, source.platform, result.cursor);
    if (batch.records.length < batchLimit) break;
  }

  return result;
}
