/**
 * Recourse: the dispute venue, used the way it was built for agents.
 *
 * No account. The company signs a Sign-In-With-Ethereum message with its
 * wallet key whose statement is its consent to the Standard Rules; that
 * signature is who it is and its venue agreement. The case fee travels with
 * the request as an x402 authorization (USDC on Base); the venue runs in
 * sandbox today, so a well-formed authorization is accepted and nothing
 * moves. The ruling names who owes what; the tempo rail turns that into
 * stablecoin transfer intents the holder executes.
 */
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import type { Invoice } from '../core/index.js';

export const RECOURSE_ORIGIN = 'https://recourse.so';
export const RULES_URL = 'https://recourse.so/rules/v1.0';
export const RULEPACK = 'marketplace-contractor-v1';
/** The clause every invoice carries, by reference to the published Rules. */
export const DISPUTE_CLAUSE = `Any dispute arising from this invoice is determined by Recourse under the Recourse Standard Rules v1.0 (${RULES_URL}), final and binding as a matter of contract.`;

export interface Requirements {
  network: string;
  sandbox: boolean;
  case_fee_minor: number;
  consent_statement: string;
  accepts: Array<{ scheme: string; network: string; maxAmountRequired: string; payTo: string; asset: string; resource: string; maxTimeoutSeconds: number; extra?: Record<string, string> }>;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class RecourseError extends Error {}

export async function requirements(fetch: FetchLike, origin = RECOURSE_ORIGIN): Promise<Requirements> {
  const r = await fetch(`${origin}/x402/requirements`);
  if (!r.ok) throw new RecourseError(`Recourse answered ${r.status} for requirements`);
  return (await r.json()) as Requirements;
}

function chainIdFor(network: string): number {
  return network === 'base-sepolia' ? 84532 : 8453;
}

/** EIP-4361 message in the exact layout the venue parses. */
export function siweMessage(p: { domain: string; address: string; statement: string; uri: string; chainId: number; nonce: string; issuedAt: string }): string {
  return `${p.domain} wants you to sign in with your Ethereum account:\n${p.address}\n\n${p.statement}\n\nURI: ${p.uri}\nVersion: 1\nChain ID: ${p.chainId}\nNonce: ${p.nonce}\nIssued At: ${p.issuedAt}`;
}

function nonce(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The X-Sign-In-With-X header: base64 JSON of address, message, signature. */
export async function signInHeader(privateKey: Hex, req: Requirements, origin = RECOURSE_ORIGIN): Promise<string> {
  const account = privateKeyToAccount(privateKey);
  const domain = new URL(origin).host;
  const message = siweMessage({ domain, address: account.address, statement: req.consent_statement, uri: `${origin}/disputes`, chainId: chainIdFor(req.network), nonce: nonce(), issuedAt: new Date().toISOString() });
  const signature = await account.signMessage({ message });
  return Buffer.from(JSON.stringify({ address: account.address, message, signature, chainId: chainIdFor(req.network) }), 'utf8').toString('base64');
}

/**
 * The X-PAYMENT header: an x402 "exact" authorization for the case fee from
 * the wallet to the venue. The venue's facilitator, when it has one, verifies
 * and settles it as USDC on Base; in sandbox the shape is checked and nothing
 * moves. The authorization is signed with the wallet key so it is attributable.
 */
export async function paymentHeader(privateKey: Hex, req: Requirements): Promise<string> {
  const account = privateKeyToAccount(privateKey);
  const accept = req.accepts[0];
  if (!accept) throw new RecourseError('Recourse published no payment terms');
  const now = Math.floor(Date.now() / 1000);
  const authorization = { from: account.address, to: accept.payTo, value: accept.maxAmountRequired, validAfter: String(now - 60), validBefore: String(now + accept.maxTimeoutSeconds), nonce: `0x${nonce()}${nonce()}${nonce()}`.slice(0, 66) };
  const signature = await account.signMessage({ message: JSON.stringify(authorization) });
  const payload = { x402Version: 1, scheme: accept.scheme, network: accept.network, payload: { signature, authorization } };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

export interface LogEntry { at: string; actor: 'claimant' | 'respondent' | 'platform' | 'system'; kind: 'message' | 'delivery' | 'payment' | 'revision_request' | 'status_change' | 'other'; content: string }
export interface Deliverable { name: string; description?: string; content?: string; url?: string }

export interface BundleInput {
  /** Who opened the case. The buyer is always the claimant and the provider the respondent. */
  role: 'claimant' | 'respondent';
  invoice: { number: string; currency: string; totalMinor: string; outstandingMinor: string; issuedAt: string | null; dueAt: string | null; lines: Array<{ description: string; quantity: string; amountMinor: string }>; notes: string | null; url: string | null; sellerName: string; buyerName: string; sentAt?: string | null; openedAt?: string | null; payments?: Array<{ occurredAt: string; amountMinor: string; reference: string | null }> };
  breach: string;
  remedy?: string | null;
  evidence?: string | null;
  amountMinor?: bigint | null;
  claimantAddress: string;
  respondentAddress: string;
  externalRef: string;
  appealWindowHours?: number;
}

/** The dispute bundle: the invoice is the contract, its history is the log. */
export function buildBundle(input: BundleInput): Record<string, unknown> {
  const inv = input.invoice;
  const money = (m: string) => `${(Number(m) / 100).toFixed(2)} ${inv.currency}`;
  const terms = [
    `Invoice ${inv.number} from ${inv.sellerName} to ${inv.buyerName}${inv.issuedAt ? `, issued ${inv.issuedAt.slice(0, 10)}` : ''}${inv.dueAt ? `, due ${inv.dueAt.slice(0, 10)}` : ''}.`,
    `Total ${money(inv.totalMinor)}; outstanding ${money(inv.outstandingMinor)}.`,
    'Lines:',
    ...inv.lines.map((l) => `- ${l.description} × ${l.quantity}: ${money(l.amountMinor)}`),
    ...(inv.notes ? ['Notes:', inv.notes] : []),
    ...(inv.url ? [`Online copy: ${inv.url}`] : []),
    '',
    DISPUTE_CLAUSE,
  ].join('\n');
  // At the venue the sides are fixed: the claimant is the buyer, the respondent
  // is the provider, whichever of them opened the case (`claim.by`).
  const log: LogEntry[] = [];
  if (inv.issuedAt) log.push({ at: inv.issuedAt, actor: 'respondent', kind: 'status_change', content: `${inv.sellerName} issued invoice ${inv.number} for ${money(inv.totalMinor)}.` });
  if (inv.sentAt) log.push({ at: inv.sentAt, actor: 'platform', kind: 'message', content: `Invoice ${inv.number} emailed to ${inv.buyerName}.` });
  if (inv.openedAt) log.push({ at: inv.openedAt, actor: 'claimant', kind: 'other', content: `${inv.buyerName} opened the invoice.` });
  for (const p of inv.payments ?? []) log.push({ at: p.occurredAt, actor: 'claimant', kind: 'payment', content: `Payment of ${money(p.amountMinor)}${p.reference ? ` (${p.reference})` : ''}.` });
  log.push({ at: new Date().toISOString(), actor: input.role, kind: 'message', content: input.breach });
  if (input.evidence) log.push({ at: new Date().toISOString(), actor: input.role, kind: 'other', content: input.evidence });
  log.sort((a, b) => a.at.localeCompare(b.at));
  const deliverables: Deliverable[] = inv.lines.map((l) => ({ name: l.description, description: `${l.quantity} × ${money(l.amountMinor)}` }));
  if (inv.url) deliverables.push({ name: `Invoice ${inv.number}`, url: inv.url });
  return {
    external_ref: input.externalRef,
    rulepack: RULEPACK,
    currency: inv.currency,
    amount_minor: Number(input.amountMinor ?? BigInt(inv.outstandingMinor)),
    terms: { format: 'text', content: terms },
    claim: { by: input.role, claimed_breach: input.breach, ...(input.remedy ? { remedy_sought: input.remedy } : {}) },
    log,
    deliverables,
    // Money moves on Tempo in pathUSD, so only a USD invoice gets a rail; other currencies get a ruling and no instruction.
    ...(inv.currency === 'USD' ? { settlement: { rail: 'tempo', network: 'tempo-testnet', asset: 'pathUSD', respondent_address: input.respondentAddress, claimant_address: input.claimantAddress } } : {}),
    metadata: { source: 'ai3-ledger', invoice: inv.number },
    ...(input.appealWindowHours !== undefined ? { appeal_window_hours: input.appealWindowHours } : {}),
  };
}

export interface Ruling {
  dispute_id: string;
  rulepack: string;
  fault_allocation: { claimant_pct: number; respondent_pct: number };
  money_instruction: { type: 'release' | 'refund' | 'split' | 'declaratory'; to_respondent_minor: number; to_claimant_minor: number; currency: string };
  summary: string;
  reasoning: Array<{ rule_id: string; finding: string; application: string }>;
  confidence: number;
  escalate: boolean;
  escalation_reason?: string;
  tier: number;
}

export interface CaseRecord {
  id: string;
  status: string;
  ruling?: Ruling | null;
  rail_instruction?: { rail: string; network?: string; transfer_intents?: Array<{ to: string; amount_minor: number; asset: string; memo: string }> } | null;
  progress?: string;
  result?: string;
  error?: string;
  [k: string]: unknown;
}

/** File the bundle. Asks for an async answer and polls the result for up to `waitMs`. */
export async function fileDispute(fetch: FetchLike, privateKey: Hex, bundle: Record<string, unknown>, opts: { origin?: string; waitMs?: number } = {}): Promise<CaseRecord> {
  const origin = opts.origin ?? RECOURSE_ORIGIN;
  const req = await requirements(fetch, origin);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-sign-in-with-x': await signInHeader(privateKey, req, origin),
    'x-payment': await paymentHeader(privateKey, req),
    prefer: 'respond-async',
  };
  const r = await fetch(`${origin}/disputes`, { method: 'POST', headers, body: JSON.stringify(bundle) });
  const text = await r.text().catch(() => '');
  let body: CaseRecord;
  try { body = JSON.parse(text) as CaseRecord; } catch { throw new RecourseError(`Recourse answered ${r.status}: ${text.slice(0, 200)}`); }
  if (r.status === 402) throw new RecourseError(`Recourse wants payment: ${(body as { error?: string }).error ?? 'case fee'}`);
  if (!r.ok) throw new RecourseError(`Recourse refused the dispute (${r.status}): ${(body as { error?: string }).error ?? text.slice(0, 200)}`);
  if (r.status === 201) return body;
  // 202: pending. Poll the result URL until the ruling lands or we run out of patience.
  const deadline = Date.now() + (opts.waitMs ?? 90_000);
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 5_000));
    const c = await getCase(fetch, body.id, origin);
    if (c.status && c.status !== 'pending') return c;
  }
  return { ...body, status: 'pending' };
}

export async function getCase(fetch: FetchLike, id: string, origin = RECOURSE_ORIGIN): Promise<CaseRecord> {
  const r = await fetch(`${origin}/disputes/${encodeURIComponent(id)}`);
  const text = await r.text().catch(() => '');
  try { return JSON.parse(text) as CaseRecord; } catch { throw new RecourseError(`Recourse answered ${r.status} for case ${id}`); }
}

/** A one-paragraph account of a ruling, for tool replies and task comments. */
export function describeRuling(ruling: Ruling): string {
  const m = ruling.money_instruction;
  const money = (n: number) => `${(n / 100).toFixed(2)} ${m.currency}`;
  const outcome = m.type === 'declaratory' ? 'no money moves' : m.type === 'release' ? `${money(m.to_respondent_minor)} to the respondent` : m.type === 'refund' ? `${money(m.to_claimant_minor)} back to the claimant` : `${money(m.to_respondent_minor)} to the respondent and ${money(m.to_claimant_minor)} to the claimant`;
  return `Ruling (tier ${ruling.tier}, confidence ${Math.round(ruling.confidence * 100)}%): fault ${ruling.fault_allocation.claimant_pct}% claimant / ${ruling.fault_allocation.respondent_pct}% respondent; ${outcome}.${ruling.escalate ? ` Escalated: ${ruling.escalation_reason ?? 'for review'}.` : ''} ${ruling.summary}`;
}

/** Keep the invoice type import honest for callers that pass a ledger invoice straight through. */
export function invoiceForBundle(inv: Invoice, sellerName: string): BundleInput['invoice'] {
  return {
    number: inv.number,
    currency: inv.currency,
    totalMinor: inv.totalMinor,
    outstandingMinor: inv.outstandingMinor,
    issuedAt: inv.issuedAt,
    dueAt: inv.dueAt,
    lines: inv.lines.map((l) => ({ description: l.description, quantity: l.quantity, amountMinor: l.amountMinor })),
    notes: inv.notes,
    url: inv.hosted?.url ?? null,
    sellerName,
    buyerName: inv.customerName,
    sentAt: inv.hosted?.sentAt ?? null,
    openedAt: inv.hosted?.openedAt ?? null,
    payments: inv.payments.map((p) => ({ occurredAt: p.occurredAt, amountMinor: p.amountMinor, reference: p.reference })),
  };
}
