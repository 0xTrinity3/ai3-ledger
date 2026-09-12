/**
 * Moving books in from another system.
 *
 * Three files, read the way statements are read (any column order, the
 * reader says how it read them, no mapping wizard):
 *
 *  - a chart of accounts (code, name, type)
 *  - a trial balance as at the conversion date (code, name, debit, credit)
 *  - invoices or bills, one row per line (Xero's export shape, and most others)
 *
 * The conversion date is the rule that keeps this honest. The trial balance
 * posts one `conversion` transaction dated the last instant of the day before
 * it, so a P&L from the conversion date excludes it and a balance sheet at
 * the conversion date includes it. Documents dated before the conversion date
 * are records only: their receivable or payable is already inside the trial
 * balance, so they are issued or approved without posting. Documents dated on
 * or after it post normally. The preview compares the unpaid pre-conversion
 * documents with the control account in the trial balance and shows the
 * difference before anything is written.
 */
import { ACCOUNT, type AccountType } from './accounts.js';
import { approveBill, createBill, findBillByNumber, listBills, payBill, resolveSupplier } from './bills.js';
import { createCustomer, createInvoice, issueInvoice, listCustomers, listInvoices, recordPayment } from './invoices.js';
import { LedgerError, accountBalances, postReversal, postTransaction, type EntryInput } from './ledger.js';
import { getSettings, updateSettings } from './settings.js';
import { detectDateOrder, parseDate, parseMoney, splitCsv, type DateOrder } from './statements.js';
import { fromMinor, newId, table, toMinor, type LedgerDb } from './sql.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDay(value: unknown, label: string): string {
  const s = String(value ?? '').trim();
  if (!DATE_RE.test(s) || new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) !== s) throw new LedgerError(`${label} must be a date like 2026-01-01`, 'invalid');
  return s;
}

/** The last instant of the day before: where opening balances sit. */
export function openingMoment(conversionDate: string): string {
  const d = new Date(`${assertDay(conversionDate, 'conversion date')}T00:00:00.000Z`);
  return new Date(d.getTime() - 1).toISOString();
}

function findCol(headers: string[], re: RegExp): number {
  return headers.findIndex((h) => re.test(h.trim().replace(/^"|"$/g, '')));
}

function headerRow(rows: string[][]): number {
  const i = rows.findIndex((r) => r.filter((c) => c.trim()).length >= 2 && r.every((c) => parseMoney(c) === null || /[A-Za-z]/.test(c)));
  return i < 0 ? 0 : i;
}

// ---------------------------------------------------------------------------
// Account types
// ---------------------------------------------------------------------------

const TYPE_WORDS: Array<[RegExp, AccountType]> = [
  [/\b(bank|cash|receivable|debtors|inventory|stock|prepay|fixed asset|equipment|asset|deposit|wallet|treasury)\b/i, 'asset'],
  [/\b(payable|creditors|loan|tax|vat|gst|accrual|accrued|liabilit|overdraft|credit card|deferred)\b/i, 'liability'],
  [/\b(equity|capital|retained|drawings|owner|share|contributed|reserve)\b/i, 'equity'],
  [/\b(sales|revenue|income|fees|turnover|interest received|gain)\b/i, 'income'],
];

const TYPE_ALIASES: Array<[RegExp, AccountType]> = [
  [/^(bank|current asset|fixed asset|non-current asset|prepayment|inventory|asset|other current asset|other asset|accounts receivable)s?$/i, 'asset'],
  [/^(current liability|liability|non-current liability|credit card|accounts payable|other current liability|long term liability)(ies|s)?$/i, 'liability'],
  [/^(equity|owner'?s equity|capital)$/i, 'equity'],
  [/^(revenue|sales|income|other income|other revenue)$/i, 'income'],
  [/^(expense|expenses|direct costs|cost of goods sold|cogs|overhead|other expense|depreciation)$/i, 'expense'],
];

/** Read a type word from another system, else guess from the code and the name. `guessed` says which. */
export function inferAccountType(input: { code?: string | undefined; name?: string | undefined; type?: string | undefined }): { type: AccountType; guessed: boolean } {
  const t = String(input.type ?? '').trim();
  if (t) {
    for (const [re, type] of TYPE_ALIASES) if (re.test(t)) return { type, guessed: false };
    const lower = t.toLowerCase();
    if (/asset/.test(lower)) return { type: 'asset', guessed: false };
    if (/liab/.test(lower)) return { type: 'liability', guessed: false };
    if (/equity/.test(lower)) return { type: 'equity', guessed: false };
    if (/income|revenue|sales/.test(lower)) return { type: 'income', guessed: false };
    if (/expense|cost/.test(lower)) return { type: 'expense', guessed: false };
  }
  const name = String(input.name ?? '');
  for (const [re, type] of TYPE_WORDS) if (re.test(name)) return { type, guessed: true };
  const code = String(input.code ?? '').trim();
  if (/^\d{4}$/.test(code)) {
    const d = code[0];
    if (d === '1') return { type: 'asset', guessed: true };
    if (d === '2') return { type: 'liability', guessed: true };
    if (d === '3') return { type: 'equity', guessed: true };
    if (d === '4') return { type: 'income', guessed: true };
  }
  return { type: 'expense', guessed: true };
}

// ---------------------------------------------------------------------------
// Chart of accounts and trial balance files
// ---------------------------------------------------------------------------

export interface ChartLine { code: string; name: string; type: AccountType; guessed: boolean }
export interface ParsedChart { lines: ChartLine[]; reading: string; warnings: string[] }

const CH = {
  code: /^(code|account code|account number|account no\.?|acct|number|no\.?|gl code|gl account)$/i,
  name: /^(name|account name|account|description|title)$/i,
  type: /^(type|account type|class|classification|category|report type)$/i,
  debit: /^(debit|dr|debits|debit amount|debit \(?[a-z]{3}\)?)$/i,
  credit: /^(credit|cr|credits|credit amount|credit \(?[a-z]{3}\)?)$/i,
  balance: /^(balance|amount|net|closing balance|ytd|ytd balance|total|net amount|balance \(?[a-z]{3}\)?)$/i,
};

export function parseChartCsv(text: string): ParsedChart {
  const rows = splitCsv(text);
  if (rows.length < 2) throw new LedgerError('The file has no rows to read', 'invalid');
  const hi = headerRow(rows);
  const headers = rows[hi]!.map((h) => h.trim().replace(/^"|"$/g, ''));
  const codeCol = findCol(headers, CH.code);
  const nameCol = findCol(headers, CH.name);
  const typeCol = findCol(headers, CH.type);
  if (codeCol < 0 || nameCol < 0) throw new LedgerError(`Need a code column and a name column; found: ${headers.join(', ')}`, 'invalid');
  const lines: ChartLine[] = [];
  const warnings: string[] = [];
  let guessed = 0;
  for (const r of rows.slice(hi + 1)) {
    const code = String(r[codeCol] ?? '').trim();
    const name = String(r[nameCol] ?? '').trim();
    if (!code || !name) continue;
    const t = inferAccountType({ code, name, type: typeCol >= 0 ? r[typeCol] : undefined });
    if (t.guessed) guessed++;
    lines.push({ code, name, type: t.type, guessed: t.guessed });
  }
  if (lines.length === 0) throw new LedgerError('No account rows found', 'invalid');
  if (guessed > 0) warnings.push(`${guessed} account type${guessed === 1 ? '' : 's'} guessed from the name or code; check them before importing`);
  return { lines, reading: `code from "${headers[codeCol]}", name from "${headers[nameCol]}"${typeCol >= 0 ? `, type from "${headers[typeCol]}"` : ', type guessed'}`, warnings };
}

export interface TrialBalanceInputLine { code: string; name: string; type: AccountType; guessed: boolean; debitMinor: string; creditMinor: string }
export interface ParsedTrialBalance { lines: TrialBalanceInputLine[]; debitMinor: string; creditMinor: string; balances: boolean; differenceMinor: string; reading: string; warnings: string[] }

export function parseTrialBalanceCsv(text: string): ParsedTrialBalance {
  const rows = splitCsv(text);
  if (rows.length < 2) throw new LedgerError('The file has no rows to read', 'invalid');
  const hi = headerRow(rows);
  const headers = rows[hi]!.map((h) => h.trim().replace(/^"|"$/g, ''));
  let codeCol = findCol(headers, CH.code);
  let nameCol = findCol(headers, CH.name);
  const typeCol = findCol(headers, CH.type);
  const debitCol = findCol(headers, CH.debit);
  const creditCol = findCol(headers, CH.credit);
  const balCol = findCol(headers, CH.balance);
  if (debitCol < 0 && creditCol < 0 && balCol < 0) throw new LedgerError(`Need debit and credit columns, or one balance column; found: ${headers.join(', ')}`, 'invalid');
  // Xero's trial balance has one "Account" column like "200 - Sales"; split code and name from it.
  const combined = codeCol < 0 && nameCol >= 0;
  if (codeCol < 0 && nameCol < 0) {
    nameCol = headers.findIndex((_, i) => i !== debitCol && i !== creditCol && i !== balCol);
    if (nameCol < 0) throw new LedgerError('No account column found', 'invalid');
    codeCol = -1;
  }
  const lines: TrialBalanceInputLine[] = [];
  const warnings: string[] = [];
  let debitTotal = 0n;
  let creditTotal = 0n;
  let guessed = 0;
  let skipped = 0;
  for (const r of rows.slice(hi + 1)) {
    let code = codeCol >= 0 ? String(r[codeCol] ?? '').trim() : '';
    let name = nameCol >= 0 ? String(r[nameCol] ?? '').trim() : '';
    if (combined || (!code && name)) {
      const m = /^(\d[\w.-]*)\s*[-–:]\s*(.+)$/.exec(name) ?? /^(\d[\w.-]*)\s+(.+)$/.exec(name);
      if (m) { code = code || m[1]!; name = m[2]!.trim(); }
    }
    if (!name && !code) continue;
    if (/^total\b/i.test(name) || /^total\b/i.test(code)) continue;
    let debit = 0n;
    let credit = 0n;
    if (debitCol >= 0 || creditCol >= 0) {
      const d = debitCol >= 0 ? parseMoney(r[debitCol] ?? '') : null;
      const c = creditCol >= 0 ? parseMoney(r[creditCol] ?? '') : null;
      debit = d ?? 0n;
      credit = c ?? 0n;
      if (debit < 0n) { credit += -debit; debit = 0n; }
      if (credit < 0n) { debit += -credit; credit = 0n; }
    } else {
      const b = parseMoney(r[balCol] ?? '');
      if (b === null) { skipped++; continue; }
      if (b >= 0n) debit = b; else credit = -b;
    }
    if (debit === 0n && credit === 0n) continue;
    if (!code) { warnings.push(`"${name}" has no account code; give it one before importing`); }
    const t = inferAccountType({ code, name, type: typeCol >= 0 ? r[typeCol] : undefined });
    if (t.guessed) guessed++;
    // A balance on the wrong side for its type is legitimate (an overdrawn bank, a debit tax balance); keep it as read.
    debitTotal += debit;
    creditTotal += credit;
    lines.push({ code, name: name || code, type: t.type, guessed: t.guessed, debitMinor: fromMinor(debit), creditMinor: fromMinor(credit) });
  }
  if (lines.length === 0) throw new LedgerError('No account rows with a balance found', 'invalid');
  if (skipped > 0) warnings.push(`${skipped} row${skipped === 1 ? '' : 's'} skipped: no amount`);
  if (guessed > 0) warnings.push(`${guessed} account type${guessed === 1 ? '' : 's'} guessed from the name or code; check them before importing`);
  const diff = debitTotal - creditTotal;
  if (diff !== 0n) warnings.push(`The trial balance does not balance: debits ${fromMinor(debitTotal)} vs credits ${fromMinor(creditTotal)}`);
  const reading = [
    codeCol >= 0 ? `code from "${headers[codeCol]}"` : 'code split from the account column',
    `name from "${headers[nameCol]}"`,
    debitCol >= 0 || creditCol >= 0 ? `debit from "${headers[debitCol] ?? ''}", credit from "${headers[creditCol] ?? ''}"` : `balance from "${headers[balCol]}" (positive is debit)`,
    typeCol >= 0 ? `type from "${headers[typeCol]}"` : 'type from the chart, else guessed',
  ].join('; ');
  return { lines, debitMinor: fromMinor(debitTotal), creditMinor: fromMinor(creditTotal), balances: diff === 0n, differenceMinor: fromMinor(diff), reading, warnings };
}

// ---------------------------------------------------------------------------
// Chart and trial balance into the books
// ---------------------------------------------------------------------------

/** Add accounts that do not exist yet. Existing codes are left alone (their type is not changed). */
export async function importChart(db: LedgerDb, companyId: string, lines: Array<{ code: string; name: string; type: AccountType }>): Promise<{ added: number; existing: number }> {
  const settings = await getSettings(db, companyId);
  let added = 0;
  let existing = 0;
  for (const l of lines) {
    const code = String(l.code ?? '').trim();
    const name = String(l.name ?? '').trim().slice(0, 200);
    if (!code || !name) throw new LedgerError('every account needs a code and a name', 'invalid');
    if (!['asset', 'liability', 'equity', 'income', 'expense'].includes(l.type)) throw new LedgerError(`account ${code} has no valid type`, 'invalid');
    const r = await db.sql.execute(
      `INSERT INTO ${table(db, 'accounts')} (company_id, code, name, type, currency, is_system) VALUES ($1, $2, $3, $4, $5, false) ON CONFLICT (company_id, code) DO NOTHING`,
      [companyId, code, name, l.type, settings.baseCurrency],
    );
    if (r.rowCount === 1) added++; else existing++;
  }
  return { added, existing };
}

export interface TrialBalanceImportResult { transactionId: string; conversionDate: string; postedAt: string; accountsAdded: number; lines: number; plugMinor: string }

/**
 * Post the opening balances. Refuses an unbalanced file unless `plugToRetainedEarnings`
 * is set, in which case the difference goes to 3900. Only one conversion may stand at
 * a time; undo the earlier one first.
 */
export async function importTrialBalance(
  db: LedgerDb,
  companyId: string,
  input: { conversionDate: string; lines: Array<{ code: string; name?: string; type?: AccountType; debitMinor: string | number | bigint; creditMinor: string | number | bigint }>; createdBy?: string; plugToRetainedEarnings?: boolean },
): Promise<TrialBalanceImportResult> {
  const date = assertDay(input.conversionDate, 'conversion date');
  const settings = await getSettings(db, companyId);
  const standing = await standingConversion(db, companyId);
  if (standing) throw new LedgerError(`opening balances were already imported as at ${standing.asOf}; undo that import first`, 'invalid');
  const lines = input.lines.map((l) => ({ code: String(l.code ?? '').trim(), name: String(l.name ?? '').trim(), type: l.type, debit: toMinor(l.debitMinor), credit: toMinor(l.creditMinor) })).filter((l) => l.debit !== 0n || l.credit !== 0n);
  if (lines.length === 0) throw new LedgerError('nothing to import', 'invalid');
  for (const l of lines) {
    if (!l.code) throw new LedgerError(`"${l.name || '(unnamed)'}" has no account code`, 'invalid');
    if (l.debit < 0n || l.credit < 0n) throw new LedgerError(`account ${l.code} has a negative amount; put it on the other side`, 'invalid');
  }
  const debit = lines.reduce((s, l) => s + l.debit, 0n);
  const credit = lines.reduce((s, l) => s + l.credit, 0n);
  const diff = debit - credit;
  if (diff !== 0n && !input.plugToRetainedEarnings) throw new LedgerError(`the trial balance does not balance: debits ${fromMinor(debit)} vs credits ${fromMinor(credit)} (difference ${fromMinor(diff)})`, 'unbalanced');
  // Accounts first: existing ones by code, new ones with the type given or inferred.
  const existing = await accountBalances(db, companyId);
  const known = new Map(existing.map((a) => [a.code, a]));
  let added = 0;
  for (const l of lines) {
    if (known.has(l.code)) continue;
    const type = l.type ?? inferAccountType({ code: l.code, name: l.name }).type;
    const r = await importChart(db, companyId, [{ code: l.code, name: l.name || l.code, type }]);
    added += r.added;
  }
  const entries: EntryInput[] = [];
  for (const l of lines) {
    if (l.debit > 0n) entries.push({ accountCode: l.code, direction: 'debit', amountMinor: l.debit });
    if (l.credit > 0n) entries.push({ accountCode: l.code, direction: 'credit', amountMinor: l.credit });
  }
  if (diff > 0n) entries.push({ accountCode: ACCOUNT.RETAINED_EARNINGS, direction: 'credit', amountMinor: diff });
  if (diff < 0n) entries.push({ accountCode: ACCOUNT.RETAINED_EARNINGS, direction: 'debit', amountMinor: -diff });
  const postedAt = openingMoment(date);
  const r = await postTransaction(db, {
    companyId,
    occurredAt: postedAt,
    description: `Opening balances as at ${date}`,
    sourcePlatform: 'manual',
    sourceKind: 'conversion',
    // A nonce, so an undone import can be repeated for the same date.
    sourceRef: `conversion:${date}#${newId().slice(0, 8)}`,
    currency: settings.baseCurrency,
    createdBy: input.createdBy ?? 'board',
    entries,
  });
  await updateSettings(db, companyId, { conversionDate: date });
  return { transactionId: r.transactionId, conversionDate: date, postedAt, accountsAdded: added, lines: lines.length, plugMinor: fromMinor(diff) };
}

/** The posted opening-balance transaction that has not been reversed, if any. */
export async function standingConversion(db: LedgerDb, companyId: string): Promise<{ transactionId: string; asOf: string; occurredAt: string } | null> {
  const rows = await db.sql.query<{ id: string; source_ref: string; occurred_at: string }>(
    `SELECT t.id, t.source_ref, t.occurred_at::text AS occurred_at
       FROM ${table(db, 'transactions')} t
      WHERE t.company_id = $1 AND t.source_kind = 'conversion' AND t.status = 'posted'
        AND NOT EXISTS (SELECT 1 FROM ${table(db, 'transactions')} r WHERE r.reverses_id = t.id AND r.status = 'posted')
      ORDER BY t.created_at DESC LIMIT 1`,
    [companyId],
  );
  const r = rows[0];
  if (!r) return null;
  return { transactionId: r.id, asOf: conversionDateOf(r.source_ref), occurredAt: r.occurred_at };
}

/** "conversion:2026-01-01#ab12cd34" → "2026-01-01". */
export function conversionDateOf(sourceRef: string | null): string {
  return String(sourceRef ?? '').replace(/^conversion:/, '').split('#')[0] ?? '';
}

/** Reverse the standing opening balances so they can be imported again. */
export async function undoTrialBalance(db: LedgerDb, companyId: string, opts: { createdBy?: string } = {}): Promise<{ reversalId: string } | null> {
  const standing = await standingConversion(db, companyId);
  if (!standing) return null;
  const r = await postReversal(db, companyId, standing.transactionId, { occurredAt: standing.occurredAt, description: `Undo opening balances as at ${standing.asOf}`, createdBy: opts.createdBy ?? 'board' });
  return { reversalId: r.transactionId };
}

// ---------------------------------------------------------------------------
// Invoices and bills, one row per line
// ---------------------------------------------------------------------------

export interface ParsedDocLine { description: string; quantity: string; unitAmountMinor: string; taxMinor: string; accountCode: string | null }
export interface ParsedDoc {
  number: string;
  contact: string;
  email: string | null;
  date: string | null; // ISO
  dueDate: string | null;
  currency: string | null;
  reference: string | null;
  status: string | null;
  paidMinor: string | null;
  lines: ParsedDocLine[];
  subtotalMinor: string;
  taxMinor: string;
  totalMinor: string;
}
export interface ParsedDocs { kind: 'invoice' | 'bill'; docs: ParsedDoc[]; reading: string; warnings: string[] }

const DH = {
  contact: /^(contact ?name|contact|customer|customer name|client|client name|supplier|supplier name|vendor|vendor name|name|company|payee|bill to|from)$/i,
  email: /^(email|email ?address|contact email|e-mail)$/i,
  number: /^(invoice ?number|invoice ?no\.?|invoice ?#|number|bill ?number|bill ?no\.?|reference number|doc(ument)? ?number|num|no\.?|id|transaction number)$/i,
  date: /^(invoice ?date|date|bill ?date|issue ?date|issued|transaction date|txn date)$/i,
  due: /^(due ?date|due|payment due|date due)$/i,
  description: /^(description|item|details|line description|item description|memo|product|service|line item)$/i,
  quantity: /^(quantity|qty|units|hours)$/i,
  unit: /^(unit ?amount|unit ?price|price|rate|unit cost|amount each)$/i,
  amount: /^(line ?amount|amount|line ?total|total|net|net amount|subtotal|amount \(?[a-z]{3}\)?|total amount)$/i,
  tax: /^(tax ?amount|tax|vat|vat amount|gst|gst amount|sales tax)$/i,
  account: /^(account ?code|account|gl code|gl account|ledger account|nominal code|category)$/i,
  currency: /^(currency|currency code|curr)$/i,
  reference: /^(reference|ref|po|po ?number|purchase order|order number|your ref|customer ref)$/i,
  status: /^(status|state|invoice status|bill status)$/i,
  paid: /^(amount ?paid|paid|paid amount|payments|received|amount received)$/i,
  amountDue: /^(amount ?due|due amount|outstanding|balance|balance due|owing)$/i,
};

function iso(day: string | null): string | null {
  return day ? day : null;
}

export function parseDocumentsCsv(text: string, kind: 'invoice' | 'bill', opts: { dateOrder?: DateOrder } = {}): ParsedDocs {
  const rows = splitCsv(text);
  if (rows.length < 2) throw new LedgerError('The file has no rows to read', 'invalid');
  const hi = headerRow(rows);
  const headers = rows[hi]!.map((h) => h.trim().replace(/^"|"$/g, ''));
  const body = rows.slice(hi + 1);
  const col = (re: RegExp) => findCol(headers, re);
  const contactCol = col(DH.contact);
  const emailCol = col(DH.email);
  const numberCol = col(DH.number);
  const dateCol = col(DH.date);
  const dueCol = col(DH.due);
  const descCol = col(DH.description);
  const qtyCol = col(DH.quantity);
  const unitCol = col(DH.unit);
  const amountCol = col(DH.amount);
  const taxCol = col(DH.tax);
  const accountCol = col(DH.account);
  const currencyCol = col(DH.currency);
  const refCol = col(DH.reference);
  const statusCol = col(DH.status);
  const paidCol = col(DH.paid);
  const dueAmtCol = col(DH.amountDue);
  if (contactCol < 0) throw new LedgerError(`No ${kind === 'invoice' ? 'customer' : 'supplier'} column found among: ${headers.join(', ')}`, 'invalid');
  if (dateCol < 0) throw new LedgerError(`No date column found among: ${headers.join(', ')}`, 'invalid');
  if (unitCol < 0 && amountCol < 0) throw new LedgerError(`No amount column found among: ${headers.join(', ')}`, 'invalid');
  const order = opts.dateOrder ?? detectDateOrder(body.map((r) => r[dateCol] ?? ''));
  const warnings: string[] = [];
  const docs = new Map<string, ParsedDoc>();
  let skipped = 0;
  let anon = 0;
  for (const r of body) {
    const contact = String(r[contactCol] ?? '').trim();
    if (!contact) { skipped++; continue; }
    const number = numberCol >= 0 ? String(r[numberCol] ?? '').trim() : '';
    const key = number || `${contact}|${r[dateCol]}|${++anon}`;
    const date = iso(parseDate(String(r[dateCol] ?? ''), order));
    const unit = unitCol >= 0 ? parseMoney(r[unitCol] ?? '') : null;
    const qtyRaw = qtyCol >= 0 ? Number(String(r[qtyCol] ?? '').replace(/,/g, '')) : NaN;
    const qty = Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : 1;
    const lineAmount = amountCol >= 0 ? parseMoney(r[amountCol] ?? '') : null;
    const tax = taxCol >= 0 ? parseMoney(r[taxCol] ?? '') ?? 0n : 0n;
    let unitMinor: bigint | null = unit;
    if (unitMinor === null && lineAmount !== null) unitMinor = qty === 1 ? lineAmount : (lineAmount * 10_000n + BigInt(Math.round(qty * 10_000)) / 2n) / BigInt(Math.round(qty * 10_000));
    if (unitMinor === null || unitMinor === 0n || !date) { skipped++; continue; }
    const description = (descCol >= 0 ? String(r[descCol] ?? '').trim() : '') || `${kind === 'invoice' ? 'Invoice' : 'Bill'} ${number || ''}`.trim();
    const account = accountCol >= 0 ? String(r[accountCol] ?? '').trim().split(/\s+[-–:]\s+/)[0] || null : null;
    let doc = docs.get(key);
    if (!doc) {
      doc = {
        number,
        contact,
        email: emailCol >= 0 ? String(r[emailCol] ?? '').trim() || null : null,
        date,
        dueDate: dueCol >= 0 ? iso(parseDate(String(r[dueCol] ?? ''), order)) : null,
        currency: currencyCol >= 0 ? String(r[currencyCol] ?? '').trim().toUpperCase() || null : null,
        reference: refCol >= 0 ? String(r[refCol] ?? '').trim() || null : null,
        status: statusCol >= 0 ? String(r[statusCol] ?? '').trim().toLowerCase() || null : null,
        paidMinor: paidCol >= 0 ? (parseMoney(r[paidCol] ?? '') === null ? null : fromMinor(parseMoney(r[paidCol] ?? '')!)) : null,
        lines: [],
        subtotalMinor: '0',
        taxMinor: '0',
        totalMinor: '0',
      };
      if (doc.paidMinor === null && dueAmtCol >= 0) {
        const due = parseMoney(r[dueAmtCol] ?? '');
        if (due !== null) doc.paidMinor = `due:${fromMinor(due)}`; // resolved once the total is known
      }
      docs.set(key, doc);
    }
    const abs = unitMinor < 0n ? -unitMinor : unitMinor;
    doc.lines.push({ description, quantity: String(qty), unitAmountMinor: fromMinor(abs), taxMinor: fromMinor(tax < 0n ? -tax : tax), accountCode: account });
  }
  const out: ParsedDoc[] = [];
  for (const d of docs.values()) {
    const subtotal = d.lines.reduce((s, l) => s + (BigInt(l.unitAmountMinor) * BigInt(Math.round(Number(l.quantity) * 10_000)) + 5_000n) / 10_000n, 0n);
    const tax = d.lines.reduce((s, l) => s + BigInt(l.taxMinor), 0n);
    d.subtotalMinor = fromMinor(subtotal);
    d.taxMinor = fromMinor(tax);
    d.totalMinor = fromMinor(subtotal + tax);
    if (d.paidMinor?.startsWith('due:')) {
      const due = BigInt(d.paidMinor.slice(4));
      d.paidMinor = fromMinor(subtotal + tax - due < 0n ? 0n : subtotal + tax - due);
    }
    if (d.paidMinor === null && d.status && /^(paid|closed|settled)$/.test(d.status)) d.paidMinor = d.totalMinor;
    if (d.paidMinor === null && d.status && /^(authorised|authorized|awaiting payment|open|unpaid|approved|issued|sent|overdue)$/.test(d.status)) d.paidMinor = '0';
    if (!d.number) warnings.push(`${d.contact} on ${d.date?.slice(0, 10)} has no number; one will be assigned`);
    out.push(d);
  }
  if (out.length === 0) throw new LedgerError('No rows had a contact, a date and an amount', 'invalid');
  if (skipped > 0) warnings.push(`${skipped} row${skipped === 1 ? '' : 's'} skipped: no contact, date or amount`);
  const voided = out.filter((d) => d.status && /^(void|voided|deleted|draft)$/.test(d.status)).length;
  if (voided > 0) warnings.push(`${voided} void, deleted or draft document${voided === 1 ? '' : 's'} will be skipped`);
  const reading = [
    `${kind === 'invoice' ? 'customer' : 'supplier'} from "${headers[contactCol]}"`,
    numberCol >= 0 ? `number from "${headers[numberCol]}"` : 'no number column',
    `date from "${headers[dateCol]}" (${order === 'dmy' ? 'day-month-year' : order === 'mdy' ? 'month-day-year' : 'year-month-day'})`,
    unitCol >= 0 ? `unit price from "${headers[unitCol]}"` : `amount from "${headers[amountCol]}"`,
    taxCol >= 0 ? `tax from "${headers[taxCol]}"` : 'no tax column',
    accountCol >= 0 ? `account from "${headers[accountCol]}"` : 'no account column',
    paidCol >= 0 ? `paid from "${headers[paidCol]}"` : dueAmtCol >= 0 ? `paid worked out from "${headers[dueAmtCol]}"` : statusCol >= 0 ? `paid from "${headers[statusCol]}"` : 'nothing marked paid',
  ].join('; ');
  return { kind, docs: out, reading, warnings };
}

// ---------------------------------------------------------------------------
// Preview and import of documents under the conversion rule
// ---------------------------------------------------------------------------

export interface DocPreviewRow {
  number: string;
  contact: string;
  date: string | null;
  totalMinor: string;
  paidMinor: string;
  outstandingMinor: string;
  currency: string;
  preConversion: boolean;
  duplicate: boolean;
  skip: string | null;
  unknownAccounts: string[];
  lines: number;
}

export interface DocPreview {
  kind: 'invoice' | 'bill';
  conversionDate: string | null;
  rows: DocPreviewRow[];
  toImport: number;
  duplicates: number;
  skipped: number;
  preConversionOutstandingMinor: string;
  /** The control account (1100 or 2000) as at the conversion date. Null when there is no conversion. */
  controlMinor: string | null;
  differenceMinor: string | null;
  postConversionTotalMinor: string;
  currency: string;
}

function isPre(date: string | null, conversion: string | null): boolean {
  return Boolean(date && conversion && date.slice(0, 10) < conversion);
}

function paidOf(d: ParsedDoc): bigint {
  const total = BigInt(d.totalMinor);
  const p = d.paidMinor === null ? 0n : BigInt(d.paidMinor);
  return p > total ? total : p < 0n ? 0n : p;
}

export async function previewDocuments(db: LedgerDb, companyId: string, parsed: ParsedDocs, opts: { conversionDate?: string | null } = {}): Promise<DocPreview> {
  const settings = await getSettings(db, companyId);
  const conversion = opts.conversionDate ? assertDay(opts.conversionDate, 'conversion date') : settings.conversionDate;
  const existingNumbers = new Set(
    parsed.kind === 'invoice' ? (await listInvoices(db, companyId, { limit: 500 })).map((i) => i.number.toUpperCase()) : (await listBills(db, companyId, { limit: 1000 })).map((b) => b.number.toUpperCase()),
  );
  const accounts = new Set((await accountBalances(db, companyId)).map((a) => a.code));
  const rows: DocPreviewRow[] = [];
  let preOutstanding = 0n;
  let postTotal = 0n;
  for (const d of parsed.docs) {
    const dup = Boolean(d.number) && existingNumbers.has(d.number.toUpperCase());
    const pre = isPre(d.date, conversion);
    const paid = paidOf(d);
    const outstanding = BigInt(d.totalMinor) - paid;
    const unknown = [...new Set(d.lines.map((l) => l.accountCode).filter((c): c is string => Boolean(c) && !accounts.has(c!)))];
    const skip = d.status && /^(void|voided|deleted|draft)$/.test(d.status) ? `status ${d.status}` : dup ? 'already in the books' : BigInt(d.totalMinor) <= 0n ? 'no amount' : null;
    if (!skip) {
      if (pre) preOutstanding += outstanding;
      else postTotal += BigInt(d.totalMinor);
    }
    rows.push({ number: d.number, contact: d.contact, date: d.date ? d.date.slice(0, 10) : null, totalMinor: d.totalMinor, paidMinor: fromMinor(paid), outstandingMinor: fromMinor(outstanding), currency: d.currency ?? settings.baseCurrency, preConversion: pre, duplicate: dup, skip, unknownAccounts: unknown, lines: d.lines.length });
  }
  let control: bigint | null = null;
  if (conversion) {
    const bal = await accountBalances(db, companyId, openingMoment(conversion));
    control = bal.find((a) => a.code === (parsed.kind === 'invoice' ? ACCOUNT.RECEIVABLES : ACCOUNT.PAYABLES))?.balanceMinor ?? 0n;
  }
  return {
    kind: parsed.kind,
    conversionDate: conversion,
    rows,
    toImport: rows.filter((r) => !r.skip).length,
    duplicates: rows.filter((r) => r.duplicate).length,
    skipped: rows.filter((r) => Boolean(r.skip)).length,
    preConversionOutstandingMinor: fromMinor(preOutstanding),
    controlMinor: control === null ? null : fromMinor(control),
    differenceMinor: control === null ? null : fromMinor(preOutstanding - control),
    postConversionTotalMinor: fromMinor(postTotal),
    currency: settings.baseCurrency,
  };
}

export interface DocImportResult { created: number; skipped: number; failed: Array<{ number: string; contact: string; error: string }>; numbers: string[] }

/**
 * Write the documents. Pre-conversion ones become records (issued or approved
 * without posting, opening paid set); the rest are issued or approved on their
 * date, and anything marked paid is paid on that date from the cash account.
 */
export async function importDocuments(
  db: LedgerDb,
  companyId: string,
  parsed: ParsedDocs,
  opts: { conversionDate?: string | null; cashAccountCode?: string | null; createdBy?: string; defaultAccountCode?: string | null; rateToBase?: Record<string, string> } = {},
): Promise<DocImportResult> {
  const settings = await getSettings(db, companyId);
  const conversion = opts.conversionDate ? assertDay(opts.conversionDate, 'conversion date') : settings.conversionDate;
  const preview = await previewDocuments(db, companyId, parsed, { conversionDate: conversion });
  const by = opts.createdBy ?? 'import';
  const result: DocImportResult = { created: 0, skipped: 0, failed: [], numbers: [] };
  const customers = parsed.kind === 'invoice' ? new Map((await listCustomers(db, companyId)).map((c) => [c.name.toLowerCase(), c])) : null;
  for (let i = 0; i < parsed.docs.length; i++) {
    const d = parsed.docs[i]!;
    const row = preview.rows[i]!;
    if (row.skip) { result.skipped++; continue; }
    try {
      const pre = row.preConversion;
      const paid = paidOf(d);
      const currency = d.currency ?? settings.baseCurrency;
      const rate = currency === settings.baseCurrency ? null : opts.rateToBase?.[currency] ?? null;
      if (currency !== settings.baseCurrency && !rate) throw new LedgerError(`no exchange rate given for ${currency}`, 'invalid');
      const lines = d.lines.map((l) => ({ description: l.description, quantity: l.quantity, unitAmountMinor: l.unitAmountMinor, taxMinor: l.taxMinor, accountCode: l.accountCode ?? (parsed.kind === 'bill' ? opts.defaultAccountCode ?? null : null) }));
      const when = d.date!;
      if (parsed.kind === 'invoice') {
        let customer = customers!.get(d.contact.toLowerCase());
        if (!customer) {
          customer = await createCustomer(db, companyId, { name: d.contact, email: d.email });
          customers!.set(d.contact.toLowerCase(), customer);
        }
        const inv = await createInvoice(db, companyId, {
          customerId: customer.id, currency, rateToBase: rate, lines, dueAt: d.dueDate, notes: null, createdBy: by,
          number: d.number || null, reference: d.reference, conversion: pre, openingPaidMinor: pre ? fromMinor(paid) : null, paymentMethodIds: [],
        });
        await issueInvoice(db, companyId, inv.id, { issuedAt: when, createdBy: by });
        if (!pre && paid > 0n) await recordPayment(db, companyId, inv.id, { amountMinor: paid, occurredAt: when, reference: `import:${inv.number}`, createdBy: by, ...(opts.cashAccountCode ? { cashAccountCode: opts.cashAccountCode } : {}) });
        result.numbers.push(inv.number);
      } else {
        const supplier = await resolveSupplier(db, companyId, d.contact, { create: true, email: d.email });
        if (!supplier) throw new LedgerError('supplier could not be created', 'invalid');
        if (d.number && (await findBillByNumber(db, companyId, d.number))) throw new LedgerError(`bill ${d.number} already exists`, 'invalid');
        const bill = await createBill(db, companyId, {
          supplierId: supplier.id, currency, rateToBase: rate, lines, issuedAt: when, dueAt: d.dueDate, reference: d.reference, createdBy: by,
          number: d.number || null, conversion: pre, openingPaidMinor: pre ? fromMinor(paid) : null,
        });
        await approveBill(db, companyId, bill.id, { approvedAt: when, createdBy: by });
        if (!pre && paid > 0n) await payBill(db, companyId, bill.id, { amountMinor: paid, occurredAt: when, reference: `import:${bill.number}`, createdBy: by, cashAccountCode: opts.cashAccountCode ?? null });
        result.numbers.push(bill.number);
      }
      result.created++;
    } catch (err) {
      result.failed.push({ number: d.number, contact: d.contact, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

