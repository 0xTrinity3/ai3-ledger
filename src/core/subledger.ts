/**
 * The subledger: millions of small facts, under a general ledger that stays readable.
 *
 * An agent does a thing a thousand times an hour. Posting each one as its own
 * double-entry transaction gives a general ledger nobody can read, a trial
 * balance that takes a minute to compute, and an audit trail where the signal —
 * €4 of model spend today — is buried under a thousand rows of €0.004. Worse,
 * it pretends each microtransaction is a miniature invoice, which is not how
 * anybody accounts for continuous consumption.
 *
 * The shape here is the ordinary one for a high-volume book:
 *
 *   real-time economic ledger  →  periodic accounting ledger  →  settlement
 *   (this file: every event)      (one journal an hour/day)      (one statement)
 *
 * **The lifecycle is a card authorisation.** `authorise` asks whether there is
 * budget; `reserve` locks the ceiling so two agents cannot spend the same
 * balance at once; `capture` records what was actually spent; `release` gives
 * back what was not. Without the reservation step, concurrent agents both see
 * €100 and both spend it.
 *
 * **Two rules decide whether the general ledger ever hears about an event.**
 *
 *   1. *Internal movements are not transactions.* Two agents inside one legal
 *      entity settling with each other move budget, not money. The statutory
 *      accounts change when value crosses a legal-entity boundary or an
 *      external resource is consumed — not when a company moves its own
 *      allowance from one of its agents to another.
 *   2. *A marketplace recognises its commission, not the gross.* When AI3
 *      collects €4 and owes €3.20 of it to the provider, revenue is €0.80 and
 *      the rest is a payable. The event carries the split; the aggregation
 *      posts all three legs.
 *
 * What the general ledger gets is one journal per window, with one pair of
 * entries per (account, counterparty, currency) group. The detail stays here,
 * addressable, and every event names the batch that swept it — so a summarised
 * figure can always be opened.
 */
import { ACCOUNT } from './accounts.js';
import { assertCurrency, fromMinor, newId, table, toMinor, type LedgerDb, type Minor } from './sql.js';
import { LedgerError, postTransaction, resolveCode, type EntryInput, type Subject } from './ledger.js';

export type MeterKind = 'usage' | 'time' | 'output' | 'outcome';
export type MeterStatus = 'reserved' | 'captured' | 'released' | 'void';
/**
 * Where the money for an event comes from.
 *
 * `balance` is money this company is holding for somebody else: they put it in,
 * this draws it down, and the reservation machinery stops two agents spending
 * the same euro. The credit side is a liability, because it is their money.
 *
 * `prepaid` is this company's own resource, bought in advance — model credits
 * it already owns. There is nothing to reserve against because nobody else has
 * a claim on it, and the credit side is the asset being consumed.
 *
 * `accrual` is earned: nobody has paid anything yet, and what the event creates
 * is a debt to whoever did the work.
 *
 * All three are the same event with the same detail. They differ only in what
 * stands behind the expense, which is exactly why it has to be recorded rather
 * than inferred later.
 */
export type MeterFunding = 'balance' | 'accrual' | 'prepaid';

export interface MeterEvent {
  id: string;
  companyId: string;
  holder: string;
  status: MeterStatus;
  kind: MeterKind;
  counterparty: string | null;
  internal: boolean;
  sku: string | null;
  quantity: string | null;
  unitAmountMinor: string | null;
  amountMinor: string;
  reservedMinor: string;
  passThroughMinor: string;
  currency: string;
  accountCode: string;
  subject: Subject;
  customer: string | null;
  occurredAt: string;
  capturedAt: string | null;
  releasedAt: string | null;
  reference: string | null;
  batchId: string | null;
  funding: MeterFunding;
  streamId: string | null;
}

export interface Balance {
  companyId: string;
  holder: string;
  currency: string;
  availableMinor: string;
  reservedMinor: string;
  /** What could still be spent right now: available less what is already held. */
  spendableMinor: string;
}

const ZERO = { availableMinor: '0', reservedMinor: '0', spendableMinor: '0' };

function rowToEvent(r: Record<string, unknown>): MeterEvent {
  return {
    id: String(r['id']),
    companyId: String(r['company_id']),
    holder: String(r['holder']),
    status: String(r['status']) as MeterStatus,
    kind: String(r['kind']) as MeterKind,
    counterparty: (r['counterparty'] as string | null) ?? null,
    internal: r['internal'] === true,
    sku: (r['sku'] as string | null) ?? null,
    quantity: r['quantity'] === null || r['quantity'] === undefined ? null : String(r['quantity']),
    unitAmountMinor: r['unit_amount_minor'] === null || r['unit_amount_minor'] === undefined ? null : fromMinor(toMinor(r['unit_amount_minor'])),
    amountMinor: fromMinor(toMinor(r['amount_minor'])),
    reservedMinor: fromMinor(toMinor(r['reserved_minor'])),
    passThroughMinor: fromMinor(toMinor(r['pass_through_minor'] ?? 0)),
    currency: String(r['currency']),
    accountCode: String(r['account_code']),
    subject: {
      ...(r['agent_ref'] ? { agent: String(r['agent_ref']) } : {}),
      ...(r['project_ref'] ? { project: String(r['project_ref']) } : {}),
      ...(r['goal_ref'] ? { goal: String(r['goal_ref']) } : {}),
      ...(r['work_ref'] ? { work: String(r['work_ref']) } : {}),
    },
    customer: (r['customer'] as string | null) ?? null,
    occurredAt: String(r['occurred_at']),
    capturedAt: (r['captured_at'] as string | null) ?? null,
    releasedAt: (r['released_at'] as string | null) ?? null,
    reference: (r['reference'] as string | null) ?? null,
    batchId: (r['batch_id'] as string | null) ?? null,
    funding: (r['funding'] as MeterFunding) ?? 'balance',
    streamId: (r['stream_id'] as string | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

export async function balanceFor(db: LedgerDb, companyId: string, holder: string, currency: string): Promise<Balance> {
  const rows = await db.sql.query<Record<string, unknown>>(
    `SELECT available_minor, reserved_minor FROM ${table(db, 'meter_balances')} WHERE company_id = $1 AND holder = $2 AND currency = $3`,
    [companyId, holder, currency],
  );
  const r = rows[0];
  if (!r) return { companyId, holder, currency, ...ZERO };
  const available = toMinor(r['available_minor']);
  const reserved = toMinor(r['reserved_minor']);
  return {
    companyId, holder, currency,
    availableMinor: fromMinor(available),
    reservedMinor: fromMinor(reserved),
    spendableMinor: fromMinor(available - reserved < 0n ? 0n : available - reserved),
  };
}

export async function listBalances(db: LedgerDb, companyId: string): Promise<Balance[]> {
  const rows = await db.sql.query<Record<string, unknown>>(
    `SELECT holder, currency, available_minor, reserved_minor FROM ${table(db, 'meter_balances')} WHERE company_id = $1 ORDER BY holder, currency`,
    [companyId],
  );
  return rows.map((r: Record<string, unknown>) => {
    const available = toMinor(r['available_minor']);
    const reserved = toMinor(r['reserved_minor']);
    return {
      companyId, holder: String(r['holder']), currency: String(r['currency']),
      availableMinor: fromMinor(available),
      reservedMinor: fromMinor(reserved),
      spendableMinor: fromMinor(available - reserved < 0n ? 0n : available - reserved),
    };
  });
}

/**
 * Put money on a holder's balance.
 *
 * This is the prepayment. Whether it also hits the general ledger is the
 * caller's call and depends on whose money it is: a customer prepaying AI3 is
 * cash in and a credit liability out, while a company topping up one of its own
 * agents is moving an allowance it already owns and posts nothing.
 */
export async function fund(
  db: LedgerDb,
  companyId: string,
  input: {
    holder: string;
    currency: string;
    amountMinor: Minor | number | string;
    /**
     * True when this is somebody else's money arriving: cash in, and a credit
     * liability out, because it is theirs until they spend it. False — the
     * default — for a company moving an allowance it already owns from itself
     * to one of its own agents, which is not a transaction.
     */
    post?: boolean;
    cashAccountCode?: string;
    reference?: string;
    occurredAt?: Date | string;
    createdBy?: string;
  },
): Promise<Balance> {
  assertCurrency(input.currency);
  const amount = toMinor(input.amountMinor);
  if (amount <= 0n) throw new LedgerError('a top-up has to be a positive amount', 'invalid');
  if (input.post) {
    await postTransaction(db, {
      companyId,
      occurredAt: input.occurredAt ?? new Date(),
      description: `Prepayment from ${input.holder}`,
      sourcePlatform: 'ai3',
      sourceKind: 'payment',
      sourceRef: `prepay:${input.holder}:${input.reference ?? fromMinor(amount)}`,
      currency: input.currency,
      createdBy: input.createdBy ?? 'system',
      entries: [
        { accountCode: input.cashAccountCode ?? ACCOUNT.TREASURY, direction: 'debit', amountMinor: amount },
        { accountCode: ACCOUNT.CUSTOMER_CREDITS, direction: 'credit', amountMinor: amount },
      ],
    });
  }
  await db.sql.execute(
    `INSERT INTO ${table(db, 'meter_balances')} (company_id, holder, currency, available_minor)
     VALUES ($1, $2, $3, $4::bigint)
     ON CONFLICT (company_id, holder, currency) DO UPDATE
       SET available_minor = ${table(db, 'meter_balances')}.available_minor + EXCLUDED.available_minor, updated_at = now()`,
    [companyId, input.holder, input.currency, fromMinor(amount)],
  );
  return balanceFor(db, companyId, input.holder, input.currency);
}

/**
 * Is there budget for this, right now?
 *
 * Answered without taking anything, because an agent deciding whether to try
 * something should not have to reserve in order to ask. `reserve` asks again
 * and is the one that binds — between the two answers another agent may have
 * spent it.
 */
export async function authorise(
  db: LedgerDb,
  companyId: string,
  input: { holder: string; currency: string; maxMinor: Minor | number | string },
): Promise<{ ok: boolean; spendableMinor: string; shortMinor: string; reason?: string }> {
  const want = toMinor(input.maxMinor);
  const b = await balanceFor(db, companyId, input.holder, input.currency);
  const spendable = toMinor(b.spendableMinor);
  if (spendable >= want) return { ok: true, spendableMinor: b.spendableMinor, shortMinor: '0' };
  return {
    ok: false,
    spendableMinor: b.spendableMinor,
    shortMinor: fromMinor(want - spendable),
    reason: `${input.holder} has ${fromMinor(spendable)} to spend and this needs ${fromMinor(want)}`,
  };
}

// ---------------------------------------------------------------------------
// The lifecycle
// ---------------------------------------------------------------------------

/**
 * Hold the ceiling before the work starts.
 *
 * The conditional UPDATE is the whole point: two agents asking at the same
 * moment cannot both succeed, because the second one's `available - reserved`
 * no longer covers it. Without this, both see the same balance and both spend
 * it.
 */
export async function reserve(
  db: LedgerDb,
  companyId: string,
  input: {
    holder: string;
    currency: string;
    maxMinor: Minor | number | string;
    kind?: MeterKind;
    accountCode?: string;
    counterparty?: string | null;
    internal?: boolean;
    sku?: string | null;
    subject?: Subject;
    customer?: string | null;
    occurredAt?: Date | string;
    reference?: string | null;
    createdBy?: string;
    funding?: MeterFunding;
    streamId?: string | null;
  },
): Promise<MeterEvent> {
  assertCurrency(input.currency);
  const max = toMinor(input.maxMinor);
  if (max <= 0n) throw new LedgerError('a reservation has to be a positive amount', 'invalid');
  const funding: MeterFunding = input.funding ?? 'balance';

  // A retry with the same reference gets the reservation it already has.
  if (input.reference) {
    const seen = await byReference(db, companyId, input.reference);
    if (seen) return seen;
  }

  // Only money held for somebody else is reserved. An accrual is work being
  // earned, and a prepaid resource is already this company's own: neither has
  // a third party whose balance could be spent twice.
  const held = funding !== 'balance'
    ? { rowCount: 1 }
    : await db.sql.execute(
      `UPDATE ${table(db, 'meter_balances')} SET reserved_minor = reserved_minor + $4::bigint, updated_at = now()
        WHERE company_id = $1 AND holder = $2 AND currency = $3
          AND available_minor - reserved_minor >= $4::bigint`,
      [companyId, input.holder, input.currency, fromMinor(max)],
    );
  if (held.rowCount === 0) {
    const b = await balanceFor(db, companyId, input.holder, input.currency);
    throw new LedgerError(
      `${input.holder} has ${fromMinor(toMinor(b.spendableMinor))} ${input.currency} to spend and this reserves ${fromMinor(max)}`,
      'invalid',
    );
  }

  const id = newId();
  const s = input.subject ?? {};
  await db.sql.execute(
    `INSERT INTO ${table(db, 'meter_events')}
       (id, company_id, holder, status, kind, counterparty, internal, sku, amount_minor, reserved_minor, currency,
        account_code, agent_ref, project_ref, goal_ref, work_ref, customer, occurred_at, reference, created_by, funding, stream_id)
     VALUES ($1::uuid, $2, $3, 'reserved', $4, $5, $6, $7, 0, $8::bigint, $9, $10, $11, $12, $13, $14, $15, $16::timestamptz, $17, $18, $19, $20::uuid)`,
    [
      id, companyId, input.holder, input.kind ?? 'usage', input.counterparty ?? null, input.internal === true,
      input.sku ?? null, fromMinor(max), input.currency,
      await resolveCode(db, companyId, input.accountCode ?? ACCOUNT.MODEL_INFERENCE),
      s.agent ?? null, s.project ?? null, s.goal ?? null, s.work ?? null,
      input.customer ?? null,
      toIso(input.occurredAt ?? new Date()), input.reference ?? null, input.createdBy ?? 'system',
      funding, input.streamId ?? null,
    ],
  );
  const made = await getEvent(db, companyId, id);
  if (!made) throw new LedgerError('the reservation was not written', 'invalid');
  return made;
}

/**
 * What it actually cost.
 *
 * The difference between the reservation and the capture goes straight back:
 * an over-estimate is not a charge, and a holder whose reservations are never
 * released has a balance that drifts down for no reason anybody can point at.
 */
export async function capture(
  db: LedgerDb,
  companyId: string,
  eventId: string,
  input: {
    amountMinor: Minor | number | string;
    passThroughMinor?: Minor | number | string;
    quantity?: number | string | null;
    unitAmountMinor?: Minor | number | string | null;
    occurredAt?: Date | string;
  },
): Promise<MeterEvent> {
  const e = await getEvent(db, companyId, eventId);
  if (!e) throw new LedgerError(`no subledger event ${eventId}`, 'invalid');
  if (e.status === 'captured') return e; // a retry captures once
  if (e.status !== 'reserved') throw new LedgerError(`that event is ${e.status}; only a reservation can be captured`, 'invalid');

  const spent = toMinor(input.amountMinor);
  if (spent < 0n) throw new LedgerError('a capture cannot be negative', 'invalid');
  const held = toMinor(e.reservedMinor);
  if (spent > held) throw new LedgerError(`capture ${fromMinor(spent)} is more than the ${fromMinor(held)} reserved`, 'invalid');
  const passThrough = input.passThroughMinor === undefined ? 0n : toMinor(input.passThroughMinor);
  if (passThrough > spent) throw new LedgerError('more cannot be owed on to somebody else than was collected', 'invalid');

  // The balance falls by what was spent, and the whole reservation is let go.
  // An accrual touches no balance: what it creates is a debt, not a drawdown.
  if (e.funding === 'balance') {
    await db.sql.execute(
      `UPDATE ${table(db, 'meter_balances')}
          SET available_minor = available_minor - $4::bigint, reserved_minor = reserved_minor - $5::bigint, updated_at = now()
        WHERE company_id = $1 AND holder = $2 AND currency = $3`,
      [companyId, e.holder, e.currency, fromMinor(spent), fromMinor(held)],
    );
  }
  await db.sql.execute(
    `UPDATE ${table(db, 'meter_events')}
        SET status = 'captured', amount_minor = $3::bigint, reserved_minor = 0, pass_through_minor = $4::bigint,
            quantity = $5::numeric, unit_amount_minor = $6::bigint, captured_at = $7::timestamptz
      WHERE company_id = $1 AND id = $2::uuid`,
    [
      companyId, eventId, fromMinor(spent), fromMinor(passThrough),
      input.quantity === null || input.quantity === undefined ? null : String(input.quantity),
      input.unitAmountMinor === null || input.unitAmountMinor === undefined ? null : fromMinor(toMinor(input.unitAmountMinor)),
      toIso(input.occurredAt ?? new Date()),
    ],
  );
  return (await getEvent(db, companyId, eventId))!;
}

/** Give the reservation back: the work did not happen, or it cost nothing. */
export async function release(db: LedgerDb, companyId: string, eventId: string, at: Date | string = new Date()): Promise<MeterEvent> {
  const e = await getEvent(db, companyId, eventId);
  if (!e) throw new LedgerError(`no subledger event ${eventId}`, 'invalid');
  if (e.status === 'released' || e.status === 'void') return e;
  if (e.status !== 'reserved') throw new LedgerError(`that event is ${e.status}; only a reservation can be released`, 'invalid');
  if (e.funding === 'balance') {
    await db.sql.execute(
      `UPDATE ${table(db, 'meter_balances')} SET reserved_minor = reserved_minor - $4::bigint, updated_at = now()
        WHERE company_id = $1 AND holder = $2 AND currency = $3`,
      [companyId, e.holder, e.currency, e.reservedMinor],
    );
  }
  await db.sql.execute(
    `UPDATE ${table(db, 'meter_events')} SET status = 'released', reserved_minor = 0, released_at = $3::timestamptz WHERE company_id = $1 AND id = $2::uuid`,
    [companyId, eventId, toIso(at)],
  );
  return (await getEvent(db, companyId, eventId))!;
}

/**
 * Reserve and capture in one go, for work whose cost is already known.
 *
 * Most metering is like this: the provider has already billed, the number is
 * exact, and there is nothing to estimate. The two-step exists for the case
 * where it is not.
 */
export async function record(
  db: LedgerDb,
  companyId: string,
  input: Omit<Parameters<typeof reserve>[2], 'maxMinor'> & { amountMinor: Minor | number | string; passThroughMinor?: Minor | number | string; quantity?: number | string | null; unitAmountMinor?: Minor | number | string | null },
): Promise<MeterEvent> {
  const amount = toMinor(input.amountMinor);
  const reserved = await reserve(db, companyId, { ...input, maxMinor: amount });
  if (reserved.status === 'captured') return reserved; // idempotent replay
  return capture(db, companyId, reserved.id, {
    amountMinor: amount,
    ...(input.passThroughMinor === undefined ? {} : { passThroughMinor: input.passThroughMinor }),
    ...(input.quantity === undefined ? {} : { quantity: input.quantity }),
    ...(input.unitAmountMinor === undefined ? {} : { unitAmountMinor: input.unitAmountMinor }),
    ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function getEvent(db: LedgerDb, companyId: string, id: string): Promise<MeterEvent | null> {
  const rows = await db.sql.query<Record<string, unknown>>(
    `SELECT *, occurred_at::text AS occurred_at, captured_at::text AS captured_at, released_at::text AS released_at
       FROM ${table(db, 'meter_events')} WHERE company_id = $1 AND id = $2::uuid`,
    [companyId, id],
  );
  return rows[0] ? rowToEvent(rows[0]) : null;
}

async function byReference(db: LedgerDb, companyId: string, reference: string): Promise<MeterEvent | null> {
  const rows = await db.sql.query<Record<string, unknown>>(
    `SELECT *, occurred_at::text AS occurred_at, captured_at::text AS captured_at, released_at::text AS released_at
       FROM ${table(db, 'meter_events')} WHERE company_id = $1 AND reference = $2`,
    [companyId, reference],
  );
  return rows[0] ? rowToEvent(rows[0]) : null;
}

export async function listEvents(
  db: LedgerDb,
  companyId: string,
  filter: { holder?: string; from?: Date | string; to?: Date | string; status?: MeterStatus; batchId?: string; limit?: number } = {},
): Promise<MeterEvent[]> {
  const limit = Math.min(Math.max(Math.floor(filter.limit ?? 500), 1), 10_000);
  const rows = await db.sql.query<Record<string, unknown>>(
    `SELECT *, occurred_at::text AS occurred_at, captured_at::text AS captured_at, released_at::text AS released_at
       FROM ${table(db, 'meter_events')}
      WHERE company_id = $1
        AND ($2::text IS NULL OR holder = $2::text)
        AND ($3::timestamptz IS NULL OR occurred_at >= $3::timestamptz)
        AND ($4::timestamptz IS NULL OR occurred_at <= $4::timestamptz)
        AND ($5::text IS NULL OR status = $5::text)
        AND ($6::uuid IS NULL OR batch_id = $6::uuid)
      ORDER BY meter_events.occurred_at, meter_events.id
      LIMIT $7::int`,
    [
      companyId, filter.holder ?? null,
      filter.from ? toIso(filter.from) : null, filter.to ? toIso(filter.to) : null,
      filter.status ?? null, filter.batchId ?? null, limit,
    ],
  );
  return rows.map(rowToEvent);
}

// ---------------------------------------------------------------------------
// Into the general ledger
// ---------------------------------------------------------------------------

export interface AggregateResult {
  batchId: string | null;
  transactionId: string | null;
  events: number;
  amountMinor: string;
  skippedInternal: number;
  groups: Array<{ accountCode: string; counterparty: string | null; funding: MeterFunding; amountMinor: string; passThroughMinor: string; events: number }>;
}

/**
 * Roll every captured, unposted event in the window into one journal.
 *
 * Grouped by account and counterparty, because those are the two things that
 * decide where a line goes and who it is owed to. Everything in one window is
 * one transaction, so a day of a thousand actions is one row in the general
 * ledger and a thousand rows here — each naming the batch that swept it, so
 * the summary can always be opened.
 *
 * Three legs come out of a group that has a pass-through:
 *
 *   Dr customer credits     the whole of what the holder spent
 *     Cr provider payable   the part owed on to whoever did the work
 *     Cr commission revenue the part that is ours
 *
 * and two out of one that does not — an ordinary expense against the balance
 * it was drawn from. Internal events are swept but post nothing: they move an
 * allowance inside one legal entity, and the statutory accounts do not change
 * because a company moved its own budget between its own agents.
 */
export async function aggregate(
  db: LedgerDb,
  companyId: string,
  opts: { from: Date | string; to: Date | string; currency?: string; createdBy?: string; description?: string; now?: Date },
): Promise<AggregateResult> {
  const from = toIso(opts.from);
  const to = toIso(opts.to);
  const currency = opts.currency ?? 'USD';
  assertCurrency(currency);

  const rows = await db.sql.query<Record<string, unknown>>(
    `SELECT id, account_code, counterparty, internal, amount_minor, pass_through_minor, holder, funding
       FROM ${table(db, 'meter_events')}
      WHERE company_id = $1 AND status = 'captured' AND batch_id IS NULL AND currency = $2
        AND occurred_at >= $3::timestamptz AND occurred_at <= $4::timestamptz
      ORDER BY occurred_at, id`,
    [companyId, currency, from, to],
  );
  if (rows.length === 0) {
    return { batchId: null, transactionId: null, events: 0, amountMinor: '0', skippedInternal: 0, groups: [] };
  }

  const batchId = newId();
  const internal = rows.filter((r: Record<string, unknown>) => r['internal'] === true);
  const external = rows.filter((r: Record<string, unknown>) => r['internal'] !== true);

  type Group = { accountCode: string; counterparty: string | null; funding: MeterFunding; amount: bigint; passThrough: bigint; events: number };
  const groups = new Map<string, Group>();
  let total = 0n;
  for (const r of external) {
    const accountCode = String(r['account_code']);
    const counterparty = (r['counterparty'] as string | null) ?? null;
    // Funding is part of the key: prepaid and earned land on different
    // sides of the ledger even when the expense account is the same.
    const funding: MeterFunding = (r['funding'] as MeterFunding) ?? 'balance';
    const key = `${accountCode} ${counterparty ?? ''} ${funding}`;
    const g = groups.get(key) ?? { accountCode, counterparty, funding, amount: 0n, passThrough: 0n, events: 0 };
    g.amount += toMinor(r['amount_minor']);
    g.passThrough += toMinor(r['pass_through_minor'] ?? 0);
    g.events += 1;
    groups.set(key, g);
    total += toMinor(r['amount_minor']);
  }

  let transactionId: string | null = null;
  if (total > 0n) {
    const entries: EntryInput[] = [];
    for (const g of groups.values()) {
      if (g.amount === 0n) continue;
      if (g.passThrough > 0n) {
        // Collected for somebody else: only the margin is ours.
        entries.push({ accountCode: ACCOUNT.CUSTOMER_CREDITS, direction: 'debit', amountMinor: g.amount });
        entries.push({ accountCode: ACCOUNT.PROVIDER_PAYABLE, direction: 'credit', amountMinor: g.passThrough });
        if (g.amount - g.passThrough > 0n) {
          entries.push({ accountCode: ACCOUNT.COMMISSION_REVENUE, direction: 'credit', amountMinor: g.amount - g.passThrough });
        }
      } else {
        // The expense is the same either way; what differs is what stands
        // behind it. Prepaid money draws down a credit balance somebody
        // already handed over; earned work creates a debt to whoever did it.
        entries.push({ accountCode: g.accountCode, direction: 'debit', amountMinor: g.amount });
        entries.push({
          accountCode: g.funding === 'accrual' ? ACCOUNT.ACCRUED_STREAMS_PAYABLE
            : g.funding === 'prepaid' ? ACCOUNT.PREPAID_CREDITS
              : ACCOUNT.CUSTOMER_CREDITS,
          direction: 'credit',
          amountMinor: g.amount,
        });
      }
    }
    const posted = await postTransaction(db, {
      companyId,
      occurredAt: opts.now ?? new Date(to),
      description: opts.description ?? `Agent activity ${from.slice(0, 10)} to ${to.slice(0, 10)} · ${external.length} event${external.length === 1 ? '' : 's'}`,
      sourcePlatform: 'ai3',
      sourceKind: 'cost_sweep',
      // One sweep per window per currency, so running it twice posts once.
      sourceRef: `subledger:${companyId}:${from}:${to}:${currency}`,
      currency,
      createdBy: opts.createdBy ?? 'subledger',
      entries,
    });
    transactionId = posted.transactionId;
  }

  await db.sql.execute(
    `INSERT INTO ${table(db, 'meter_batches')} (id, company_id, from_at, to_at, transaction_id, event_count, amount_minor, currency, created_by)
     VALUES ($1::uuid, $2, $3::timestamptz, $4::timestamptz, $5::uuid, $6::int, $7::bigint, $8, $9)`,
    [batchId, companyId, from, to, transactionId, rows.length, fromMinor(total), currency, opts.createdBy ?? 'subledger'],
  );
  // Internal events are marked too: swept, accounted for, and deliberately
  // absent from the journal rather than left to be swept again tomorrow.
  await db.sql.execute(
    `UPDATE ${table(db, 'meter_events')} SET batch_id = $2::uuid
      WHERE company_id = $1 AND status = 'captured' AND batch_id IS NULL AND currency = $3
        AND occurred_at >= $4::timestamptz AND occurred_at <= $5::timestamptz`,
    [companyId, batchId, currency, from, to],
  );

  return {
    batchId,
    transactionId,
    events: rows.length,
    amountMinor: fromMinor(total),
    skippedInternal: internal.length,
    groups: [...groups.values()].map((g) => ({
      accountCode: g.accountCode, counterparty: g.counterparty, funding: g.funding,
      amountMinor: fromMinor(g.amount), passThroughMinor: fromMinor(g.passThrough), events: g.events,
    })),
  };
}

// ---------------------------------------------------------------------------
// The statement
// ---------------------------------------------------------------------------

export interface Statement {
  companyId: string;
  holder: string;
  currency: string;
  from: string;
  to: string;
  openingMinor: string;
  spentMinor: string;
  fundedMinor: string;
  closingMinor: string;
  events: number;
  lines: Array<{ counterparty: string | null; sku: string | null; kind: MeterKind; quantity: string; amountMinor: string; events: number }>;
}

/**
 * What one holder consumed over a period, summarised the way a bill is read.
 *
 * This is the document that replaces a thousand invoices: the customer
 * transacts continuously, their balance falls as they go, and at the end of the
 * month they get one statement with the total and the detail behind it. Grouped
 * by counterparty and SKU because "what did I spend it on" is the question
 * being asked, not "in what order".
 */
export async function statement(
  db: LedgerDb,
  companyId: string,
  input: { holder: string; currency: string; from: Date | string; to: Date | string },
): Promise<Statement> {
  const from = toIso(input.from);
  const to = toIso(input.to);
  const rows = await db.sql.query<Record<string, unknown>>(
    `SELECT counterparty, sku, kind, COALESCE(SUM(quantity), 0)::text AS quantity,
            COALESCE(SUM(amount_minor), 0) AS amount_minor, COUNT(*)::int AS n
       FROM ${table(db, 'meter_events')}
      WHERE company_id = $1 AND holder = $2 AND currency = $3 AND status = 'captured'
        AND occurred_at >= $4::timestamptz AND occurred_at <= $5::timestamptz
      GROUP BY counterparty, sku, kind
      ORDER BY SUM(amount_minor) DESC`,
    [companyId, input.holder, input.currency, from, to],
  );
  let spent = 0n;
  let events = 0;
  const lines = rows.map((r: Record<string, unknown>) => {
    const amount = toMinor(r['amount_minor']);
    spent += amount;
    events += Number(r['n']);
    return {
      counterparty: (r['counterparty'] as string | null) ?? null,
      sku: (r['sku'] as string | null) ?? null,
      kind: String(r['kind']) as MeterKind,
      quantity: String(r['quantity'] ?? '0'),
      amountMinor: fromMinor(amount),
      events: Number(r['n']),
    };
  });

  const closing = await balanceFor(db, companyId, input.holder, input.currency);
  return {
    companyId, holder: input.holder, currency: input.currency, from, to,
    // Derived rather than stored: what it is now, plus what left it in the
    // window. A stored opening balance is a second source of truth.
    openingMinor: fromMinor(toMinor(closing.availableMinor) + spent),
    spentMinor: fromMinor(spent),
    fundedMinor: '0',
    closingMinor: closing.availableMinor,
    events,
    lines,
  };
}

/**
 * Turn a period's consumption into the one document that is legally an invoice.
 *
 * This is the other half of "no invoice before each action": the customer
 * transacts continuously and their balance falls as they go, and then once a
 * month they get a tax invoice for the total with the detail behind it. One
 * line per counterparty and SKU — the same grouping the statement shows, so
 * the invoice and the statement cannot disagree — and a reference that makes
 * running the month twice produce one document rather than two.
 *
 * It bills what was consumed, not what is owed: a customer who prepaid has
 * already paid, and the invoice is marked paid out of the balance they drew
 * on. A customer on credit gets an ordinary receivable.
 */
export async function invoiceStatement(
  db: LedgerDb,
  companyId: string,
  input: {
    holder: string;
    customerId: string;
    currency: string;
    from: Date | string;
    to: Date | string;
    /** True when the holder prepaid: the invoice is settled against the balance they drew on. */
    prepaid?: boolean;
    accountCode?: string;
    dueAt?: Date | string | null;
    createdBy?: string;
    reference?: string;
  },
): Promise<{ invoiceId: string | null; number: string | null; totalMinor: string; lines: number; alreadyBilled: boolean }> {
  const s = await statement(db, companyId, { holder: input.holder, currency: input.currency, from: input.from, to: input.to });
  if (s.lines.length === 0 || toMinor(s.spentMinor) === 0n) {
    return { invoiceId: null, number: null, totalMinor: '0', lines: 0, alreadyBilled: false };
  }
  const reference = input.reference ?? `statement:${input.holder}:${s.from.slice(0, 10)}:${s.to.slice(0, 10)}`;
  const existing = await db.sql.query<{ id: string; number: string }>(
    `SELECT id, number FROM ${table(db, 'invoices')} WHERE company_id = $1 AND reference = $2 LIMIT 1`,
    [companyId, reference],
  );
  if (existing[0]) {
    return { invoiceId: existing[0].id, number: existing[0].number, totalMinor: s.spentMinor, lines: s.lines.length, alreadyBilled: true };
  }

  const { createInvoice, issueInvoice, recordPayment } = await import('./invoices.js');
  const draft = await createInvoice(db, companyId, {
    customerId: input.customerId,
    currency: input.currency,
    reference,
    ...(input.dueAt === undefined || input.dueAt === null ? {} : { dueAt: toIso(input.dueAt) }),
    lines: s.lines.map((l) => ({
      description: `${l.counterparty ?? 'Agent activity'}${l.sku ? ` · ${l.sku}` : ''} · ${l.events} event${l.events === 1 ? '' : 's'}`,
      quantity: '1',
      unitAmountMinor: l.amountMinor,
      ...(input.accountCode ? { accountCode: input.accountCode } : {}),
    })),
    notes: `Usage from ${s.from.slice(0, 10)} to ${s.to.slice(0, 10)}. ${s.events} metered events; the detail is on the statement.`,
  });
  const issued = await issueInvoice(db, companyId, draft.id, { createdBy: input.createdBy ?? 'subledger' });
  if (input.prepaid) {
    // They paid before they spent it, so the invoice documents what the money
    // was for rather than asking for it again.
    await recordPayment(db, companyId, draft.id, {
      amountMinor: toMinor(s.spentMinor),
      cashAccountCode: ACCOUNT.CUSTOMER_CREDITS,
      reference,
      occurredAt: toIso(input.to),
      createdBy: input.createdBy ?? 'subledger',
    });
  }
  return { invoiceId: draft.id, number: issued.number, totalMinor: s.spentMinor, lines: s.lines.length, alreadyBilled: false };
}

const toIso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());
