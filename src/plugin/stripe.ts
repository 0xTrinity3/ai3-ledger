/**
 * Stripe, through ai3.co. The platform holds the Stripe keys and the Connect
 * relationship; this plugin only ever talks to ai3.co with the company key.
 *
 * What a company gets once connected: a "Pay by card" option printed on its
 * invoices (the hosted page runs the checkout on the company's own connected
 * account), a bank account "Stripe" whose feed is the connected account's
 * balance (charges gross, fees as their own lines, payouts), and the ability
 * to pay another company's invoice from the card the owner saved on ai3.co,
 * booked here the moment it happens. Fees post to 5300 Payment processing on
 * sight; everything else goes through the same matcher as any bank feed.
 */
import {
  ACCOUNT,
  LedgerError,
  applyDecision,
  createBankAccount,
  createPaymentMethod,
  getBankAccount,
  getStripeLink,
  importStatementLines,
  listPaymentMethods,
  listStatementLines,
  postTransaction,
  runReconciliation,
  saveStripeLink,
  type BankAccount,
  type CompanySettings,
  type LedgerDb,
  type ParsedLine,
  type StripeLink,
  resolveCode,

} from '../core/index.js';
import { ai3Call, isConnected, type FetchLike } from './ai3.js';

export interface StripeRemote {
  connected: boolean;
  accountId: string | null;
  type: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  defaultCurrency: string | null;
  requirementsDue: string[];
  disabledReason: string | null;
  test: boolean;
  card: { brand: string; last4: string | null; expMonth: number | null; expYear: number | null } | null;
  cardUrl: string | null;
  creditsUrl: string | null;
  dashboardUrl: string | null;
  onboardingUrl?: string | null | undefined;
  warning?: string | undefined;
}

export interface StripeFeedLine { id: string; at: string; amountMinor: string; currency: string; description: string; payee: string | null; reference: string | null; kind: string; sourceId: string | null; invoiceNumber: string | null }

export const STRIPE_BANK_NAME = 'Stripe';
export const STRIPE_CARD_BANK_NAME = 'Card on file (Stripe)';
export const STRIPE_METHOD_LABEL = 'Pay by card';

function asRemote(d: unknown): StripeRemote {
  const r = (d && typeof d === 'object' ? d : {}) as Partial<StripeRemote>;
  return {
    connected: r.connected === true, accountId: r.accountId ?? null, type: r.type ?? null,
    chargesEnabled: r.chargesEnabled === true, payoutsEnabled: r.payoutsEnabled === true, detailsSubmitted: r.detailsSubmitted === true,
    defaultCurrency: r.defaultCurrency ?? null, requirementsDue: Array.isArray(r.requirementsDue) ? r.requirementsDue : [], disabledReason: r.disabledReason ?? null,
    test: r.test === true, card: r.card ?? null, cardUrl: r.cardUrl ?? null, creditsUrl: r.creditsUrl ?? null, dashboardUrl: r.dashboardUrl ?? null,
    onboardingUrl: r.onboardingUrl ?? null, warning: r.warning,
  };
}

/** Ask ai3.co where the company's Stripe stands. */
export async function stripeStatus(fetch: FetchLike, settings: CompanySettings, companyId: string): Promise<StripeRemote> {
  return asRemote(await ai3Call(fetch, settings, '/api/ledger/stripe/status', { companyId }));
}

/**
 * Give the company its Stripe bank account and the invoice payment option
 * once the connected account exists. Idempotent.
 */
export async function ensureStripeAccounts(db: LedgerDb, companyId: string, remote: StripeRemote, baseCurrency: string): Promise<StripeLink> {
  let link = await getStripeLink(db, companyId);
  const patch: Partial<StripeLink> = { accountId: remote.accountId, chargesEnabled: remote.chargesEnabled, payoutsEnabled: remote.payoutsEnabled, detailsSubmitted: remote.detailsSubmitted };
  if (remote.accountId) {
    if (!link?.bankAccountId) {
      const bank = await createBankAccount(db, companyId, { name: STRIPE_BANK_NAME, kind: 'stripe', currency: remote.defaultCurrency ?? baseCurrency, feed: 'stripe', externalRef: `stripe:${remote.accountId}` });
      patch.bankAccountId = bank.id;
      patch.feedCursorUnix = link?.feedCursorUnix || Math.floor(Date.now() / 1000) - 24 * 3600;
    }
    if (!link?.paymentMethodId) {
      const have = (await listPaymentMethods(db, companyId)).find((m) => m.kind === 'stripe' && m.details.account === remote.accountId);
      patch.paymentMethodId = have?.id ?? (await createPaymentMethod(db, companyId, { kind: 'stripe', label: STRIPE_METHOD_LABEL, currency: null, details: { account: remote.accountId }, isDefault: true })).id;
    }
  }
  link = await saveStripeLink(db, companyId, patch);
  return link;
}

/** Connect (create the account on first call) and get a fresh onboarding link until Stripe says charges are on. */
export async function connectStripe(db: LedgerDb, fetch: FetchLike, settings: CompanySettings, companyId: string, input: { email?: string | null; country?: string | null; companyName?: string | null }, baseCurrency: string): Promise<{ remote: StripeRemote; link: StripeLink }> {
  const remote = asRemote(await ai3Call(fetch, settings, '/api/ledger/stripe/connect', { companyId, email: input.email ?? undefined, country: input.country ?? undefined, companyName: input.companyName ?? undefined }));
  const link = await ensureStripeAccounts(db, companyId, remote, baseCurrency);
  return { remote, link };
}

/** Refresh the flags from Stripe and make sure the accounts exist. */
export async function refreshStripe(db: LedgerDb, fetch: FetchLike, settings: CompanySettings, companyId: string, baseCurrency: string): Promise<{ remote: StripeRemote; link: StripeLink | null }> {
  if (!isConnected(settings)) return { remote: asRemote({}), link: await getStripeLink(db, companyId) };
  const remote = await stripeStatus(fetch, settings, companyId);
  const link = remote.accountId ? await ensureStripeAccounts(db, companyId, remote, baseCurrency) : await getStripeLink(db, companyId);
  return { remote, link };
}

/** Feed lines from ai3.co as the statement lines the matcher reads. */
export function linesFromStripe(lines: StripeFeedLine[]): ParsedLine[] {
  return lines.filter((l) => /^-?\d+$/.test(String(l.amountMinor)) && BigInt(l.amountMinor) !== 0n).map((l) => ({
    postedAt: l.at,
    amountMinor: BigInt(l.amountMinor),
    description: l.description,
    ...(l.payee ? { payee: l.payee } : {}),
    ...(l.reference ? { reference: l.reference } : {}),
    externalId: `stripe:${l.id}`,
  }));
}

const MAX_PAGES = 10;

/**
 * Read new balance transactions on the connected account into the Stripe
 * bank account, post the fees, then let the matcher post what it is sure of
 * (a charge whose description carries the invoice number pays that invoice).
 */
export async function syncStripeFeed(db: LedgerDb, fetch: FetchLike, settings: CompanySettings, companyId: string, opts: { autoPost?: boolean; by?: string } = {}): Promise<{ imported: number; duplicates: number; autoPosted: number; leftForReview: number; cursorUnix: number } | null> {
  const link = await getStripeLink(db, companyId);
  if (!link?.accountId || !link.bankAccountId || !isConnected(settings)) return null;
  const bank = await getBankAccount(db, companyId, link.bankAccountId);
  if (!bank) return null;
  let cursor = link.feedCursorUnix;
  let imported = 0;
  let duplicates = 0;
  let feeLines = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = (await ai3Call(fetch, settings, '/api/ledger/stripe/transactions', { companyId, sinceUnix: cursor, limit: 100 })) as { lines?: StripeFeedLine[]; cursorUnix?: number; hasMore?: boolean };
    const lines = Array.isArray(r.lines) ? r.lines : [];
    if (lines.length > 0) {
      const res = await importStatementLines(db, companyId, bank.id, linesFromStripe(lines));
      imported += res.imported;
      duplicates += res.duplicates;
      feeLines += lines.filter((l) => l.kind === 'fee').length;
    }
    const nextCursor = Number(r.cursorUnix ?? cursor);
    if (nextCursor > cursor) cursor = nextCursor;
    if (!r.hasMore || lines.length === 0 || nextCursor <= link.feedCursorUnix) break;
  }
  await saveStripeLink(db, companyId, { feedCursorUnix: cursor, lastSyncedAt: new Date().toISOString() });
  // Fees are Stripe's and nobody else's: post them straight to payment processing.
  let settled = 0;
  if (imported > 0 && feeLines > 0) {
    const by = opts.by ?? 'stripe-feed';
    for (const line of await listStatementLines(db, companyId, bank.id, { status: 'unreconciled', limit: 500 })) {
      if (!line.externalId?.endsWith(':fee') || BigInt(line.amountMinor) >= 0n) continue;
      try {
        await applyDecision(db, companyId, line.id, { kind: 'create', accountCode: ACCOUNT.PAYMENT_PROCESSING, description: line.description, contactName: 'Stripe', reason: 'A Stripe processing fee, taken from the payment it belongs to.' }, by);
        settled += 1;
      } catch { /* the matcher and the person get it */ }
    }
  }
  const run = imported > 0 ? await runReconciliation(db, companyId, bank.id, { autoPost: opts.autoPost ?? true, by: opts.by ?? 'stripe-feed' }) : { autoPosted: 0, leftForReview: 0 };
  return { imported, duplicates, autoPosted: run.autoPosted + settled, leftForReview: run.leftForReview, cursorUnix: cursor };
}

/** The bank account the company's saved card is booked against. Created on first use. */
export async function ensureCardAccount(db: LedgerDb, companyId: string, currency: string): Promise<BankAccount> {
  const link = await getStripeLink(db, companyId);
  if (link?.cardBankAccountId) {
    const have = await getBankAccount(db, companyId, link.cardBankAccountId);
    if (have) return have;
  }
  const bank = await createBankAccount(db, companyId, { name: STRIPE_CARD_BANK_NAME, kind: 'card', currency, feed: 'upload', externalRef: 'stripe:card' });
  await saveStripeLink(db, companyId, { cardBankAccountId: bank.id });
  return bank;
}

export interface CardPaymentResult { paymentIntentId: string; amountMinor: bigint; currency: string; invoiceNumber: string; seller: string; feeMinor: string; at: string; card: { brand: string; last4: string | null } | null; accountCode: string }

/**
 * Pay another company's hosted invoice from the card the owner saved on
 * ai3.co. The platform charges the card and the seller's connected account
 * receives it. Booked here at once: the expense, credited to the card account.
 */
export async function payInvoiceByCard(db: LedgerDb, fetch: FetchLike, settings: CompanySettings, companyId: string, input: { invoiceUrl: string; amountCents: bigint | null; description: string | null; accountCode: string | null; by: string }): Promise<CardPaymentResult> {
  if (!isConnected(settings)) throw new LedgerError('paying by card needs the ai3.co connection (Finance › Settings)', 'invalid');
  const r = (await ai3Call(fetch, settings, '/api/ledger/stripe/pay', { companyId, invoiceUrl: input.invoiceUrl, amountMinor: input.amountCents === null ? undefined : input.amountCents.toString() })) as { paymentIntentId: string; status: string; amountMinor: string; currency: string; invoiceNumber: string; seller: string; feeMinor: string; at: string; card: { brand: string; last4: string | null } | null };
  const amount = BigInt(r.amountMinor);
  // Resolved here rather than at posting, because the code is also reported
  // back to the caller and put on the record.
  const code = await resolveCode(db, companyId, input.accountCode ?? ACCOUNT.OTHER_OPERATING);
  const bank = await ensureCardAccount(db, companyId, r.currency);
  await postTransaction(db, {
    companyId, occurredAt: new Date(r.at || Date.now()), description: input.description ?? `Invoice ${r.invoiceNumber} from ${r.seller} · card`,
    sourcePlatform: 'stripe', sourceKind: 'payment', sourceRef: `stripe:${r.paymentIntentId}`, currency: r.currency,
    entries: [{ accountCode: code, direction: 'debit', amountMinor: amount }, { accountCode: bank.accountCode, direction: 'credit', amountMinor: amount }], createdBy: input.by,
  });
  return { paymentIntentId: r.paymentIntentId, amountMinor: amount, currency: r.currency, invoiceNumber: r.invoiceNumber, seller: r.seller, feeMinor: r.feeMinor, at: r.at, card: r.card, accountCode: code };
}
