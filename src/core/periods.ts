/**
 * Accounting periods (M4). A period is a date range per company. Closing one
 * locks it: no transaction dated inside a closed period can be posted, and the
 * error names the period (acceptance criterion 6). Nothing is ever deleted.
 */
import { LedgerError } from './ledger.js';
import { newId, table, type LedgerDb } from './sql.js';

export interface Period {
  id: string;
  companyId: string;
  startsOn: string; // YYYY-MM-DD
  endsOn: string; // YYYY-MM-DD, inclusive
  status: 'open' | 'closed';
  closedAt: string | null;
  closedBy: string | null;
  label: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(value: unknown, label: string): string {
  // Round-trip through UTC so "2026-09-31" is refused rather than rolled into October.
  const ok = typeof value === 'string' && DATE.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (!ok) throw new LedgerError(`${label} must be a real date like 2026-09-01`, 'invalid');
  return value;
}

/** First and last day of a calendar month, from 'YYYY-MM'. */
export function monthBounds(month: string): { startsOn: string; endsOn: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month));
  if (!m) throw new LedgerError('month must look like 2026-09', 'invalid');
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) throw new LedgerError('month must be 01 to 12', 'invalid');
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { startsOn: `${m[1]}-${m[2]}-01`, endsOn: `${m[1]}-${m[2]}-${String(last).padStart(2, '0')}` };
}

interface PeriodRow {
  id: string;
  company_id: string;
  starts_on: string;
  ends_on: string;
  status: 'open' | 'closed';
  closed_at: string | null;
  closed_by: string | null;
}

function fromRow(r: PeriodRow): Period {
  return {
    id: r.id,
    companyId: r.company_id,
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    status: r.status,
    closedAt: r.closed_at,
    closedBy: r.closed_by,
    label: `${r.starts_on}..${r.ends_on}`,
  };
}

const SELECT = (db: LedgerDb) =>
  `SELECT id, company_id, starts_on::text AS starts_on, ends_on::text AS ends_on, status, closed_at::text AS closed_at, closed_by
     FROM ${table(db, 'periods')}`;

export async function listPeriods(db: LedgerDb, companyId: string): Promise<Period[]> {
  const rows = await db.sql.query<PeriodRow>(`${SELECT(db)} WHERE company_id = $1 ORDER BY starts_on`, [companyId]);
  return rows.map(fromRow);
}

export async function getPeriod(db: LedgerDb, companyId: string, id: string): Promise<Period | null> {
  const rows = await db.sql.query<PeriodRow>(`${SELECT(db)} WHERE company_id = $1 AND id = $2::uuid`, [companyId, id]);
  return rows[0] ? fromRow(rows[0]) : null;
}

/** Create a period. Refuses overlap with an existing one. */
export async function createPeriod(db: LedgerDb, companyId: string, input: { startsOn: string; endsOn: string }): Promise<Period> {
  const startsOn = assertDate(input.startsOn, 'startsOn');
  const endsOn = assertDate(input.endsOn, 'endsOn');
  if (endsOn < startsOn) throw new LedgerError('endsOn must not be before startsOn', 'invalid');
  const overlap = await db.sql.query<{ starts_on: string; ends_on: string }>(
    `SELECT starts_on::text AS starts_on, ends_on::text AS ends_on FROM ${table(db, 'periods')}
      WHERE company_id = $1 AND starts_on <= $3::date AND ends_on >= $2::date LIMIT 1`,
    [companyId, startsOn, endsOn],
  );
  if (overlap[0]) {
    throw new LedgerError(`period ${startsOn}..${endsOn} overlaps ${overlap[0].starts_on}..${overlap[0].ends_on}`, 'invalid');
  }
  const id = newId();
  await db.sql.execute(
    `INSERT INTO ${table(db, 'periods')} (id, company_id, starts_on, ends_on, status) VALUES ($1::uuid, $2, $3::date, $4::date, 'open')
     ON CONFLICT (company_id, starts_on) DO NOTHING`,
    [id, companyId, startsOn, endsOn],
  );
  const p = await getPeriod(db, companyId, id);
  if (!p) throw new LedgerError(`a period starting ${startsOn} already exists`, 'invalid');
  return p;
}

/** Create a calendar month if it does not exist; return it either way. */
export async function ensureMonth(db: LedgerDb, companyId: string, month: string): Promise<Period> {
  const { startsOn, endsOn } = monthBounds(month);
  const existing = (await listPeriods(db, companyId)).find((p) => p.startsOn === startsOn && p.endsOn === endsOn);
  return existing ?? createPeriod(db, companyId, { startsOn, endsOn });
}

/**
 * Close a period. After this, posting anything dated inside it fails with
 * `period <label> is closed`. A period with a half-written (pending)
 * transaction inside it cannot be closed until the sweep clears it.
 */
export async function closePeriod(db: LedgerDb, companyId: string, id: string, closedBy = 'board'): Promise<Period> {
  const p = await getPeriod(db, companyId, id);
  if (!p) throw new LedgerError(`period ${id} not found for company ${companyId}`, 'invalid');
  if (p.status === 'closed') return p;
  const pending = await db.sql.query<{ n: unknown }>(
    `SELECT COUNT(*) AS n FROM ${table(db, 'transactions')}
      WHERE company_id = $1 AND status = 'pending' AND (occurred_at AT TIME ZONE 'UTC')::date BETWEEN $2::date AND $3::date`,
    [companyId, p.startsOn, p.endsOn],
  );
  if (Number(pending[0]?.n ?? 0) > 0) throw new LedgerError(`period ${p.label} has unfinished transactions; try again in a few minutes`, 'invalid');
  await db.sql.execute(
    `UPDATE ${table(db, 'periods')} SET status = 'closed', closed_at = now(), closed_by = $3
      WHERE company_id = $1 AND id = $2::uuid AND status = 'open'`,
    [companyId, id, closedBy],
  );
  return (await getPeriod(db, companyId, id)) ?? { ...p, status: 'closed' };
}
