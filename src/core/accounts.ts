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

/**
 * The roles the core posts to, as tokens rather than codes.
 *
 * A code is a company's own vocabulary. Until now the core hard-coded one
 * chart's numbers — receivables *were* 1100 — so changing the default chart
 * would have silently repointed every future posting of every existing company
 * at whatever else now sat on that number. Receivables at 1100 in one company
 * and 1200 in another is an ordinary fact about charts of accounts, and the
 * ledger has to be able to hold both at once.
 *
 * So these are roles. `resolveCode` turns one into the code *that company*
 * uses, at the point of posting and at the point of reading, and a code that
 * is not a role passes through untouched.
 */
export const ACCOUNT = {
  TREASURY: '@treasury',
  /** What a stream has earned and not yet settled, on either side of it. */
  ACCRUED_SERVICES_RECEIVABLE: '@accruedServicesReceivable',
  ACCRUED_STREAMS_PAYABLE: '@accruedStreamsPayable',
  /** Money held for somebody who has not spent it yet — a prepaid balance. */
  CUSTOMER_CREDITS: '@customerCredits',
  /** Collected on somebody else's behalf, and owed on to them. */
  PROVIDER_PAYABLE: '@providerPayable',
  /** Ours out of what we collected, when we are the marketplace and not the provider. */
  COMMISSION_REVENUE: '@commissionRevenue',
  RECEIVABLES: '@receivables',
  PREPAID_CREDITS: '@prepaidCredits',
  PAYABLES: '@payables',
  TAX_PAYABLE: '@taxPayable',
  CONTRIBUTED_FUNDS: '@contributedFunds',
  RETAINED_EARNINGS: '@retainedEarnings',
  SERVICE_INCOME: '@serviceIncome',
  CURRENCY_GAINS: '@currencyGains',
  MODEL_INFERENCE: '@modelInference',
  TOOLS_AND_APIS: '@toolsAndApis',
  COMPUTE_AND_SANDBOXES: '@computeAndSandboxes',
  PAYMENT_PROCESSING: '@paymentProcessing',
  OTHER_OPERATING: '@otherOperating',
} as const;

export type AccountRole = (typeof ACCOUNT)[keyof typeof ACCOUNT];
export type AccountCode = string;

export const isRole = (code: string): boolean => typeof code === 'string' && code.startsWith('@');

/**
 * Chart 1: what every company opened before 2026-09-14 has. Kept exactly as it
 * was, because those companies have postings against these numbers and an
 * append-only ledger cannot be renumbered.
 */
const V1_ROLES: Record<string, string> = {
  '@treasury': '1000',
  '@receivables': '1100',
  '@prepaidCredits': '1300',
  '@payables': '2000',
  '@taxPayable': '2100',
  '@contributedFunds': '3000',
  '@retainedEarnings': '3900',
  '@serviceIncome': '4000',
  '@currencyGains': '4900',
  '@modelInference': '5000',
  '@toolsAndApis': '5100',
  '@computeAndSandboxes': '5200',
  '@paymentProcessing': '5300',
  '@otherOperating': '5900',
  // Chart 1 never had these as lines of their own; they fall back to the
  // nearest thing it does have, so a company on the old chart still balances.
  '@accruedServicesReceivable': '1100',
  '@accruedStreamsPayable': '2000',
  '@customerCredits': '2000',
  '@providerPayable': '2000',
  '@commissionRevenue': '4000',
};

const V1_ACCOUNTS: readonly SeedAccount[] = [
  { code: '1000', name: 'Treasury', type: 'asset' },
  { code: '1100', name: 'Receivables', type: 'asset' },
  { code: '1300', name: 'Prepaid model credits', type: 'asset' },
  { code: '2000', name: 'Payables', type: 'liability' },
  { code: '2100', name: 'Tax payable', type: 'liability' },
  { code: '3000', name: 'Contributed funds', type: 'equity' },
  { code: '3900', name: 'Retained earnings', type: 'equity' },
  { code: '4000', name: 'Service income', type: 'income' },
  { code: '4900', name: 'Currency gains and losses', type: 'income' },
  { code: '5000', name: 'Model inference', type: 'expense' },
  { code: '5100', name: 'Tools and APIs', type: 'expense' },
  { code: '5200', name: 'Compute and sandboxes', type: 'expense' },
  { code: '5300', name: 'Payment processing', type: 'expense' },
  { code: '5900', name: 'Other operating', type: 'expense' },
];

/**
 * Chart 2: what a company opened from 2026-09-14 gets.
 *
 * A chart for a business whose costs are inference, whose revenue is agent
 * work, and whose worst months are the ones where an agent got something
 * wrong — so "Agent mistakes and remediation" is a line rather than a note in
 * "other". The thousands are groups and nothing posts to them directly.
 */
const V2_ROLES: Record<string, string> = {
  '@treasury': '1100',
  '@receivables': '1200',
  '@prepaidCredits': '1300',
  '@payables': '2100',
  '@taxPayable': '2240',
  '@contributedFunds': '3100',
  '@retainedEarnings': '3300',
  '@serviceIncome': '4130',
  '@currencyGains': '7300',
  '@modelInference': '5100',
  '@toolsAndApis': '5130',
  '@computeAndSandboxes': '5120',
  '@paymentProcessing': '5140',
  '@otherOperating': '6120',
  // The two control accounts the subledger needs: what has been earned or
  // consumed continuously and not yet settled. See src/core/subledger.ts.
  '@accruedServicesReceivable': '1220',
  '@accruedStreamsPayable': '2130',
  '@customerCredits': '2210',
  '@providerPayable': '2220',
  '@commissionRevenue': '4200',
};

const V2_ACCOUNTS: readonly SeedAccount[] = [
  { code: '1100', name: 'Operating bank accounts', type: 'asset' },
  { code: '1110', name: 'Agent-controlled bank/wallet balances', type: 'asset' },
  { code: '1120', name: 'Payment processor clearing', type: 'asset' },
  { code: '1130', name: 'Crypto/stablecoin wallets', type: 'asset' },
  { code: '1200', name: 'Accounts receivable', type: 'asset' },
  { code: '1210', name: 'Unbilled revenue', type: 'asset' },
  { code: '1220', name: 'Accrued agent services receivable', type: 'asset' },
  { code: '1300', name: 'Prepaid model/API credits', type: 'asset' },
  { code: '1310', name: 'Other prepaid software', type: 'asset' },
  { code: '1400', name: 'Deposits', type: 'asset' },
  { code: '1500', name: 'Equipment', type: 'asset' },
  { code: '1600', name: 'Capitalised software/intangibles', type: 'asset' },

  { code: '2100', name: 'Accounts payable', type: 'liability' },
  { code: '2110', name: 'Accrued model/API usage', type: 'liability' },
  { code: '2120', name: 'Payroll and contractor liabilities', type: 'liability' },
  { code: '2130', name: 'Accrued agent streams payable', type: 'liability' },
  { code: '2200', name: 'Deferred subscription revenue', type: 'liability' },
  { code: '2210', name: 'Customer credit balances', type: 'liability' },
  { code: '2220', name: 'Marketplace provider payables', type: 'liability' },
  { code: '2230', name: 'Client/escrow funds payable', type: 'liability' },
  { code: '2240', name: 'Taxes payable', type: 'liability' },
  { code: '2300', name: 'Loans and other debt', type: 'liability' },

  { code: '3100', name: 'Share capital', type: 'equity' },
  { code: '3200', name: 'Additional paid-in capital', type: 'equity' },
  { code: '3300', name: 'Retained earnings', type: 'equity' },
  { code: '3400', name: 'Current-year profit/loss', type: 'equity' },

  { code: '4100', name: 'Subscription revenue', type: 'income' },
  { code: '4110', name: 'Usage-based revenue', type: 'income' },
  { code: '4120', name: 'Implementation/onboarding', type: 'income' },
  { code: '4130', name: 'Managed agent services', type: 'income' },
  { code: '4200', name: 'Marketplace commissions', type: 'income' },
  { code: '4210', name: 'API/voice reseller margin', type: 'income' },
  { code: '4220', name: 'Transaction/dispute fees', type: 'income' },
  { code: '4230', name: 'Outcome-based fees', type: 'income' },
  { code: '4300', name: 'Other business-specific revenue', type: 'income' },

  { code: '5100', name: 'Production model inference', type: 'expense' },
  { code: '5110', name: 'Voice, transcription and synthesis', type: 'expense' },
  { code: '5120', name: 'Agent hosting and runtime', type: 'expense' },
  { code: '5130', name: 'Data and tool API usage', type: 'expense' },
  { code: '5140', name: 'Payment and transaction costs', type: 'expense' },
  { code: '5150', name: 'Model/provider revenue share', type: 'expense' },
  { code: '5160', name: 'Human fulfilment and escalation', type: 'expense' },

  { code: '6100', name: 'Model experimentation and R&D', type: 'expense' },
  { code: '6110', name: 'Simulations and evaluations', type: 'expense' },
  { code: '6120', name: 'Internal software and SaaS', type: 'expense' },
  { code: '6130', name: 'Cloud infrastructure', type: 'expense' },
  { code: '6200', name: 'Sales and marketing', type: 'expense' },
  { code: '6210', name: 'Customer acquisition', type: 'expense' },
  { code: '6300', name: 'Employees and contractors', type: 'expense' },
  { code: '6310', name: 'Human supervision of agents', type: 'expense' },
  { code: '6320', name: 'Security and compliance', type: 'expense' },
  { code: '6330', name: 'Legal, accounting and audit', type: 'expense' },
  { code: '6340', name: 'Insurance', type: 'expense' },
  { code: '6400', name: 'Agent mistakes and remediation', type: 'expense' },
  { code: '6410', name: 'Refunds, disputes and chargebacks', type: 'expense' },
  { code: '6500', name: 'Depreciation and amortisation', type: 'expense' },

  { code: '7100', name: 'Interest income', type: 'income' },
  { code: '7200', name: 'Interest expense', type: 'expense' },
  { code: '7300', name: 'FX gains/losses', type: 'income' },
  { code: '7310', name: 'Crypto gains/losses', type: 'income' },
  { code: '7400', name: 'Exceptional items', type: 'expense' },
];

export const CHART_VERSIONS = [1, 2] as const;
export type ChartVersion = (typeof CHART_VERSIONS)[number];

/** What a company opened today is given. */
export const CURRENT_CHART: ChartVersion = 2;

export const CHARTS: Record<ChartVersion, { accounts: readonly SeedAccount[]; roles: Record<string, string> }> = {
  1: { accounts: V1_ACCOUNTS, roles: V1_ROLES },
  2: { accounts: V2_ACCOUNTS, roles: V2_ROLES },
};

/** The code this chart uses for a role. A code that is not a role is its own answer. */
export function codeFor(code: string, version: ChartVersion): string {
  if (!isRole(code)) return code;
  const found = CHARTS[version]?.roles[code];
  if (!found) throw new Error(`no account plays ${code} in chart ${version}`);
  return found;
}

/** The whole map, for a caller that needs several. */
export const rolesOf = (version: ChartVersion): Record<string, string> => ({ ...CHARTS[version].roles });

/** Kept for callers that want the current default chart's account list. */
export const SEED_ACCOUNTS: readonly SeedAccount[] = V2_ACCOUNTS;

/**
 * Which side increases an account's balance. Assets and expenses grow on
 * debit; liabilities, equity and income grow on credit. Used to turn raw
 * debit/credit sums into the signed balances people expect to read.
 */
export function normalSide(type: AccountType): 'debit' | 'credit' {
  return type === 'asset' || type === 'expense' ? 'debit' : 'credit';
}
