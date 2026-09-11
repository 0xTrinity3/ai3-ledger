/**
 * Overdue reminders. Three nudges after the due date, from the owner's own
 * mailbox, only for companies that turned them on. A reminder is due when an
 * open, sent invoice is at least REMINDER_DAYS[stage] days past due and only
 * `stage` reminders have gone out so far. Nothing is sent for invoices that
 * were never emailed: the customer never had it, so a chase makes no sense.
 */
import type { Invoice } from './invoices.js';
import { listInvoices } from './invoices.js';
import type { LedgerDb } from './sql.js';

export const REMINDER_DAYS = [3, 14, 30] as const;

export interface DueReminder {
  invoice: Invoice;
  /** 1, 2 or 3: which reminder this is. */
  stage: number;
  overdueDays: number;
}

function overdueDays(inv: Invoice, now: Date): number {
  if (!inv.dueAt) return 0;
  return Math.floor((now.getTime() - Date.parse(inv.dueAt)) / 86_400_000);
}

export async function dueReminders(db: LedgerDb, companyId: string, now = new Date()): Promise<DueReminder[]> {
  const open = (await listInvoices(db, companyId, { limit: 500 })).filter((i) => (i.status === 'issued' || i.status === 'part_paid') && i.hosted?.sentAt && i.hosted.sentTo);
  const out: DueReminder[] = [];
  for (const inv of open) {
    const days = overdueDays(inv, now);
    const stage = inv.reminderStage;
    if (stage >= REMINDER_DAYS.length) continue;
    if (days >= REMINDER_DAYS[stage]!) out.push({ invoice: inv, stage: stage + 1, overdueDays: days });
  }
  return out;
}

function money(minor: string, currency: string): string {
  const n = BigInt(minor);
  const whole = n / 100n;
  const frac = (n % 100n).toString().padStart(2, '0');
  return `${whole}.${frac} ${currency}`;
}

/** Subject and message for a reminder; the hosted page and payment details ride along in the email itself. */
export function reminderEmail(r: DueReminder, companyName: string): { subject: string; message: string } {
  const inv = r.invoice;
  const amount = money(inv.outstandingMinor, inv.currency);
  const due = inv.dueAt ? inv.dueAt.slice(0, 10) : '';
  if (r.stage === 1) {
    return {
      subject: `Reminder: invoice ${inv.number} from ${companyName} was due ${due}`,
      message: `A quick reminder that invoice ${inv.number} for ${amount} was due on ${due}. If it is already on its way, thank you and please ignore this. Otherwise the payment details are on the invoice.`,
    };
  }
  if (r.stage === 2) {
    return {
      subject: `Second reminder: invoice ${inv.number} from ${companyName} is ${r.overdueDays} days overdue`,
      message: `Invoice ${inv.number} for ${amount} is now ${r.overdueDays} days past its due date of ${due}. Could you let us know when we can expect payment, or if anything on the invoice needs correcting?`,
    };
  }
  return {
    subject: `Final reminder: invoice ${inv.number} from ${companyName} is ${r.overdueDays} days overdue`,
    message: `Invoice ${inv.number} for ${amount} is ${r.overdueDays} days overdue. Please arrange payment or reply to this email today so we can resolve it. This is the last reminder we will send automatically.`,
  };
}
