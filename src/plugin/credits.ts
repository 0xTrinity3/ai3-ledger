/**
 * Model credits: the prepaid balance a hosted company holds with ai3.co.
 *
 * ai3.co meters model usage on the company's platform key and keeps the
 * balance; the ledger asks for it with the company key and books it so the
 * books agree with the platform. A grant or a card top-up is money put in
 * (1300 Prepaid model credits against 3000 Contributed funds); a pathUSD
 * top-up already leaves the company's wallet and is booked by the chain feed
 * as a transfer into 1300, so it is skipped here; usage is booked as the
 * difference between what ai3.co has charged to date and what the books
 * already carry (5000 Model inference against 1300), replay-safe because the
 * reference is the cumulative total.
 */
import { ACCOUNT, postTransaction, sumPostedBySource, type CompanySettings, type LedgerDb } from '../core/index.js';
import { ai3Call, isConnected, type FetchLike } from './ai3.js';

export interface CreditsEntry { at: string; amountMinor: string; kind: string; ref: string | null }

export interface CreditsView {
  hosted: boolean;
  keyed: boolean;
  slug: string | null;
  at: string | null;
  markup: number;
  platformWallet: string | null;
  memo: string | null;
  creditsUrl: string | null;
  modelUrl: string | null;
  grantedMinor: string;
  usageMinor: string;
  chargedMinor: string;
  remainingMinor: string;
  usageMonthlyMinor: string;
  keyDisabled: boolean;
  entries: CreditsEntry[];
  message?: string | null;
}

export const CREDITS_PLATFORM = 'ai3-credits';

export async function fetchCredits(fetch: FetchLike, settings: CompanySettings, companyId: string): Promise<CreditsView> {
  const r = (await ai3Call(fetch, settings, '/api/ledger/credits', { companyId })) as Partial<CreditsView>;
  return {
    hosted: r.hosted === true, keyed: r.keyed === true, slug: r.slug ?? null, at: r.at ?? null, markup: Number(r.markup ?? 0.2), platformWallet: r.platformWallet ?? null, memo: r.memo ?? null,
    creditsUrl: r.creditsUrl ?? null, modelUrl: r.modelUrl ?? null, grantedMinor: String(r.grantedMinor ?? '0'), usageMinor: String(r.usageMinor ?? '0'), chargedMinor: String(r.chargedMinor ?? '0'),
    remainingMinor: String(r.remainingMinor ?? '0'), usageMonthlyMinor: String(r.usageMonthlyMinor ?? '0'), keyDisabled: r.keyDisabled === true, entries: Array.isArray(r.entries) ? r.entries : [], message: r.message ?? null,
  };
}

export interface CreditsSyncResult { fetched: boolean; grantsBooked: number; usageBookedMinor: string; chargedMinor: string; remainingMinor: string; skipped: string | null }

/** Grants that are money put in by the owner or AI3. A pathUSD top-up left the wallet and is booked by the chain feed. */
const GRANT_KINDS = new Set(['free', 'admin', 'stripe', 'card', 'grant', 'promo']);

/** Bring the books level with ai3.co. Safe to run every hour; nothing is posted twice. */
export async function syncCredits(db: LedgerDb, fetch: FetchLike, settings: CompanySettings, companyId: string, by = 'credits'): Promise<CreditsSyncResult> {
  const out: CreditsSyncResult = { fetched: false, grantsBooked: 0, usageBookedMinor: '0', chargedMinor: '0', remainingMinor: '0', skipped: null };
  if (!isConnected(settings)) { out.skipped = 'not connected to ai3.co'; return out; }
  const v = await fetchCredits(fetch, settings, companyId);
  out.fetched = true;
  out.chargedMinor = v.chargedMinor;
  out.remainingMinor = v.remainingMinor;
  if (!v.hosted || !v.keyed) { out.skipped = v.hosted ? 'the company runs on its own model key' : 'not a hosted company'; return out; }
  const currency = settings.baseCurrency;
  for (const e of v.entries) {
    if (!GRANT_KINDS.has(e.kind)) continue;
    const amount = BigInt(e.amountMinor);
    if (amount <= 0n) continue;
    const ref = `credits:${e.ref ?? `${e.kind}:${e.at}`}`;
    const r = await postTransaction(db, {
      companyId, occurredAt: e.at, description: e.kind === 'free' ? 'AI3 starter credit' : e.kind === 'admin' ? `AI3 credit grant${e.ref ? ` · ${e.ref}` : ''}` : `Model credits topped up by card${e.ref ? ` · ${e.ref}` : ''}`,
      sourcePlatform: CREDITS_PLATFORM, sourceKind: 'funding', sourceRef: ref, currency, createdBy: by,
      entries: [{ accountCode: ACCOUNT.PREPAID_CREDITS, direction: 'debit', amountMinor: amount }, { accountCode: ACCOUNT.CONTRIBUTED_FUNDS, direction: 'credit', amountMinor: amount }],
    });
    if (r.inserted) out.grantsBooked += 1;
  }
  const charged = BigInt(v.chargedMinor);
  const booked = await sumPostedBySource(db, companyId, CREDITS_PLATFORM, 'cost_sweep', ACCOUNT.MODEL_INFERENCE, 'debit');
  const delta = charged - booked;
  if (delta > 0n) {
    const r = await postTransaction(db, {
      companyId, occurredAt: new Date(), description: `Model usage through AI3 (at cost plus ${Math.round(v.markup * 100)}%)`,
      sourcePlatform: CREDITS_PLATFORM, sourceKind: 'cost_sweep', sourceRef: `credits:usage:${charged.toString()}`, currency, createdBy: by,
      entries: [{ accountCode: ACCOUNT.MODEL_INFERENCE, direction: 'debit', amountMinor: delta }, { accountCode: ACCOUNT.PREPAID_CREDITS, direction: 'credit', amountMinor: delta }],
    });
    if (r.inserted) out.usageBookedMinor = delta.toString();
  }
  return out;
}
