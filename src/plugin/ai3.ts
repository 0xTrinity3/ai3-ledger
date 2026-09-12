/**
 * The connection to ai3.co: hosted invoice pages and sending.
 *
 * Outbound only, over the host's HTTP client, with the company's key. ai3.co
 * never connects in. What travels is the invoice document: number, customer,
 * lines, totals, currency, payment options, notes, and who issued it. Nothing
 * from Paperclip's own tables.
 */
import type { CompanySettings, Invoice } from '../core/index.js';
import { DISPUTE_CLAUSE } from './recourse.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface HostedResult { token: string; url: string }
export interface HostedStatus { token: string; url: string; revoked: boolean; sentAt: string | null; sentTo: string | null; openedAt: string | null; openCount: number; paidAt: string | null; sender?: { email: string; via: string } | null; payments?: Array<{ at: string; amountMinor: string; currency: string; via: string; ref: string; network?: string | null; from?: string | null; explorer?: string | null }> }

export class Ai3Error extends Error { constructor(message: string) { super(message); this.name = 'Ai3Error'; } }

export function isConnected(settings: CompanySettings): boolean {
  return Boolean(settings.ai3Key && settings.ai3Origin);
}

export async function ai3Call(fetch: FetchLike, settings: CompanySettings, path: string, body: unknown): Promise<unknown> {
  if (!isConnected(settings)) throw new Ai3Error('Not connected to ai3.co. Add the company key under Finance › Settings.');
  const r = await fetch(`${settings.ai3Origin!.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.ai3Key}`, 'user-agent': 'ai3-ledger-plugin' },
    body: JSON.stringify(body),
  });
  const text = await r.text().catch(() => '');
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!r.ok) {
    const msg = data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string' ? (data as { error: string }).error : `ai3.co answered ${r.status}`;
    throw new Ai3Error(msg);
  }
  return data;
}

/** The document as the hosted page shows it. */
export function invoiceDocument(inv: Invoice, settings: CompanySettings, companyName: string): Record<string, unknown> {
  return {
    invoiceId: inv.id,
    publicId: inv.publicId,
    number: inv.number,
    status: inv.status,
    currency: inv.currency,
    issuedAt: inv.issuedAt,
    dueAt: inv.dueAt,
    subtotalMinor: inv.subtotalMinor,
    taxMinor: inv.taxMinor,
    totalMinor: inv.totalMinor,
    paidMinor: inv.paidMinor,
    outstandingMinor: inv.outstandingMinor,
    lines: inv.lines,
    paymentMethods: inv.paymentMethods,
    notes: inv.notes,
    customer: { name: inv.customerName, email: inv.customerEmail },
    company: { name: settings.legalName || companyName, address: settings.address, email: settings.email, taxId: settings.taxId, footer: settings.invoiceFooter },
    disputes: DISPUTE_CLAUSE,
  };
}

/** Create or update the hosted page for an invoice. Idempotent on invoiceId. */
export async function publishInvoice(fetch: FetchLike, settings: CompanySettings, inv: Invoice, companyName: string): Promise<HostedResult> {
  const r = (await ai3Call(fetch, settings, '/api/ledger/invoices', { companyId: inv.companyId, invoice: invoiceDocument(inv, settings, companyName) })) as Partial<HostedStatus>;
  if (!r.token || !r.url) throw new Ai3Error('ai3.co returned no page for the invoice');
  return { token: r.token, url: r.url, ...(r.sender !== undefined ? { sender: r.sender } : {}) } as HostedResult & { sender?: { email: string; via: string } | null };
}

export async function sendInvoice(
  fetch: FetchLike,
  settings: CompanySettings,
  input: { companyId: string; token: string; to: string; cc?: string | null; subject?: string | null; message?: string | null; replyTo?: string | null },
): Promise<{ sentAt: string; from: string; via: string }> {
  return (await ai3Call(fetch, settings, `/api/ledger/invoices/${encodeURIComponent(input.token)}/send`, input)) as { sentAt: string; from: string; via: string };
}

export async function hostedStatus(fetch: FetchLike, settings: CompanySettings, companyId: string, token: string): Promise<HostedStatus> {
  return (await ai3Call(fetch, settings, `/api/ledger/invoices/${encodeURIComponent(token)}/status`, { companyId })) as HostedStatus;
}

export async function revokeInvoice(fetch: FetchLike, settings: CompanySettings, companyId: string, token: string): Promise<void> {
  await ai3Call(fetch, settings, `/api/ledger/invoices/${encodeURIComponent(token)}/revoke`, { companyId });
}
