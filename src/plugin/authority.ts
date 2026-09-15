/**
 * The spending-authority gate: an agent pays only inside what its owner set.
 *
 * ai3.co holds the owner's spending authorities (who may pay whom, how much
 * per payment and per period, after what inspection window) and the feed
 * where a person can veto a payment while the window is open. This module is
 * the ledger's side of that: before an agent moves money on either rail it
 * asks `/api/ledger/agent-pay/check`, and after it has moved it reports to
 * `/api/ledger/agent-pay/paid` so the caps count it and the decision log
 * carries it.
 *
 * Three rules this file keeps:
 *
 *   1. A person is not gated. The board pays what it likes from the UI; the
 *      gate is for agents, and an actor whose id starts with `board:` is a
 *      person.
 *   2. An agent with no connection to ai3.co cannot pay. There is no
 *      authority store to ask, so the honest answer is "connect, then grant",
 *      not "pay anyway".
 *   3. "No" is a sentence. Every refusal names the rule, and where a person
 *      can change it: the authorities page, the feed item, or the time the
 *      window closes.
 */
import type { CompanySettings } from '../core/index.js';
import { LedgerError } from '../core/index.js';
import { ai3Call, isConnected, type FetchLike } from './ai3.js';

/** What ai3.co answers to a check. Mirrors site/lib/authorities.mjs mayPay/decidePayment. */
export interface AuthorityDecision {
  allowed: boolean;
  code: string;
  why?: string;
  authorityId?: string | null;
  actionId?: string | null;
  windowEndsAt?: string | null;
  feedUrl?: string | null;
  configureUrl?: string | null;
  capMinor?: string;
  spentMinor?: string;
  by?: string | null;
  dispute?: { invoice?: string; status?: string; venueUrl?: string | null; why?: string } | null;
  /** On a failed-check refusal: the verdict and the rules that failed. */
  verdictId?: string | null;
  failed?: string[];
}

export interface AuthorityCheckInput {
  companyId: string;
  /** The seller's organization id on ai3.co when the invoice names one, else the address paid. */
  payee: string;
  payeeName?: string | null;
  amountMinor: bigint;
  currency: string;
  invoiceId?: string | null;
  description?: string | null;
}

export interface AuthorityPaidInput extends Omit<AuthorityCheckInput, 'description'> {
  authorityId: string | null;
  rail: 'tempo' | 'stripe';
  chain: string | null;
  /** The chain transaction hash, or the Stripe payment intent id. */
  ref: string;
  openedAt?: string | null;
  approvedBy?: string | null;
}

/** The board is a person; anything else that runs a tool is an agent. */
export function isAgentActor(agentId: string): boolean {
  return !String(agentId ?? '').startsWith('board:');
}

export const NOT_CONNECTED = 'an agent can only pay inside a spending authority its owner set on ai3.co, and this company is not connected to ai3.co. Ask the owner to add the company key under Finance › Settings and grant an authority for this payee; or the owner can pay from the Finance page themselves.';

const major = (minor: bigint, currency: string) => `${(minor / 100n).toString()}.${(minor % 100n).toString().padStart(2, '0')} ${currency}`;

/** Turn a refusal into the sentence the agent passes on. */
export function explainRefusal(d: AuthorityDecision, input: { payeeName?: string | null; amountMinor: bigint; currency: string }): string {
  const who = input.payeeName ? `${input.payeeName}` : 'this payee';
  const amt = major(input.amountMinor, input.currency);
  const where = d.configureUrl ? ` The owner can grant one at ${d.configureUrl}.` : '';
  switch (d.code) {
    case 'no-authority':
      return `not paid: the owner has not authorised agent payments to ${who}.${where}`;
    case 'window-open':
      return `not paid yet: ${amt} to ${who} is in the owner's feed for inspection${d.windowEndsAt ? ` until ${d.windowEndsAt}` : ''}${d.feedUrl ? ` (${d.feedUrl})` : ''}. Ask again after the window closes, or the owner can approve it now from the feed. Do not pay it another way.`;
    case 'needs-first-approval':
      return `not paid: the first payment to ${who} always needs a person.${d.feedUrl ? ` It is in the owner's feed at ${d.feedUrl}.` : ''} Wait for the approval; do not pay it another way.`;
    case 'over-transaction-cap':
      return `not paid: ${amt} is over the per-payment cap${d.capMinor ? ` of ${major(BigInt(d.capMinor), input.currency)}` : ''} the owner set for ${who}.${where} Do not split it into smaller payments.`;
    case 'over-period-cap':
      return `not paid: ${amt} would pass the period cap${d.capMinor ? ` of ${major(BigInt(d.capMinor), input.currency)}` : ''} for ${who}${d.spentMinor ? ` (${major(BigInt(d.spentMinor), input.currency)} already paid this period)` : ''}. Wait for the next period, or the owner can raise it.${where}`;
    case 'over-budget-policy':
      return `not paid: the company budget policy is tighter than the payment cap and it wins. The owner can change either.`;
    case 'disputed':
      return `not paid: there is an open dispute with ${who}${d.dispute?.invoice ? ` on ${d.dispute.invoice}` : ''}, so nothing is paid automatically until it is ruled.${d.dispute?.venueUrl ? ` Case: ${d.dispute.venueUrl}.` : ''}`;
    case 'vetoed':
      return `not paid: a person rejected this payment in the feed. That is final; do not pay it another way.`;
    case 'deferred':
      return `not paid: a person put this payment off in the feed. Ask again later; do not pay it another way.`;
    case 'paused':
    case 'revoked':
      return `not paid: the authority for ${who} is ${d.code}.${where}`;
    case 'chain-not-enabled':
      return `not paid: the chain the authority names is not open for agent payments right now.`;
    case 'failed-check':
      return `not paid: this organisation's own acceptance check failed for this invoice${d.failed?.length ? ` (${d.failed.join(', ')})` : ''}. Dispute it with \`dispute-invoice\` and verdict ${d.verdictId ?? ''}, or wait for a delivery that passes. Do not pay work recorded as not done.`;
    default:
      return `not paid: ${d.why || `ai3.co refused it (${d.code})`}`;
  }
}

/**
 * Ask ai3.co whether this agent may pay this, now. Throws a LedgerError with
 * the reason when it may not; returns the decision (with the authority id the
 * receipt must carry) when it may.
 */
export async function checkAuthority(fetch: FetchLike, settings: CompanySettings, input: AuthorityCheckInput): Promise<AuthorityDecision> {
  if (!isConnected(settings)) throw new LedgerError(NOT_CONNECTED, 'invalid');
  const d = (await ai3Call(fetch, settings, '/api/ledger/agent-pay/check', {
    companyId: input.companyId,
    payee: input.payee,
    payeeName: input.payeeName ?? null,
    amountMinor: input.amountMinor.toString(),
    currency: input.currency,
    invoiceId: input.invoiceId ?? null,
    description: input.description ?? null,
  })) as Partial<AuthorityDecision> | null;
  if (!d || typeof d !== 'object' || typeof d.code !== 'string') throw new LedgerError('not paid: ai3.co gave no answer to the authority check', 'invalid');
  const decision = { ...d, allowed: d.allowed === true, code: d.code } as AuthorityDecision;
  if (!decision.allowed) throw new LedgerError(explainRefusal(decision, input), 'invalid');
  return decision;
}

/**
 * Tell ai3.co the payment happened. The caps count it, the feed item closes,
 * and the company's decision log gets the event with the authority that
 * permitted it. Never throws: the money has moved and the books say so; a
 * report that did not land is a note in the reply, and the site's own feeds
 * catch up from the chain.
 */
export async function reportPayment(fetch: FetchLike, settings: CompanySettings, input: AuthorityPaidInput): Promise<{ ok: boolean; note: string; paymentId?: string | null }> {
  try {
    const r = (await ai3Call(fetch, settings, '/api/ledger/agent-pay/paid', {
      companyId: input.companyId,
      payee: input.payee,
      payeeName: input.payeeName ?? null,
      amountMinor: input.amountMinor.toString(),
      currency: input.currency,
      invoiceId: input.invoiceId ?? null,
      authorityId: input.authorityId,
      chain: input.chain,
      txHash: input.ref,
      rail: input.rail,
      openedAt: input.openedAt ?? null,
      approvedBy: input.approvedBy ?? null,
    })) as { ok?: boolean; paymentId?: string } | null;
    return { ok: true, note: 'counted against the owner’s spending authority', paymentId: r?.paymentId ?? null };
  } catch (err) {
    return { ok: false, note: `the payment was not reported to the spending authority (${err instanceof Error ? err.message.slice(0, 80) : String(err)}); ai3.co will catch up from the chain` };
  }
}


// ---------------------------------------------------------------------------
// A failed verdict as the claim of a dispute
// ---------------------------------------------------------------------------

/** A verdict as ai3.co keeps it (lib/acceptance.mjs runCheck + saveVerdict). */
export interface Verdict {
  id: string;
  checkId: string;
  model: string | null;
  producerModel: string | null;
  pass: boolean;
  failed: string[];
  rules: Array<{ id: string; kind: string; pass: boolean; evidence: string; reason?: string }>;
  slug?: string | null;
  version?: number | null;
  deliveryRef?: string | null;
  at: string;
}

/** Fetch one of this company's verdicts from ai3.co. */
export async function fetchVerdict(fetch: FetchLike, settings: CompanySettings, companyId: string, id: string): Promise<Verdict> {
  const v = (await ai3Call(fetch, settings, '/api/market/verdict/get', { companyId, id })) as Partial<Verdict> | null;
  if (!v || typeof v !== 'object' || typeof v.id !== 'string' || !Array.isArray(v.rules)) throw new LedgerError(`ai3.co returned no verdict ${id}`, 'invalid');
  return { ...v, failed: Array.isArray(v.failed) ? v.failed : v.rules.filter((r) => !r.pass).map((r) => r.id), pass: v.pass === true } as Verdict;
}

/**
 * The breach and evidence a dispute carries when it rests on a failed check:
 * the rule, its reason, and the evidence recorded, so the venue reads the
 * check and not an account of it. Refuses a verdict that passed.
 */
export function claimFromVerdict(v: Verdict, { breach = null, evidence = null }: { breach?: string | null; evidence?: string | null } = {}): { breach: string; evidence: string } {
  if (v.pass) throw new LedgerError(`verdict ${v.id} passed every rule; there is nothing on the acceptance check to dispute`, 'invalid');
  const failed = v.rules.filter((r) => !r.pass);
  const lines = failed.map((r) => `- ${r.id}${r.reason ? ` (${r.reason})` : ''}: ${r.evidence}`);
  const head = `The delivery${v.deliveryRef ? ` for ${v.deliveryRef}` : ''} failed ${failed.length} of ${v.rules.length} rules of the listing's acceptance check (${v.checkId}${v.slug ? `, ${v.slug}${v.version ? ` v${v.version}` : ''}` : ''}), scored by ${v.model ?? 'the buyer\u2019s acceptance agent'}${v.producerModel ? ` on a model different from the seller\u2019s (${v.producerModel})` : ''} at ${v.at}.`;
  return {
    breach: [breach?.trim(), head, ...lines].filter(Boolean).join('\n'),
    evidence: [evidence?.trim(), `Verdict ${v.id} as recorded at ai3.co.`, ...v.rules.map((r) => `${r.id}: ${r.pass ? 'pass' : 'FAIL'} — ${r.evidence}`)].filter(Boolean).join('\n'),
  };
}
