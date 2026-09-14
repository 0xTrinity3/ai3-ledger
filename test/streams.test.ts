// Work earned by the second, not by the invoice.
//
// An agent paid €0.01 a task and running all day is not billing anybody 300
// times: it earns continuously, the balance owed grows as the work happens,
// and a withdrawal later settles what was already earned. The accounting
// follows: the expense arises when the work is done, and cash moves when
// somebody asks.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { openPluginTestDb, type PluginTestDb } from './harness.js';
import {
  ACCOUNT, accrue, aggregate, balanceOf, cancelStream, getStream, headroom, listEvents, listStreams,
  openStream, pauseStream, profitAndLoss, resumeStream, seedAccounts, tick, trialBalance, withdraw,
} from '../src/core/index.js';

let db: PluginTestDb;
let CO = '';
let n = 0;

beforeAll(async () => { db = await openPluginTestDb(); });
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  CO = `57ea${String(n += 1).padStart(4, '0')}-1111-4111-8111-111111111111`;
  await seedAccounts(db, CO, 'EUR');
});

const DAY = { from: '2026-09-14T00:00:00.000Z', to: '2026-09-14T23:59:59.999Z' };
const at = (h: number, m = 0) => new Date(`2026-09-14T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`);

const output = (over: Record<string, unknown> = {}) => openStream(db, CO, {
  payer: 'company', recipient: 'agent:writer', kind: 'output', meter: 'task',
  rateMinor: '1', currency: 'EUR', capMinor: '10000', accountCode: ACCOUNT.MODEL_INFERENCE, ...over,
});

describe('a stream is an agreement, and says so', () => {
  it('needs a payer, a recipient, a meter, a rate and a cap', async () => {
    await expect(openStream(db, CO, { payer: 'a', recipient: 'a', kind: 'output', meter: 'task', rateMinor: '1', currency: 'EUR', capMinor: '100' }))
      .rejects.toThrow(/from somebody to themselves/);
    await expect(openStream(db, CO, { payer: 'a', recipient: 'b', kind: 'output', meter: '', rateMinor: '1', currency: 'EUR', capMinor: '100' }))
      .rejects.toThrow(/needs a meter/);
    await expect(openStream(db, CO, { payer: 'a', recipient: 'b', kind: 'output', meter: 'task', rateMinor: '0', currency: 'EUR', capMinor: '100' }))
      .rejects.toThrow(/needs a rate per task/);
    // No cap is a standing instruction to spend without limit.
    await expect(openStream(db, CO, { payer: 'a', recipient: 'b', kind: 'output', meter: 'task', rateMinor: '1', currency: 'EUR', capMinor: '0' }))
      .rejects.toThrow(/needs a cap/);
    // An outcome stream is a percentage, not a rate.
    await expect(openStream(db, CO, { payer: 'a', recipient: 'b', kind: 'outcome', meter: 'value', currency: 'EUR', capMinor: '100' }))
      .rejects.toThrow(/percentage of verified value/);
  });

  it('records how it can be stopped, because that is half the agreement', async () => {
    const s = await output({ noticeSeconds: 3600 });
    expect(s.noticeSeconds).toBe(3600);
    expect(s.status).toBe('active');
    expect(s.withdrawableMinor).toBe('0');
  });
});

describe('earning', () => {
  it('300 tasks at a penny is €3 accrued, and the general ledger sees one entry', async () => {
    const s = await output();
    for (let i = 0; i < 300; i += 1) {
      await accrue(db, CO, s.id, { quantity: 1, at: at(9), reference: `task-${i}` });
    }
    const live = await getStream(db, CO, s.id);
    expect(live!.accruedMinor).toBe('300');
    expect(live!.withdrawableMinor).toBe('300');

    // The daily journal: the expense arises as the work is earned.
    const r = await aggregate(db, CO, { ...DAY, currency: 'EUR' });
    expect(r.events).toBe(300);
    expect(r.groups[0]!.funding).toBe('accrual');
    expect((await trialBalance(db, CO)).entryCount).toBe(2);
    expect(await balanceOf(db, CO, ACCOUNT.MODEL_INFERENCE)).toBe(300n);
    expect(await balanceOf(db, CO, ACCOUNT.ACCRUED_STREAMS_PAYABLE)).toBe(300n);
  });

  it('an accrual draws no prepaid balance: it is a debt, not a drawdown', async () => {
    const s = await output();
    await accrue(db, CO, s.id, { quantity: 10, at: at(9) });
    const events = await listEvents(db, CO, { holder: 'company' });
    expect(events[0]!.funding).toBe('accrual');
    expect(events[0]!.status).toBe('captured');
    expect(events[0]!.amountMinor).toBe('10');
  });

  it('a time stream bills the gap since the last tick, and only once', async () => {
    const s = await openStream(db, CO, {
      payer: 'company', recipient: 'agent:ops', kind: 'time', meter: 'hour',
      rateMinor: '500', currency: 'EUR', capMinor: '100000', startedAt: at(9),
    });
    const first = await tick(db, CO, s.id, { now: at(10) });
    expect(first.seconds).toBe(3600);
    expect(first.accruedMinor).toBe('500'); // €5.00 an hour

    // Immediately again: no time has passed, so nothing is owed.
    const again = await tick(db, CO, s.id, { now: at(10) });
    expect(again.seconds).toBe(0);
    expect(again.accruedMinor).toBe('0');

    const half = await tick(db, CO, s.id, { now: at(10, 30) });
    expect(half.accruedMinor).toBe('250');
    expect((await getStream(db, CO, s.id))!.accruedMinor).toBe('750');
  });

  it('an outcome stream takes its share of verified value', async () => {
    const s = await openStream(db, CO, {
      payer: 'company', recipient: 'agent:closer', kind: 'outcome', meter: 'verified value',
      ratePct: 5, currency: 'EUR', capMinor: '100000',
    });
    const r = await accrue(db, CO, s.id, { valueMinor: '40000', at: at(9) });
    expect(r.accruedMinor).toBe('2000'); // 5% of €400
    await expect(accrue(db, CO, s.id, { quantity: 1, at: at(9) })).rejects.toThrow(/earns on a verified value/);
  });

  it('the cap is a ceiling: what crosses it is clamped and reported', async () => {
    const s = await output({ capMinor: '250' });
    const under = await accrue(db, CO, s.id, { quantity: 200, at: at(9) });
    expect(under.accruedMinor).toBe('200');
    expect(under.cappedMinor).toBe('0');

    const over = await accrue(db, CO, s.id, { quantity: 100, at: at(10) });
    expect(over.accruedMinor).toBe('50', );
    expect(over.cappedMinor).toBe('50');

    const nothingLeft = await accrue(db, CO, s.id, { quantity: 10, at: at(11) });
    expect(nothingLeft.accruedMinor).toBe('0');
    expect(nothingLeft.event).toBe(null);
    expect((await headroom(db, CO, s.id)).leftMinor).toBe('0');
  });

  it('a monthly cap is measured on the month, not on the life of the stream', async () => {
    const s = await output({ capMinor: '100', capPeriod: 'month' });
    await accrue(db, CO, s.id, { quantity: 100, at: new Date('2026-08-20T09:00:00.000Z') });
    // August is full; September starts again.
    const sept = await accrue(db, CO, s.id, { quantity: 40, at: at(9) });
    expect(sept.accruedMinor).toBe('40');
  });
});

describe('stopping', () => {
  it('a pause earns nothing, and resuming does not hand back the gap', async () => {
    const s = await openStream(db, CO, {
      payer: 'company', recipient: 'agent:ops', kind: 'time', meter: 'hour',
      rateMinor: '3600', currency: 'EUR', capMinor: '100000', startedAt: at(9),
    });
    await tick(db, CO, s.id, { now: at(10) });
    await pauseStream(db, CO, s.id);
    await expect(accrue(db, CO, s.id, { quantity: 1, at: at(11) })).rejects.toThrow(/is paused/);
    await resumeStream(db, CO, s.id, at(12));
    const after = await tick(db, CO, s.id, { now: at(13) });
    expect(after.seconds).toBe(3600, );
  });

  it('notice is honoured, and what was earned under it stays earned', async () => {
    const s = await output({ noticeSeconds: 3600 });
    await accrue(db, CO, s.id, { quantity: 100, at: at(9) });
    const cancelling = await cancelStream(db, CO, s.id, { reason: 'project over', now: at(10) });
    // An hour's notice: still active, still earning, with an end in sight.
    expect(cancelling.status).toBe('active');
    expect(Date.parse(cancelling.endsAt!)).toBe(at(11).getTime());
    const during = await accrue(db, CO, s.id, { quantity: 10, at: at(10, 30) });
    expect(during.accruedMinor).toBe('10');
    // After it ends, nothing more.
    await expect(accrue(db, CO, s.id, { quantity: 10, at: at(12) })).rejects.toThrow(/already ended/);
    expect((await getStream(db, CO, s.id))!.accruedMinor).toBe('110');
  });

  it('with no notice it stops on the word', async () => {
    const s = await output();
    const done = await cancelStream(db, CO, s.id, { now: at(10) });
    expect(done.status).toBe('cancelled');
    await expect(accrue(db, CO, s.id, { quantity: 1, at: at(10) })).rejects.toThrow(/is cancelled/);
  });
});

describe('settlement', () => {
  it('a withdrawal settles the liability and moves cash; it does not book the cost again', async () => {
    const s = await output();
    await accrue(db, CO, s.id, { quantity: 300, at: at(9) });
    await aggregate(db, CO, { ...DAY, currency: 'EUR' });
    expect(await balanceOf(db, CO, ACCOUNT.ACCRUED_STREAMS_PAYABLE)).toBe(300n);

    const paid = await withdraw(db, CO, s.id, { occurredAt: at(18) });
    expect(paid.paidMinor).toBe('300');
    expect(paid.stream.withdrawableMinor).toBe('0');

    // The liability is gone and the cash went with it. The expense was booked
    // when the work was earned, and is not booked twice.
    expect(await balanceOf(db, CO, ACCOUNT.ACCRUED_STREAMS_PAYABLE)).toBe(0n);
    expect(await balanceOf(db, CO, ACCOUNT.TREASURY)).toBe(-300n);
    const pnl = await profitAndLoss(db, CO, { from: '2026-09-01', to: '2026-09-30' });
    expect(pnl.expenseMinor).toBe('300');
  });

  it('nobody can withdraw what has not been earned', async () => {
    const s = await output();
    await accrue(db, CO, s.id, { quantity: 50, at: at(9) });
    await expect(withdraw(db, CO, s.id, { amountMinor: '100' })).rejects.toThrow(/more than the 50 earned/);
    await withdraw(db, CO, s.id, { amountMinor: '50' });
    await expect(withdraw(db, CO, s.id, {})).rejects.toThrow(/nothing earned to withdraw/);
  });

  it('an internal stream moves budget and has nothing to settle', async () => {
    const s = await output({ internal: true, recipient: 'agent:writer', payer: 'agent:research' });
    await accrue(db, CO, s.id, { quantity: 100, at: at(9) });
    const r = await aggregate(db, CO, { ...DAY, currency: 'EUR' });
    expect(r.skippedInternal).toBe(1);
    expect(r.transactionId).toBe(null);
    await expect(withdraw(db, CO, s.id, {})).rejects.toThrow(/moves budget, not money/);
  });

  it('streams are listed by who earns from them', async () => {
    const a = await output({ recipient: 'agent:writer' });
    await output({ recipient: 'agent:ops' });
    const mine = await listStreams(db, CO, { recipient: 'agent:writer' });
    expect(mine.length).toBe(1);
    expect(mine[0]!.id).toBe(a.id);
    expect((await listStreams(db, CO, { status: 'active' })).length).toBe(2);
  });
});
