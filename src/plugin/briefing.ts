/**
 * The morning finance briefing: what needs attention, written as a task in
 * Paperclip rather than left under a tab. One issue per company, updated in
 * place while anything is open; nothing is created on a quiet day.
 */
import { listBankAccounts, listInvoices, listPaymentMethods, position, type Invoice, type LedgerDb } from '../core/index.js';
import { minorToMajor } from './tools.js';

export interface BriefingItem { severity: 'high' | 'medium' | 'low'; line: string }
export interface Briefing { companyId: string; date: string; items: BriefingItem[]; title: string; body: string; priority: 'high' | 'medium' | 'low' }

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '');

function overdue(inv: Invoice, now: Date): number {
  if (!inv.dueAt || !(inv.status === 'issued' || inv.status === 'part_paid')) return 0;
  return Math.max(0, Math.floor((now.getTime() - Date.parse(inv.dueAt)) / 86_400_000));
}

export async function buildBriefing(db: LedgerDb, companyId: string, now = new Date()): Promise<Briefing | null> {
  const items: BriefingItem[] = [];
  const pos = await position(db, companyId, now);
  const cur = pos.currency ?? '';
  const invoices = await listInvoices(db, companyId, { limit: 500 });
  const open = invoices.filter((i) => i.status === 'issued' || i.status === 'part_paid');

  const payOptions = await listPaymentMethods(db, companyId, { enabledOnly: true });
  if (payOptions.length === 0 && invoices.length > 0) {
    items.push({ severity: open.length > 0 ? 'high' : 'medium', line: `No payment options are set, so invoices go out without a way to pay${open.length > 0 ? ` (${open.length} open invoice(s) affected)` : ''}. A person adds a bank account, Stripe link or wallet under Finance › Settings › Payment options; ask the owner for the details.` });
  }
  if (pos.runwayDays !== null && pos.runwayDays < 60) {
    items.push({ severity: pos.runwayDays < 30 ? 'high' : 'medium', line: `Runway is ${pos.runwayDays} days at the trailing burn of ${minorToMajor(pos.trailing30d.dailyBurnMinor)} ${cur} per day (treasury ${minorToMajor(pos.treasuryMinor)} ${cur}).` });
  }
  const late = open.filter((i) => overdue(i, now) > 0).sort((a, b) => overdue(b, now) - overdue(a, now));
  for (const inv of late) {
    const d = overdue(inv, now);
    const seen = inv.hosted?.openedAt ? `opened ${inv.hosted.openCount} time(s)` : inv.hosted?.sentAt ? 'sent, not opened' : 'never sent';
    items.push({ severity: d > 30 ? 'high' : 'medium', line: `${inv.number} to ${inv.customerName}: ${minorToMajor(inv.outstandingMinor)} ${inv.currency} outstanding, ${d} day(s) overdue (${seen}). Chase it, or write it off if it will not be paid.` });
  }
  const unsent = open.filter((i) => overdue(i, now) === 0 && !i.hosted?.sentAt && i.customerEmail);
  for (const inv of unsent) {
    items.push({ severity: 'low', line: `${inv.number} to ${inv.customerName} (${minorToMajor(inv.outstandingMinor)} ${inv.currency}${inv.dueAt ? `, due ${day(inv.dueAt)}` : ''}) is issued but has not been emailed. Send it with send-invoice.` });
  }
  const drafts = invoices.filter((i) => i.status === 'draft');
  if (drafts.length > 0) items.push({ severity: 'low', line: `${drafts.length} draft invoice(s) waiting to be issued: ${drafts.map((d) => d.number).join(', ')}.` });

  for (const bank of await listBankAccounts(db, companyId)) {
    if (bank.unreconciled > 0) {
      items.push({ severity: bank.unreconciled > 20 ? 'medium' : 'low', line: `${bank.name}: ${bank.unreconciled} statement line(s) not yet reconciled. Run reconcile-all, then decide the rest from reconcile-queue.` });
    }
  }

  if (items.length === 0) return null;
  const rank = { high: 0, medium: 1, low: 2 } as const;
  items.sort((a, b) => rank[a.severity] - rank[b.severity]);
  const date = now.toISOString().slice(0, 10);
  const priority = items[0]!.severity;
  const body = [
    `Position on ${date}: treasury ${minorToMajor(pos.treasuryMinor)} ${cur}, receivables ${minorToMajor(pos.receivablesMinor)} ${cur}, month-to-date net ${minorToMajor(pos.monthToDate.netMinor)} ${cur}${pos.runwayDays === null ? '' : `, runway ${pos.runwayDays} days`}.`,
    '',
    ...items.map((i) => `- ${i.severity === 'high' ? '**' : ''}${i.line}${i.severity === 'high' ? '**' : ''}`),
    '',
    'The ledger tools (ai3.ledger:*) do all of this: invoices, send-invoice, record-payment, write-off-invoice, reconcile-queue, reconcile, reconcile-all, position. Close this task when nothing above is open.',
  ].join('\n');
  return { companyId, date, items, title: `Finance briefing ${date}: ${items.length} item(s)`, body, priority };
}
