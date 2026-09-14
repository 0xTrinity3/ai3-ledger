/** Overdue reminders: which invoices are due a nudge, and what the nudge says. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openPluginTestDb, type PluginTestDb } from './harness.js';
import { REMINDER_DAYS, createCustomer, createInvoice, dueReminders, getSettings, issueInvoice, markInvoiceReminded, markInvoiceSent, reminderEmail, seedAccounts, setInvoiceHosted, updateSettings } from '../src/core/index.js';

const CO = '99999999-1111-4111-8111-999999999999';
let db: PluginTestDb;
let sentId: string;
let unsentId: string;

beforeAll(async () => {
  db = await openPluginTestDb();
  await seedAccounts(db, CO, 'USD', { version: 1 });
  const c = await createCustomer(db, CO, { name: 'Late Payer', email: 'ap@late.example' });
  const due = '2026-09-01T12:00:00.000Z';
  const a = await createInvoice(db, CO, { customerId: c.id, currency: 'USD', lines: [{ description: 'Work', quantity: '1', unitAmountMinor: '20000' }], dueAt: due });
  await issueInvoice(db, CO, a.id, { issuedAt: '2026-08-15T12:00:00.000Z' });
  await setInvoiceHosted(db, CO, a.id, { token: 't', url: 'https://ai3.test/i/t' });
  await markInvoiceSent(db, CO, a.id, 'ap@late.example');
  sentId = a.id;
  const b = await createInvoice(db, CO, { customerId: c.id, currency: 'USD', lines: [{ description: 'Never emailed', quantity: '1', unitAmountMinor: '5000' }], dueAt: due });
  await issueInvoice(db, CO, b.id, { issuedAt: '2026-08-15T12:00:00.000Z' });
  unsentId = b.id;
});
afterAll(async () => { await db.close(); });

describe('reminders', () => {
  it('are off by default and can be turned on', async () => {
    expect((await getSettings(db, CO)).remindersEnabled).toBe(false);
    await updateSettings(db, CO, { remindersEnabled: true });
    expect((await getSettings(db, CO)).remindersEnabled).toBe(true);
  });

  it('nothing is due before the first threshold', async () => {
    expect(await dueReminders(db, CO, new Date('2026-09-03T00:00:00.000Z'))).toEqual([]);
  });

  it('chases only emailed invoices, one stage at a time', async () => {
    const first = await dueReminders(db, CO, new Date('2026-09-05T12:00:00.000Z'));
    expect(first.map((r) => [r.invoice.id, r.stage])).toEqual([[sentId, 1]]);
    expect(first.some((r) => r.invoice.id === unsentId)).toBe(false);
    const mail = reminderEmail(first[0]!, 'Test Co');
    expect(mail.subject).toMatch(/^Reminder: invoice INV-0001 from Test Co was due 2026-09-01/);
    expect(mail.message).toContain('200.00 USD');
    await markInvoiceReminded(db, CO, sentId, 1);
    // same day again: nothing new
    expect(await dueReminders(db, CO, new Date('2026-09-05T12:00:00.000Z'))).toEqual([]);
    // 14 days: second, 30 days: third, then silence
    const second = await dueReminders(db, CO, new Date('2026-09-16T12:00:00.000Z'));
    expect(second.map((r) => r.stage)).toEqual([2]);
    expect(reminderEmail(second[0]!, 'Test Co').subject).toMatch(/Second reminder/);
    await markInvoiceReminded(db, CO, sentId, 2);
    const third = await dueReminders(db, CO, new Date('2026-10-05T12:00:00.000Z'));
    expect(third.map((r) => r.stage)).toEqual([3]);
    expect(reminderEmail(third[0]!, 'Test Co').subject).toMatch(/Final reminder/);
    await markInvoiceReminded(db, CO, sentId, 3);
    expect(await dueReminders(db, CO, new Date('2027-01-01T12:00:00.000Z'))).toEqual([]);
    expect(REMINDER_DAYS).toEqual([3, 14, 30]);
  });
});
