/**
 * Reports (M4): profit and loss over a window, balance sheet at a date.
 * Every figure comes from posted entries. The balance sheet must balance at
 * any date asked for (acceptance criterion 7); the report says whether it does
 * rather than assuming it.
 */
import { ACCOUNT, normalSide, type AccountType } from './accounts.js';
import { LedgerError, accountBalances } from './ledger.js';
import { fromMinor, table, toIso, toMinor, type LedgerDb, type Minor } from './sql.js';

export type GroupBy = 'agent' | 'project' | 'goal';

const GROUP_COLUMN: Record<GroupBy, string> = {
  agent: 'subject_agent_ref',
  project: 'subject_project_ref',
  goal: 'subject_goal_ref',
};

export interface PnlLine {
  code: string;
  name: string;
  type: 'income' | 'expense';
  amountMinor: string;
}

export interface PnlGroup {
  key: string | null;
  incomeMinor: string;
  expenseMinor: string;
  netMinor: string;
  lines: PnlLine[];
}

export interface ProfitAndLoss {
  companyId: string;
  currency: string | null;
  from: string;
  to: string;
  groupBy: GroupBy | null;
  incomeMinor: string;
  expenseMinor: string;
  netMinor: string;
  lines: PnlLine[];
  groups: PnlGroup[];
}

interface PnlRow {
  code: string;
  name: string;
  type: 'income' | 'expense';
  currency: string;
  grp: string | null;
  debit: unknown;
  credit: unknown;
}

function signed(type: AccountType, debit: Minor, credit: Minor): Minor {
  return normalSide(type) === 'debit' ? debit - credit : credit - debit;
}

/** Income and expense between two moments, inclusive, optionally split by a subject reference. */
export async function profitAndLoss(
  db: LedgerDb,
  companyId: string,
  window: { from: Date | string; to: Date | string },
  groupBy: GroupBy | null = null,
): Promise<ProfitAndLoss> {
  const from = toIso(window.from);
  const to = toIso(window.to);
  if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) throw new LedgerError('from and to must be dates', 'invalid');
  if (Date.parse(to) < Date.parse(from)) throw new LedgerError('to must not be before from', 'invalid');
  if (groupBy && !(groupBy in GROUP_COLUMN)) throw new LedgerError('groupBy must be agent, project or goal', 'invalid');
  const grpExpr = groupBy ? `e.${GROUP_COLUMN[groupBy]}` : 'NULL::text';

  const rows = await db.sql.query<PnlRow>(
    `SELECT a.code, a.name, a.type, a.currency, ${grpExpr} AS grp,
            COALESCE(SUM(CASE WHEN e.direction = 'debit'  THEN e.amount_minor END), 0) AS debit,
            COALESCE(SUM(CASE WHEN e.direction = 'credit' THEN e.amount_minor END), 0) AS credit
       FROM ${table(db, 'entries')} e
       JOIN ${table(db, 'transactions')} t ON t.id = e.transaction_id
       JOIN ${table(db, 'accounts')} a ON a.id = e.account_id
      WHERE t.company_id = $1 AND t.status = 'posted'
        AND t.occurred_at >= $2::timestamptz AND t.occurred_at <= $3::timestamptz
        AND a.type IN ('income', 'expense')
      GROUP BY a.code, a.name, a.type, a.currency, ${grpExpr}
      ORDER BY ${grpExpr} NULLS FIRST, a.code`,
    [companyId, from, to],
  );

  const totalsByCode = new Map<string, PnlLine & { minor: Minor }>();
  const groups = new Map<string | null, { income: Minor; expense: Minor; lines: Map<string, PnlLine & { minor: Minor }> }>();
  let currency: string | null = null;
  for (const r of rows) {
    currency ??= r.currency;
    const amount = signed(r.type, toMinor(r.debit), toMinor(r.credit));
    const key = groupBy ? r.grp : null;
    const g = groups.get(key) ?? { income: 0n, expense: 0n, lines: new Map() };
    if (r.type === 'income') g.income += amount;
    else g.expense += amount;
    const gl = g.lines.get(r.code) ?? { code: r.code, name: r.name, type: r.type, amountMinor: '0', minor: 0n };
    gl.minor += amount;
    gl.amountMinor = fromMinor(gl.minor);
    g.lines.set(r.code, gl);
    groups.set(key, g);
    const tl = totalsByCode.get(r.code) ?? { code: r.code, name: r.name, type: r.type, amountMinor: '0', minor: 0n };
    tl.minor += amount;
    tl.amountMinor = fromMinor(tl.minor);
    totalsByCode.set(r.code, tl);
  }
  const lines = [...totalsByCode.values()].sort((a, b) => a.code.localeCompare(b.code)).map(({ minor: _m, ...l }) => l);
  const income = lines.filter((l) => l.type === 'income').reduce((s, l) => s + BigInt(l.amountMinor), 0n);
  const expense = lines.filter((l) => l.type === 'expense').reduce((s, l) => s + BigInt(l.amountMinor), 0n);

  return {
    companyId,
    currency,
    from,
    to,
    groupBy,
    incomeMinor: fromMinor(income),
    expenseMinor: fromMinor(expense),
    netMinor: fromMinor(income - expense),
    lines,
    groups: groupBy
      ? [...groups.entries()].map(([key, g]) => ({
          key,
          incomeMinor: fromMinor(g.income),
          expenseMinor: fromMinor(g.expense),
          netMinor: fromMinor(g.income - g.expense),
          lines: [...g.lines.values()].sort((a, b) => a.code.localeCompare(b.code)).map(({ minor: _m, ...l }) => l),
        }))
      : [],
  };
}

export interface BalanceSheetLine {
  code: string;
  name: string;
  balanceMinor: string;
}

export interface BalanceSheet {
  companyId: string;
  currency: string | null;
  asOf: string;
  assets: { lines: BalanceSheetLine[]; totalMinor: string };
  liabilities: { lines: BalanceSheetLine[]; totalMinor: string };
  equity: { lines: BalanceSheetLine[]; retainedEarningsMinor: string; totalMinor: string };
  /** assets == liabilities + equity, where equity includes retained earnings to date */
  balances: boolean;
  differenceMinor: string;
}

/** Balance sheet at a moment (inclusive). Retained earnings is all income less all expense to that moment. */
export async function balanceSheet(db: LedgerDb, companyId: string, asOf: Date | string = new Date()): Promise<BalanceSheet> {
  const at = toIso(asOf);
  if (Number.isNaN(Date.parse(at))) throw new LedgerError('asOf must be a date', 'invalid');
  const rows = await accountBalances(db, companyId, at);
  const pick = (type: AccountType) => rows.filter((r) => r.type === type).map((r) => ({ code: r.code, name: r.name, balanceMinor: fromMinor(r.balanceMinor) }));
  const sum = (lines: BalanceSheetLine[]) => lines.reduce((s, l) => s + BigInt(l.balanceMinor), 0n);

  const assets = pick('asset');
  const liabilities = pick('liability');
  const equity = pick('equity');
  const income = rows.filter((r) => r.type === 'income').reduce((s, r) => s + r.balanceMinor, 0n);
  const expense = rows.filter((r) => r.type === 'expense').reduce((s, r) => s + r.balanceMinor, 0n);
  const retained = income - expense;
  const assetsTotal = sum(assets);
  const liabilitiesTotal = sum(liabilities);
  const equityTotal = sum(equity) + retained;
  const difference = assetsTotal - liabilitiesTotal - equityTotal;

  return {
    companyId,
    currency: rows[0]?.currency ?? null,
    asOf: at,
    assets: { lines: assets, totalMinor: fromMinor(assetsTotal) },
    liabilities: { lines: liabilities, totalMinor: fromMinor(liabilitiesTotal) },
    equity: {
      // The seeded 3900 account only moves at a period close; the current
      // year's result is shown as its own line so the sheet balances live.
      lines: [...equity, { code: `${ACCOUNT.RETAINED_EARNINGS}.current`, name: 'Current earnings (income less expense to date)', balanceMinor: fromMinor(retained) }],
      retainedEarningsMinor: fromMinor(retained),
      totalMinor: fromMinor(equityTotal),
    },
    balances: difference === 0n,
    differenceMinor: fromMinor(difference),
  };
}

// ---------------------------------------------------------------------------
// Trial balance
// ---------------------------------------------------------------------------

export interface TrialBalanceLine {
  code: string;
  name: string;
  type: AccountType;
  /** The account's net balance shown on one side only, as accountants read it. */
  debitMinor: string;
  creditMinor: string;
}

export interface TrialBalanceReport {
  companyId: string;
  currency: string | null;
  asOf: string;
  from: string | null;
  lines: TrialBalanceLine[];
  debitMinor: string;
  creditMinor: string;
  balances: boolean;
  differenceMinor: string;
}

/**
 * Every account with its net balance at a moment, debit balances in one column
 * and credit balances in the other. The two columns must agree; the report says
 * whether they do. Accounts with nothing in them are left out. `from` limits
 * the window (useful for a period's movements rather than balances to date).
 */
export async function trialBalanceReport(db: LedgerDb, companyId: string, asOf: Date | string = new Date(), from?: Date | string): Promise<TrialBalanceReport> {
  const at = toIso(asOf);
  if (Number.isNaN(Date.parse(at))) throw new LedgerError('asOf must be a date', 'invalid');
  const rows = await accountBalances(db, companyId, at, from);
  let debit = 0n;
  let credit = 0n;
  const lines: TrialBalanceLine[] = [];
  for (const r of rows) {
    const net = r.debitMinor - r.creditMinor;
    if (net === 0n) continue;
    if (net > 0n) debit += net;
    else credit += -net;
    lines.push({ code: r.code, name: r.name, type: r.type, debitMinor: fromMinor(net > 0n ? net : 0n), creditMinor: fromMinor(net < 0n ? -net : 0n) });
  }
  return {
    companyId,
    currency: rows[0]?.currency ?? null,
    asOf: at,
    from: from ? toIso(from) : null,
    lines,
    debitMinor: fromMinor(debit),
    creditMinor: fromMinor(credit),
    balances: debit === credit,
    differenceMinor: fromMinor(debit - credit),
  };
}
