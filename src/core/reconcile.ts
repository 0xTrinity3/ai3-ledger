/**
 * Reconciliation: for each statement line, what the books say happened.
 *
 * `propose()` looks at a line and returns one proposal with a confidence and a
 * reason a person can check at a glance. `apply()` carries out a decision by
 * posting ordinary ledger transactions. `run()` does both for every open line
 * on an account and posts everything at or above a threshold, leaving the
 * rest for a person. Rules are written by confirmations, never by hand.
 *
 * The one thing Xero cannot do and we can: the batch match, one provider
 * charge against the sum of the swept cost events for that provider.
 */
import { ACCOUNT } from './accounts.js';
import {
  getBankAccount,
  getStatementLine,
  linkTransactions,
  listBankAccounts,
  listStatementLines,
  markLine,
  saveProposal,
  type BankAccount,
  type Decision,
  type Proposal,
  type StatementLine,
} from './banks.js';
import { listInvoices, recordPayment, type Invoice } from './invoices.js';
import { LedgerError, postTransaction } from './ledger.js';
import { table, toMinor, type LedgerDb, type Minor } from './sql.js';

const SYMBOL: Record<string, string> = { USD: '$', EUR: '€', GBP: '£' };
function money(minor: Minor, currency: string): string {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${SYMBOL[currency] ?? `${currency} `}${whole}.${(abs % 100n).toString().padStart(2, '0')}`;
}

function norm(s: string | null | undefined): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The payee name most banks bury in the description: first few words, letters only. */
export function payeeKey(line: Pick<StatementLine, 'payee' | 'description'>): string {
  const src = norm(line.payee || line.description);
  const words = src.split(' ').filter((w) => w.length > 1 && !/^\d+$/.test(w)).slice(0, 3);
  return words.join(' ');
}

function daysApart(a: string, b: string): number {
  return Math.abs(Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000));
}

// ---------------------------------------------------------------------------
// Candidates from the books
// ---------------------------------------------------------------------------

interface OpenTx {
  id: string;
  occurred_at: string;
  description: string;
  source_kind: string;
  source_ref: string | null;
  amount: unknown;
  direction: string; // direction of the Treasury entry: debit = money in
}

/** Posted transactions that touched 1000 Treasury and are not linked to any statement line yet. */
async function unlinkedTreasuryTransactions(db: LedgerDb, companyId: string, from: string, to: string): Promise<OpenTx[]> {
  return db.sql.query<OpenTx>(
    `SELECT t.id, t.occurred_at::text AS occurred_at, t.description, t.source_kind, t.source_ref, e.amount_minor AS amount, e.direction
       FROM ${table(db, 'transactions')} t
       JOIN ${table(db, 'entries')} e ON e.transaction_id = t.id
       JOIN ${table(db, 'accounts')} a ON a.id = e.account_id AND a.code = '${ACCOUNT.TREASURY}'
      WHERE t.company_id = $1 AND t.status = 'posted'
        AND t.occurred_at >= $2::timestamptz AND t.occurred_at <= $3::timestamptz
        AND t.id NOT IN (SELECT transaction_id FROM ${table(db, 'reconciliation_links')} r WHERE r.company_id = $1)
      ORDER BY t.occurred_at`,
    [companyId, from, to],
  );
}

interface Rule { id: string; payee_contains: string; direction: string; account_code: string; contact_name: string | null; confirmations: number; misses: number }

async function rulesFor(db: LedgerDb, companyId: string): Promise<Rule[]> {
  return db.sql.query<Rule>(
    `SELECT id, payee_contains, direction, account_code, contact_name, confirmations, misses FROM ${table(db, 'bank_rules')} WHERE company_id = $1 AND enabled = true ORDER BY confirmations DESC`,
    [companyId],
  );
}

/** How this payee was coded before, from lines a person or the rule engine already reconciled. */
async function history(db: LedgerDb, companyId: string, key: string, direction: 'in' | 'out'): Promise<Array<{ account_code: string; n: unknown }>> {
  if (!key) return [];
  return db.sql.query<{ account_code: string; n: unknown }>(
    `SELECT a.code AS account_code, COUNT(*) AS n
       FROM ${table(db, 'statement_lines')} l
       JOIN ${table(db, 'transactions')} t ON t.id = l.reconciled_transaction_id
       JOIN ${table(db, 'entries')} e ON e.transaction_id = t.id
       JOIN ${table(db, 'accounts')} a ON a.id = e.account_id
      WHERE l.company_id = $1 AND l.status = 'created' AND lower(COALESCE(l.payee, l.description)) LIKE '%' || $2 || '%'
        AND a.type IN ('income', 'expense', 'equity') AND ($3::text = 'out' AND l.amount_minor < 0 OR $3::text = 'in' AND l.amount_minor > 0)
      GROUP BY a.code ORDER BY n DESC LIMIT 1`,
    [companyId, key.split(' ')[0] ?? key, direction],
  );
}

const KEYWORDS: Array<[RegExp, string, string]> = [
  [/anthropic|openai|open ai|google cloud|gemini|mistral|cohere|groq|together ai|fireworks|replicate|xai/i, ACCOUNT.MODEL_INFERENCE, 'a model provider'],
  [/github|vercel|netlify|cloudflare|twilio|sendgrid|postmark|resend|exa|serp|tavily|browserbase|apify|zapier|notion|slack|linear|figma|1password|namecheap|godaddy|hetzner dns/i, ACCOUNT.TOOLS_AND_APIS, 'a tool or API'],
  [/aws|amazon web|hetzner|digitalocean|linode|fly\.io|railway|render|e2b|modal|runpod|lambda labs|gcp|azure|ovh|scaleway/i, ACCOUNT.COMPUTE_AND_SANDBOXES, 'compute'],
  [/stripe fee|processing fee|paypal fee|card fee|merchant fee/i, ACCOUNT.PAYMENT_PROCESSING, 'a payment processing fee'],
];

// ---------------------------------------------------------------------------
// Propose
// ---------------------------------------------------------------------------

export async function propose(db: LedgerDb, companyId: string, line: StatementLine): Promise<Proposal> {
  const bank = await getBankAccount(db, companyId, line.bankAccountId);
  if (!bank) throw new LedgerError('bank account not found', 'invalid');
  const cur = bank.currency;
  const amount = toMinor(line.amountMinor);
  const abs = amount < 0n ? -amount : amount;
  const text = norm(`${line.payee ?? ''} ${line.description} ${line.reference ?? ''}`);
  const direction: 'in' | 'out' = amount >= 0n ? 'in' : 'out';
  const dayAgo = (n: number) => new Date(Date.parse(line.postedAt) - n * 86_400_000).toISOString();
  const dayAhead = (n: number) => new Date(Date.parse(line.postedAt) + n * 86_400_000).toISOString();

  // 1. Transfer between our own accounts: the mirror line on another account, close in time.
  const others = (await listBankAccounts(db, companyId)).filter((b) => b.id !== bank.id);
  for (const other of others) {
    const candidates = (await listStatementLines(db, companyId, other.id, { status: 'unreconciled', limit: 500 })).filter(
      (l) => toMinor(l.amountMinor) === -amount && daysApart(l.postedAt, line.postedAt) <= 4,
    );
    if (candidates.length > 0) {
      const sameRef = candidates.find((l) => l.reference && line.reference && norm(l.reference) === norm(line.reference)) ?? candidates.find((l) => /payout|transfer|tfr|xfer/i.test(`${l.description} ${line.description}`));
      const pick = sameRef ?? candidates[0]!;
      return {
        kind: 'transfer', confidence: sameRef ? 99 : 88, otherBankAccountId: other.id, otherLineId: pick.id,
        reason: `${money(abs, cur)} ${direction === 'in' ? 'arrived from' : 'went to'} ${other.name} on ${pick.postedAt.slice(0, 10)}${sameRef ? ', same reference on both sides' : ', same amount within four days'}.`,
      };
    }
  }

  // 2. Money in: an open invoice.
  if (direction === 'in') {
    const open = (await listInvoices(db, companyId, { limit: 500 })).filter((i) => i.status === 'issued' || i.status === 'part_paid');
    const scored = open.map((inv) => scoreInvoice(inv, abs, text)).filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (best && best.score >= 60) {
      return { kind: 'create', confidence: best.score, accountCode: ACCOUNT.RECEIVABLES, contactName: best.invoice.customerName, invoiceId: best.invoice.id, reason: best.reason };
    }
  }

  // 3. Something already in the books for this amount (a funding, a payment or a manual entry posted before the statement arrived).
  const window = await unlinkedTreasuryTransactions(db, companyId, dayAgo(10), dayAhead(10));
  const sameAmount = window.filter((t) => toMinor(t.amount) === abs && (t.direction === 'debit') === (direction === 'in') && t.source_kind !== 'cost_sweep');
  if (sameAmount.length > 0) {
    const t = sameAmount.sort((a, b) => daysApart(a.occurred_at, line.postedAt) - daysApart(b.occurred_at, line.postedAt))[0]!;
    const refHit = t.source_ref && line.reference && norm(t.source_ref).includes(norm(line.reference));
    return {
      kind: 'match', confidence: refHit ? 97 : sameAmount.length === 1 ? 90 : 75, transactionIds: [t.id],
      reason: `${t.description || t.source_kind} for ${money(abs, cur)} was recorded on ${t.occurred_at.slice(0, 10)}${refHit ? ', same reference' : ''}.`,
    };
  }

  // 4. Money out: the batch match against swept costs.
  if (direction === 'out') {
    const costs = (await unlinkedTreasuryTransactions(db, companyId, dayAgo(45), dayAhead(2))).filter((t) => t.source_kind === 'cost_sweep');
    const byProvider = new Map<string, OpenTx[]>();
    for (const t of costs) {
      const provider = norm(t.description.split(' · ')[0] ?? '');
      byProvider.set(provider, [...(byProvider.get(provider) ?? []), t]);
    }
    let best: { ids: string[]; provider: string; sum: Minor; from: string; to: string; exact: boolean; named: boolean } | null = null;
    for (const [provider, txs] of byProvider) {
      const named = provider.length > 2 && text.includes(provider.split(' ')[0]!);
      const groupings: OpenTx[][] = [txs];
      const months = new Set(txs.map((t) => t.occurred_at.slice(0, 7)));
      for (const m of months) groupings.push(txs.filter((t) => t.occurred_at.startsWith(m)));
      for (const g of groupings) {
        if (g.length === 0) continue;
        const sum = g.reduce((s, t) => s + toMinor(t.amount), 0n);
        const diff = sum > abs ? sum - abs : abs - sum;
        const exact = diff === 0n;
        const close = !exact && diff * 50n <= abs; // within 2%
        if (!exact && !close) continue;
        const cand = { ids: g.map((t) => t.id), provider, sum, from: g[0]!.occurred_at.slice(0, 10), to: g[g.length - 1]!.occurred_at.slice(0, 10), exact, named };
        if (!best || (cand.exact && !best.exact) || (cand.exact === best.exact && cand.named && !best.named)) best = cand;
      }
    }
    if (best) {
      const conf = best.exact ? (best.named ? 96 : 84) : best.named ? 72 : 60;
      return {
        kind: 'batch', confidence: conf, transactionIds: best.ids,
        reason: `${best.ids.length} swept cost event${best.ids.length === 1 ? '' : 's'} from ${best.provider || 'this provider'} between ${best.from} and ${best.to} sum to ${money(best.sum, cur)}${best.exact ? ', exactly the charge' : `, within 2% of the ${money(abs, cur)} charge`}${best.named ? '' : '; the payee text does not name the provider'}.`,
      };
    }
  }

  // 5. A rule written by an earlier confirmation.
  const key = payeeKey(line);
  const rules = await rulesFor(db, companyId);
  const rule = rules.find((r) => (r.direction === 'any' || r.direction === direction) && text.includes(norm(r.payee_contains)));
  if (rule) {
    const conf = Math.min(97, 84 + Math.min(10, rule.confirmations * 2) - Math.min(20, rule.misses * 5));
    return {
      kind: 'create', confidence: conf, accountCode: rule.account_code, ...(rule.contact_name ? { contactName: rule.contact_name } : {}), ruleId: rule.id,
      reason: `Rule: lines with "${rule.payee_contains}" go to ${rule.account_code}, confirmed ${rule.confirmations} time${rule.confirmations === 1 ? '' : 's'}.`,
    };
  }

  // 6. History for this payee.
  const past = await history(db, companyId, key, direction);
  if (past[0]) {
    const n = Number(past[0].n);
    return {
      kind: 'create', confidence: n >= 3 ? 82 : n === 2 ? 74 : 65, accountCode: past[0].account_code,
      reason: `"${key}" was coded to ${past[0].account_code} ${n} time${n === 1 ? '' : 's'} before. Confirming makes it a rule.`,
    };
  }

  // 7. Keywords.
  if (direction === 'out') {
    for (const [re, code, what] of KEYWORDS) {
      if (re.test(text)) return { kind: 'create', confidence: 62, accountCode: code, reason: `The payee looks like ${what}; ${code} is the usual account. Confirming makes it a rule.` };
    }
  }

  // 8. Ask, with the likely answers ready.
  if (direction === 'in') {
    return {
      kind: 'ask', confidence: 54, reason: `No open invoice for ${money(abs, cur)} and nothing in the books for it. Funding from the owner, a customer paying without a reference, or something else?`,
      options: [
        { label: 'Funding from the owner', decision: { kind: 'create', accountCode: ACCOUNT.CONTRIBUTED_FUNDS, description: line.description } },
        { label: 'Service income, no invoice', decision: { kind: 'create', accountCode: ACCOUNT.SERVICE_INCOME, description: line.description } },
        { label: 'Not the company’s money', decision: { kind: 'exclude', reason: 'not company money' } },
      ],
    };
  }
  return {
    kind: 'ask', confidence: 50, reason: `Nothing in the books explains ${money(abs, cur)} to ${line.payee || line.description}. Which kind of cost is it?`,
    options: [
      { label: 'Model inference', decision: { kind: 'create', accountCode: ACCOUNT.MODEL_INFERENCE } },
      { label: 'Tools and APIs', decision: { kind: 'create', accountCode: ACCOUNT.TOOLS_AND_APIS } },
      { label: 'Compute and sandboxes', decision: { kind: 'create', accountCode: ACCOUNT.COMPUTE_AND_SANDBOXES } },
      { label: 'Other operating', decision: { kind: 'create', accountCode: ACCOUNT.OTHER_OPERATING } },
    ],
  };
}

function scoreInvoice(inv: Invoice, abs: Minor, text: string): { score: number; invoice: Invoice; reason: string } {
  const outstanding = toMinor(inv.outstandingMinor);
  const numberHit = text.includes(norm(inv.number)) || text.replace(/\s/g, '').includes(norm(inv.number).replace(/\s/g, ''));
  const nameWords = norm(inv.customerName).split(' ').filter((w) => w.length > 2);
  const nameHit = nameWords.length > 0 && nameWords.some((w) => text.includes(w));
  if (outstanding === abs) {
    if (numberHit) return { score: 98, invoice: inv, reason: `Pays ${inv.number} in full: same amount and the invoice number is in the reference.` };
    if (nameHit) return { score: 90, invoice: inv, reason: `Pays ${inv.number} in full: same amount and ${inv.customerName} is named.` };
    return { score: 70, invoice: inv, reason: `Same amount as ${inv.number} (${inv.customerName}), still outstanding; nothing else in the text confirms it.` };
  }
  if (abs < outstanding && (numberHit || nameHit)) {
    return { score: numberHit ? 88 : 78, invoice: inv, reason: `Part payment on ${inv.number}: ${numberHit ? 'invoice number in the reference' : `${inv.customerName} is named`}, less than the amount outstanding.` };
  }
  return { score: 0, invoice: inv, reason: '' };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export interface ApplyResult { lineId: string; status: string; transactionId: string | null }

/** Carry out a decision for one line. Every posting is an ordinary, reversible ledger transaction with the reason on it. */
export async function apply(db: LedgerDb, companyId: string, lineId: string, decision: Decision & { invoiceId?: string; reason?: string }, by = 'board'): Promise<ApplyResult> {
  const line = await getStatementLine(db, companyId, lineId);
  if (!line) throw new LedgerError(`statement line ${lineId} not found`, 'invalid');
  if (line.status !== 'unreconciled') throw new LedgerError(`line is already ${line.status}`, 'invalid');
  const bank = await getBankAccount(db, companyId, line.bankAccountId);
  if (!bank) throw new LedgerError('bank account not found', 'invalid');
  const amount = toMinor(line.amountMinor);
  const abs = amount < 0n ? -amount : amount;
  const inflow = amount >= 0n;
  const note = decision.reason ? ` · ${decision.reason}` : '';

  if (decision.kind === 'exclude') {
    await markLine(db, companyId, lineId, 'excluded', null, by);
    return { lineId, status: 'excluded', transactionId: null };
  }

  if (decision.kind === 'match') {
    if (!decision.transactionIds?.length) throw new LedgerError('match needs transaction ids', 'invalid');
    // Those transactions moved cash in 1000 Treasury; move it to the account it really touched.
    const r = await postTransaction(db, {
      companyId, occurredAt: line.postedAt, sourcePlatform: 'bank', sourceKind: 'manual', sourceRef: `line:${line.id}`, currency: bank.currency, createdBy: by,
      description: `${bank.name}: ${line.payee || line.description}${note}`,
      entries: inflow
        ? [{ accountCode: bank.accountCode, direction: 'debit', amountMinor: abs }, { accountCode: ACCOUNT.TREASURY, direction: 'credit', amountMinor: abs }]
        : [{ accountCode: ACCOUNT.TREASURY, direction: 'debit', amountMinor: abs }, { accountCode: bank.accountCode, direction: 'credit', amountMinor: abs }],
    });
    await linkTransactions(db, companyId, lineId, [...decision.transactionIds, r.transactionId]);
    await markLine(db, companyId, lineId, 'matched', r.transactionId, by);
    return { lineId, status: 'matched', transactionId: r.transactionId };
  }

  if (decision.kind === 'transfer') {
    const other = await getBankAccount(db, companyId, decision.otherBankAccountId);
    if (!other) throw new LedgerError('other bank account not found', 'invalid');
    const r = await postTransaction(db, {
      companyId, occurredAt: line.postedAt, sourcePlatform: 'bank', sourceKind: 'manual', sourceRef: `line:${line.id}`, currency: bank.currency, createdBy: by,
      description: `Transfer ${inflow ? `from ${other.name} to ${bank.name}` : `from ${bank.name} to ${other.name}`}${note}`,
      entries: inflow
        ? [{ accountCode: bank.accountCode, direction: 'debit', amountMinor: abs }, { accountCode: other.accountCode, direction: 'credit', amountMinor: abs }]
        : [{ accountCode: other.accountCode, direction: 'debit', amountMinor: abs }, { accountCode: bank.accountCode, direction: 'credit', amountMinor: abs }],
    });
    await linkTransactions(db, companyId, lineId, [r.transactionId]);
    await markLine(db, companyId, lineId, 'transferred', r.transactionId, by);
    if (decision.otherLineId) {
      const otherLine = await getStatementLine(db, companyId, decision.otherLineId);
      if (otherLine && otherLine.status === 'unreconciled' && toMinor(otherLine.amountMinor) === -amount) {
        await markLine(db, companyId, otherLine.id, 'transferred', r.transactionId, by);
      }
    }
    return { lineId, status: 'transferred', transactionId: r.transactionId };
  }

  // create
  if (decision.invoiceId && inflow) {
    const inv = await recordPayment(db, companyId, decision.invoiceId, { amountMinor: abs, occurredAt: line.postedAt, reference: `line:${line.id}`, createdBy: by, cashAccountCode: bank.accountCode });
    const paymentTx = await db.sql.query<{ id: string }>(
      `SELECT id FROM ${table(db, 'transactions')} WHERE company_id = $1 AND source_kind = 'payment' AND source_ref = $2`,
      [companyId, `payment:${inv.id}:line:${line.id}`],
    );
    const txId = paymentTx[0]?.id ?? null;
    if (txId) await linkTransactions(db, companyId, lineId, [txId]);
    await markLine(db, companyId, lineId, 'created', txId, by);
    await learn(db, companyId, line, ACCOUNT.RECEIVABLES, inv.customerName);
    return { lineId, status: 'created', transactionId: txId };
  }
  const code = decision.accountCode;
  if (!code) throw new LedgerError('create needs an account code', 'invalid');
  const r = await postTransaction(db, {
    companyId, occurredAt: line.postedAt, sourcePlatform: 'bank', sourceKind: 'manual', sourceRef: `line:${line.id}`, currency: bank.currency, createdBy: by,
    description: `${decision.description || line.payee || line.description}${decision.contactName ? ` · ${decision.contactName}` : ''}${note}`,
    entries: inflow
      ? [{ accountCode: bank.accountCode, direction: 'debit', amountMinor: abs }, { accountCode: code, direction: 'credit', amountMinor: abs }]
      : [{ accountCode: code, direction: 'debit', amountMinor: abs }, { accountCode: bank.accountCode, direction: 'credit', amountMinor: abs }],
  });
  await linkTransactions(db, companyId, lineId, [r.transactionId]);
  await markLine(db, companyId, lineId, 'created', r.transactionId, by);
  await learn(db, companyId, line, code, decision.contactName ?? null);
  return { lineId, status: 'created', transactionId: r.transactionId };
}

/** A confirmed coding becomes a rule, or strengthens one. */
async function learn(db: LedgerDb, companyId: string, line: StatementLine, accountCode: string, contactName: string | null): Promise<void> {
  const key = payeeKey(line);
  if (!key || key.length < 3) return;
  const direction = toMinor(line.amountMinor) >= 0n ? 'in' : 'out';
  await db.sql.execute(
    `INSERT INTO ${table(db, 'bank_rules')} (id, company_id, payee_contains, direction, account_code, contact_name, confirmations)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 1)
     ON CONFLICT (company_id, payee_contains, direction)
     DO UPDATE SET confirmations = bank_rules.confirmations + 1, account_code = EXCLUDED.account_code, contact_name = COALESCE(EXCLUDED.contact_name, bank_rules.contact_name), updated_at = now()`,
    [companyId, key, direction, accountCode, contactName],
  );
}

export interface BankRule { id: string; payeeContains: string; direction: string; accountCode: string; contactName: string | null; confirmations: number; misses: number; enabled: boolean }

export async function listRules(db: LedgerDb, companyId: string): Promise<BankRule[]> {
  const rows = await db.sql.query<{ id: string; payee_contains: string; direction: string; account_code: string; contact_name: string | null; confirmations: unknown; misses: unknown; enabled: boolean }>(
    `SELECT id, payee_contains, direction, account_code, contact_name, confirmations, misses, enabled FROM ${table(db, 'bank_rules')} WHERE company_id = $1 ORDER BY confirmations DESC, payee_contains`,
    [companyId],
  );
  return rows.map((r) => ({ id: r.id, payeeContains: r.payee_contains, direction: r.direction, accountCode: r.account_code, contactName: r.contact_name, confirmations: Number(r.confirmations), misses: Number(r.misses), enabled: r.enabled }));
}

export async function setRuleEnabled(db: LedgerDb, companyId: string, ruleId: string, enabled: boolean): Promise<void> {
  await db.sql.execute(`UPDATE ${table(db, 'bank_rules')} SET enabled = $3, updated_at = now() WHERE company_id = $1 AND id = $2::uuid`, [companyId, ruleId, enabled]);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export interface RunResult { bankAccountId: string; linesSeen: number; autoPosted: number; leftForReview: number; threshold: number; ranBy: string }

/** Propose for every open line; post those at or above the threshold; save the rest for a person. */
export async function run(db: LedgerDb, companyId: string, bankAccountId: string, opts: { threshold?: number; by?: string; autoPost?: boolean } = {}): Promise<RunResult> {
  const threshold = Math.min(100, Math.max(50, Math.floor(opts.threshold ?? 90)));
  const by = opts.by ?? 'reconcile';
  const autoPost = opts.autoPost ?? true;
  const lines = await listStatementLines(db, companyId, bankAccountId, { status: 'unreconciled', limit: 2000 });
  let autoPosted = 0;
  for (const line of [...lines].sort((a, b) => a.postedAt.localeCompare(b.postedAt))) {
    const fresh = await getStatementLine(db, companyId, line.id);
    if (!fresh || fresh.status !== 'unreconciled') continue; // a transfer may have closed its mirror
    const p = await propose(db, companyId, fresh);
    await saveProposal(db, companyId, line.id, p);
    if (!autoPost || p.kind === 'ask' || p.confidence < threshold) continue;
    try {
      await apply(db, companyId, line.id, decisionOf(p), by);
      autoPosted += 1;
    } catch {
      /* leave it for a person; the proposal stays on the line */
    }
  }
  const result: RunResult = { bankAccountId, linesSeen: lines.length, autoPosted, leftForReview: lines.length - autoPosted, threshold, ranBy: by };
  await db.sql.execute(
    `INSERT INTO ${table(db, 'reconciliation_runs')} (id, company_id, bank_account_id, ran_by, lines_seen, auto_posted, left_for_review, threshold)
     VALUES (gen_random_uuid(), $1, $2::uuid, $3, $4::int, $5::int, $6::int, $7::int)`,
    [companyId, bankAccountId, by, result.linesSeen, result.autoPosted, result.leftForReview, threshold],
  );
  return result;
}

/** The decision a proposal implies when accepted as is. */
export function decisionOf(p: Proposal): Decision & { invoiceId?: string; reason?: string } {
  const reason = p.reason;
  switch (p.kind) {
    case 'match':
    case 'batch':
      return { kind: 'match', transactionIds: p.transactionIds ?? [], reason };
    case 'transfer':
      return { kind: 'transfer', otherBankAccountId: p.otherBankAccountId ?? '', ...(p.otherLineId ? { otherLineId: p.otherLineId } : {}), reason };
    case 'create':
      return { kind: 'create', accountCode: p.accountCode ?? ACCOUNT.OTHER_OPERATING, ...(p.contactName ? { contactName: p.contactName } : {}), ...(p.invoiceId ? { invoiceId: p.invoiceId } : {}), reason };
    default:
      throw new LedgerError('a question has no default decision', 'invalid');
  }
}

export interface RunSummary { at: string | null; linesSeen: number; autoPosted: number; leftForReview: number; threshold: number; ranBy: string | null }

export async function lastRun(db: LedgerDb, companyId: string, bankAccountId: string): Promise<RunSummary | null> {
  const rows = await db.sql.query<{ ran_at: string; lines_seen: unknown; auto_posted: unknown; left_for_review: unknown; threshold: unknown; ran_by: string }>(
    `SELECT ran_at::text AS ran_at, lines_seen, auto_posted, left_for_review, threshold, ran_by FROM ${table(db, 'reconciliation_runs')}
      WHERE company_id = $1 AND bank_account_id = $2::uuid ORDER BY ran_at DESC LIMIT 1`,
    [companyId, bankAccountId],
  );
  const r = rows[0];
  return r ? { at: r.ran_at, linesSeen: Number(r.lines_seen), autoPosted: Number(r.auto_posted), leftForReview: Number(r.left_for_review), threshold: Number(r.threshold), ranBy: r.ran_by } : null;
}

