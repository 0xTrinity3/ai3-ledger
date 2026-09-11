/**
 * Position: what the company holds and what it is burning. Every figure is
 * derived from posted entries; nothing here is invented when the ledger is
 * empty (acceptance criterion 9), it is simply zero.
 */
import { ACCOUNT, type AccountType } from './accounts.js';
import { accountBalances, trialBalance, type AccountBalance } from './ledger.js';
import { fromMinor, type LedgerDb, type Minor } from './sql.js';

export interface PositionAccount {
  code: string;
  name: string;
  type: AccountType;
  balanceMinor: string;
}

export interface Position {
  companyId: string;
  currency: string | null;
  asOf: string;
  treasuryMinor: string;
  receivablesMinor: string;
  payablesMinor: string;
  monthToDate: { fromDate: string; incomeMinor: string; expenseMinor: string; netMinor: string };
  trailing30d: { fromDate: string; expenseMinor: string; dailyBurnMinor: string };
  /** Days of treasury left at the trailing-30-day burn. Null when there is no burn. */
  runwayDays: number | null;
  balanceSheet: { assetsMinor: string; liabilitiesMinor: string; equityMinor: string; retainedMinor: string; balances: boolean };
  trial: { debitMinor: string; creditMinor: string; netMinor: string; entryCount: number };
  accounts: PositionAccount[];
}

function sumType(rows: AccountBalance[], type: AccountType): Minor {
  return rows.filter((r) => r.type === type).reduce((acc, r) => acc + r.balanceMinor, 0n);
}

function code(rows: AccountBalance[], c: string): Minor {
  return rows.find((r) => r.code === c)?.balanceMinor ?? 0n;
}

export async function position(db: LedgerDb, companyId: string, now: Date = new Date()): Promise<Position> {
  const asOf = now;
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [all, mtd, trailing, trial] = await Promise.all([
    accountBalances(db, companyId, asOf),
    accountBalances(db, companyId, asOf, monthStart),
    accountBalances(db, companyId, asOf, thirtyDaysAgo),
    trialBalance(db, companyId),
  ]);

  const treasury = code(all, ACCOUNT.TREASURY);
  const income = sumType(mtd, 'income');
  const expense = sumType(mtd, 'expense');
  const trailingExpense = sumType(trailing, 'expense');
  const dailyBurn = trailingExpense / 30n;
  const runwayDays = dailyBurn > 0n ? Number(treasury / dailyBurn) : null;

  const assets = sumType(all, 'asset');
  const liabilities = sumType(all, 'liability');
  const equity = sumType(all, 'equity');
  const retained = sumType(all, 'income') - sumType(all, 'expense');

  return {
    companyId,
    currency: all[0]?.currency ?? null,
    asOf: asOf.toISOString(),
    treasuryMinor: fromMinor(treasury),
    receivablesMinor: fromMinor(code(all, ACCOUNT.RECEIVABLES)),
    payablesMinor: fromMinor(code(all, ACCOUNT.PAYABLES)),
    monthToDate: {
      fromDate: monthStart.toISOString(),
      incomeMinor: fromMinor(income),
      expenseMinor: fromMinor(expense),
      netMinor: fromMinor(income - expense),
    },
    trailing30d: {
      fromDate: thirtyDaysAgo.toISOString(),
      expenseMinor: fromMinor(trailingExpense),
      dailyBurnMinor: fromMinor(dailyBurn),
    },
    runwayDays,
    balanceSheet: {
      assetsMinor: fromMinor(assets),
      liabilitiesMinor: fromMinor(liabilities),
      equityMinor: fromMinor(equity),
      retainedMinor: fromMinor(retained),
      balances: assets === liabilities + equity + retained,
    },
    trial: {
      debitMinor: fromMinor(trial.debitMinor),
      creditMinor: fromMinor(trial.creditMinor),
      netMinor: fromMinor(trial.netMinor),
      entryCount: trial.entryCount,
    },
    accounts: all.map((a) => ({ code: a.code, name: a.name, type: a.type, balanceMinor: fromMinor(a.balanceMinor) })),
  };
}
