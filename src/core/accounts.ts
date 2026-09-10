/**
 * The seeded chart of accounts. Codes are stable identifiers the rest of the
 * core refers to; names are display only.
 */
export type AccountType = 'asset' | 'liability' | 'income' | 'expense' | 'equity';

export interface SeedAccount {
  code: string;
  name: string;
  type: AccountType;
}

export const ACCOUNT = {
  TREASURY: '1000',
  RECEIVABLES: '1100',
  PAYABLES: '2000',
  CONTRIBUTED_FUNDS: '3000',
  RETAINED_EARNINGS: '3900',
  SERVICE_INCOME: '4000',
  MODEL_INFERENCE: '5000',
  TOOLS_AND_APIS: '5100',
  COMPUTE_AND_SANDBOXES: '5200',
  OTHER_OPERATING: '5900',
} as const;

export type AccountCode = (typeof ACCOUNT)[keyof typeof ACCOUNT];

export const SEED_ACCOUNTS: readonly SeedAccount[] = [
  { code: ACCOUNT.TREASURY, name: 'Treasury', type: 'asset' },
  { code: ACCOUNT.RECEIVABLES, name: 'Receivables', type: 'asset' },
  { code: ACCOUNT.PAYABLES, name: 'Payables', type: 'liability' },
  { code: ACCOUNT.CONTRIBUTED_FUNDS, name: 'Contributed funds', type: 'equity' },
  { code: ACCOUNT.RETAINED_EARNINGS, name: 'Retained earnings', type: 'equity' },
  { code: ACCOUNT.SERVICE_INCOME, name: 'Service income', type: 'income' },
  { code: ACCOUNT.MODEL_INFERENCE, name: 'Model inference', type: 'expense' },
  { code: ACCOUNT.TOOLS_AND_APIS, name: 'Tools and APIs', type: 'expense' },
  { code: ACCOUNT.COMPUTE_AND_SANDBOXES, name: 'Compute and sandboxes', type: 'expense' },
  { code: ACCOUNT.OTHER_OPERATING, name: 'Other operating', type: 'expense' },
];

/**
 * Which side increases an account's balance. Assets and expenses grow on
 * debit; liabilities, equity and income grow on credit. Used to turn raw
 * debit/credit sums into the signed balances people expect to read.
 */
export function normalSide(type: AccountType): 'debit' | 'credit' {
  return type === 'asset' || type === 'expense' ? 'debit' : 'credit';
}
