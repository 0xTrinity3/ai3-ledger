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
import { ACCOUNT, agentTokens, allocate, postTransaction, sumPostedBySource, table, type CompanySettings, type LedgerDb,
  resolveCode,
} from '../core/index.js';
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

export interface CreditsSyncResult {
  fetched: boolean;
  grantsBooked: number;
  usageBookedMinor: string;
  chargedMinor: string;
  remainingMinor: string;
  skipped: string | null;
  /** How many agents the usage was split across. */
  attributedToAgents?: number;
  /** The part nobody caused, left on the company rather than spread over agents. */
  unattributedMinor?: string;
}

/**
 * When model usage was last booked, so the token split covers the same stretch
 * the money does. Nothing booked yet means the window opens a day back, which is
 * the most an hourly job can have missed.
 */
async function lastUsagePostedAt(db: LedgerDb, companyId: string): Promise<Date | null> {
  const rows = await db.sql.query<{ at: string | null }>(
    `SELECT MAX(occurred_at)::text AS at FROM ${table(db, 'transactions')}
      WHERE company_id = $1 AND status = 'posted' AND source_platform = $2 AND source_kind = 'cost_sweep'`,
    [companyId, CREDITS_PLATFORM],
  );
  const at = rows[0]?.at;
  return at ? new Date(at) : null;
}

/** Grants that are money put in by the owner or AI3. A pathUSD top-up left the wallet and is booked by the chain feed. */
const GRANT_KINDS = new Set(['free', 'admin', 'stripe', 'card', 'grant', 'promo']);

/** Bring the books level with ai3.co. Safe to run every hour; nothing is posted twice. */
export async function syncCredits(db: LedgerDb, fetch: FetchLike, settings: CompanySettings, companyId: string, by = 'credits'): Promise<CreditsSyncResult> {
  const out: CreditsSyncResult = { fetched: false, grantsBooked: 0, usageBookedMinor: '0', chargedMinor: '0', remainingMinor: '0', skipped: null, attributedToAgents: 0, unattributedMinor: '0' };
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
    // Attribute the charge to the agents that caused it.
    //
    // The amount is what the provisioned key actually metered: real money, and
    // nothing here computes it. The split comes from Paperclip's own per-agent
    // token counts — which it records even on runs it prices at zero, which is
    // most of them when an agent talks to a model through a CLI. Without this
    // the whole charge lands on the company and on no agent, and every per-agent
    // figure downstream reads zero while real money is being spent.
    const since = (await lastUsagePostedAt(db, companyId)) ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
    const now = new Date();
    let tokens: Awaited<ReturnType<typeof agentTokens>> = [];
    try {
      tokens = await agentTokens(db.sql, companyId, { from: since, to: now });
    } catch {
      // No readable cost events: the charge is still real, so book it whole and
      // unattributed rather than losing it.
      tokens = [];
    }
    const split = allocate(delta, tokens);
    const attributed = split.filter((s) => s.agent !== null);
    const entries = [
      ...split.map((s) => ({
        accountCode: ACCOUNT.MODEL_INFERENCE,
        direction: 'debit' as const,
        amountMinor: s.amountMinor,
        ...(s.agent ? { subject: { agent: s.agent } } : {}),
      })),
      { accountCode: ACCOUNT.PREPAID_CREDITS, direction: 'credit' as const, amountMinor: delta },
    ];
    const r = await postTransaction(db, {
      companyId, occurredAt: now,
      description: attributed.length > 0
        ? `Model usage through AI3 (at cost plus ${Math.round(v.markup * 100)}%), across ${attributed.length} agent${attributed.length === 1 ? '' : 's'}`
        : `Model usage through AI3 (at cost plus ${Math.round(v.markup * 100)}%)`,
      sourcePlatform: CREDITS_PLATFORM, sourceKind: 'cost_sweep', sourceRef: `credits:usage:${charged.toString()}`, currency, createdBy: by,
      entries,
    });
    if (r.inserted) {
      out.usageBookedMinor = delta.toString();
      out.attributedToAgents = attributed.length;
      out.unattributedMinor = (split.find((s) => s.agent === null)?.amountMinor ?? 0n).toString();
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Crypto top-ups: the wallet the money came from
// ---------------------------------------------------------------------------

/**
 * A card top-up tells you the issuer's country. A crypto top-up tells you the
 * account — a public ledger has no choice but to name it — and the transfer
 * itself is signed by that account, so watching it needs no further proof.
 *
 * That makes the top-up the cheapest possible on-ramp to reconciliation: the
 * money the company just spent is the first line it ever sees matched. It is
 * offered, never assumed: watching an address imports everything it does into
 * the company's books, and a personal wallet's history does not belong there.
 *
 * Until the wallet is watched (or its export uploaded), a crypto top-up is
 * real at ai3.co and absent from the books — syncCredits deliberately leaves
 * it to the chain feed, which cannot see a wallet nobody is watching. The
 * offer says so.
 */
export interface WalletOffer {
  address: string;
  /** The bank-account ref prefix ai3.co saw it on ('tempo', 'base'); the caller maps it to a chain. */
  chainRef: string | null;
  txHash: string | null;
  amountMinor: string;
  at: string | null;
  /** How many top-ups came from this address, when it is more than one. */
  topUps: number;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
// A mint comes from the zero address, which sends nothing and owns nothing.
// Live tenant data carries such lines, so the offer has to exclude it.
const ZERO = `0x${'0'.repeat(40)}`;

/**
 * Addresses that paid for credits and are not already watched. Newest first,
 * one entry per address, with the total it has topped up.
 */
export function walletOffers(view: CreditsView, watched: Iterable<string> = []): WalletOffer[] {
  const already = new Set([...watched].map((a) => String(a).toLowerCase()));
  const byAddress = new Map<string, WalletOffer>();
  for (const e of view.entries) {
    const from = (e as CreditsEntry & { from?: { address?: string; chainRef?: string | null; txHash?: string | null; at?: string | null } }).from;
    const address = String(from?.address ?? '').toLowerCase();
    if (!ADDRESS.test(address) || address === ZERO || already.has(address)) continue;
    const amount = /^-?\d+$/.test(String(e.amountMinor)) ? BigInt(e.amountMinor) : 0n;
    const seen = byAddress.get(address);
    if (seen) {
      seen.amountMinor = (BigInt(seen.amountMinor) + amount).toString();
      seen.topUps += 1;
      // Keep the most recent transfer as the one that proves the address.
      if (!seen.at || (from?.at && from.at > seen.at)) { seen.at = from?.at ?? seen.at; seen.txHash = from?.txHash ?? seen.txHash; }
    } else {
      byAddress.set(address, {
        address, chainRef: from?.chainRef ?? null, txHash: from?.txHash ?? null,
        amountMinor: amount.toString(), at: from?.at ?? e.at ?? null, topUps: 1,
      });
    }
  }
  return [...byAddress.values()].sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
}
