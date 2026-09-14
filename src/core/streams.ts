/**
 * Continuous accrual: work that is earned by the second, not by the invoice.
 *
 * An agent paid €0.01 a task and running all day is not billing anybody 300
 * times. It earns continuously, the balance owed to it grows as the work
 * happens, and a withdrawal later only settles what was already earned. That
 * is how streaming payroll is accounted for, and it is what an agent economy
 * needs: the expense arises when the work is done, and the cash moves whenever
 * somebody asks for it.
 *
 *   300 completed tasks           →  €3 accrued, live
 *   the daily journal             →  Dr agent services  Cr accrued streams payable
 *   a withdrawal of the €3        →  Dr accrued streams payable  Cr cash
 *
 * A stream is the standing agreement, and it needs all of:
 *
 *   payer, recipient, meter, rate, cap, currency, cancellation, balance
 *
 * — because every one of those is a question somebody asks later. A stream
 * with no cap is a standing instruction to spend without limit, so `capMinor`
 * is required; a stream with no notice period stops on the word, which is a
 * choice rather than an omission, so it is recorded as zero rather than left
 * undefined.
 *
 * Each accrual is an ordinary subledger event with `funding: 'accrual'`, so
 * the same daily sweep that summarises usage summarises this. Nothing in this
 * file moves money: `withdraw` settles an earned balance against cash, and
 * until then the accrual is a liability and reads as one.
 */
import { ACCOUNT } from './accounts.js';
import { assertCurrency, fromMinor, newId, table, toMinor, type LedgerDb, type Minor } from './sql.js';
import { LedgerError, postTransaction, resolveCode } from './ledger.js';
import { capture, record, type MeterEvent, type MeterKind } from './subledger.js';

export type StreamStatus = 'active' | 'paused' | 'cancelled' | 'ended';
export type CapPeriod = 'total' | 'day' | 'month';

export interface Stream {
  id: string;
  companyId: string;
  payer: string;
  recipient: string;
  kind: MeterKind;
  meter: string;
  rateMinor: string;
  ratePct: string | null;
  currency: string;
  capMinor: string | null;
  capPeriod: CapPeriod;
  accruedMinor: string;
  settledMinor: string;
  /** Earned and not yet taken: what a withdrawal may draw on right now. */
  withdrawableMinor: string;
  status: StreamStatus;
  internal: boolean;
  accountCode: string;
  noticeSeconds: number;
  startedAt: string;
  endsAt: string | null;
  lastTickAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
}

function rowToStream(r: Record<string, unknown>): Stream {
  const accrued = toMinor(r['accrued_minor']);
  const settled = toMinor(r['settled_minor']);
  return {
    id: String(r['id']),
    companyId: String(r['company_id']),
    payer: String(r['payer']),
    recipient: String(r['recipient']),
    kind: String(r['kind']) as MeterKind,
    meter: String(r['meter']),
    rateMinor: fromMinor(toMinor(r['rate_minor'])),
    ratePct: r['rate_pct'] === null || r['rate_pct'] === undefined ? null : String(r['rate_pct']),
    currency: String(r['currency']),
    capMinor: r['cap_minor'] === null || r['cap_minor'] === undefined ? null : fromMinor(toMinor(r['cap_minor'])),
    capPeriod: String(r['cap_period']) as CapPeriod,
    accruedMinor: fromMinor(accrued),
    settledMinor: fromMinor(settled),
    withdrawableMinor: fromMinor(accrued - settled < 0n ? 0n : accrued - settled),
    status: String(r['status']) as StreamStatus,
    internal: r['internal'] === true,
    accountCode: String(r['account_code']),
    noticeSeconds: Number(r['notice_seconds'] ?? 0),
    startedAt: String(r['started_at']),
    endsAt: (r['ends_at'] as string | null) ?? null,
    lastTickAt: (r['last_tick_at'] as string | null) ?? null,
    cancelledAt: (r['cancelled_at'] as string | null) ?? null,
    cancelReason: (r['cancel_reason'] as string | null) ?? null,
  };
}

const SELECT = (db: LedgerDb) => `SELECT *, started_at::text AS started_at, ends_at::text AS ends_at,
  last_tick_at::text AS last_tick_at, cancelled_at::text AS cancelled_at FROM ${table(db, 'meter_streams')}`;

export async function getStream(db: LedgerDb, companyId: string, id: string): Promise<Stream | null> {
  const rows = await db.sql.query<Record<string, unknown>>(`${SELECT(db)} WHERE company_id = $1 AND id = $2::uuid`, [companyId, id]);
  return rows[0] ? rowToStream(rows[0]) : null;
}

export async function listStreams(
  db: LedgerDb,
  companyId: string,
  filter: { recipient?: string; payer?: string; status?: StreamStatus } = {},
): Promise<Stream[]> {
  const rows = await db.sql.query<Record<string, unknown>>(
    `${SELECT(db)} WHERE company_id = $1
       AND ($2::text IS NULL OR recipient = $2::text)
       AND ($3::text IS NULL OR payer = $3::text)
       AND ($4::text IS NULL OR status = $4::text)
     ORDER BY meter_streams.started_at DESC`,
    [companyId, filter.recipient ?? null, filter.payer ?? null, filter.status ?? null],
  );
  return rows.map(rowToStream);
}

/**
 * Open one.
 *
 * The cap is required and the notice period is explicit, because "how much can
 * this cost me" and "how do I stop it" are the two questions anybody agreeing
 * to a standing payment asks, and a stream that cannot answer them is not an
 * agreement — it is an open tab.
 */
export async function openStream(
  db: LedgerDb,
  companyId: string,
  input: {
    payer: string;
    recipient: string;
    kind: MeterKind;
    meter: string;
    currency: string;
    rateMinor?: Minor | number | string;
    /** For an outcome stream: a share of the value it is measured against. */
    ratePct?: number | string;
    capMinor: Minor | number | string;
    capPeriod?: CapPeriod;
    accountCode?: string;
    internal?: boolean;
    noticeSeconds?: number;
    startedAt?: Date | string;
    endsAt?: Date | string | null;
    createdBy?: string;
  },
): Promise<Stream> {
  assertCurrency(input.currency);
  const payer = String(input.payer ?? '').trim();
  const recipient = String(input.recipient ?? '').trim();
  if (!payer || !recipient) throw new LedgerError('a stream needs a payer and a recipient', 'invalid');
  if (payer === recipient) throw new LedgerError('a stream from somebody to themselves is not a stream', 'invalid');
  const meter = String(input.meter ?? '').trim();
  if (!meter) throw new LedgerError('a stream needs a meter: what is being counted', 'invalid');

  const rate = input.rateMinor === undefined ? 0n : toMinor(input.rateMinor);
  const pct = input.ratePct === undefined || input.ratePct === null ? null : Number(input.ratePct);
  if (input.kind === 'outcome') {
    if (pct === null || !Number.isFinite(pct) || pct <= 0 || pct > 100) {
      throw new LedgerError('an outcome stream is a percentage of verified value, between 0 and 100', 'invalid');
    }
  } else if (rate <= 0n) {
    throw new LedgerError(`a ${input.kind} stream needs a rate per ${meter}`, 'invalid');
  }

  const cap = toMinor(input.capMinor);
  if (cap <= 0n) throw new LedgerError('a stream needs a cap: without one it is a standing instruction to spend without limit', 'invalid');

  const id = newId();
  await db.sql.execute(
    `INSERT INTO ${table(db, 'meter_streams')}
       (id, company_id, payer, recipient, kind, meter, rate_minor, rate_pct, currency, cap_minor, cap_period,
        internal, account_code, notice_seconds, started_at, ends_at, created_by)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::bigint, $8::numeric, $9, $10::bigint, $11, $12, $13, $14::int, $15::timestamptz, $16::timestamptz, $17)`,
    [
      id, companyId, payer, recipient, input.kind, meter, fromMinor(rate), pct === null ? null : String(pct),
      input.currency, fromMinor(cap), input.capPeriod ?? 'total',
      input.internal === true,
      await resolveCode(db, companyId, input.accountCode ?? ACCOUNT.MODEL_INFERENCE),
      Math.max(0, Math.floor(input.noticeSeconds ?? 0)),
      toIso(input.startedAt ?? new Date()),
      input.endsAt ? toIso(input.endsAt) : null,
      input.createdBy ?? 'system',
    ],
  );
  const made = await getStream(db, companyId, id);
  if (!made) throw new LedgerError('the stream was not written', 'invalid');
  return made;
}

/** What the cap has left, over the window the cap is measured on. */
export async function headroom(db: LedgerDb, companyId: string, id: string, now: Date = new Date()): Promise<{ capMinor: string; usedMinor: string; leftMinor: string }> {
  const s = await getStream(db, companyId, id);
  if (!s) throw new LedgerError(`no stream ${id}`, 'invalid');
  const cap = s.capMinor === null ? null : toMinor(s.capMinor);
  if (cap === null) return { capMinor: '0', usedMinor: '0', leftMinor: '0' };
  const used = s.capPeriod === 'total'
    ? toMinor(s.accruedMinor)
    : await accruedSince(db, companyId, id, periodStart(s.capPeriod, now));
  const left = cap - used;
  return { capMinor: fromMinor(cap), usedMinor: fromMinor(used), leftMinor: fromMinor(left < 0n ? 0n : left) };
}

async function accruedSince(db: LedgerDb, companyId: string, streamId: string, from: Date): Promise<bigint> {
  const rows = await db.sql.query<{ total: unknown }>(
    `SELECT COALESCE(SUM(amount_minor), 0) AS total FROM ${table(db, 'meter_events')}
      WHERE company_id = $1 AND stream_id = $2::uuid AND status = 'captured' AND occurred_at >= $3::timestamptz`,
    [companyId, streamId, from.toISOString()],
  );
  return toMinor(rows[0]?.total ?? 0);
}

function periodStart(period: CapPeriod, now: Date): Date {
  if (period === 'day') return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Earn against the stream.
 *
 * `quantity` is in the stream's own meter: hours for a time stream, calls for
 * usage, completed tasks for output. An outcome stream takes the value it is a
 * percentage of instead.
 *
 * The cap is a ceiling, not a suggestion: an accrual that would cross it is
 * clamped to what is left and says so, rather than being refused outright and
 * losing the work that was actually done.
 */
export async function accrue(
  db: LedgerDb,
  companyId: string,
  id: string,
  input: { quantity?: number | string; valueMinor?: Minor | number | string; at?: Date | string; reference?: string; createdBy?: string },
): Promise<{ stream: Stream; event: MeterEvent | null; accruedMinor: string; cappedMinor: string }> {
  const s = await getStream(db, companyId, id);
  if (!s) throw new LedgerError(`no stream ${id}`, 'invalid');
  if (s.status !== 'active') throw new LedgerError(`that stream is ${s.status}`, 'invalid');

  const at = input.at ? new Date(toIso(input.at)) : new Date();
  if (s.endsAt && at.getTime() > Date.parse(s.endsAt)) throw new LedgerError('that stream had already ended', 'invalid');

  let earned: bigint;
  let quantity: string | null = null;
  if (s.kind === 'outcome') {
    if (input.valueMinor === undefined) throw new LedgerError('an outcome stream earns on a verified value', 'invalid');
    const value = toMinor(input.valueMinor);
    // Percentages are held to four decimal places, so the arithmetic is done
    // in basis points rather than floating point.
    const bps = BigInt(Math.round(Number(s.ratePct ?? '0') * 100));
    earned = (value * bps) / 10_000n;
  } else {
    const q = Number(input.quantity ?? 0);
    if (!Number.isFinite(q) || q <= 0) throw new LedgerError(`a ${s.kind} stream earns on a positive number of ${s.meter}`, 'invalid');
    quantity = String(q);
    // Quantities carry four decimals (a tenth of a second of an hour), so the
    // rate is multiplied before it is divided and nothing is lost to rounding
    // until the last step.
    earned = (toMinor(s.rateMinor) * BigInt(Math.round(q * 10_000))) / 10_000n;
  }

  const room = await headroom(db, companyId, id, at);
  const left = toMinor(room.leftMinor);
  const capped = earned > left ? earned - left : 0n;
  const take = earned > left ? left : earned;

  if (take <= 0n) {
    return { stream: s, event: null, accruedMinor: '0', cappedMinor: fromMinor(earned) };
  }

  const event = await record(db, companyId, {
    holder: s.payer,
    currency: s.currency,
    amountMinor: take,
    kind: s.kind,
    accountCode: s.accountCode,
    counterparty: s.recipient,
    internal: s.internal,
    sku: s.meter,
    funding: 'accrual',
    streamId: s.id,
    occurredAt: at,
    ...(quantity === null ? {} : { quantity }),
    ...(input.reference ? { reference: input.reference } : {}),
    ...(input.createdBy ? { createdBy: input.createdBy } : {}),
  });

  await db.sql.execute(
    `UPDATE ${table(db, 'meter_streams')} SET accrued_minor = accrued_minor + $3::bigint, last_tick_at = $4::timestamptz
      WHERE company_id = $1 AND id = $2::uuid`,
    [companyId, id, fromMinor(take), at.toISOString()],
  );
  return { stream: (await getStream(db, companyId, id))!, event, accruedMinor: fromMinor(take), cappedMinor: fromMinor(capped) };
}

/**
 * Time passing, for a stream that is paid by it.
 *
 * Only ever bills the gap since the last tick, so running the job twice in a
 * minute costs a minute rather than two. A stream that has never ticked starts
 * from when it started.
 */
export async function tick(
  db: LedgerDb,
  companyId: string,
  id: string,
  opts: { now?: Date; createdBy?: string } = {},
): Promise<{ stream: Stream; seconds: number; accruedMinor: string }> {
  const s = await getStream(db, companyId, id);
  if (!s) throw new LedgerError(`no stream ${id}`, 'invalid');
  if (s.kind !== 'time') throw new LedgerError('only a time stream is billed by the clock', 'invalid');
  if (s.status !== 'active') return { stream: s, seconds: 0, accruedMinor: '0' };

  const now = opts.now ?? new Date();
  const since = Date.parse(s.lastTickAt ?? s.startedAt);
  const until = s.endsAt ? Math.min(now.getTime(), Date.parse(s.endsAt)) : now.getTime();
  const seconds = Math.max(0, Math.floor((until - since) / 1000));
  if (seconds === 0) return { stream: s, seconds: 0, accruedMinor: '0' };

  // The meter names the unit the rate is quoted in, so an hourly rate over
  // ninety seconds is a fortieth of an hour rather than ninety of anything.
  const perUnit = s.meter === 'second' ? 1 : s.meter === 'minute' ? 60 : s.meter === 'day' ? 86_400 : 3600;
  const r = await accrue(db, companyId, id, { quantity: seconds / perUnit, at: now, ...(opts.createdBy ? { createdBy: opts.createdBy } : {}) });
  return { stream: r.stream, seconds, accruedMinor: r.accruedMinor };
}

/** Stop earning for now; the balance already earned stays owed. */
export async function pauseStream(db: LedgerDb, companyId: string, id: string): Promise<Stream> {
  await db.sql.execute(`UPDATE ${table(db, 'meter_streams')} SET status = 'paused' WHERE company_id = $1 AND id = $2::uuid AND status = 'active'`, [companyId, id]);
  return (await getStream(db, companyId, id))!;
}

export async function resumeStream(db: LedgerDb, companyId: string, id: string, now: Date = new Date()): Promise<Stream> {
  // The clock restarts rather than catching up: a paused stream earned nothing
  // while it was paused, and a resumed one should not be handed the gap.
  await db.sql.execute(
    `UPDATE ${table(db, 'meter_streams')} SET status = 'active', last_tick_at = $3::timestamptz WHERE company_id = $1 AND id = $2::uuid AND status = 'paused'`,
    [companyId, id, now.toISOString()],
  );
  return (await getStream(db, companyId, id))!;
}

/**
 * End it.
 *
 * The notice period is honoured: a stream with an hour's notice stops in an
 * hour, and keeps earning until then. What has already been earned is not
 * touched — cancelling an agreement does not unmake the work done under it.
 */
export async function cancelStream(
  db: LedgerDb,
  companyId: string,
  id: string,
  opts: { reason?: string; now?: Date; immediate?: boolean } = {},
): Promise<Stream> {
  const s = await getStream(db, companyId, id);
  if (!s) throw new LedgerError(`no stream ${id}`, 'invalid');
  if (s.status === 'cancelled' || s.status === 'ended') return s;
  const now = opts.now ?? new Date();
  const endsAt = opts.immediate || s.noticeSeconds === 0 ? now : new Date(now.getTime() + s.noticeSeconds * 1000);
  const immediate = endsAt.getTime() <= now.getTime();
  await db.sql.execute(
    `UPDATE ${table(db, 'meter_streams')}
        SET status = $5, ends_at = $3::timestamptz, cancelled_at = $4::timestamptz, cancel_reason = $6
      WHERE company_id = $1 AND id = $2::uuid`,
    [companyId, id, endsAt.toISOString(), now.toISOString(), immediate ? 'cancelled' : 'active', (opts.reason ?? '').slice(0, 500) || null],
  );
  return (await getStream(db, companyId, id))!;
}

/**
 * Take what has been earned.
 *
 * This is the only part that moves money, and it moves it against a liability
 * that already exists: the accrual was posted when the work happened, so a
 * withdrawal settles rather than recognises. Posting an expense here as well
 * would count the same work twice.
 */
export async function withdraw(
  db: LedgerDb,
  companyId: string,
  id: string,
  input: { amountMinor?: Minor | number | string; cashAccountCode?: string; occurredAt?: Date | string; createdBy?: string; reference?: string },
): Promise<{ stream: Stream; paidMinor: string; transactionId: string }> {
  const s = await getStream(db, companyId, id);
  if (!s) throw new LedgerError(`no stream ${id}`, 'invalid');
  const available = toMinor(s.withdrawableMinor);
  const want = input.amountMinor === undefined ? available : toMinor(input.amountMinor);
  if (want <= 0n) throw new LedgerError('there is nothing earned to withdraw', 'invalid');
  if (want > available) throw new LedgerError(`${fromMinor(want)} is more than the ${fromMinor(available)} earned and unsettled`, 'invalid');
  if (s.internal) throw new LedgerError('an internal stream moves budget, not money: there is nothing to withdraw', 'invalid');

  const posted = await postTransaction(db, {
    companyId,
    occurredAt: input.occurredAt ?? new Date(),
    description: `Stream settlement to ${s.recipient} · ${s.meter}`,
    sourcePlatform: 'ai3',
    sourceKind: 'payment',
    sourceRef: `stream:${id}:${input.reference ?? fromMinor(toMinor(s.settledMinor) + want)}`,
    currency: s.currency,
    createdBy: input.createdBy ?? 'system',
    entries: [
      { accountCode: ACCOUNT.ACCRUED_STREAMS_PAYABLE, direction: 'debit', amountMinor: want },
      { accountCode: input.cashAccountCode ?? ACCOUNT.TREASURY, direction: 'credit', amountMinor: want },
    ],
  });
  await db.sql.execute(
    `UPDATE ${table(db, 'meter_streams')} SET settled_minor = settled_minor + $3::bigint WHERE company_id = $1 AND id = $2::uuid`,
    [companyId, id, fromMinor(want)],
  );
  return { stream: (await getStream(db, companyId, id))!, paidMinor: fromMinor(want), transactionId: posted.transactionId };
}

const toIso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

/** Kept so a caller that already has an event can finish it the same way. */
export { capture as captureStreamEvent };
