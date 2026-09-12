/**
 * Where a transaction came from. The third level of the drill-down: a figure
 * opens its entries, an entry opens its transaction, and the transaction
 * points at the document or event that caused it. Everything the core knows
 * is resolved here; the Paperclip cost event is the one platform-specific
 * lookup and stays behind the adapter in cost-source.ts.
 */
import {
  getInvoice,
  getStatementLine,
  getBankAccount,
  journalForTransaction,
  getBill,
  conversionDateOf,
  table,
  type LedgerDb,
  type TransactionRow,
} from '../core/index.js';
import { costEventDetail, type CostEventDetail } from './cost-source.js';

export type Source =
  | { kind: 'invoice'; invoiceId: string; number: string; customer: string; what: 'issue' | 'payment' | 'write-off' }
  | { kind: 'bill'; billId: string; number: string; supplier: string; what: 'approve' | 'payment' }
  | { kind: 'journal'; journalId: string; number: string; status: string }
  | { kind: 'bank'; lineId: string; bankAccountId: string; bankName: string; description: string }
  | { kind: 'cost'; event: CostEventDetail }
  | { kind: 'conversion'; asOf: string }
  | { kind: 'funding' }
  | { kind: 'reversal' }
  | { kind: 'manual' }
  | { kind: 'unknown' };

export interface BankLink { lineId: string; bankAccountId: string; bankName: string; postedAt: string; description: string; amountMinor: string }

export async function describeSource(db: LedgerDb, companyId: string, tx: TransactionRow): Promise<Source> {
  const ref = tx.sourceRef ?? '';
  try {
    if (tx.sourceKind === 'reversal') return { kind: 'reversal' };
    if (tx.sourceKind === 'funding') return { kind: 'funding' };
    if (tx.sourceKind === 'conversion') return { kind: 'conversion', asOf: conversionDateOf(ref) };
    if (tx.sourceKind === 'journal' || ref.startsWith('journal:')) {
      const j = await journalForTransaction(db, companyId, tx.id);
      if (j) return { kind: 'journal', journalId: j.id, number: j.number, status: j.status };
    }
    if (tx.sourceKind === 'cost_sweep') {
      const ev = await costEventDetail(db.sql, companyId, ref);
      if (ev) return { kind: 'cost', event: ev };
      return { kind: 'unknown' };
    }
    let m: RegExpExecArray | null;
    if ((m = /^(invoice|writeoff):([0-9a-f-]{36})$/i.exec(ref))) {
      const inv = await getInvoice(db, companyId, m[2]!);
      if (inv) return { kind: 'invoice', invoiceId: inv.id, number: inv.number, customer: inv.customerName, what: m[1] === 'invoice' ? 'issue' : 'write-off' };
    }
    if ((m = /^payment:([0-9a-f-]{36}):/i.exec(ref))) {
      const inv = await getInvoice(db, companyId, m[1]!);
      if (inv) return { kind: 'invoice', invoiceId: inv.id, number: inv.number, customer: inv.customerName, what: 'payment' };
    }
    if ((m = /^bill:([0-9a-f-]{36})$/i.exec(ref)) || (m = /^billpay:([0-9a-f-]{36}):/i.exec(ref))) {
      const bill = await getBill(db, companyId, m[1]!);
      if (bill) return { kind: 'bill', billId: bill.id, number: bill.number, supplier: bill.supplierName, what: ref.startsWith('bill:') ? 'approve' : 'payment' };
    }
    if ((m = /^line:([0-9a-f-]{36})$/i.exec(ref))) {
      const line = await getStatementLine(db, companyId, m[1]!);
      if (line) {
        const bank = await getBankAccount(db, companyId, line.bankAccountId);
        return { kind: 'bank', lineId: line.id, bankAccountId: line.bankAccountId, bankName: bank?.name ?? 'Bank account', description: line.payee || line.description };
      }
    }
    if (tx.sourceKind === 'manual') return { kind: 'manual' };
  } catch {
    /* a source that cannot be read is reported as unknown rather than failing the transaction view */
  }
  return { kind: 'unknown' };
}

/** Bank statement lines reconciled against this transaction, whatever created it. */
export async function bankLinksFor(db: LedgerDb, companyId: string, transactionId: string): Promise<BankLink[]> {
  const rows = await db.sql.query<{ line_id: string; bank_account_id: string; name: string; posted_at: string; description: string; payee: string | null; amount_minor: unknown }>(
    `SELECT l.id AS line_id, l.bank_account_id, b.name, l.posted_at::text AS posted_at, l.description, l.payee, l.amount_minor
       FROM ${table(db, 'statement_lines')} l
       JOIN ${table(db, 'bank_accounts')} b ON b.id = l.bank_account_id
      WHERE l.company_id = $1 AND (l.reconciled_transaction_id = $2::uuid OR EXISTS (
              SELECT 1 FROM ${table(db, 'reconciliation_links')} k WHERE k.line_id = l.id AND k.transaction_id = $2::uuid))`,
    [companyId, transactionId],
  );
  return rows.map((r) => ({ lineId: r.line_id, bankAccountId: r.bank_account_id, bankName: r.name, postedAt: r.posted_at, description: r.payee || r.description, amountMinor: String(r.amount_minor) }));
}
