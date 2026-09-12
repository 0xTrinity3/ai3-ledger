/**
 * The company summary: the figures a company publishes to ai3.co for the
 * owner's portfolio view and, when it opts in, the public leaderboard.
 *
 * Every figure comes from posted entries and issued invoices in these books.
 * Nothing is estimated here; when the books are empty the numbers are zero
 * and `entryCount` says so, and the reader can label them accordingly.
 * Windows are trailing 30 days ending at `asOf`, plus the 30 days before that
 * so growth can be read without a second call.
 */
import { ACCOUNT } from './accounts.js';
import { listInvoices } from './invoices.js';
import { position } from './position.js';
import { profitAndLoss, type ProfitAndLoss } from './reports.js';
import { fromMinor, table, type LedgerDb } from './sql.js';

export interface SummaryWindow {
  from: string;
  to: string;
  revenueMinor: string;
  expenseMinor: string;
  profitMinor: string;
  /** Account 5000, model inference. */
  modelCostMinor: string;
  /** Accounts 5000 to 5200: what running the agents cost (inference, tools, compute). */
  agentCostMinor: string;
  invoicesIssued: number;
  invoicesPaid: number;
}

export interface CompanySummary {
  version: 1;
  companyId: string;
  currency: string | null;
  asOf: string;
  trailing30d: SummaryWindow;
  prior30d: SummaryWindow;
  treasuryMinor: string;
  receivablesMinor: string;
  payablesMinor: string;
  overdue: { count: number; amountMinor: string };
  dailyBurnMinor: string;
  runwayDays: number | null;
  /** Posted entries in total; zero means the books are empty. */
  entryCount: number;
  /** When something was last posted, or null. */
  lastPostedAt: string | null;
  customers: number;
}

const DAY = 24 * 60 * 60 * 1000;

function sumCodes(p: ProfitAndLoss, codes: string[]): bigint {
  return p.lines.filter((l) => codes.includes(l.code)).reduce((s, l) => s + BigInt(l.amountMinor), 0n);
}

async function window(db: LedgerDb, companyId: string, from: Date, to: Date, invoices: Array<{ status: string; issuedAt: string | null }>, paidAt: Map<string, string>): Promise<SummaryWindow> {
  const p = await profitAndLoss(db, companyId, { from, to });
  const inWindow = (at: string | null | undefined) => Boolean(at) && Date.parse(at!) >= from.getTime() && Date.parse(at!) <= to.getTime();
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    revenueMinor: p.incomeMinor,
    expenseMinor: p.expenseMinor,
    profitMinor: p.netMinor,
    modelCostMinor: fromMinor(sumCodes(p, [ACCOUNT.MODEL_INFERENCE])),
    agentCostMinor: fromMinor(sumCodes(p, [ACCOUNT.MODEL_INFERENCE, ACCOUNT.TOOLS_AND_APIS, ACCOUNT.COMPUTE_AND_SANDBOXES])),
    invoicesIssued: invoices.filter((i) => i.status !== 'draft' && i.status !== 'void' && inWindow(i.issuedAt)).length,
    invoicesPaid: [...paidAt.values()].filter((at) => inWindow(at)).length,
  };
}

export async function companySummary(db: LedgerDb, companyId: string, now: Date = new Date()): Promise<CompanySummary> {
  const to = now;
  const from30 = new Date(now.getTime() - 30 * DAY);
  const from60 = new Date(now.getTime() - 60 * DAY);
  const [pos, invoices, last, customers, paid] = await Promise.all([
    position(db, companyId, now),
    listInvoices(db, companyId, { limit: 500 }),
    db.sql.query<{ at: string | null }>(`SELECT MAX(occurred_at)::text AS at FROM ${table(db, 'transactions')} WHERE company_id = $1 AND status = 'posted'`, [companyId]),
    db.sql.query<{ n: unknown }>(`SELECT COUNT(*) AS n FROM ${table(db, 'customers')} WHERE company_id = $1`, [companyId]),
    // The moment each invoice became fully paid: its last payment.
    db.sql.query<{ invoice_id: string; at: string }>(
      `SELECT p.invoice_id, MAX(p.occurred_at)::text AS at FROM ${table(db, 'invoice_payments')} p JOIN ${table(db, 'invoices')} i ON i.id = p.invoice_id WHERE i.company_id = $1 AND i.status = 'paid' GROUP BY p.invoice_id`,
      [companyId],
    ),
  ]);
  const paidAt = new Map(paid.map((r) => [r.invoice_id, new Date(r.at).toISOString()]));
  const overdue = invoices.filter((i) => (i.status === 'issued' || i.status === 'part_paid') && i.dueAt && Date.parse(i.dueAt) < now.getTime());
  const [trailing30d, prior30d] = await Promise.all([window(db, companyId, from30, to, invoices, paidAt), window(db, companyId, from60, new Date(from30.getTime() - 1), invoices, paidAt)]);
  const lastAt = last[0]?.at ?? null;
  return {
    version: 1,
    companyId,
    currency: pos.currency,
    asOf: now.toISOString(),
    trailing30d,
    prior30d,
    treasuryMinor: pos.treasuryMinor,
    receivablesMinor: pos.receivablesMinor,
    payablesMinor: pos.payablesMinor,
    overdue: { count: overdue.length, amountMinor: fromMinor(overdue.reduce((s, i) => s + BigInt(i.outstandingMinor), 0n)) },
    dailyBurnMinor: pos.trailing30d.dailyBurnMinor,
    runwayDays: pos.runwayDays,
    entryCount: pos.trial.entryCount,
    lastPostedAt: lastAt ? new Date(lastAt).toISOString() : null,
    customers: Number(customers[0]?.n ?? 0),
  };
}
