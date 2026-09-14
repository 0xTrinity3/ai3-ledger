/**
 * AI3 Ledger — the page inside Paperclip.
 *
 * Layout borrows the conventions of mature accounting software: a page header
 * with breadcrumb, title and primary actions; dashboard cards with one big
 * figure and a caption; status-tabbed lists with a count and total; reports
 * as a titled statement with sections and bold totals, negatives in
 * parentheses. Colours and radii come from the host's theme variables so the
 * page sits naturally in light and dark mode.
 *
 * Reads go through `usePluginData` (worker data providers) and writes through
 * `usePluginAction` (worker actions). The host scopes both to the company on
 * screen, so the page never names a company id itself.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useHostContext, useHostLocation, useHostNavigation, usePluginAction, usePluginData, usePluginToast, ErrorBoundary, Spinner } from '@paperclipai/plugin-sdk/ui';
import type { PluginPageProps, PluginSidebarProps } from '@paperclipai/plugin-sdk/ui';
import { BillsTab, EntriesView, ImportTab, JournalsTab, TransactionDetail, TrialBalanceCard, entriesLink } from './books.js';
import { connectWallet, discoverWallets, sendToken, signMessage, short, waitForReceipt, WalletError, type ChainInfo, type DiscoveredWallet } from './wallet.js';

// Settings › Model lives in its own file; the host loads it by export name.
export { ModelSettings } from './model.js';

// ---------------------------------------------------------------------------
// Theme: one stylesheet, host variables, own class names.
// ---------------------------------------------------------------------------

const CSS = `
.ai3 { --ai3-blue: #1f6fcf; --ai3-blue-soft: rgba(31,111,207,.12); --ai3-green: #0b7a55; --ai3-green-soft: rgba(11,122,85,.12); --ai3-red: #c8372d; --ai3-amber: #9a6b00; --ai3-amber-soft: rgba(154,107,0,.12);
  color: var(--foreground, #111); font-size: 14px; line-height: 1.45; max-width: 1180px; margin: 0 auto; padding: 8px 24px 48px; }
.ai3 * { box-sizing: border-box; }
.ai3 a { color: var(--ai3-blue); text-decoration: none; }
.ai3 a:hover { text-decoration: underline; }
.ai3-crumb { font-size: 12px; color: var(--muted-foreground, #666); margin: 8px 0 2px; }
.ai3-crumb a { color: var(--muted-foreground, #666); }
.ai3-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 18px; }
.ai3-head h1 { font-size: 26px; font-weight: 600; letter-spacing: -.01em; margin: 0; }
.ai3-head .ai3-sub { color: var(--muted-foreground, #666); margin-top: 2px; }
.ai3-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.ai3-btn { display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; border-radius: var(--radius, 6px); border: 1px solid var(--border, #ddd); background: var(--card, #fff); color: var(--foreground, #111); font: inherit; font-weight: 500; cursor: pointer; white-space: nowrap; }
.ai3-btn:hover { background: var(--accent, #f5f5f5); }
.ai3-btn:disabled { opacity: .5; cursor: default; }
.ai3-btn.primary { background: var(--ai3-blue); border-color: var(--ai3-blue); color: #fff; }
.ai3-btn.primary:hover { filter: brightness(.95); }
.ai3-btn.small { padding: 4px 10px; font-size: 13px; }
.ai3-btn.danger { color: var(--ai3-red); }
.ai3-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border, #ddd); margin: 0 0 14px; overflow-x: auto; }
.ai3-tab { padding: 10px 14px; border: 0; border-bottom: 2px solid transparent; background: none; color: var(--muted-foreground, #666); font: inherit; font-weight: 500; cursor: pointer; white-space: nowrap; margin-bottom: -1px; }
.ai3-tab:hover { color: var(--foreground, #111); }
.ai3-tab.on { color: var(--foreground, #111); border-bottom-color: var(--ai3-blue); }
.ai3-tab .n { color: var(--muted-foreground, #666); font-weight: 400; margin-left: 4px; }
.ai3-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 14px; margin-bottom: 14px; }
.ai3-grid.two { grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); }
.ai3-card { background: var(--card, #fff); border: 1px solid var(--border, #ddd); border-radius: 10px; padding: 16px 18px; min-width: 0; }
.ai3-card h3 { margin: 0 0 10px; font-size: 15px; font-weight: 600; display: flex; align-items: baseline; gap: 6px; }
.ai3-card h3 .ctx { font-weight: 400; color: var(--muted-foreground, #666); font-size: 14px; }
.ai3-card h3 .ctx::before { content: "•"; margin-right: 6px; }
.ai3-big { font-size: 26px; font-weight: 500; letter-spacing: -.01em; font-variant-numeric: tabular-nums; line-height: 1.1; }
.ai3-cap { color: var(--muted-foreground, #666); font-size: 13px; margin-top: 4px; }
.ai3-cap.red { color: var(--ai3-red); }
.ai3-cap.green { color: var(--ai3-green); }
.ai3-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.ai3-pair > div + div { border-left: 1px solid var(--border, #ddd); padding-left: 12px; }
.ai3-table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.ai3-table th { text-align: left; font-weight: 600; font-size: 12px; color: var(--muted-foreground, #666); padding: 8px 10px; border-bottom: 1px solid var(--border, #ddd); white-space: nowrap; }
.ai3-table td { padding: 9px 10px; border-bottom: 1px solid var(--border, #eee); vertical-align: top; }
.ai3-table tr:last-child td { border-bottom: 0; }
.ai3-table tbody tr.click { cursor: pointer; }
.ai3-table tbody tr.click:hover td { background: var(--accent, #f7f7f7); }
.ai3-table .num, .ai3-num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.ai3-table .muted { color: var(--muted-foreground, #666); }
.ai3-table .red { color: var(--ai3-red); }
.ai3-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
.ai3-toolbar .summary { color: var(--muted-foreground, #666); font-size: 13px; }
.ai3-toolbar .summary b { color: var(--foreground, #111); font-weight: 500; }
.ai3-badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 500; white-space: nowrap; }
.ai3-badge.draft { background: var(--muted, #eee); color: var(--muted-foreground, #555); }
.ai3-badge.issued { background: var(--ai3-blue-soft); color: var(--ai3-blue); }
.ai3-badge.part_paid { background: var(--ai3-amber-soft); color: var(--ai3-amber); }
.ai3-badge.paid { background: var(--ai3-green-soft); color: var(--ai3-green); }
.ai3-badge.written_off, .ai3-badge.void { background: var(--muted, #eee); color: var(--muted-foreground, #555); text-decoration: line-through; }
.ai3-badge.ok { background: var(--ai3-green-soft); color: var(--ai3-green); }
.ai3-badge.bad { background: rgba(200,55,45,.12); color: var(--ai3-red); }
.ai3-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.ai3-field label { font-size: 12px; font-weight: 600; color: var(--muted-foreground, #666); }
.ai3-input, .ai3-select { padding: 8px 10px; border: 1px solid var(--input, #ccc); border-radius: var(--radius, 6px); background: var(--background, #fff); color: var(--foreground, #111); font: inherit; min-width: 0; width: 100%; }
.ai3-input:focus, .ai3-select:focus { outline: 2px solid var(--ai3-blue); outline-offset: -1px; }
.ai3-form-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 14px; }
.ai3-lines th { background: var(--muted, #f6f6f6); }
.ai3-lines td { padding: 4px 6px; }
.ai3-lines .ai3-input { padding: 6px 8px; }
.ai3-totals { display: flex; justify-content: flex-end; margin-top: 10px; }
.ai3-totals table { font-size: 14px; }
.ai3-totals td { padding: 4px 0 4px 32px; text-align: right; font-variant-numeric: tabular-nums; }
.ai3-totals tr.total td { font-weight: 600; border-top: 1px solid var(--border, #ddd); padding-top: 8px; font-size: 16px; }
.ai3-report { background: var(--card, #fff); border: 1px solid var(--border, #ddd); border-radius: 10px; padding: 24px 28px; margin-bottom: 14px; }
.ai3-report h2 { margin: 0 0 4px; font-size: 22px; font-weight: 600; }
.ai3-report .who { color: var(--foreground, #111); }
.ai3-report .when { color: var(--muted-foreground, #666); margin-bottom: 18px; }
.ai3-stmt { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.ai3-stmt th { text-align: right; font-weight: 400; color: var(--muted-foreground, #666); font-size: 12px; padding: 0 0 6px; border-bottom: 1px solid var(--border, #ccc); }
.ai3-stmt th:first-child { text-align: left; }
.ai3-stmt td { padding: 5px 0; border-bottom: 1px solid var(--border, #eee); }
.ai3-stmt td.num { text-align: right; font-variant-numeric: tabular-nums; }
.ai3-stmt tr.section td { font-weight: 600; padding-top: 12px; border-bottom: 1px solid var(--border, #ccc); }
.ai3-stmt tr.line td:first-child { padding-left: 16px; }
.ai3-stmt tr.total td { font-weight: 600; border-top: 1px solid var(--border, #ccc); border-bottom: 1px solid var(--border, #ccc); }
.ai3-stmt tr.grand td { font-weight: 700; border-top: 2px solid var(--foreground, #111); border-bottom: 2px solid var(--foreground, #111); }
.ai3-stmt td.link { color: var(--ai3-blue); }
.ai3-report-bar { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; margin-bottom: 14px; }
.ai3-report-bar .ai3-field { min-width: 160px; }
.ai3-note { color: var(--muted-foreground, #666); font-size: 12.5px; margin: 8px 0 0; }
.ai3-empty { color: var(--muted-foreground, #666); padding: 20px 0; text-align: center; }
.ai3-chart { width: 100%; height: 150px; display: block; }
.ai3-legend { display: flex; gap: 14px; font-size: 12px; color: var(--muted-foreground, #666); margin-top: 6px; justify-content: flex-end; }
.ai3-legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
.ai3-detail { background: var(--muted, #f7f7f7); border-radius: 8px; padding: 14px 16px; margin: 4px 0 8px; }
.ai3-list { list-style: none; margin: 0; padding: 0; }
.ai3-list li { display: flex; justify-content: space-between; gap: 12px; padding: 7px 0; border-bottom: 1px solid var(--border, #eee); font-size: 13.5px; }
.ai3-list li:last-child { border-bottom: 0; }
.ai3-list .l { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ai3-list .r { font-variant-numeric: tabular-nums; white-space: nowrap; }
.ai3-list .d { color: var(--muted-foreground, #666); margin-right: 8px; }
.ai3-side { display: block; padding: 6px 12px; margin: 1px 6px; border-radius: 6px; color: inherit; font-size: 14px; text-decoration: none; }
.ai3-side:hover { background: var(--sidebar-accent, rgba(127,127,127,.1)); text-decoration: none; }
.ai3-side.on { background: var(--sidebar-accent, rgba(127,127,127,.14)); font-weight: 600; }
.ai3-side-label { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted-foreground, #666); padding: 14px 12px 4px; font-weight: 500; }
.ai3-recon { display: grid; grid-template-columns: minmax(0, 1fr) 56px minmax(0, 1.3fr); gap: 10px; align-items: stretch; }
.ai3-line { border: 1px solid var(--border, #ddd); border-radius: 8px; padding: 10px 12px; background: var(--background, #fff); min-width: 0; }
.ai3-okcol { display: flex; align-items: center; justify-content: center; }
.ai3-prop { border: 1px solid var(--border, #ddd); border-left: 4px solid var(--ai3-green); border-radius: 8px; padding: 10px 12px; background: var(--ai3-green-soft); min-width: 0; }
.ai3-prop.batch { border-left-color: var(--ai3-green); }
.ai3-prop.transfer { border-left-color: var(--ai3-green); }
.ai3-prop.create { border-left-color: var(--ai3-blue); background: var(--ai3-blue-soft); }
.ai3-prop.ask { border-left-color: var(--ai3-amber); background: var(--ai3-amber-soft); }
.ai3-prop-kind { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted-foreground, #666); margin-bottom: 3px; font-weight: 600; }
.ai3-conf { color: var(--ai3-green); }
.ai3-conf.mid { color: var(--ai3-amber); }
@media (max-width: 700px) { .ai3-recon { grid-template-columns: 1fr; } }
`;

export function useStyles() {
  useEffect(() => {
    if (document.getElementById('ai3-ledger-css')) return;
    const el = document.createElement('style');
    el.id = 'ai3-ledger-css';
    el.textContent = CSS;
    document.head.appendChild(el);
  }, []);
}

// ---------------------------------------------------------------------------
// Money and dates
// ---------------------------------------------------------------------------

export const SYMBOL: Record<string, string> = { USD: '$', EUR: '€', GBP: '£' };

export function fmt(minor: string | number | bigint | null | undefined, opts: { currency?: string; paren?: boolean; symbol?: boolean } = {}): string {
  if (minor === null || minor === undefined || minor === '') return '—';
  const n = typeof minor === 'bigint' ? minor : typeof minor === 'number' ? BigInt(Math.trunc(minor)) : BigInt(minor);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = (abs % 100n).toString().padStart(2, '0');
  const sym = opts.symbol === false ? '' : SYMBOL[opts.currency ?? 'USD'] ?? `${opts.currency ?? ''} `;
  const body = `${sym}${whole}.${cents}`;
  if (!neg) return body;
  return opts.paren ? `(${body})` : `-${body}`;
}

export function toMinor(amount: string): string {
  const [w, c = ''] = amount.trim().split('.');
  return `${BigInt(w || '0') * 100n + BigInt((c + '00').slice(0, 2))}`;
}

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function dateLong(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function plusDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.floor((Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
}

export const AMOUNT = /^\d+(\.\d{1,2})?$/;

// ---------------------------------------------------------------------------
// Data shapes (loose mirrors of the worker's JSON)
// ---------------------------------------------------------------------------

export interface Company { name: string; currency: string; settings?: Settings }
interface Position {
  currency: string | null;
  treasuryMinor: string;
  receivablesMinor: string;
  monthToDate: { fromDate: string; incomeMinor: string; expenseMinor: string; netMinor: string };
  trailing30d: { expenseMinor: string; dailyBurnMinor: string };
  runwayDays: number | null;
  balanceSheet: { balances: boolean };
  trial: { entryCount: number; netMinor: string };
  accounts: Array<{ code: string; name: string; type: string; balanceMinor: string }>;
}
interface Entry { accountCode: string; accountName: string; direction: string; amountMinor: string; subject: { agent?: string } }
interface Tx { id: string; occurredAt: string; description: string; sourceKind: string; sourceRef: string | null; entries: Entry[] }
interface InvoiceLine { position: number; description: string; quantity: string; unitAmountMinor: string; amountMinor: string }
interface Invoice {
  id: string; number: string; status: string; customerName: string; customerEmail: string | null; customerId: string; currency: string; baseCurrency: string; rateToBase: string;
  issuedAt: string | null; dueAt: string | null; createdAt: string; subtotalMinor?: string; taxMinor?: string; totalMinor: string; baseTotalMinor: string; paidMinor: string; outstandingMinor: string; lines: InvoiceLine[];
  paymentMethods: Array<{ id: string; kind: 'bank' | 'stripe' | 'crypto' | 'other'; label: string; currency: string | null; details: PaymentDetails }>;
  notes: string | null;
  payments: Array<{ id: string; occurredAt: string; amountMinor: string; rateToBase: string; baseMinor: string; reference: string | null }>;
  hosted: { token: string; url: string; hostedAt: string; sentAt: string | null; sentTo: string | null; openedAt: string | null; openCount: number } | null;
  connected?: boolean;
  sender?: { email: string; via: string } | null;
  hostedPayments?: Array<{ at: string; amountMinor: string; currency: string; via: string; ref: string; network?: string | null; from?: string | null; explorer?: string | null }>;
}
interface Customer { id: string; name: string; email: string | null }
interface Period { id: string; label: string; startsOn: string; endsOn: string; status: 'open' | 'closed' }
interface Pnl {
  from: string; to: string; incomeMinor: string; expenseMinor: string; netMinor: string; groupBy: string | null;
  lines: Array<{ code: string; name: string; type: string; amountMinor: string }>;
  groups: Array<{ key: string | null; incomeMinor: string; expenseMinor: string; netMinor: string; lines: Array<{ code: string; name: string; type: string; amountMinor: string }> }>;
}
interface BsSection { lines: Array<{ code: string; name: string; balanceMinor: string }>; totalMinor: string }
interface BalanceSheet { asOf: string; assets: BsSection; liabilities: BsSection; equity: BsSection & { retainedEarningsMinor: string }; balances: boolean }

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

/** The message of whatever a worker action threw: an Error, or the bridge's plain { code, message } object. */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') return (err as { message: string }).message;
  return String(err);
}

export function useRun(refreshers: Array<() => void>) {
  const toast = usePluginToast();
  const [busy, setBusy] = useState(false);
  async function run(fn: () => Promise<unknown>, done: string): Promise<boolean> {
    setBusy(true);
    try {
      await fn();
      toast({ title: done, tone: 'success' });
      refreshers.forEach((r) => r());
      return true;
    } catch (err) {
      toast({ title: 'That did not work', body: errorText(err), tone: 'error', ttlMs: 8000 });
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { run, busy };
}

export function Failure({ error }: { error: { message: string } | null | undefined }) {
  if (!error) return null;
  return <div className="ai3-card" style={{ borderColor: 'var(--ai3-red)', marginBottom: 14 }}>{error.message}</div>;
}

export function Header({ crumb, title, sub, actions }: { crumb: React.ReactNode; title: string; sub?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <>
      <div className="ai3-crumb">Finance › {crumb}</div>
      <div className="ai3-head">
        <div>
          <h1>{title}</h1>
          {sub ? <div className="ai3-sub">{sub}</div> : null}
        </div>
        {actions ? <div className="ai3-actions">{actions}</div> : null}
      </div>
    </>
  );
}

export function Field({ label, children, style }: { label: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div className="ai3-field" style={style}>
      <label>{label}</label>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cash in / out chart (last six months), from the transaction list
// ---------------------------------------------------------------------------

function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

function cashByMonth(txs: Tx[]): Array<{ key: string; label: string; inMinor: bigint; outMinor: bigint }> {
  const now = new Date();
  const keys: string[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    keys.push(d.toISOString().slice(0, 7));
  }
  const acc = new Map(keys.map((k) => [k, { key: k, label: MONTHS[Number(k.slice(5, 7)) - 1]!, inMinor: 0n, outMinor: 0n }]));
  for (const t of txs) {
    const row = acc.get(monthKey(t.occurredAt));
    if (!row) continue;
    for (const e of t.entries) {
      if (e.accountCode !== '1000') continue;
      if (e.direction === 'debit') row.inMinor += BigInt(e.amountMinor);
      else row.outMinor += BigInt(e.amountMinor);
    }
  }
  return keys.map((k) => acc.get(k)!);
}

function CashChart({ txs }: { txs: Tx[] }) {
  const rows = cashByMonth(txs);
  const max = rows.reduce((m, r) => (r.inMinor > m ? r.inMinor : r.outMinor > m ? r.outMinor : m), 1n);
  const W = 520;
  const H = 150;
  const pad = { l: 8, r: 8, t: 10, b: 22 };
  const slot = (W - pad.l - pad.r) / rows.length;
  const bar = Math.min(28, slot * 0.32);
  const scale = (v: bigint) => Number((v * 1000n) / max) / 1000;
  return (
    <>
      <svg className="ai3-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Cash in and out by month">
        <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} stroke="var(--border, #ddd)" />
        {rows.map((r, i) => {
          const x = pad.l + i * slot + slot / 2;
          const hi = scale(r.inMinor) * (H - pad.t - pad.b);
          const ho = scale(r.outMinor) * (H - pad.t - pad.b);
          return (
            <g key={r.key}>
              <rect x={x - bar - 2} y={H - pad.b - hi} width={bar} height={hi} fill="var(--ai3-blue)" rx="2" />
              <rect x={x + 2} y={H - pad.b - ho} width={bar} height={ho} fill="var(--ai3-blue-soft)" stroke="var(--ai3-blue)" strokeWidth="1" rx="2" />
              <text x={x} y={H - 6} textAnchor="middle" fontSize="11" fill="var(--muted-foreground, #666)">{r.label}</text>
            </g>
          );
        })}
      </svg>
      <div className="ai3-legend"><span><i style={{ background: 'var(--ai3-blue)' }} />Cash in</span><span><i style={{ background: 'var(--ai3-blue-soft)', border: '1px solid var(--ai3-blue)' }} />Cash out</span></div>
    </>
  );
}

interface CreditsView { hosted: boolean; keyed: boolean; slug: string | null; at: string | null; markup: number; platformWallet: string | null; memo: string | null; creditsUrl: string | null; modelUrl: string | null; grantedMinor: string; usageMinor: string; chargedMinor: string; remainingMinor: string; usageMonthlyMinor: string; keyDisabled: boolean; entries: Array<{ at: string; amountMinor: string; kind: string; ref: string | null }>; message?: string | null }
interface CreditsData { connected: boolean; view: CreditsView | null; error?: string | null; bookedMinor: string | null }

/** The company's prepaid model credits at ai3.co. On the Position page as one card; in Settings with the top-up instructions and history. */
function CreditsCard({ companyId, full }: { companyId: string; full: boolean }) {
  const nav = useHostNavigation();
  const data = usePluginData<CreditsData>('credits', { companyId });
  const sync = usePluginAction('credits.sync');
  const toast = usePluginToast();
  const { run, busy } = useRun([data.refresh]);
  const [copied, setCopied] = useState(false);
  const d = data.data;
  const v = d?.view ?? null;
  if (d && !d.connected) return full ? <div className="ai3-card" style={{ marginTop: 14 }}><h3>Model credits</h3><p className="ai3-note" style={{ marginTop: 0 }}>Connect this company to ai3.co under Finance › Settings to see the model credits its agents run on.</p></div> : null;
  if (v && (!v.hosted || !v.keyed)) return full ? <div className="ai3-card" style={{ marginTop: 14 }}><h3>Model credits</h3><p className="ai3-note" style={{ marginTop: 0 }}>{v.message ?? 'This company runs on its own model key, so ai3.co meters nothing for it.'}</p></div> : null;
  const booked = d?.bookedMinor ?? null;
  const drift = v && booked !== null ? BigInt(v.remainingMinor) - BigInt(booked) : null;
  const doSync = () => run(async () => { const r = (await sync({ companyId })) as { grantsBooked: number; usageBookedMinor: string; skipped: string | null }; if (r.skipped) throw new Error(r.skipped); toast({ title: 'Credits booked', body: `${r.grantsBooked} grant(s) and ${fmt(r.usageBookedMinor, { symbol: false })} of usage posted.`, tone: 'success' }); }, 'Credits booked');
  return (
    <div className="ai3-card" style={full ? { marginTop: 14 } : undefined}>
      <div className="ai3-toolbar" style={{ marginBottom: 6 }}>
        <h3 style={{ margin: 0 }}>Model credits <span className="ctx">prepaid at ai3.co</span></h3>
        {v?.keyDisabled ? <span className="ai3-badge bad">used up · agents paused</span> : v ? <span className="ai3-badge paid">running</span> : null}
      </div>
      <Failure error={data.error} />
      {d?.error && <div className="ai3-cap red">ai3.co did not answer: {d.error}</div>}
      {v && (
        <>
          <div className="ai3-pair">
            <div>
              <div className="ai3-big" style={{ fontSize: full ? 26 : 22, color: v.keyDisabled ? 'var(--ai3-red)' : undefined }}>{fmt(v.remainingMinor, { currency: 'USD' })}</div>
              <div className="ai3-cap">Balance left of {fmt(v.grantedMinor, { currency: 'USD' })} put in</div>
            </div>
            <div>
              <div className="ai3-big" style={{ fontSize: full ? 26 : 22 }}>{fmt(v.usageMonthlyMinor, { currency: 'USD' })}</div>
              <div className="ai3-cap">Model usage at cost this month · {fmt(v.chargedMinor, { currency: 'USD' })} charged in all, at cost plus {Math.round(v.markup * 100)}%</div>
            </div>
          </div>
          {drift !== null && drift !== 0n && <div className="ai3-cap" style={{ marginTop: 6 }}>The books carry {fmt(booked!, { currency: 'USD' })} in 1300 Prepaid model credits, {fmt(drift < 0n ? -drift : drift, { currency: 'USD' })} {drift > 0n ? 'behind' : 'ahead of'} ai3.co. <a href="#" onClick={(e) => { e.preventDefault(); void doSync(); }}>Book the difference</a>.</div>}
          {!full && <div className="ai3-cap" style={{ marginTop: 8 }}><a {...nav.linkProps('/company/settings/finance')}>Top up and history</a>{v.modelUrl ? <> · <a href={v.modelUrl} target="_blank" rel="noreferrer">default model</a></> : null}</div>}
          {full && (
            <>
              <div style={{ marginTop: 12, fontWeight: 600 }}>Top up</div>
              <p className="ai3-note" style={{ marginTop: 4 }}>Credits pay for the models your agents use through AI3's key, at cost plus {Math.round(v.markup * 100)}%. Agents stop at zero and resume when topped up.</p>
              {v.platformWallet && v.memo && (
                <div className="ai3-line" style={{ marginTop: 8 }}>
                  <div style={{ fontWeight: 600 }}>Pay in pathUSD on Tempo <span className="ai3-cap" style={{ display: 'inline' }}>· testnet for now</span></div>
                  <div className="ai3-cap" style={{ wordBreak: 'break-all' }}>Send any amount to <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{v.platformWallet}</span> with the memo <strong>{v.memo}</strong>. Credited within the hour; the chain feed books it as a transfer into Prepaid model credits.</div>
                  <div className="ai3-actions" style={{ marginTop: 8 }}>
                    <button className="ai3-btn small" onClick={() => { void navigator.clipboard?.writeText(v.platformWallet!).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>{copied ? 'Copied' : 'Copy address'}</button>
                    {v.creditsUrl && <a className="ai3-btn small" href={v.creditsUrl} target="_blank" rel="noreferrer">Card top-up and auto-recharge on ai3.co</a>}
                  </div>
                  <p className="ai3-note">An agent can do it with the pay-invoice tool: to {v.platformWallet.slice(0, 8)}…, amount, memo {v.memo}.</p>
                </div>
              )}
              {v.entries.length > 0 && (
                <>
                  <div style={{ marginTop: 12, fontWeight: 600 }}>Put in</div>
                  <table className="ai3-table">
                    <thead><tr><th>When</th><th>Kind</th><th>Reference</th><th className="num">USD</th></tr></thead>
                    <tbody>{v.entries.slice().reverse().slice(0, 20).map((e, i) => <tr key={`${e.ref ?? ''}:${i}`}><td className="muted">{dateLong(e.at)}</td><td>{e.kind === 'free' ? 'Starter credit' : e.kind === 'admin' ? 'Grant' : e.kind === 'crypto' ? 'pathUSD top-up' : e.kind === 'stripe' || e.kind === 'card' ? 'Card top-up' : e.kind}</td><td className="muted" style={{ wordBreak: 'break-all' }}>{e.ref ?? ''}</td><td className="num">{fmt(e.amountMinor, { symbol: false })}</td></tr>)}</tbody>
                  </table>
                </>
              )}
              <div className="ai3-actions" style={{ marginTop: 10 }}>
                <button className="ai3-btn" disabled={busy} onClick={() => void doSync()}>Book into the ledger now</button>
                <button className="ai3-btn" onClick={() => data.refresh()}>Refresh</button>
              </div>
              <p className="ai3-note">Booked every hour: grants and card top-ups into 1300 Prepaid model credits from Contributed funds, usage out of it into 5000 Model inference, pathUSD top-ups through the wallet feed.{v.at ? ` ai3.co figures as of ${dateLong(v.at)}.` : ''}</p>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Position (the dashboard)
// ---------------------------------------------------------------------------

function PositionTab({ companyId, company }: { companyId: string; company: Company | null }) {
  const pos = usePluginData<Position>('position', { companyId });
  const txs = usePluginData<{ transactions: Tx[] }>('transactions', { companyId, limit: 500 });
  const invs = usePluginData<{ invoices: Invoice[] }>('invoices', { companyId });
  const sweep = usePluginAction('sweep');
  const fund = usePluginAction('funding');
  const nav = useHostNavigation();
  const { run, busy } = useRun([pos.refresh, txs.refresh, invs.refresh]);
  const [showFund, setShowFund] = useState(false);
  const [amount, setAmount] = useState('');
  const [desc, setDesc] = useState('');
  const [fundDate, setFundDate] = useState(today());
  const cur = company?.currency ?? pos.data?.currency ?? 'USD';
  const p = pos.data;
  const invoices = invs.data?.invoices ?? [];
  const open = invoices.filter((i) => i.status === 'issued' || i.status === 'part_paid');
  const overdue = open.filter((i) => i.dueAt && i.dueAt.slice(0, 10) < today());
  const owed = open.reduce((s, i) => s + BigInt(i.outstandingMinor), 0n);
  const overdueSum = overdue.reduce((s, i) => s + BigInt(i.outstandingMinor), 0n);
  const drafts = invoices.filter((i) => i.status === 'draft');
  const recent = (txs.data?.transactions ?? []).slice(0, 8);

  return (
    <>
      <Header
        crumb="Position"
        title={company?.name ?? 'Position'}
        sub={p ? `Books balance · ${p.trial.entryCount} entries` : undefined}
        actions={
          <>
            <button className="ai3-btn" disabled={busy} onClick={() => run(() => sweep({ companyId }), 'Costs swept from Paperclip')}>Sweep costs now</button>
            <button className="ai3-btn primary" onClick={() => setShowFund((v) => !v)}>Record funding</button>
          </>
        }
      />
      <Failure error={pos.error ?? txs.error ?? invs.error} />
      {showFund && (
        <div className="ai3-card" style={{ marginBottom: 14 }}>
          <h3>Record funding <span className="ctx">money that arrived in the treasury</span></h3>
          <div className="ai3-form-row">
            <Field label={`Amount (${cur})`}><input className="ai3-input" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1,000.00" inputMode="decimal" /></Field>
            <Field label="Date"><input className="ai3-input" type="date" value={fundDate} onChange={(e) => setFundDate(e.target.value)} /></Field>
            <Field label="Description"><input className="ai3-input" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Initial float" /></Field>
          </div>
          <div className="ai3-actions">
            <button
              className="ai3-btn primary"
              disabled={busy || !AMOUNT.test(amount.replace(/,/g, ''))}
              onClick={async () => {
                const ok = await run(() => fund({ companyId, amountMinor: toMinor(amount.replace(/,/g, '')), description: desc || 'Funding', occurredAt: `${fundDate}T12:00:00.000Z` }), 'Funding recorded');
                if (ok) { setAmount(''); setDesc(''); setShowFund(false); }
              }}
            >
              Save
            </button>
            <button className="ai3-btn" onClick={() => setShowFund(false)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="ai3-grid">
        <div className="ai3-card">
          <h3>Treasury</h3>
          <div className="ai3-big">{p ? fmt(p.treasuryMinor, { currency: cur }) : '…'}</div>
          <div className="ai3-cap">{p ? (p.runwayDays === null ? 'No burn yet' : `${p.runwayDays.toLocaleString()} days of runway at current burn`) : ''}</div>
        </div>
        <div className="ai3-card">
          <h3>Invoices owed to you</h3>
          <div className="ai3-pair">
            <div>
              <div className="ai3-big">{fmt(owed, { currency: cur })}</div>
              <div className="ai3-cap"><a {...nav.linkProps('/ledger?tab=invoices&status=open')}>{open.length} awaiting payment</a></div>
            </div>
            <div>
              <div className="ai3-big" style={{ color: overdue.length ? 'var(--ai3-red)' : undefined }}>{fmt(overdueSum, { currency: cur })}</div>
              <div className={`ai3-cap ${overdue.length ? 'red' : ''}`}>{overdue.length} of {open.length} overdue</div>
            </div>
          </div>
          {drafts.length > 0 && <div className="ai3-cap" style={{ marginTop: 8 }}><a {...nav.linkProps('/ledger?tab=invoices&status=draft')}>{drafts.length} draft{drafts.length === 1 ? '' : 's'}</a> · {fmt(drafts.reduce((s, i) => s + BigInt(i.totalMinor), 0n), { currency: cur })}</div>}
        </div>
        <div className="ai3-card">
          <h3>Burn <span className="ctx">this month</span></h3>
          <div className="ai3-big">{p ? fmt(p.monthToDate.expenseMinor, { currency: cur }) : '…'}</div>
          <div className="ai3-cap">{p ? `${fmt(p.trailing30d.dailyBurnMinor, { currency: cur })} a day over the last 30 days` : ''}</div>
        </div>
        <div className="ai3-card">
          <h3>Net profit or loss <span className="ctx">month to date</span></h3>
          <div className="ai3-big" style={{ color: p && BigInt(p.monthToDate.netMinor) < 0n ? 'var(--ai3-red)' : undefined }}>{p ? fmt(p.monthToDate.netMinor, { currency: cur }) : '…'}</div>
          <div className="ai3-cap">{p ? `Income ${fmt(p.monthToDate.incomeMinor, { currency: cur })} · Expenses ${fmt(p.monthToDate.expenseMinor, { currency: cur })}` : ''}</div>
        </div>
        <CreditsCard companyId={companyId} full={false} />
      </div>

      <div className="ai3-grid two">
        <div className="ai3-card">
          <h3>Cash in and out <span className="ctx">last 6 months</span></h3>
          {(() => {
            const rows = cashByMonth(txs.data?.transactions ?? []);
            const tin = rows.reduce((s, r) => s + r.inMinor, 0n);
            const tout = rows.reduce((s, r) => s + r.outMinor, 0n);
            return (
              <div className="ai3-pair" style={{ marginBottom: 8 }}>
                <div><div className="ai3-big" style={{ fontSize: 20 }}>{fmt(tin, { currency: cur })}</div><div className="ai3-cap">Cash in</div></div>
                <div><div className="ai3-big" style={{ fontSize: 20 }}>{fmt(-tout, { currency: cur })}</div><div className="ai3-cap">Cash out</div></div>
              </div>
            );
          })()}
          <CashChart txs={txs.data?.transactions ?? []} />
        </div>
        <div className="ai3-card">
          <h3>Recent transactions</h3>
          {recent.length === 0 ? (
            <div className="ai3-empty">Nothing posted yet. Fund the treasury, or let the sweep find costs.</div>
          ) : (
            <ul className="ai3-list">
              {recent.map((t) => {
                const debit = t.entries.find((e) => e.direction === 'debit');
                return (
                  <li key={t.id}>
                    <span className="l"><span className="d">{dateLong(t.occurredAt)}</span>{t.description}</span>
                    <span className="r">{fmt(debit?.amountMinor ?? '0', { currency: cur })}</span>
                  </li>
                );
              })}
            </ul>
          )}
          <div style={{ marginTop: 10 }}><a {...nav.linkProps('/ledger?tab=transactions')}>View all transactions</a></div>
        </div>
      </div>

      <div className="ai3-card">
        <h3>Accounts</h3>
        <table className="ai3-table">
          <thead><tr><th style={{ width: 70 }}>Code</th><th>Account</th><th>Type</th><th className="num">Balance</th></tr></thead>
          <tbody>
            {(p?.accounts ?? []).map((a) => (
              <tr key={a.code}>
                <td className="muted">{a.code}</td>
                <td>{a.name}</td>
                <td className="muted" style={{ textTransform: 'capitalize' }}>{a.type}</td>
                <td className="num">{fmt(a.balanceMinor, { currency: cur, paren: true })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

function TransactionsTab({ companyId, company }: { companyId: string; company: Company | null }) {
  const location = useHostLocation();
  const search = new URLSearchParams(location.search);
  const filtered = ['account', 'type', 'from', 'to', 'groupBy', 'source'].some((k) => search.has(k));
  if (filtered) return <EntriesView companyId={companyId} company={company} />;
  return <TransactionList companyId={companyId} company={company} openId={search.get('open')} />;
}

function TransactionList({ companyId, company, openId: initialOpen }: { companyId: string; company: Company | null; openId: string | null }) {
  const txs = usePluginData<{ transactions: Tx[] }>('transactions', { companyId, limit: 500 });
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<string | null>(initialOpen);
  const cur = company?.currency ?? 'USD';
  const rows = useMemo(() => {
    const all = txs.data?.transactions ?? [];
    const needle = q.trim().toLowerCase();
    return needle ? all.filter((t) => `${t.description} ${t.sourceKind} ${t.entries.map((e) => e.accountName).join(' ')}`.toLowerCase().includes(needle)) : all;
  }, [txs.data, q]);
  const total = rows.reduce((s, t) => s + BigInt(t.entries.find((e) => e.direction === 'debit')?.amountMinor ?? '0'), 0n);
  return (
    <>
      <Header crumb="Transactions" title="Transactions" sub="Every posted entry, newest first. Nothing here is edited; corrections are reversals. Click a row for where it came from." />
      <Failure error={txs.error} />
      <div className="ai3-card">
        <div className="ai3-toolbar">
          <input className="ai3-input" style={{ maxWidth: 320 }} placeholder="Search description, kind or account" value={q} onChange={(e) => setQ(e.target.value)} />
          <span className="summary"><b>{rows.length}</b> items | <b>{fmt(total, { currency: cur })}</b></span>
        </div>
        <table className="ai3-table">
          <thead>
            <tr><th>Date</th><th>Description</th><th>Kind</th><th>Debit</th><th>Credit</th><th className="num">Amount</th></tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={6} className="ai3-empty">{txs.loading ? 'Loading…' : 'No transactions yet.'}</td></tr>}
            {rows.map((t) => {
              const d = t.entries.find((e) => e.direction === 'debit');
              const c = t.entries.find((e) => e.direction === 'credit');
              const isOpen = openId === t.id;
              return (
                <React.Fragment key={t.id}>
                  <tr className="click" onClick={() => setOpenId(isOpen ? null : t.id)}>
                    <td className="muted" style={{ whiteSpace: 'nowrap' }}>{dateLong(t.occurredAt)}</td>
                    <td>{t.description}{d?.subject?.agent ? <span className="muted"> · agent {d.subject.agent.slice(0, 8)}</span> : null}</td>
                    <td className="muted" style={{ textTransform: 'capitalize' }}>{t.sourceKind.replace('_', ' ')}</td>
                    <td>{d ? `${d.accountCode} ${d.accountName}${t.entries.filter((e) => e.direction === 'debit').length > 1 ? ' +' : ''}` : ''}</td>
                    <td>{c ? `${c.accountCode} ${c.accountName}${t.entries.filter((e) => e.direction === 'credit').length > 1 ? ' +' : ''}` : ''}</td>
                    <td className="num">{fmt(t.entries.filter((e) => e.direction === 'debit').reduce((s, e) => s + BigInt(e.amountMinor), 0n), { currency: cur })}</td>
                  </tr>
                  {isOpen && <tr><td colSpan={6} style={{ padding: '0 0 8px' }}><TransactionDetail companyId={companyId} transactionId={t.id} cur={cur} onClose={() => setOpenId(null)} /></td></tr>}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

type InvoiceFilter = 'all' | 'draft' | 'open' | 'paid' | 'closed';
const FILTERS: Array<{ key: InvoiceFilter; label: string; test: (i: Invoice) => boolean }> = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'draft', label: 'Draft', test: (i) => i.status === 'draft' },
  { key: 'open', label: 'Awaiting payment', test: (i) => i.status === 'issued' || i.status === 'part_paid' },
  { key: 'paid', label: 'Paid', test: (i) => i.status === 'paid' },
  { key: 'closed', label: 'Written off or void', test: (i) => i.status === 'written_off' || i.status === 'void' },
];

function statusLabel(s: string): string {
  return { draft: 'Draft', issued: 'Awaiting payment', part_paid: 'Part paid', paid: 'Paid', written_off: 'Written off', void: 'Void' }[s] ?? s;
}

export const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'SGD', 'JPY', 'USDC', 'USDT', 'DAI'];
const NETWORKS = ['Base', 'Ethereum', 'Solana', 'Polygon', 'Arbitrum', 'Optimism', 'Bitcoin', 'Tron'];

interface PaymentDetails { accountName?: string; bankName?: string; accountNumber?: string; iban?: string; sortCode?: string; routingNumber?: string; bic?: string; url?: string; account?: string; network?: string; asset?: string; address?: string; instructions?: string }
interface PaymentMethod { id: string; kind: 'bank' | 'stripe' | 'crypto' | 'other'; label: string; currency: string | null; details: PaymentDetails; isDefault: boolean; enabled: boolean }
interface RateQuote { from: string; to: string; rate: string; date: string; source: string }
export interface Settings { baseCurrency: string; legalName: string | null; address: string | null; email: string | null; taxId: string | null; invoiceFooter: string | null; replyTo: string | null; ai3Key: string | null; ai3Origin: string | null; remindersEnabled: boolean; leaderboardOptIn: boolean; summaryPublishedAt: string | null }

const KIND_TITLE: Record<PaymentMethod['kind'], string> = { bank: 'Bank transfer', stripe: 'Pay online', crypto: 'Crypto', other: 'Other' };

function PayLines({ m }: { m: { kind: PaymentMethod['kind']; label: string; currency: string | null; details: PaymentDetails } }) {
  const d = m.details;
  const row = (k: string, v?: string) => (v ? <div><span style={{ opacity: 0.65 }}>{k} </span><span style={{ fontVariantNumeric: 'tabular-nums', wordBreak: 'break-all' }}>{v}</span></div> : null);
  return (
    <div style={{ fontSize: 13, lineHeight: 1.5 }}>
      <div style={{ fontWeight: 600 }}>{m.label}{m.currency ? <span style={{ fontWeight: 400, opacity: 0.65 }}> · {m.currency}</span> : null}</div>
      {m.kind === 'bank' && <>{row('Account name', d.accountName)}{row('Bank', d.bankName)}{row('Account', d.accountNumber)}{row('IBAN', d.iban)}{row('Sort code', d.sortCode)}{row('Routing', d.routingNumber)}{row('BIC', d.bic)}</>}
      {m.kind === 'stripe' && d.url && <div><a href={d.url} target="_blank" rel="noreferrer">{d.url}</a></div>}
      {m.kind === 'stripe' && !d.url && d.account && <div>Card, Apple Pay or Google Pay on the invoice page, through Stripe</div>}
      {m.kind === 'crypto' && <>{row('Send', d.asset)}{row('Network', d.network)}{row('To', d.address)}</>}
      {m.kind === 'other' && d.instructions && <div style={{ whiteSpace: 'pre-wrap' }}>{d.instructions}</div>}
    </div>
  );
}

function InvoiceForm({ companyId, customers, cur, onDone, onCancel }: { companyId: string; customers: Customer[]; cur: string; onDone: () => void; onCancel: () => void }) {
  const createCustomer = usePluginAction('customer.create');
  const createInvoice = usePluginAction('invoice.create');
  const issue = usePluginAction('invoice.issue');
  const methods = usePluginData<{ paymentMethods: PaymentMethod[] }>('payment-methods', { companyId, enabledOnly: true });
  const nav = useHostNavigation();
  const { run, busy } = useRun([]);
  const [customerId, setCustomerId] = useState('');
  const [newCustomer, setNewCustomer] = useState(false);
  const [custName, setCustName] = useState('');
  const [custEmail, setCustEmail] = useState('');
  const [issueDate, setIssueDate] = useState(today());
  const [dueDate, setDueDate] = useState(plusDays(today(), 14));
  const [currency, setCurrency] = useState(cur);
  const [rate, setRate] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState([{ description: '', quantity: '1', unit: '' }]);
  const [taxRate, setTaxRate] = useState('');
  const [chosen, setChosen] = useState<Record<string, boolean> | null>(null);
  const [rateTouched, setRateTouched] = useState(false);
  const available = methods.data?.paymentMethods ?? [];
  const picked = chosen ?? Object.fromEntries(available.map((m) => [m.id, m.isDefault]));
  const foreign = currency !== cur;
  const fx = usePluginData<RateQuote>('fx-rate', foreign ? { companyId, from: currency, to: cur, date: issueDate } : { companyId, from: cur, to: cur });
  useEffect(() => {
    if (foreign && fx.data && !rateTouched) setRate(fx.data.rate);
  }, [foreign, fx.data, rateTouched]);
  const lineTotal = (l: { quantity: string; unit: string }) => {
    if (!AMOUNT.test(l.unit.replace(/,/g, '')) || !/^\d+(\.\d+)?$/.test(l.quantity)) return 0n;
    const unit = BigInt(toMinor(l.unit.replace(/,/g, '')));
    const q4 = Math.round(Number(l.quantity) * 10_000);
    return (unit * BigInt(q4) + 5_000n) / 10_000n;
  };
  const net = lines.reduce((s, l) => s + lineTotal(l), 0n);
  const taxBp = /^\d+(\.\d{1,2})?$/.test(taxRate) ? BigInt(Math.round(Number(taxRate) * 100)) : 0n;
  const lineTax = (l: { quantity: string; unit: string }) => (lineTotal(l) * taxBp + 5_000n) / 10_000n;
  const taxTotal = lines.reduce((s, l) => s + lineTax(l), 0n);
  const total = net + taxTotal;
  const rateOk = !foreign || /^\d+(\.\d{1,10})?$/.test(rate);
  const valid = (customerId || (newCustomer && custName.trim())) && lines.every((l) => l.description.trim() && AMOUNT.test(l.unit.replace(/,/g, ''))) && total > 0n && rateOk;
  const baseTotal = foreign && rateOk && rate ? (total * BigInt(Math.round(Number(rate) * 1e6)) + 500_000n) / 1_000_000n : total;

  async function save(thenIssue: boolean) {
    let cid = customerId;
    const ok = await run(async () => {
      if (newCustomer) {
        const c = (await createCustomer({ companyId, name: custName, email: custEmail })) as { id: string };
        cid = c.id;
      }
      const inv = (await createInvoice({
        companyId, customerId: cid, dueAt: `${dueDate}T23:59:59.000Z`, currency, rateToBase: foreign ? rate : null, notes,
        paymentMethodIds: available.filter((m) => picked[m.id]).map((m) => m.id),
        lines: lines.map((l) => ({ description: l.description, quantity: l.quantity || '1', unitAmountMinor: toMinor(l.unit.replace(/,/g, '')), taxMinor: taxBp > 0n ? lineTax(l).toString() : null })),
      })) as { id: string; number: string };
      if (thenIssue) await issue({ companyId, invoiceId: inv.id, issuedAt: `${issueDate}T12:00:00.000Z` });
    }, thenIssue ? 'Invoice issued' : 'Draft saved');
    if (ok) onDone();
  }

  return (
    <div className="ai3-card" style={{ marginBottom: 14 }}>
      <div className="ai3-toolbar">
        <h3 style={{ margin: 0 }}>New invoice <span className="ai3-badge draft">Draft</span></h3>
        <div className="ai3-actions">
          <button className="ai3-btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="ai3-btn" onClick={() => save(false)} disabled={busy || !valid}>Save as draft</button>
          <button className="ai3-btn primary" onClick={() => save(true)} disabled={busy || !valid}>Issue</button>
        </div>
      </div>
      <div className="ai3-form-row">
        <Field label="Customer">
          {newCustomer ? (
            <input className="ai3-input" placeholder="Customer name" value={custName} onChange={(e) => setCustName(e.target.value)} autoFocus />
          ) : (
            <select className="ai3-select" value={customerId} onChange={(e) => (e.target.value === '__new' ? setNewCustomer(true) : setCustomerId(e.target.value))}>
              <option value="">Choose a customer…</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              <option value="__new">+ New customer</option>
            </select>
          )}
        </Field>
        {newCustomer && <Field label="Customer email"><input className="ai3-input" placeholder="accounts@customer.com" value={custEmail} onChange={(e) => setCustEmail(e.target.value)} /></Field>}
        <Field label="Issue date"><input className="ai3-input" type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} /></Field>
        <Field label="Due date"><input className="ai3-input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
        <Field label="Currency">
          <select className="ai3-select" value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {[cur, ...CURRENCIES.filter((c) => c !== cur)].map((c) => <option key={c} value={c}>{c}{c === cur ? ' (base)' : ''}</option>)}
          </select>
        </Field>
        {foreign && (
          <Field label={`Rate: 1 ${currency} = ? ${cur}`}>
            <input className="ai3-input" placeholder={fx.loading ? 'fetching…' : '1.0850'} value={rate} inputMode="decimal" onChange={(e) => { setRate(e.target.value); setRateTouched(true); }} />
            <span className="ai3-cap">{fx.error ? `No rate found: ${fx.error.message}` : fx.data && !rateTouched ? `${fx.data.source}, ${dateLong(fx.data.date)}` : rateTouched ? <a href="#" onClick={(e) => { e.preventDefault(); setRateTouched(false); }}>use the published rate</a> : 'fetching…'}</span>
          </Field>
        )}
        <Field label="Tax rate % (optional)"><input className="ai3-input" value={taxRate} inputMode="decimal" placeholder="0" onChange={(e) => setTaxRate(e.target.value)} /></Field>
        <Field label="Invoice number"><input className="ai3-input" value="Assigned on save" disabled /></Field>
      </div>
      <table className="ai3-table ai3-lines">
        <thead><tr><th style={{ width: '50%' }}>Description</th><th style={{ width: 90 }}>Qty</th><th style={{ width: 140 }}>Price</th><th className="num" style={{ width: 140 }}>Amount {currency}</th><th style={{ width: 40 }}></th></tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td><input className="ai3-input" placeholder="What was done" value={l.description} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} /></td>
              <td><input className="ai3-input" value={l.quantity} inputMode="decimal" onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} /></td>
              <td><input className="ai3-input" placeholder="0.00" value={l.unit} inputMode="decimal" onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x)))} /></td>
              <td className="num" style={{ paddingTop: 12 }}>{fmt(lineTotal(l), { symbol: false })}</td>
              <td><button className="ai3-btn small" title="Remove line" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))}>×</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ marginTop: 8 }}><button className="ai3-btn small" onClick={() => setLines([...lines, { description: '', quantity: '1', unit: '' }])}>+ Add row</button></div>
      <div className="ai3-totals">
        <table>
          <tbody>
            <tr><td>Subtotal</td><td>{fmt(net, { symbol: false })}</td></tr>
            {taxTotal > 0n && <tr><td>Tax {taxRate}%</td><td>{fmt(taxTotal, { symbol: false })}</td></tr>}
            <tr className="total"><td>Total {currency}</td><td>{fmt(total, { symbol: false })}</td></tr>
            {foreign && rate && rateOk && <tr><td style={{ fontWeight: 400, opacity: 0.7 }}>Booked as {cur}</td><td style={{ fontWeight: 400, opacity: 0.7 }}>{fmt(baseTotal, { symbol: false })}</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="ai3-grid two" style={{ marginTop: 14 }}>
        <div>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>How to pay <span className="ai3-cap" style={{ display: 'inline' }}>· printed on the invoice</span></div>
          {available.length === 0 ? (
            <p className="ai3-note" style={{ marginTop: 0 }}>No payment options saved yet. <a {...nav.linkProps('/company/settings/finance')}>Add a bank account, a Stripe link or a wallet</a> and they will appear here.</p>
          ) : (
            available.map((m) => (
              <label key={m.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 0', cursor: 'pointer' }}>
                <input type="checkbox" checked={Boolean(picked[m.id])} onChange={(e) => setChosen({ ...picked, [m.id]: e.target.checked })} style={{ marginTop: 3 }} />
                <span><strong>{m.label}</strong> <span className="ai3-cap" style={{ display: 'inline' }}>· {KIND_TITLE[m.kind]}{m.kind === 'crypto' ? ` · ${m.details.asset} on ${m.details.network}` : ''}{m.currency ? ` · ${m.currency}` : ''}</span></span>
              </label>
            ))
          )}
        </div>
        <Field label="Notes on the invoice"><textarea className="ai3-input" rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Payment terms, a thank-you, a purchase order number…" /></Field>
      </div>
      <p className="ai3-note">Saving as draft changes nothing in the books. Issuing books the receivable and the income on the issue date{foreign ? `, in ${cur} at the rate you set` : ''}.</p>
    </div>
  );
}

function InvoiceDocument({ inv, settings, companyName }: { inv: Invoice; settings: Settings | null; companyName: string }) {
  const outstanding = BigInt(inv.outstandingMinor);
  return (
    <div className="ai3-report ai3-invoice-doc" style={{ marginBottom: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 24, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '.02em' }}>INVOICE</div>
          <div style={{ marginTop: 6, fontSize: 13 }}>
            <div><span style={{ opacity: 0.65 }}>Number</span> {inv.number}</div>
            <div><span style={{ opacity: 0.65 }}>Issued</span> {inv.issuedAt ? dateLong(inv.issuedAt) : 'not yet'}</div>
            <div><span style={{ opacity: 0.65 }}>Due</span> {dateLong(inv.dueAt)}</div>
            <div><span style={{ opacity: 0.65 }}>Currency</span> {inv.currency}{inv.currency !== inv.baseCurrency ? ` (1 ${inv.currency} = ${inv.rateToBase} ${inv.baseCurrency})` : ''}</div>
          </div>
        </div>
        <div style={{ textAlign: 'right', fontSize: 13 }}>
          <div style={{ fontWeight: 600, fontSize: 15 }}>{settings?.legalName || companyName}</div>
          {settings?.address && <div style={{ whiteSpace: 'pre-line', opacity: 0.8 }}>{settings.address}</div>}
          {settings?.email && <div style={{ opacity: 0.8 }}>{settings.email}</div>}
          {settings?.taxId && <div style={{ opacity: 0.8 }}>Tax ID {settings.taxId}</div>}
        </div>
      </div>
      <div style={{ marginTop: 18, fontSize: 13 }}>
        <div style={{ opacity: 0.65, fontSize: 12, textTransform: 'uppercase', letterSpacing: '.06em' }}>Bill to</div>
        <div style={{ fontWeight: 600 }}>{inv.customerName}</div>
        {inv.customerEmail && <div style={{ opacity: 0.8 }}>{inv.customerEmail}</div>}
      </div>
      <table className="ai3-table" style={{ marginTop: 18 }}>
        <thead><tr><th>Description</th><th className="num">Qty</th><th className="num">Price</th><th className="num">Amount {inv.currency}</th></tr></thead>
        <tbody>
          {inv.lines.map((l) => (
            <tr key={l.position}><td>{l.description}</td><td className="num">{Number(l.quantity)}</td><td className="num">{fmt(l.unitAmountMinor, { symbol: false })}</td><td className="num">{fmt(l.amountMinor, { symbol: false })}</td></tr>
          ))}
        </tbody>
      </table>
      <div className="ai3-totals">
        <table>
          <tbody>
            {inv.taxMinor && BigInt(inv.taxMinor) > 0n && <><tr><td>Subtotal</td><td>{fmt(inv.subtotalMinor ?? inv.totalMinor, { symbol: false })}</td></tr><tr><td>Tax</td><td>{fmt(inv.taxMinor, { symbol: false })}</td></tr></>}
            <tr className="total"><td>Total {inv.currency}</td><td>{fmt(inv.totalMinor, { symbol: false })}</td></tr>
            {BigInt(inv.paidMinor) > 0n && <tr><td>Paid</td><td>{fmt(inv.paidMinor, { symbol: false })}</td></tr>}
            {(inv.status === 'issued' || inv.status === 'part_paid') && <tr className="total"><td>Amount due {inv.currency}</td><td>{fmt(outstanding, { symbol: false })}</td></tr>}
          </tbody>
        </table>
      </div>
      {inv.paymentMethods.length > 0 && (
        <div style={{ marginTop: 20, paddingTop: 14, borderTop: '1px solid var(--border, #ddd)' }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>How to pay</div>
          <div className="ai3-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
            {inv.paymentMethods.map((m) => <div key={m.id} className="ai3-card" style={{ padding: '10px 12px' }}><PayLines m={m} /></div>)}
          </div>
          <p className="ai3-note">Please quote {inv.number} with your payment.</p>
        </div>
      )}
      {inv.notes && <p style={{ marginTop: 16, whiteSpace: 'pre-wrap', fontSize: 13 }}>{inv.notes}</p>}
      {settings?.invoiceFooter && <p className="ai3-note" style={{ marginTop: 16, whiteSpace: 'pre-wrap' }}>{settings.invoiceFooter}</p>}
    </div>
  );
}

function InvoiceDetail({ companyId, invoice, cur, onChanged }: { companyId: string; invoice: Invoice; cur: string; onChanged: () => void }) {
  const full = usePluginData<Invoice>('invoice', { companyId, invoiceId: invoice.id });
  const company = usePluginData<Company & { settings?: Settings }>('company', { companyId });
  const methods = usePluginData<{ paymentMethods: PaymentMethod[] }>('payment-methods', { companyId, enabledOnly: true });
  const issue = usePluginAction('invoice.issue');
  const pay = usePluginAction('invoice.payment');
  const writeOff = usePluginAction('invoice.writeoff');
  const voidIt = usePluginAction('invoice.void');
  const setMethods = usePluginAction('invoice.set-payment-methods');
  const publish = usePluginAction('invoice.publish');
  const send = usePluginAction('invoice.send');
  const { run, busy } = useRun([full.refresh, onChanged]);
  const [sending, setSending] = useState(false);
  const [sendTo, setSendTo] = useState('');
  const [sendCc, setSendCc] = useState('');
  const [sendMsg, setSendMsg] = useState('');
  const [copied, setCopied] = useState(false);
  const [payAmount, setPayAmount] = useState('');
  const [payDate, setPayDate] = useState(today());
  const [payRef, setPayRef] = useState('');
  const [payRate, setPayRate] = useState('');
  const [payRateTouched, setPayRateTouched] = useState(false);
  const [issueDate, setIssueDate] = useState(today());
  const [showDoc, setShowDoc] = useState(true);
  const inv = full.data ?? invoice;
  const openStatus = inv.status === 'issued' || inv.status === 'part_paid';
  const foreign = inv.currency !== inv.baseCurrency;
  const fxPay = usePluginData<RateQuote>('fx-rate', foreign && openStatus ? { companyId, from: inv.currency, to: inv.baseCurrency, date: payDate } : { companyId, from: inv.currency, to: inv.currency });
  useEffect(() => {
    if (foreign && fxPay.data && !payRateTouched) setPayRate(fxPay.data.rate);
  }, [foreign, fxPay.data, payRateTouched]);
  const available = methods.data?.paymentMethods ?? [];
  const printDoc = () => {
    const el = document.querySelector('.ai3-invoice-doc');
    if (!el) return;
    const w = window.open('', '_blank', 'width=900,height=1100');
    if (!w) return;
    w.document.write(`<!doctype html><html><head><title>${inv.number}</title><style>body{font:14px -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111;margin:40px auto;max-width:800px}.ai3-table{width:100%;border-collapse:collapse;font-size:13px}.ai3-table th{text-align:left;font-size:11px;color:#666;padding:6px 8px;border-bottom:1px solid #999}.ai3-table td{padding:8px;border-bottom:1px solid #ddd}.num{text-align:right}.ai3-totals{display:flex;justify-content:flex-end;margin-top:12px}.ai3-totals td{padding:4px 0 4px 32px;text-align:right}.ai3-totals tr.total td{font-weight:600;border-top:1px solid #999;font-size:16px}.ai3-card{border:1px solid #ddd;border-radius:6px;padding:10px 12px}.ai3-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.ai3-note{color:#666;font-size:12px}a{color:#1f6fcf}</style></head><body>${el.innerHTML}</body></html>`);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 300);
  };
  return (
    <div className="ai3-detail">
      <div className="ai3-toolbar">
        <div>
          <strong>{inv.number}</strong> · {inv.customerName} · <span className={`ai3-badge ${inv.status}`}>{statusLabel(inv.status)}</span>
          <div className="ai3-note" style={{ marginTop: 4 }}>
            {inv.issuedAt ? `Issued ${dateLong(inv.issuedAt)}` : `Created ${dateLong(inv.createdAt)}`}{inv.dueAt ? ` · Due ${dateLong(inv.dueAt)}` : ''}
            {openStatus && inv.dueAt && inv.dueAt.slice(0, 10) < today() ? <span style={{ color: 'var(--ai3-red)' }}> · Overdue by {daysBetween(inv.dueAt, today())} days</span> : null}
            {foreign ? ` · ${inv.currency} at ${inv.rateToBase} ${inv.baseCurrency}` : ''}
          </div>
        </div>
        <div className="ai3-actions">
          <button className="ai3-btn" onClick={printDoc}>Print / PDF</button>
          <button className="ai3-btn" onClick={() => setShowDoc((v) => !v)}>{showDoc ? 'Hide invoice' : 'Show invoice'}</button>
          {inv.status === 'draft' && (
            <>
              <input className="ai3-input" type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} style={{ width: 160 }} />
              <button className="ai3-btn primary" disabled={busy} onClick={() => run(() => issue({ companyId, invoiceId: inv.id, issuedAt: `${issueDate}T12:00:00.000Z` }), `${inv.number} issued`)}>Issue</button>
              <button className="ai3-btn danger" disabled={busy} onClick={() => run(() => voidIt({ companyId, invoiceId: inv.id }), `${inv.number} voided`)}>Void</button>
            </>
          )}
          {openStatus && inv.connected && <button className="ai3-btn primary" disabled={busy} onClick={() => { setSendTo(inv.hosted?.sentTo ?? inv.customerEmail ?? ''); setSending((v) => !v); }}>{inv.hosted?.sentAt ? 'Send again' : 'Send'}</button>}
          {openStatus && <button className="ai3-btn danger" disabled={busy} onClick={() => run(() => writeOff({ companyId, invoiceId: inv.id }), `${inv.number} written off`)}>Write off</button>}
        </div>
      </div>
      {openStatus && full.data && (
        <div className="ai3-card" style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
          {inv.hosted ? (
            <>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>Online copy</div>
                <a href={inv.hosted.url} target="_blank" rel="noreferrer" style={{ wordBreak: 'break-all' }}>{inv.hosted.url}</a>
                <div className="ai3-note" style={{ marginTop: 4 }}>
                  {inv.hosted.sentAt ? `Sent ${dateLong(inv.hosted.sentAt)} to ${inv.hosted.sentTo ?? ''}` : 'Not sent yet'}
                  {inv.hosted.openedAt ? ` · Opened ${inv.hosted.openCount === 1 ? 'once' : `${inv.hosted.openCount} times`}, last ${dateLong(inv.hosted.openedAt)}` : inv.hosted.sentAt ? ' · Not opened yet' : ''}
                </div>
              </div>
              <div className="ai3-actions">
                <button className="ai3-btn small" onClick={() => { void navigator.clipboard?.writeText(inv.hosted!.url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>{copied ? 'Copied' : 'Copy link'}</button>
                <button className="ai3-btn small" disabled={busy} onClick={() => run(() => publish({ companyId, invoiceId: inv.id }), 'Online copy refreshed')}>Refresh copy</button>
              </div>
            </>
          ) : inv.connected ? (
            <>
              <div><div style={{ fontWeight: 600 }}>Online copy</div><div className="ai3-note">Create a page on ai3.co your customer can open, with a link you can send or paste anywhere.</div></div>
              <button className="ai3-btn small" disabled={busy} onClick={() => run(() => publish({ companyId, invoiceId: inv.id }), 'Online copy created')}>Create link</button>
            </>
          ) : (
            <div className="ai3-note">Connect this company to ai3.co under Finance › Settings to send invoices by email and share a link.</div>
          )}
        </div>
      )}
      {sending && openStatus && (
        <div className="ai3-card" style={{ marginTop: 12 }}>
          <h3>Send {inv.number}</h3>
          <div className="ai3-form-row">
            <Field label="To"><input className="ai3-input" type="email" value={sendTo} onChange={(e) => setSendTo(e.target.value)} placeholder="customer@example.com" /></Field>
            <Field label="Cc (optional)"><input className="ai3-input" value={sendCc} onChange={(e) => setSendCc(e.target.value)} /></Field>
            <Field label="Message (optional)" style={{ gridColumn: 'span 3' }}><textarea className="ai3-input" rows={3} value={sendMsg} onChange={(e) => setSendMsg(e.target.value)} placeholder={`Hi ${inv.customerName}, please find invoice ${inv.number} attached. Thank you.`} /></Field>
          </div>
          <div className="ai3-actions">
            <button className="ai3-btn primary" disabled={busy || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(sendTo)} onClick={async () => { const ok = await run(() => send({ companyId, invoiceId: inv.id, to: sendTo.trim(), cc: sendCc.trim() || null, message: sendMsg.trim() || null }), `${inv.number} sent to ${sendTo.trim()}`); if (ok) { setSending(false); setSendMsg(''); } }}>Send email</button>
            <button className="ai3-btn" onClick={() => setSending(false)}>Cancel</button>
          </div>
          <p className="ai3-note">{inv.sender ? `Goes from ${inv.sender.email} via ${inv.sender.via === 'gmail' ? 'your Gmail, so replies land in your inbox' : 'ai3.co'}.` : 'Goes from ai3.co on your behalf.'} The email carries the invoice and a link to the online copy; opens are recorded here.</p>
        </div>
      )}
      {showDoc && full.data && <InvoiceDocument inv={full.data} settings={company.data?.settings ?? null} companyName={company.data?.name ?? ''} />}
      {inv.status === 'draft' && available.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Payment options on this draft</div>
          {available.map((m) => {
            const on = inv.paymentMethods.some((p) => p.id === m.id);
            return (
              <label key={m.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0', cursor: 'pointer' }}>
                <input type="checkbox" checked={on} disabled={busy} onChange={(e) => { const ids = available.filter((x) => (x.id === m.id ? e.target.checked : inv.paymentMethods.some((p) => p.id === x.id))).map((x) => x.id); void run(() => setMethods({ companyId, invoiceId: inv.id, paymentMethodIds: ids }), 'Payment options updated'); }} />
                <span>{m.label} <span className="ai3-cap" style={{ display: 'inline' }}>· {KIND_TITLE[m.kind]}</span></span>
              </label>
            );
          })}
        </div>
      )}
      {(inv.hostedPayments?.length ?? 0) > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Paid on the online copy</div>
          <table className="ai3-table">
            <thead><tr><th>Date</th><th>How</th><th>Reference</th><th className="num">{inv.currency}</th><th></th></tr></thead>
            <tbody>{inv.hostedPayments!.map((p) => {
              const known = inv.payments.some((x) => x.reference === p.ref);
              return (
                <tr key={p.ref}>
                  <td className="muted">{dateLong(p.at)}</td>
                  <td>{p.via === 'stripe' ? 'Card' : `Wallet${p.network ? ` on ${p.network}` : ''}${p.from ? ` from ${p.from.slice(0, 6)}…${p.from.slice(-4)}` : ''}`}</td>
                  <td style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, wordBreak: 'break-all' }}>{p.explorer ? <a href={p.explorer} target="_blank" rel="noreferrer">{p.ref.slice(0, 18)}…</a> : p.ref}</td>
                  <td className="num">{fmt(p.amountMinor, { symbol: false })}</td>
                  <td>{known ? <span className="ai3-badge paid">in the books</span> : openStatus ? <button className="ai3-btn small" onClick={() => { setPayAmount(fmt(p.amountMinor, { symbol: false }).replace(/,/g, '')); setPayRef(p.ref); setPayDate(p.at.slice(0, 10)); }}>Use below</button> : null}</td>
                </tr>
              );
            })}</tbody>
          </table>
          <p className="ai3-note">Reported by ai3.co from the invoice page. A wallet payment into the company's Tempo wallet also lands through the chain feed; anything else, record it below with the reference filled in.</p>
        </div>
      )}
      {inv.payments.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Payments received</div>
          <table className="ai3-table">
            <thead><tr><th>Date</th><th>Reference</th><th className="num">{inv.currency}</th>{foreign && <th className="num">Rate</th>}{foreign && <th className="num">{inv.baseCurrency}</th>}</tr></thead>
            <tbody>{inv.payments.map((p) => <tr key={p.id}><td className="muted">{dateLong(p.occurredAt)}</td><td>{p.reference}</td><td className="num">{fmt(p.amountMinor, { symbol: false })}</td>{foreign && <td className="num">{p.rateToBase}</td>}{foreign && <td className="num">{fmt(p.baseMinor, { symbol: false })}</td>}</tr>)}</tbody>
          </table>
        </div>
      )}
      {openStatus && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border, #ddd)' }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Receive a payment</div>
          <div className="ai3-form-row" style={{ marginBottom: 8 }}>
            <Field label={`Amount paid (${inv.currency})`}><input className="ai3-input" placeholder={fmt(inv.outstandingMinor, { symbol: false })} value={payAmount} inputMode="decimal" onChange={(e) => setPayAmount(e.target.value)} /></Field>
            <Field label="Date paid"><input className="ai3-input" type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} /></Field>
            {foreign && <Field label={`Rate that day: 1 ${inv.currency} = ? ${inv.baseCurrency}`}><input className="ai3-input" placeholder={inv.rateToBase} value={payRate} inputMode="decimal" onChange={(e) => { setPayRate(e.target.value); setPayRateTouched(true); }} /><span className="ai3-cap">{fxPay.data && !payRateTouched ? `${fxPay.data.source}, ${dateLong(fxPay.data.date)}` : fxPay.error ? 'no published rate; the issue rate applies' : ''}</span></Field>}
            <Field label="Reference"><input className="ai3-input" placeholder="Bank or transaction reference" value={payRef} onChange={(e) => setPayRef(e.target.value)} /></Field>
          </div>
          <button
            className="ai3-btn primary"
            disabled={busy}
            onClick={async () => {
              const raw = payAmount.replace(/,/g, '');
              const amountMinor = AMOUNT.test(raw) ? toMinor(raw) : inv.outstandingMinor;
              const ok = await run(() => pay({ companyId, invoiceId: inv.id, amountMinor, occurredAt: `${payDate}T12:00:00.000Z`, reference: payRef || null, rateToBase: foreign && payRate ? payRate : null }), `Payment on ${inv.number} recorded`);
              if (ok) { setPayAmount(''); setPayRef(''); setPayRate(''); }
            }}
          >
            Add payment
          </button>
          {foreign && <p className="ai3-note">The published rate for the payment date is filled in; change it if your bank applied another. A rate other than the issue rate books the difference as a currency gain or loss.</p>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings: company details, base currency, payment options
// ---------------------------------------------------------------------------

function PaymentMethodForm({ companyId, onDone }: { companyId: string; onDone: () => void }) {
  const create = usePluginAction('payment-method.create');
  const { run, busy } = useRun([onDone]);
  const [kind, setKind] = useState<PaymentMethod['kind']>('bank');
  const [label, setLabel] = useState('');
  const [currency, setCurrency] = useState('');
  const [d, setD] = useState<PaymentDetails>({});
  const set = (k: keyof PaymentDetails) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setD({ ...d, [k]: e.target.value });
  const ok = label.trim() && (kind === 'bank' ? Boolean(d.accountNumber || d.iban) : kind === 'stripe' ? /^https:\/\//.test(d.url ?? '') : kind === 'crypto' ? Boolean(d.address && d.asset && d.network) : Boolean(d.instructions));
  return (
    <div className="ai3-card" style={{ marginBottom: 14 }}>
      <h3>Add a payment option</h3>
      <div className="ai3-form-row">
        <Field label="Type">
          <select className="ai3-select" value={kind} onChange={(e) => { setKind(e.target.value as PaymentMethod['kind']); setD({}); }}>
            <option value="bank">Bank transfer</option><option value="stripe">Stripe payment link</option><option value="crypto">Crypto wallet</option><option value="other">Other</option>
          </select>
        </Field>
        <Field label="Label on the invoice"><input className="ai3-input" placeholder={kind === 'bank' ? 'Mercury (USD)' : kind === 'stripe' ? 'Pay by card' : kind === 'crypto' ? 'USDC on Base' : 'PayPal'} value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
        <Field label="Currency (optional)">
          <select className="ai3-select" value={currency} onChange={(e) => setCurrency(e.target.value)}>
            <option value="">Any</option>{CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
      </div>
      {kind === 'bank' && (
        <div className="ai3-form-row">
          <Field label="Account name"><input className="ai3-input" value={d.accountName ?? ''} onChange={set('accountName')} /></Field>
          <Field label="Bank"><input className="ai3-input" value={d.bankName ?? ''} onChange={set('bankName')} /></Field>
          <Field label="Account number"><input className="ai3-input" value={d.accountNumber ?? ''} onChange={set('accountNumber')} /></Field>
          <Field label="IBAN"><input className="ai3-input" value={d.iban ?? ''} onChange={set('iban')} /></Field>
          <Field label="Sort code"><input className="ai3-input" value={d.sortCode ?? ''} onChange={set('sortCode')} /></Field>
          <Field label="Routing number"><input className="ai3-input" value={d.routingNumber ?? ''} onChange={set('routingNumber')} /></Field>
          <Field label="BIC / SWIFT"><input className="ai3-input" value={d.bic ?? ''} onChange={set('bic')} /></Field>
        </div>
      )}
      {kind === 'stripe' && (
        <div className="ai3-form-row">
          <Field label="Payment link (https://…)" style={{ gridColumn: 'span 2' }}><input className="ai3-input" placeholder="https://buy.stripe.com/…" value={d.url ?? ''} onChange={set('url')} /></Field>
        </div>
      )}
      {kind === 'crypto' && (
        <div className="ai3-form-row">
          <Field label="Asset"><input className="ai3-input" placeholder="USDC" value={d.asset ?? ''} onChange={set('asset')} list="ai3-assets" /><datalist id="ai3-assets"><option value="USDC" /><option value="USDT" /><option value="ETH" /><option value="BTC" /><option value="SOL" /></datalist></Field>
          <Field label="Network"><input className="ai3-input" placeholder="Base" value={d.network ?? ''} onChange={set('network')} list="ai3-networks" /><datalist id="ai3-networks">{NETWORKS.map((n) => <option key={n} value={n} />)}</datalist></Field>
          <Field label="Wallet address" style={{ gridColumn: 'span 2' }}><input className="ai3-input" placeholder="0x…" value={d.address ?? ''} onChange={set('address')} /></Field>
        </div>
      )}
      {kind === 'other' && (
        <div className="ai3-form-row">
          <Field label="Instructions" style={{ gridColumn: 'span 3' }}><textarea className="ai3-input" rows={3} value={d.instructions ?? ''} onChange={set('instructions')} placeholder="How the customer should pay" /></Field>
        </div>
      )}
      <div className="ai3-actions">
        <button className="ai3-btn primary" disabled={busy || !ok} onClick={() => run(() => create({ companyId, kind, label, currency: currency || null, details: d }), 'Payment option added')}>Add</button>
        <button className="ai3-btn" onClick={onDone}>Cancel</button>
      </div>
      {kind === 'crypto' && <p className="ai3-note">The address is printed exactly as entered. Check it twice; a wrong address cannot be undone.</p>}
    </div>
  );
}

interface WalletInfo { address: string; network: string; networkLabel: string; asset: string; balanceMinor: string | null; explorer: string; bankAccountId: string | null; createdAt: string }

function WalletCard({ companyId }: { companyId: string }) {
  const data = usePluginData<{ wallet: WalletInfo | null }>('wallet', { companyId });
  const create = usePluginAction('wallet.create');
  const faucet = usePluginAction('wallet.faucet');
  const sync = usePluginAction('wallet.sync');
  const { run, busy } = useRun([data.refresh]);
  const [copied, setCopied] = useState(false);
  const w = data.data?.wallet ?? null;
  return (
    <div className="ai3-card" style={{ marginTop: 14 }}>
      <div className="ai3-toolbar">
        <h3 style={{ margin: 0 }}>Wallet <span className="ctx">stablecoins on Tempo, Stripe’s payments chain · testnet</span></h3>
        {w ? <span className="ai3-badge paid">{w.networkLabel}</span> : null}
      </div>
      {!w ? (
        <div className="ai3-actions">
          <span className="ai3-note">No wallet yet. One is created automatically within minutes of the company starting; or create it now.</span>
          <button className="ai3-btn primary" disabled={busy} onClick={() => run(() => create({ companyId }), 'Wallet created and funded from the testnet faucet')}>Create wallet</button>
        </div>
      ) : (
        <>
          <div className="ai3-grid two">
            <div>
              <div className="ai3-cap">Address</div>
              <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13, wordBreak: 'break-all' }}>{w.address}</div>
              <div className="ai3-actions" style={{ marginTop: 6 }}>
                <button className="ai3-btn small" onClick={() => { void navigator.clipboard?.writeText(w.address).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>{copied ? 'Copied' : 'Copy'}</button>
                <a className="ai3-btn small" href={w.explorer} target="_blank" rel="noreferrer">Explorer</a>
              </div>
            </div>
            <div>
              <div className="ai3-cap">Balance</div>
              <div style={{ fontSize: 22, fontWeight: 600 }}>{w.balanceMinor === null ? '—' : `${fmt(w.balanceMinor, { symbol: false })} ${w.asset}`}</div>
              <div className="ai3-actions" style={{ marginTop: 6 }}>
                <button className="ai3-btn small" disabled={busy} onClick={() => run(() => faucet({ companyId }), 'Test money requested')}>Top up (faucet)</button>
                <button className="ai3-btn small" disabled={busy} onClick={() => run(() => sync({ companyId }), 'Chain read into the books')}>Read chain now</button>
              </div>
            </div>
          </div>
          <p className="ai3-note">Printed on every invoice as a payment option; transfers in and out land in the bank account "Tempo wallet" and reconcile by invoice number in the memo. The key lives in this company’s database: test money only.</p>
        </>
      )}
    </div>
  );
}

interface StripeRemote { connected: boolean; accountId: string | null; type: string | null; chargesEnabled: boolean; payoutsEnabled: boolean; detailsSubmitted: boolean; requirementsDue: string[]; disabledReason: string | null; test: boolean; card: { brand: string; last4: string | null; expMonth: number | null; expYear: number | null } | null; cardUrl: string | null; creditsUrl: string | null; dashboardUrl: string | null; onboardingUrl?: string | null; warning?: string }
interface StripeLink { accountId: string | null; bankAccountId: string | null; paymentMethodId: string | null; chargesEnabled: boolean; lastSyncedAt: string | null }

/** Stripe through ai3.co: take card payments on invoices, keep a card for paying others. */
function StripeCard({ companyId }: { companyId: string }) {
  const data = usePluginData<{ ai3Connected: boolean; link: StripeLink | null; remote: Partial<StripeRemote> | null }>('stripe', { companyId });
  const connect = usePluginAction('stripe.connect');
  const refresh = usePluginAction('stripe.status');
  const sync = usePluginAction('stripe.sync');
  const { run, busy } = useRun([data.refresh]);
  const [link, setLink] = useState<string | null>(null);
  const r = data.data?.remote ?? null;
  const ai3 = data.data?.ai3Connected ?? false;
  const connected = Boolean(r?.connected);
  const ready = Boolean(r?.chargesEnabled);
  const onboard = () => run(async () => {
    const res = (await connect({ companyId })) as { onboardingUrl?: string | null; chargesEnabled?: boolean };
    if (res.onboardingUrl) { setLink(res.onboardingUrl); window.open(res.onboardingUrl, '_blank', 'noopener'); }
  }, 'Stripe onboarding opened in a new tab');
  return (
    <div className="ai3-card" style={{ marginTop: 14 }}>
      <div className="ai3-toolbar">
        <h3 style={{ margin: 0 }}>Stripe <span className="ctx">cards on invoices · a card for paying others{r?.test ? ' · test mode' : ''}</span></h3>
        {ready ? <span className="ai3-badge paid">Card payments on</span> : connected ? <span className="ai3-badge issued">Onboarding incomplete</span> : null}
      </div>
      {!ai3 ? (
        <span className="ai3-note">Stripe runs through ai3.co. Connect this company to ai3.co above first.</span>
      ) : (
        <>
          <div className="ai3-grid two">
            <div>
              <div className="ai3-cap">Taking card payments</div>
              <div style={{ fontSize: 13, lineHeight: 1.5 }}>
                {ready ? <>Every invoice carries <strong>Pay by card</strong>; other companies on AI3 can pay you from their saved card. Charges, fees and payouts land in the bank account “Stripe”.</> : connected ? <>Stripe still needs {r?.requirementsDue?.length ? `${r.requirementsDue.length} item(s)` : 'more details'} before charges switch on.{r?.disabledReason ? ` (${r.disabledReason})` : ''}</> : <>Not connected. Onboarding takes a few minutes; an existing Stripe account can be linked.</>}
              </div>
              <div className="ai3-actions" style={{ marginTop: 6 }}>
                {!ready && <button className="ai3-btn primary small" disabled={busy} onClick={onboard}>{connected ? 'Continue Stripe setup' : 'Connect Stripe'}</button>}
                <button className="ai3-btn small" disabled={busy} onClick={() => run(() => refresh({ companyId }), 'Stripe status refreshed')}>Refresh</button>
                {ready && <button className="ai3-btn small" disabled={busy} onClick={() => run(() => sync({ companyId }), 'Stripe read into the books')}>Read Stripe now</button>}
                {r?.dashboardUrl && <a className="ai3-btn small" href={r.dashboardUrl} target="_blank" rel="noreferrer">Stripe dashboard</a>}
              </div>
              {link && <div className="ai3-cap" style={{ marginTop: 6, wordBreak: 'break-all' }}>If the tab did not open: <a href={link} target="_blank" rel="noreferrer">{link}</a></div>}
            </div>
            <div>
              <div className="ai3-cap">Paying others by card</div>
              <div style={{ fontSize: 13, lineHeight: 1.5 }}>
                {r?.card ? <>On file: <strong>{r.card.brand} ···· {r.card.last4}</strong>{r.card.expMonth ? ` (${r.card.expMonth}/${r.card.expYear})` : ''}. Agents can pay other companies’ invoices with it (pay-invoice, rail stripe); each payment is booked against “Card on file (Stripe)”.</> : <>No card on file. Agents can then only pay from the Tempo wallet.</>}
              </div>
              <div className="ai3-actions" style={{ marginTop: 6 }}>
                {r?.cardUrl && <a className="ai3-btn small" href={r.cardUrl} target="_blank" rel="noreferrer">{r.card ? 'Replace card' : 'Add a card'}</a>}
                {r?.creditsUrl && <a className="ai3-btn small" href={r.creditsUrl} target="_blank" rel="noreferrer">Top up model credits</a>}
              </div>
            </div>
          </div>
          {r?.warning && <p className="ai3-note">ai3.co: {r.warning}</p>}
          {r?.test && <p className="ai3-note">Stripe is in test mode: no real money moves. Test card 4242 4242 4242 4242, any future date, any CVC.</p>}
        </>
      )}
    </div>
  );
}

interface DisputeRow { id: string; invoiceNumber: string | null; role: string; caseId: string | null; status: string; amountMinor: string; currency: string; claim: string; ruling: { summary?: string; fault_allocation?: { claimant_pct: number; respondent_pct: number }; money_instruction?: { type: string; to_respondent_minor: number; to_claimant_minor: number; currency: string } } | null; settledTx: string | null; filedAt: string }

function DisputesList({ companyId }: { companyId: string }) {
  const data = usePluginData<{ disputes: DisputeRow[] }>('disputes', { companyId });
  const rows = data.data?.disputes ?? [];
  if (rows.length === 0) return null;
  return (
    <div className="ai3-card" style={{ marginTop: 14 }}>
      <h3>Disputes <span className="ctx">at Recourse, the venue every invoice names</span></h3>
      <table className="ai3-table">
        <thead><tr><th>Filed</th><th>Invoice</th><th>Side</th><th>Status</th><th className="num">Amount</th><th>Ruling</th></tr></thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id}>
              <td className="muted">{dateLong(d.filedAt)}</td>
              <td>{d.invoiceNumber ?? '—'}</td>
              <td>{d.role}</td>
              <td><span className={`ai3-badge ${d.status === 'decided' || d.status === 'settled' ? 'paid' : d.status === 'failed' ? 'void' : 'issued'}`}>{d.status}</span>{d.caseId ? <> · <a href={`https://recourse.so/disputes/${d.caseId}`} target="_blank" rel="noreferrer">case</a></> : null}</td>
              <td className="num">{fmt(d.amountMinor, { symbol: false })} {d.currency}</td>
              <td style={{ maxWidth: 420 }}>{d.ruling ? `${d.ruling.fault_allocation?.claimant_pct ?? '?'}% / ${d.ruling.fault_allocation?.respondent_pct ?? '?'}% fault · ${d.ruling.money_instruction?.type ?? ''} · ${d.ruling.summary ?? ''}` : d.claim}{d.settledTx ? <div className="ai3-cap">settled {d.settledTx.slice(0, 18)}…</div> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SettingsTab({ companyId, company }: { companyId: string; company: Company | null }) {
  const data = usePluginData<{ settings: Settings; paymentMethods: PaymentMethod[] }>('settings', { companyId });
  const update = usePluginAction('settings.update');
  const updateMethod = usePluginAction('payment-method.update');
  const { run, busy } = useRun([data.refresh]);
  const [form, setForm] = useState<Settings | null>(null);
  const [adding, setAdding] = useState(false);
  const s = form ?? data.data?.settings ?? { baseCurrency: company?.currency ?? 'USD', legalName: null, address: null, email: null, taxId: null, invoiceFooter: null, replyTo: null, ai3Key: null, ai3Origin: null, remindersEnabled: false, leaderboardOptIn: false, summaryPublishedAt: null };
  const connected = Boolean(data.data?.settings.ai3Key);
  const publishNow = usePluginAction('summary.publish');
  const [showKey, setShowKey] = useState(false);
  const setField = (k: keyof Settings) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm({ ...s, [k]: e.target.value });
  const methods = data.data?.paymentMethods ?? [];
  return (
    <>
      <Header crumb="Settings" title="Finance settings" sub={company?.name} />
      <Failure error={data.error} />
      <div className="ai3-grid two">
        <div className="ai3-card">
          <h3>On the invoice</h3>
          <div className="ai3-form-row">
            <Field label="Legal name" style={{ gridColumn: 'span 2' }}><input className="ai3-input" value={s.legalName ?? ''} onChange={setField('legalName')} placeholder={company?.name ?? ''} /></Field>
            <Field label="Email"><input className="ai3-input" value={s.email ?? ''} onChange={setField('email')} /></Field>
            <Field label="Address" style={{ gridColumn: 'span 2' }}><textarea className="ai3-input" rows={3} value={s.address ?? ''} onChange={setField('address')} /></Field>
            <Field label="Tax ID"><input className="ai3-input" value={s.taxId ?? ''} onChange={setField('taxId')} /></Field>
            <Field label="Footer" style={{ gridColumn: 'span 3' }}><textarea className="ai3-input" rows={2} value={s.invoiceFooter ?? ''} onChange={setField('invoiceFooter')} placeholder="Registered in…, payment terms, thank you" /></Field>
          </div>
          <div className="ai3-actions">
            <button className="ai3-btn primary" disabled={busy || !form} onClick={() => run(async () => { await update({ companyId, legalName: s.legalName ?? '', address: s.address ?? '', email: s.email ?? '', taxId: s.taxId ?? '', invoiceFooter: s.invoiceFooter ?? '' }); setForm(null); }, 'Saved')}>Save</button>
          </div>
        </div>
        <div className="ai3-card">
          <h3>Base currency</h3>
          <p className="ai3-note" style={{ marginTop: 0 }}>The books are kept in one currency. Invoices can be in any other, with a rate to this one fixed at issue; differences at payment go to Currency gains and losses.</p>
          <div className="ai3-form-row">
            <Field label="Base currency">
              <select className="ai3-select" value={s.baseCurrency} onChange={setField('baseCurrency')}>{CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}</select>
            </Field>
          </div>
          <div className="ai3-actions">
            <button className="ai3-btn" disabled={busy || !form || form.baseCurrency === data.data?.settings.baseCurrency} onClick={() => run(async () => { await update({ companyId, baseCurrency: s.baseCurrency }); setForm(null); }, 'Base currency saved')}>Save currency</button>
          </div>
          <p className="ai3-note">Change this before anything is posted. It does not convert existing entries.</p>
        </div>
      </div>
      <div className="ai3-card" style={{ marginTop: 14 }}>
        <div className="ai3-toolbar">
          <h3 style={{ margin: 0 }}>Sending invoices <span className="ctx">online copies on ai3.co and email</span></h3>
          <span className={`ai3-badge ${connected ? 'paid' : 'draft'}`}>{connected ? 'Connected to ai3.co' : 'Not connected'}</span>
        </div>
        <p className="ai3-note" style={{ marginTop: 0 }}>Each issued invoice gets a page at ai3.co with a link you can email or paste anywhere. Emails go from the Google account that owns this company, so replies land in your inbox. Companies set up through ai3.co are connected already; the key is under the company on ai3.co/companies.</p>
        <div className="ai3-form-row">
          <Field label="Company key" style={{ gridColumn: 'span 2' }}>
            <div style={{ display: 'flex', gap: 6 }}>
              <input className="ai3-input" type={showKey ? 'text' : 'password'} value={s.ai3Key ?? ''} onChange={setField('ai3Key')} placeholder="ai3k_…" autoComplete="off" />
              <button className="ai3-btn small" type="button" onClick={() => setShowKey((v) => !v)}>{showKey ? 'Hide' : 'Show'}</button>
            </div>
          </Field>
          <Field label="Reply-to (optional)"><input className="ai3-input" value={s.replyTo ?? ''} onChange={setField('replyTo')} placeholder={s.email ?? 'billing@…'} /></Field>
        </div>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', cursor: 'pointer' }}>
          <input type="checkbox" checked={s.remindersEnabled} disabled={busy} onChange={(e) => setForm({ ...s, remindersEnabled: e.target.checked })} />
          <span>Send overdue reminders automatically <span className="ai3-cap" style={{ display: 'inline' }}>· 3, 14 and 30 days past due, from your mailbox, only for invoices that were emailed</span></span>
        </label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', cursor: 'pointer' }}>
          <input type="checkbox" checked={s.leaderboardOptIn} disabled={busy} onChange={(e) => setForm({ ...s, leaderboardOptIn: e.target.checked })} />
          <span>Show this company on the AI3 leaderboard <span className="ai3-cap" style={{ display: 'inline' }}>· revenue and profit over the trailing 30 days, from these books, refreshed nightly; off by default, switch off to be removed at the next refresh</span></span>
        </label>
        {connected && <p className="ai3-note" style={{ margin: '4px 0 0' }}>Your figures reach your portfolio page at ai3.co/companies every night either way{s.summaryPublishedAt ? `; last sent ${new Date(s.summaryPublishedAt).toLocaleString()}` : '; not sent yet'}. Only the leaderboard is public.</p>}
        <div className="ai3-actions">
          <button className="ai3-btn primary" disabled={busy || !form} onClick={() => run(async () => { await update({ companyId, ai3Key: s.ai3Key ?? '', ai3Origin: s.ai3Origin || 'https://ai3.co', replyTo: s.replyTo ?? '', remindersEnabled: s.remindersEnabled, leaderboardOptIn: s.leaderboardOptIn }); if (s.ai3Key) { try { await publishNow({ companyId }); } catch { /* the nightly job will retry */ } } setForm(null); }, connected || s.ai3Key ? 'Connection saved' : 'Disconnected')}>Save</button>
          {connected && <button className="ai3-btn" disabled={busy} onClick={() => run(async () => { await publishNow({ companyId }); }, 'Figures sent to ai3.co')}>Send figures now</button>}
          {connected && <button className="ai3-btn" disabled={busy} onClick={() => run(async () => { await update({ companyId, ai3Key: '', replyTo: s.replyTo ?? '' }); setForm(null); }, 'Disconnected')}>Disconnect</button>}
        </div>
      </div>
      <WalletCard companyId={companyId} />
      <StripeCard companyId={companyId} />
      <CreditsCard companyId={companyId} full />
      <div className="ai3-card" style={{ marginTop: 14 }}>
        <div className="ai3-toolbar">
          <h3 style={{ margin: 0 }}>Payment options <span className="ctx">what customers see under "How to pay"</span></h3>
          <button className="ai3-btn primary" onClick={() => setAdding(true)}>Add payment option</button>
        </div>
        {adding && <PaymentMethodForm companyId={companyId} onDone={() => { setAdding(false); data.refresh(); }} />}
        {methods.length === 0 && !adding && <div className="ai3-empty">None yet. Add a bank account, a Stripe payment link, a crypto wallet, or written instructions.</div>}
        {methods.map((m) => (
          <div key={m.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderTop: '1px solid var(--border, #eee)', opacity: m.enabled ? 1 : 0.55 }}>
            <PayLines m={m} />
            <div className="ai3-actions" style={{ alignItems: 'flex-start' }}>
              <span className={`ai3-badge ${m.enabled ? 'paid' : 'void'}`}>{m.enabled ? (m.isDefault ? 'on new invoices' : 'optional') : 'off'}</span>
              <button className="ai3-btn small" disabled={busy} onClick={() => run(() => updateMethod({ companyId, id: m.id, isDefault: !m.isDefault }), 'Updated')}>{m.isDefault ? 'Make optional' : 'Use by default'}</button>
              <button className="ai3-btn small" disabled={busy} onClick={() => run(() => updateMethod({ companyId, id: m.id, enabled: !m.enabled }), 'Updated')}>{m.enabled ? 'Turn off' : 'Turn on'}</button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function InvoicesTab({ companyId, company }: { companyId: string; company: Company | null }) {
  const location = useHostLocation();
  const nav = useHostNavigation();
  const invs = usePluginData<{ invoices: Invoice[] }>('invoices', { companyId });
  const custs = usePluginData<{ customers: Customer[] }>('customers', { companyId });
  const cur = company?.currency ?? 'USD';
  const filterParam = new URLSearchParams(location.search).get('status') as InvoiceFilter | null;
  const [filter, setFilter] = useState<InvoiceFilter>(filterParam && FILTERS.some((f) => f.key === filterParam) ? filterParam : 'all');
  const [showNew, setShowNew] = useState(new URLSearchParams(location.search).get('new') === '1');
  const [openId, setOpenId] = useState<string | null>(new URLSearchParams(location.search).get('open'));
  const all = invs.data?.invoices ?? [];
  const rows = all.filter(FILTERS.find((f) => f.key === filter)!.test);
  const totalDue = rows.reduce((s, i) => s + BigInt(i.status === 'draft' ? i.totalMinor : i.outstandingMinor), 0n);
  const refreshAll = () => { invs.refresh(); custs.refresh(); };
  return (
    <>
      <Header
        crumb="Invoices"
        title="Invoices"
        actions={<button className="ai3-btn primary" onClick={() => setShowNew(true)}>New invoice</button>}
      />
      <Failure error={invs.error ?? custs.error} />
      {showNew && <InvoiceForm companyId={companyId} customers={custs.data?.customers ?? []} cur={cur} onDone={() => { setShowNew(false); refreshAll(); }} onCancel={() => setShowNew(false)} />}
      <div className="ai3-tabs">
        {FILTERS.map((f) => {
          const n = all.filter(f.test).length;
          return (
            <button key={f.key} className={`ai3-tab ${filter === f.key ? 'on' : ''}`} onClick={() => { setFilter(f.key); nav.navigate(`/ledger?tab=invoices&status=${f.key}`, { replace: true }); }}>
              {f.label}{f.key !== 'all' ? <span className="n">({n})</span> : null}
            </button>
          );
        })}
      </div>
      <div className="ai3-card">
        <div className="ai3-toolbar">
          <span className="summary"><b>{rows.length}</b> items | <b>{fmt(totalDue, { currency: cur })}</b> {filter === 'draft' ? 'in drafts' : filter === 'paid' ? 'collected' : 'due'}</span>
        </div>
        <table className="ai3-table">
          <thead>
            <tr><th>Number</th><th>To</th><th>Date</th><th>Due date</th><th>Status</th><th>Currency</th><th className="num">Paid</th><th className="num">Due</th></tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={8} className="ai3-empty">{invs.loading ? 'Loading…' : 'No invoices here.'}</td></tr>}
            {rows.map((i) => {
              const overdueDays = (i.status === 'issued' || i.status === 'part_paid') && i.dueAt && i.dueAt.slice(0, 10) < today() ? daysBetween(i.dueAt, today()) : 0;
              const isOpen = openId === i.id;
              return (
                <React.Fragment key={i.id}>
                  <tr className="click" onClick={() => setOpenId(isOpen ? null : i.id)}>
                    <td><a onClick={(e) => e.preventDefault()} href="#">{i.number}</a></td>
                    <td>{i.customerName}</td>
                    <td className="muted">{dateLong(i.issuedAt ?? i.createdAt)}</td>
                    <td className={overdueDays ? 'red' : 'muted'}>{dateLong(i.dueAt)}{overdueDays ? <span> · {overdueDays}d overdue</span> : null}</td>
                    <td><span className={`ai3-badge ${i.status}`}>{statusLabel(i.status)}</span></td>
                    <td className="muted">{i.currency}</td>
                    <td className="num">{fmt(i.paidMinor, { symbol: false })}</td>
                    <td className="num">{fmt(i.status === 'draft' ? i.totalMinor : i.outstandingMinor, { symbol: false })}</td>
                  </tr>
                  {isOpen && (
                    <tr><td colSpan={8} style={{ padding: '0 0 8px' }}><InvoiceDetail companyId={companyId} invoice={i} cur={cur} onChanged={refreshAll} /></td></tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <DisputesList companyId={companyId} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Statements: profit and loss, balance sheet, periods
// ---------------------------------------------------------------------------

function pnlRange(choice: string, periods: Period[], from: string, to: string): { from: string; to: string; label: string; periodId?: string } {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const iso = (d: Date) => d.toISOString();
  if (choice === 'last-month') {
    const a = new Date(Date.UTC(y, m - 1, 1));
    const b = new Date(Date.UTC(y, m, 0, 23, 59, 59, 999));
    return { from: iso(a), to: iso(b), label: `${MONTHS[a.getUTCMonth()]} ${a.getUTCFullYear()}` };
  }
  if (choice === 'ytd') return { from: iso(new Date(Date.UTC(y, 0, 1))), to: iso(now), label: `1 Jan ${y} to ${dateLong(iso(now))}` };
  if (choice === 'custom' && from && to) return { from: `${from}T00:00:00.000Z`, to: `${to}T23:59:59.999Z`, label: `${dateLong(from)} to ${dateLong(to)}` };
  const p = periods.find((x) => x.id === choice);
  if (p) return { from: `${p.startsOn}T00:00:00.000Z`, to: `${p.endsOn}T23:59:59.999Z`, label: `${dateLong(p.startsOn)} to ${dateLong(p.endsOn)}`, periodId: p.id };
  const a = new Date(Date.UTC(y, m, 1));
  return { from: iso(a), to: iso(now), label: `${dateLong(iso(a))} to ${dateLong(iso(now))}` };
}

function StatementRows({ title, lines, totalLabel, total, cur, sign = 1n, linkFor, totalLink }: { title: string; lines: Array<{ code: string; name: string; amount: string }>; totalLabel: string; total: bigint; cur: string; sign?: bigint; linkFor?: (code: string, name: string) => string | null; totalLink?: string | null }) {
  const nav = useHostNavigation();
  const cell = (href: string | null | undefined, text: string) => (href ? <a {...nav.linkProps(href)} title="See the entries behind this figure">{text}</a> : text);
  return (
    <>
      <tr className="section"><td colSpan={2}>{title}</td></tr>
      {lines.length === 0 && <tr className="line"><td className="muted" style={{ color: 'var(--muted-foreground)' }}>Nothing in this window</td><td className="num">—</td></tr>}
      {lines.map((l) => {
        const href = linkFor ? linkFor(l.code, l.name) : null;
        return <tr className="line" key={l.code}><td>{cell(href, l.name)}</td><td className="num link">{cell(href, fmt(BigInt(l.amount) * sign, { symbol: false, paren: true, currency: cur }))}</td></tr>;
      })}
      <tr className="total"><td>{cell(totalLink, totalLabel)}</td><td className="num">{cell(totalLink, fmt(total * sign, { symbol: false, paren: true }))}</td></tr>
    </>
  );
}

function StatementsTab({ companyId, company }: { companyId: string; company: Company | null }) {
  const location = useHostLocation();
  const cur = company?.currency ?? 'USD';
  const periods = usePluginData<{ periods: Period[] }>('periods', { companyId });
  const list = periods.data?.periods ?? [];
  const [choice, setChoice] = useState('this-month');
  const [from, setFrom] = useState(today().slice(0, 8) + '01');
  const [to, setTo] = useState(today());
  const [groupBy, setGroupBy] = useState('');
  const range = pnlRange(choice, list, from, to);
  const pnl = usePluginData<Pnl>('pnl', { companyId, from: range.from, to: range.to, ...(groupBy ? { groupBy } : {}) });
  const [asOf, setAsOf] = useState(today());
  const asOfIso = `${asOf}T23:59:59.999Z`;
  const nav = useHostNavigation();
  const sheet = usePluginData<BalanceSheet>('balance-sheet', { companyId, asOf: asOfIso });
  const createPeriod = usePluginAction('period.create');
  const closePeriod = usePluginAction('period.close');
  const { run, busy } = useRun([periods.refresh, pnl.refresh]);
  const now = new Date();
  const [month, setMonth] = useState(`${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`);
  const balanceFirst = location.search.includes('view=balance');
  const trialFirst = location.search.includes('view=trial');
  const selectedPeriod = list.find((p) => p.id === choice);
  const p = pnl.data;
  const b = sheet.data;

  const pnlCard = (
    <div className="ai3-report">
      <h2>Profit and Loss</h2>
      <div className="who">{company?.name ?? ''}</div>
      <div className="when">For the period {range.label}</div>
      {p && (
        <table className="ai3-stmt">
          <thead><tr><th></th><th>{cur}</th></tr></thead>
          <tbody>
            <StatementRows title="Income" lines={p.lines.filter((l) => l.type === 'income').map((l) => ({ code: l.code, name: l.name, amount: l.amountMinor }))} totalLabel="Total income" total={BigInt(p.incomeMinor)} cur={cur} linkFor={(code, name) => entriesLink({ account: code, from: range.from, to: range.to, label: `${code} ${name}` })} totalLink={entriesLink({ type: 'income', from: range.from, to: range.to, label: 'Income' })} />
            <StatementRows title="Expenses" lines={p.lines.filter((l) => l.type === 'expense').map((l) => ({ code: l.code, name: l.name, amount: l.amountMinor }))} totalLabel="Total expenses" total={BigInt(p.expenseMinor)} cur={cur} linkFor={(code, name) => entriesLink({ account: code, from: range.from, to: range.to, label: `${code} ${name}` })} totalLink={entriesLink({ type: 'expense', from: range.from, to: range.to, label: 'Expenses' })} />
            <tr className="grand"><td>Net profit</td><td className="num">{fmt(p.netMinor, { symbol: false, paren: true })}</td></tr>
          </tbody>
        </table>
      )}
      {p && groupBy && p.groups.length > 0 && (
        <table className="ai3-stmt" style={{ marginTop: 22 }}>
          <thead><tr><th style={{ textAlign: 'left' }}>By {groupBy}</th><th>Income</th><th>Expenses</th><th>Net</th></tr></thead>
          <tbody>
            {p.groups.map((g) => (
              <tr className="line" key={g.key ?? 'none'} style={{ fontWeight: 400 }}>
                <td style={{ paddingLeft: 0 }}>{g.key ? g.key : 'Unattributed'}</td>
                <td className="num"><a {...nav.linkProps(entriesLink({ type: 'income', from: range.from, to: range.to, groupBy, groupKey: g.key, label: `Income · ${groupBy} ${g.key ?? 'unattributed'}` }))}>{fmt(g.incomeMinor, { symbol: false })}</a></td>
                <td className="num"><a {...nav.linkProps(entriesLink({ type: 'expense', from: range.from, to: range.to, groupBy, groupKey: g.key, label: `Expenses · ${groupBy} ${g.key ?? 'unattributed'}` }))}>{fmt(g.expenseMinor, { symbol: false })}</a></td>
                <td className="num">{fmt(g.netMinor, { symbol: false, paren: true })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {selectedPeriod && selectedPeriod.status === 'open' && (
        <p className="ai3-note" style={{ marginTop: 16 }}>
          <button className="ai3-btn small" disabled={busy} onClick={() => run(() => closePeriod({ companyId, periodId: selectedPeriod.id }), `${selectedPeriod.label} closed`)}>Close this period</button>
          <span style={{ marginLeft: 8 }}>Closing locks it: nothing dated inside can be posted afterwards.</span>
        </p>
      )}
      {selectedPeriod && selectedPeriod.status === 'closed' && <p className="ai3-note" style={{ marginTop: 16 }}>This period is closed.</p>}
    </div>
  );

  const sheetCard = (
    <div className="ai3-report">
      <h2>Balance Sheet</h2>
      <div className="who">{company?.name ?? ''}</div>
      <div className="when">As at {dateLong(asOf)}</div>
      {b && (
        <table className="ai3-stmt">
          <thead><tr><th></th><th>{cur}</th></tr></thead>
          <tbody>
            <StatementRows title="Assets" lines={b.assets.lines.map((l) => ({ code: l.code, name: l.name, amount: l.balanceMinor }))} totalLabel="Total assets" total={BigInt(b.assets.totalMinor)} cur={cur} linkFor={(code, name) => entriesLink({ account: code, to: asOfIso, label: `${code} ${name}` })} totalLink={entriesLink({ type: 'asset', to: asOfIso, label: 'Assets' })} />
            <StatementRows title="Liabilities" lines={b.liabilities.lines.map((l) => ({ code: l.code, name: l.name, amount: l.balanceMinor }))} totalLabel="Total liabilities" total={BigInt(b.liabilities.totalMinor)} cur={cur} linkFor={(code, name) => entriesLink({ account: code, to: asOfIso, label: `${code} ${name}` })} totalLink={entriesLink({ type: 'liability', to: asOfIso, label: 'Liabilities' })} />
            <tr className="grand"><td>Net assets</td><td className="num">{fmt(BigInt(b.assets.totalMinor) - BigInt(b.liabilities.totalMinor), { symbol: false, paren: true })}</td></tr>
            <StatementRows title="Equity" lines={b.equity.lines.map((l) => ({ code: l.code, name: l.name, amount: l.balanceMinor }))} totalLabel="Total equity" total={BigInt(b.equity.totalMinor)} cur={cur} linkFor={(code, name) => (code.endsWith('.current') ? `/ledger?tab=statements` : entriesLink({ account: code, to: asOfIso, label: `${code} ${name}` }))} />
          </tbody>
        </table>
      )}
      {b && (
        <p className="ai3-note" style={{ marginTop: 12 }}>
          <span className={`ai3-badge ${b.balances ? 'ok' : 'bad'}`}>{b.balances ? 'Balances' : 'Does not balance'}</span>
          <span style={{ marginLeft: 8 }}>Assets equal liabilities plus equity, with income less expense to date shown as current earnings.</span>
        </p>
      )}
    </div>
  );

  return (
    <>
      <Header crumb="Statements" title={trialFirst ? 'Trial balance' : balanceFirst ? 'Balance sheet' : 'Profit and loss'} sub={company?.name} />
      <Failure error={periods.error ?? pnl.error ?? sheet.error} />
      <div className="ai3-card" style={{ marginBottom: 14 }}>
        <div className="ai3-report-bar">
          <Field label="Profit and loss period">
            <select className="ai3-select" value={choice} onChange={(e) => setChoice(e.target.value)}>
              <option value="this-month">This month so far</option>
              <option value="last-month">Last month</option>
              <option value="ytd">Year to date</option>
              {list.map((x) => <option key={x.id} value={x.id}>{x.label}{x.status === 'closed' ? ' (closed)' : ''}</option>)}
              <option value="custom">Custom range</option>
            </select>
          </Field>
          {choice === 'custom' && (
            <>
              <Field label="From"><input className="ai3-input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
              <Field label="To"><input className="ai3-input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
            </>
          )}
          <Field label="Split by">
            <select className="ai3-select" value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
              <option value="">Whole company</option>
              <option value="agent">Agent</option>
              <option value="project">Project</option>
              <option value="goal">Goal</option>
            </select>
          </Field>
          <Field label="Balance sheet and trial balance date"><input className="ai3-input" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
        </div>
      </div>
      {trialFirst ? <><TrialBalanceCard companyId={companyId} company={company} asOf={asOf} />{sheetCard}{pnlCard}</> : balanceFirst ? <>{sheetCard}{pnlCard}<TrialBalanceCard companyId={companyId} company={company} asOf={asOf} /></> : <>{pnlCard}{sheetCard}<TrialBalanceCard companyId={companyId} company={company} asOf={asOf} /></>}
      <div className="ai3-card">
        <h3>Periods</h3>
        {list.length === 0 ? (
          <p className="ai3-note" style={{ marginTop: 0 }}>No periods yet. Create the current month so it can be closed later.</p>
        ) : (
          <table className="ai3-table" style={{ marginBottom: 12 }}>
            <thead><tr><th>Period</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {list.map((x) => (
                <tr key={x.id}>
                  <td>{dateLong(x.startsOn)} to {dateLong(x.endsOn)}</td>
                  <td><span className={`ai3-badge ${x.status === 'closed' ? 'ok' : 'draft'}`}>{x.status === 'closed' ? 'Closed' : 'Open'}</span></td>
                  <td className="num">{x.status === 'open' && <button className="ai3-btn small" disabled={busy} onClick={() => run(() => closePeriod({ companyId, periodId: x.id }), `${x.label} closed`)}>Close</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="ai3-actions" style={{ alignItems: 'flex-end' }}>
          <Field label="Month"><input className="ai3-input" type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></Field>
          <button className="ai3-btn" disabled={busy || !/^\d{4}-\d{2}$/.test(month)} onClick={() => run(() => createPeriod({ companyId, month }), `${month} created`)}>Create month</button>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Bank accounts
// ---------------------------------------------------------------------------

interface BankAccount {
  id: string; name: string; kind: string; currency: string; feed: string; accountCode: string; externalRef: string | null;
  ledgerBalanceMinor: string; statementBalanceMinor: string | null; lastLineAt: string | null; unreconciled: number;
  lastRun: { at: string | null; autoPosted: number; leftForReview: number; linesSeen: number } | null;
}
interface Institution { id: string; name: string; kind: string; provider: string; connectionType: string; countries?: string[]; popular?: boolean; network?: string; exchange?: string }
interface ExchangeInfo { id: string; name: string; fields: Array<{ key: 'apiKey' | 'secret' | 'passphrase'; label: string; secret: boolean; help?: string }>; currencies: string[]; note: string }
interface ConnectedWallet { id: string; kind: 'address' | 'exchange'; label: string; network: string | null; address: string | null; exchange: string | null; currency: string; bankAccountId: string | null; lastSyncAt: string | null; lastError: string | null; balanceMinor: string | null; explorer: string | null; chainName: string | null; symbol: string | null; proof: unknown }
interface Proposal {
  kind: 'match' | 'batch' | 'create' | 'transfer' | 'ask'; confidence: number; reason: string; transactionIds?: string[]; accountCode?: string; contactName?: string;
  otherBankAccountId?: string; otherLineId?: string; invoiceId?: string; options?: Array<{ label: string; decision: Record<string, unknown> }>;
}
interface StatementLine {
  id: string; postedAt: string; amountMinor: string; description: string; payee: string | null; reference: string | null; status: string; proposal: Proposal | null; reconciledAt: string | null; reconciledBy: string | null;
}

const KIND_LABEL: Record<string, string> = { bank: 'Bank', card: 'Card', stripe: 'Payment provider', wallet: 'Wallet' };
const ACCOUNT_CHOICES: Array<{ code: string; name: string; dir: 'in' | 'out' | 'any' }> = [
  { code: '5000', name: 'Model inference', dir: 'out' },
  { code: '5100', name: 'Tools and APIs', dir: 'out' },
  { code: '5200', name: 'Compute and sandboxes', dir: 'out' },
  { code: '5300', name: 'Payment processing', dir: 'out' },
  { code: '5900', name: 'Other operating', dir: 'out' },
  { code: '4000', name: 'Service income', dir: 'in' },
  { code: '3000', name: 'Contributed funds (owner funding)', dir: 'in' },
  { code: '2000', name: 'Payables', dir: 'any' },
];


// ---------------------------------------------------------------------------
// Connected wallets: an address watched on a chain, or an exchange read by key
// ---------------------------------------------------------------------------

const SINCE_OPTIONS = [{ v: '0', l: 'From now' }, { v: '7', l: 'Last 7 days' }, { v: '30', l: 'Last 30 days' }];

function WalletPicker({ onPick, disabled }: { onPick: (w: DiscoveredWallet) => void; disabled?: boolean }) {
  const [wallets, setWallets] = useState<DiscoveredWallet[] | null>(null);
  useEffect(() => { void discoverWallets().then(setWallets); }, []);
  if (wallets === null) return <span className="ai3-note">Looking for wallets in this browser…</span>;
  if (wallets.length === 0) return <span className="ai3-note">No wallet extension found in this browser. Paste the address instead, or install MetaMask, Rabby or Coinbase Wallet. A hardware wallet connects through one of those.</span>;
  return (
    <div className="ai3-actions">
      {wallets.map((w) => (
        <button key={w.uuid} className="ai3-btn" disabled={disabled} onClick={() => onPick(w)}>
          {w.icon ? <img src={w.icon} alt="" style={{ width: 16, height: 16 }} /> : null}{w.name}
        </button>
      ))}
    </div>
  );
}

function ConnectWalletForm({ companyId, institution, onDone, onBack }: { companyId: string; institution: Institution; onDone: () => void; onBack: () => void }) {
  const chains = usePluginData<{ chains: ChainInfo[] }>('chains', { companyId });
  const chain = chains.data?.chains.find((c) => c.slug === institution.network) ?? null;
  const connect = usePluginAction('wallet.connect');
  const toast = usePluginToast();
  const { run, busy } = useRun([]);
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [since, setSince] = useState('0');
  const [picked, setPicked] = useState<DiscoveredWallet | null>(null);
  const [proof, setProof] = useState<{ message: string; signature: string } | null>(null);
  const valid = /^0x[0-9a-fA-F]{40}$/.test(address.trim());
  const ownership = usePluginData<{ message: string; at: string }>('ownership-message', { companyId, address: valid ? address.trim() : '' });
  async function pickWallet(w: DiscoveredWallet) {
    try {
      const a = await connectWallet(w.provider);
      setPicked(w);
      setAddress(a);
      setProof(null);
    } catch (err) {
      toast({ title: 'Wallet not connected', body: err instanceof Error ? err.message : String(err), tone: 'error' });
    }
  }
  async function sign() {
    if (!picked || !ownership.data) return;
    try {
      const signature = await signMessage(picked.provider, address.trim(), ownership.data.message);
      setProof({ message: ownership.data.message, signature });
      toast({ title: 'Ownership signed', body: 'The signature is kept with the wallet as proof it is yours.', tone: 'success' });
    } catch (err) {
      toast({ title: 'Not signed', body: err instanceof Error ? err.message : String(err), tone: 'error' });
    }
  }
  async function save() {
    const ok = await run(async () => {
      const r = (await connect({ companyId, label: label.trim() || null, network: institution.network, address: address.trim(), proof, sinceDays: Number(since) })) as { label: string; proven: boolean };
      toast({ title: `${r.label} connected`, body: `${chain?.token.symbol ?? 'Token'} transfers in and out land in its bank account within five minutes.${r.proven ? ' Ownership proven by signature.' : ''}`, tone: 'success', ttlMs: 8000 });
    }, 'Wallet connected');
    if (ok) onDone();
  }
  return (
    <>
      <p className="ai3-note" style={{ marginTop: 0 }}><strong>{institution.name}</strong> · watched by address on {chain?.name ?? institution.network}{chain?.testnet ? ' (testnet)' : ''}. <a href="#" onClick={(e) => { e.preventDefault(); onBack(); }}>Choose another</a></p>
      <div style={{ marginBottom: 10 }}>
        <div className="ai3-cap" style={{ marginBottom: 6 }}>Connect a wallet in this browser, or paste the address. Hot and hardware wallets are the same to the ledger: an address it reads.</div>
        <WalletPicker onPick={pickWallet} disabled={busy} />
      </div>
      <div className="ai3-form-row">
        <Field label="Address" style={{ gridColumn: 'span 2' }}><input className="ai3-input" value={address} onChange={(e) => { setAddress(e.target.value); setProof(null); }} placeholder="0x…" spellCheck={false} /></Field>
        <Field label="Label"><input className="ai3-input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={valid ? `${chain?.name ?? ''} wallet ${short(address.trim())}` : 'Treasury wallet'} /></Field>
        <Field label="Read history">
          <select className="ai3-select" value={since} onChange={(e) => setSince(e.target.value)}>{SINCE_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}</select>
        </Field>
      </div>
      <div className="ai3-actions">
        <button className="ai3-btn primary" disabled={busy || !valid} onClick={save}>Connect wallet</button>
        {picked && valid && !proof && <button className="ai3-btn" disabled={busy || !ownership.data} onClick={sign}>Sign to prove it is yours</button>}
        {proof && <span className="ai3-badge paid">Ownership signed</span>}
      </div>
      <p className="ai3-note">Only the address is stored{proof ? ', with the signature' : ''}. The ledger never holds this wallet's key; paying from it happens in your wallet, when you click Pay on an invoice.</p>
    </>
  );
}

function ConnectExchangeForm({ companyId, institution, onDone, onBack }: { companyId: string; institution: Institution; onDone: () => void; onBack: () => void }) {
  const info = usePluginData<{ exchanges: ExchangeInfo[] }>('chains', { companyId });
  const ex = info.data?.exchanges.find((e) => e.id === institution.exchange) ?? null;
  const connect = usePluginAction('wallet.exchange');
  const toast = usePluginToast();
  const { run, busy } = useRun([]);
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [currency, setCurrency] = useState('');
  const [label, setLabel] = useState('');
  const [since, setSince] = useState('30');
  const cur = currency || ex?.currencies[0] || 'USD';
  const complete = Boolean(ex) && ex!.fields.every((f) => f.key === 'passphrase' || (creds[f.key] ?? '').trim());
  async function save() {
    const ok = await run(async () => {
      const r = (await connect({ companyId, label: label.trim() || null, exchange: institution.exchange, apiKey: creds['apiKey'] ?? '', secret: creds['secret'] ?? '', passphrase: creds['passphrase'] ?? null, currency: cur, sinceDays: Number(since) })) as { label: string; detail: string };
      toast({ title: `${r.label} connected`, body: `${ex?.name ?? 'The exchange'} accepted the key (${r.detail}). Its ${cur} ledger is read every five minutes.`, tone: 'success', ttlMs: 8000 });
    }, 'Exchange connected');
    if (ok) onDone();
  }
  return (
    <>
      <p className="ai3-note" style={{ marginTop: 0 }}><strong>{institution.name}</strong> · read with an API key. <a href="#" onClick={(e) => { e.preventDefault(); onBack(); }}>Choose another</a></p>
      {ex && <p className="ai3-note" style={{ marginTop: 0 }}>{ex.note} The ledger only reads; a key that can trade or withdraw is more than it needs.</p>}
      <div className="ai3-form-row">
        {(ex?.fields ?? []).map((f) => (
          <Field key={f.key} label={f.label} {...(f.secret ? { style: { gridColumn: 'span 2' } } : {})}>
            {f.secret ? <textarea className="ai3-input" rows={3} value={creds[f.key] ?? ''} onChange={(e) => setCreds({ ...creds, [f.key]: e.target.value })} placeholder={f.help ?? ''} spellCheck={false} /> : <input className="ai3-input" value={creds[f.key] ?? ''} onChange={(e) => setCreds({ ...creds, [f.key]: e.target.value })} placeholder={f.help ?? ''} spellCheck={false} />}
          </Field>
        ))}
        <Field label="Currency to read">
          <select className="ai3-select" value={cur} onChange={(e) => setCurrency(e.target.value)}>{(ex?.currencies ?? ['USD']).map((c) => <option key={c} value={c}>{c}</option>)}</select>
        </Field>
        <Field label="Label"><input className="ai3-input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={`${ex?.name ?? institution.name} · ${cur}`} /></Field>
        <Field label="Read history">
          <select className="ai3-select" value={since} onChange={(e) => setSince(e.target.value)}>{[{ v: '7', l: 'Last 7 days' }, { v: '30', l: 'Last 30 days' }, { v: '90', l: 'Last 90 days' }, { v: '365', l: 'Last year' }].map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}</select>
        </Field>
      </div>
      <div className="ai3-actions">
        <button className="ai3-btn primary" disabled={busy || !complete} onClick={save}>{busy ? 'Checking the key…' : 'Connect exchange'}</button>
      </div>
      <p className="ai3-note">One account per currency: add {ex?.name ?? 'the exchange'} again for another currency. Credentials are sealed in this company's database; use a read-only key all the same.</p>
    </>
  );
}

interface WalletOffer { address: string; chainRef: string | null; txHash: string | null; amountMinor: string; at: string | null; topUps: number; network: string | null; chainName: string | null; explorer: string | null }

interface BankFeedsView {
  ai3Connected: boolean;
  providers: { plaid: boolean; gocardless: boolean } | null;
  connectUrl: string | null;
  connections: Array<{ id: string; provider: 'plaid' | 'gocardless'; institutionName: string | null; accounts: Array<{ id: string; name: string; currency: string; bankAccountId: string | null }>; lastSyncedAt: string | null; revokedAt: string | null; error: string | null }>;
  accounts: Array<{ bankAccountId: string; name: string; currency: string; lastLineAt: string | null; unreconciled: number }>;
  error: string | null;
}

/**
 * A bank feed is authorised by the owner at their own bank, so it cannot start
 * here: ai3.co holds the aggregator apps and runs that flow. This says so
 * plainly and hands over, rather than creating an account whose feed would
 * stay pending forever.
 */
function ConnectBankFeed({ companyId, institution, country, onBack, onManual }: { companyId: string; institution: Institution; country: string; onBack: () => void; onManual: () => void }) {
  const feeds = usePluginData<BankFeedsView>('bank-feeds', { companyId });
  const d = feeds.data;
  const ready = institution.provider === 'plaid' ? d?.providers?.plaid : d?.providers?.gocardless;
  // The country the person chose decides which aggregator ai3.co offers.
  const url = d?.connectUrl ? `${d.connectUrl}${d.connectUrl.includes('?') ? '&' : '?'}country=${encodeURIComponent(country === 'EU' ? 'DE' : country)}` : null;
  return (
    <>
      <p className="ai3-note" style={{ marginTop: 0 }}><strong>{institution.name}</strong> · automatic feed via {institution.provider}. <a href="#" onClick={(e) => { e.preventDefault(); onBack(); }}>Choose another</a></p>
      {!d?.ai3Connected ? (
        <p className="ai3-note">Bank feeds come through ai3.co, and this company is not connected to it yet. Add the company key under Finance › Settings, then come back.</p>
      ) : !url ? (
        <p className="ai3-note">ai3.co did not offer a bank page for this company{d.error ? `: ${d.error}` : ''}. Statements can be uploaded in the meantime.</p>
      ) : (
        <>
          <p className="ai3-note" style={{ marginTop: 0 }}>
            You authorise {institution.name} at your own bank, on ai3.co — nothing about your bank is typed here.
            {ready ? ' Once you have, the account appears in this list within the half hour and its transactions arrive reconciled.' : ` ${institution.provider} is not switched on for this host yet, so the page will say so honestly.`}
          </p>
          <div className="ai3-actions">
            <a className="ai3-btn primary" href={url} target="_blank" rel="noreferrer">Connect {institution.name} on ai3.co ↗</a>
            <button className="ai3-btn" onClick={onManual}>Add it for uploads instead</button>
          </div>
          <p className="ai3-note">{institution.provider === 'gocardless' ? 'Your bank allows a small number of reads a day, so the feed runs a few times a day rather than constantly. “Sync now” on the account asks straight away.' : 'The feed runs every half hour.'}</p>
        </>
      )}
    </>
  );
}

function AddBankAccount({ companyId, onDone, onCancel }: { companyId: string; onDone: () => void; onCancel: () => void }) {
  const [query, setQuery] = useState('');
  const [country, setCountry] = useState('US');
  const [picked, setPicked] = useState<Institution | null>(null);
  const [name, setName] = useState('');
  const [manual, setManual] = useState(false);
  const [kind, setKind] = useState('bank');
  const institutions = usePluginData<{ institutions: Institution[] }>('feed-institutions', { companyId, query, country });
  const create = usePluginAction('bank.create');
  const toast = usePluginToast();
  const { run, busy } = useRun([]);
  const list = institutions.data?.institutions ?? [];
  async function save() {
    const ok = await run(async () => {
      const r = (await create({ companyId, institutionId: picked?.id, name: name || picked?.name, kind: picked?.kind ?? kind })) as { feedStatus: string; name: string };
      if (r.feedStatus !== 'upload') toast({ title: `${r.name} added; feed pending`, body: `The account is ready for uploads. Its feed ${r.feedStatus}.`, tone: 'info', ttlMs: 9000 });
    }, 'Bank account added');
    if (ok) onDone();
  }
  return (
    <div className="ai3-card" style={{ marginBottom: 14 }}>
      <div className="ai3-toolbar">
        <h3 style={{ margin: 0 }}>Select your account</h3>
        <div className="ai3-actions">
          <button className="ai3-btn" onClick={() => { setManual(true); setPicked(null); }}>Add without a feed</button>
          <button className="ai3-btn" onClick={onCancel}>Cancel</button>
        </div>
      </div>
      {!manual && !picked && (
        <>
          <p className="ai3-note" style={{ marginTop: 0 }}>Search for banks, cards, payment providers, wallets and exchanges. Bank feeds come through ai3.co — Plaid in the US and Canada, GoCardless everywhere else — and you authorise them at your own bank; Stripe connects with a restricted key; a wallet is watched by its address; an exchange is read with a read-only API key.</p>
          <div className="ai3-form-row">
            <Field label="Search" style={{ gridColumn: 'span 2' }}><input className="ai3-input" autoFocus placeholder="Mercury, Monzo, Stripe…" value={query} onChange={(e) => setQuery(e.target.value)} /></Field>
            <Field label="Country">
              <select className="ai3-select" value={country} onChange={(e) => setCountry(e.target.value)}>
                <option value="US">United States</option><option value="GB">United Kingdom</option><option value="EU">Europe</option><option value="CA">Canada</option><option value="AU">Australia</option>
              </select>
            </Field>
          </div>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>{query ? `${list.length} results` : `Popular in ${country === 'US' ? 'the United States' : country === 'GB' ? 'the United Kingdom' : 'your region'}`}</div>
          <div className="ai3-grid">
            {list.map((i) => (
              <button key={i.id} className="ai3-card" style={{ textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit' }} onClick={() => { setPicked(i); setName(i.name); }}>
                <div style={{ fontWeight: 600 }}>{i.name}</div>
                <div className="ai3-cap">{KIND_LABEL[i.kind] ?? i.kind} · {i.connectionType}{!['upload', 'stripe', 'chain', 'exchange'].includes(i.provider) ? ` via ${i.provider}` : ''}</div>
              </button>
            ))}
          </div>
        </>
      )}
      {picked && picked.provider === 'chain' && <ConnectWalletForm companyId={companyId} institution={picked} onDone={onDone} onBack={() => setPicked(null)} />}
      {picked && picked.provider === 'exchange' && <ConnectExchangeForm companyId={companyId} institution={picked} onDone={onDone} onBack={() => setPicked(null)} />}
      {picked && !manual && (picked.provider === 'plaid' || picked.provider === 'gocardless') && (
        <ConnectBankFeed companyId={companyId} institution={picked} country={country} onBack={() => setPicked(null)} onManual={() => setManual(true)} />
      )}
      {(manual || (picked && !['chain', 'exchange', 'plaid', 'gocardless'].includes(picked.provider))) && (
        <>
          {picked && <p className="ai3-note" style={{ marginTop: 0 }}><strong>{picked.name}</strong> · {picked.connectionType}{picked.provider !== 'upload' && picked.provider !== 'stripe' ? ` via ${picked.provider}` : ''}. <a href="#" onClick={(e) => { e.preventDefault(); setPicked(null); }}>Choose another</a></p>}
          <div className="ai3-form-row">
            <Field label="Account name"><input className="ai3-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Mercury Checking" /></Field>
            {manual && (
              <Field label="Kind">
                <select className="ai3-select" value={kind} onChange={(e) => setKind(e.target.value)}>
                  <option value="bank">Bank account</option><option value="card">Card</option><option value="stripe">Payment provider</option><option value="wallet">Wallet</option>
                </select>
              </Field>
            )}
          </div>
          <div className="ai3-actions">
            <button className="ai3-btn primary" disabled={busy || !name.trim()} onClick={save}>{picked && picked.provider !== 'upload' ? 'Add and connect' : 'Add account'}</button>
          </div>
          {picked && picked.provider !== 'upload' && <p className="ai3-note">Until the feed is connected, statements can be uploaded to this account. Nothing is lost but convenience.</p>}
        </>
      )}
    </div>
  );
}

function UploadStatement({ companyId, accounts, preselect, onDone }: { companyId: string; accounts: BankAccount[]; preselect?: string; onDone: (bankAccountId: string) => void }) {
  const importAction = usePluginAction('bank.import');
  const { run, busy } = useRun([]);
  const [bankAccountId, setBankAccountId] = useState(preselect ?? accounts[0]?.id ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<{ imported: number; duplicates: number; from: string | null; to: string | null; reading: string; warnings: string[]; closingBalanceMinor: string | null } | null>(null);
  async function upload() {
    if (!file) return;
    const content = await file.text();
    await run(async () => {
      const r = (await importAction({ companyId, bankAccountId, filename: file.name, content })) as typeof result;
      setResult(r);
    }, 'Statement read');
  }
  const bank = accounts.find((a) => a.id === bankAccountId);
  return (
    <div className="ai3-card" style={{ marginBottom: 14 }}>
      <h3>Upload a statement <span className="ctx">CSV, OFX, QFX or QBO from any bank</span></h3>
      {!result ? (
        <>
          <div className="ai3-form-row">
            <Field label="Into">
              <select className="ai3-select" value={bankAccountId} onChange={(e) => setBankAccountId(e.target.value)}>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
            <Field label="File"><input className="ai3-input" type="file" accept=".csv,.txt,.ofx,.qfx,.qbo,.tsv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
          </div>
          <div className="ai3-actions">
            <button className="ai3-btn primary" disabled={busy || !file || !bankAccountId} onClick={upload}>Read the file</button>
            <button className="ai3-btn" onClick={() => onDone(bankAccountId)}>Cancel</button>
          </div>
          <p className="ai3-note">No column mapping to fill in. The reader works out dates, amounts and descriptions from the file, tells you how it read them, and skips lines already imported.</p>
        </>
      ) : (
        <>
          <p style={{ margin: '0 0 6px' }}>
            <strong>{result.imported} line{result.imported === 1 ? '' : 's'} imported</strong>
            {result.duplicates > 0 ? `, ${result.duplicates} already there` : ''}{result.from ? `, ${dateLong(result.from)} to ${dateLong(result.to)}` : ''}
            {result.closingBalanceMinor ? `, closing balance ${fmt(result.closingBalanceMinor, { currency: bank?.currency ?? 'USD' })}` : ''}.
          </p>
          <p className="ai3-note" style={{ marginTop: 0 }}>Read as: {result.reading}.{result.warnings.length ? ` ${result.warnings.join('; ')}.` : ''}</p>
          <div className="ai3-actions">
            <button className="ai3-btn primary" onClick={() => onDone(bankAccountId)}>Go to reconcile</button>
            <button className="ai3-btn" onClick={() => { setResult(null); setFile(null); }}>Upload another</button>
          </div>
        </>
      )}
    </div>
  );
}

function BanksTab({ companyId, company }: { companyId: string; company: Company | null }) {
  const nav = useHostNavigation();
  const location = useHostLocation();
  const banks = usePluginData<{ accounts: BankAccount[] }>('bank-accounts', { companyId });
  const connected = usePluginData<{ wallets: ConnectedWallet[] }>('connected-wallets', { companyId });
  const feeds = usePluginData<BankFeedsView>('bank-feeds', { companyId });
  const offers = usePluginData<{ connected: boolean; error: string | null; offers: WalletOffer[] }>('wallet-offers', { companyId });
  const feedSync = usePluginAction('feed.sync');
  const connectWallet = usePluginAction('wallet.connect');
  const bankSync = usePluginAction('bank.sync');
  const disconnect = usePluginAction('wallet.disconnect');
  const toast = usePluginToast();
  const { run: runFeed, busy: feedBusy } = useRun([banks.refresh, connected.refresh, feeds.refresh, offers.refresh]);
  const walletFor = (bankId: string) => (connected.data?.wallets ?? []).find((w) => w.bankAccountId === bankId) ?? null;
  // The bank behind an aggregator account, so a live feed does not read as pending.
  const connFor = (bankId: string) => {
    for (const c of feeds.data?.connections ?? []) if (c.accounts.some((a) => a.bankAccountId === bankId)) return c;
    return null;
  };
  const [adding, setAdding] = useState(new URLSearchParams(location.search).get('add') === '1');
  const [uploading, setUploading] = useState<string | null>(null);
  const cur = company?.currency ?? 'USD';
  const accounts = banks.data?.accounts ?? [];
  const total = accounts.reduce((s, a) => s + BigInt(a.ledgerBalanceMinor), 0n);
  return (
    <>
      <Header
        crumb="Bank accounts"
        title="Bank accounts"
        sub={accounts.length ? `${fmt(total, { currency: cur })} across ${accounts.length} account${accounts.length === 1 ? '' : 's'}` : 'Where the company’s money actually sits'}
        actions={
          <>
            {accounts.length > 0 && <button className="ai3-btn" onClick={() => setUploading(accounts[0]!.id)}>Upload a statement</button>}
            <button className="ai3-btn primary" onClick={() => setAdding(true)}>Add bank account</button>
          </>
        }
      />
      <Failure error={banks.error} />
      {(offers.data?.offers ?? []).map((o) => (
        <div className="ai3-card" key={o.address} style={{ marginBottom: 14, borderLeft: '3px solid #1f6fcf' }}>
          <h3 style={{ marginTop: 0 }}>You topped up model credits from a wallet this company does not watch</h3>
          <p className="ai3-note" style={{ marginTop: 0 }}>
            {fmt(o.amountMinor, { currency: cur })}{o.topUps > 1 ? ` over ${o.topUps} top-ups` : ''} came from{' '}
            {o.explorer ? <a href={o.explorer} target="_blank" rel="noreferrer">{o.address}</a> : <code>{o.address}</code>}
            {o.chainName ? ` on ${o.chainName}` : ''}. Paying from that address signed a transaction with it, so watching it needs no further proof —
            nothing to sign, no bank to authorise.
          </p>
          <p className="ai3-note" style={{ marginTop: 0 }}>
            Watch it and that transfer arrives as a statement line and reconciles against your prepaid credits, which is the whole trick this does for
            every transaction after it. Until then the top-up is real at ai3.co and absent from these books, because nothing is watching the wallet it
            left. Watching brings in <strong>everything that address does</strong>, so use it for the company's wallet, not a personal one.
          </p>
          <div className="ai3-actions">
            <button className="ai3-btn primary" disabled={feedBusy || !o.network} onClick={() => runFeed(async () => {
              await connectWallet({ companyId, network: o.network, address: o.address, viaTopUp: true, sinceDays: 30 });
            }, `${o.address.slice(0, 6)}…${o.address.slice(-4)} watched`)}>Watch this wallet</button>
            <a className="ai3-btn" {...nav.linkProps('/ledger?tab=credits')}>See the credit balance</a>
          </div>
          {!o.network && <p className="ai3-note">ai3.co did not say which chain that top-up arrived on, so it cannot be connected from here. Add the address under “Add bank account”.</p>}
        </div>
      ))}
      {adding && <AddBankAccount companyId={companyId} onDone={() => { setAdding(false); banks.refresh(); connected.refresh(); }} onCancel={() => setAdding(false)} />}
      {uploading && <UploadStatement companyId={companyId} accounts={accounts} preselect={uploading} onDone={(id) => { setUploading(null); banks.refresh(); nav.navigate(`/ledger?tab=reconcile&account=${id}`); }} />}
      {accounts.length === 0 && !adding ? (
        <div className="ai3-card"><div className="ai3-empty">No bank accounts yet. Add one, then upload its statement or connect a feed. Stripe counts as a bank account.</div></div>
      ) : (
        <div className="ai3-grid two">
          {accounts.map((a) => {
            const ledger = BigInt(a.ledgerBalanceMinor);
            const stmt = a.statementBalanceMinor === null ? null : BigInt(a.statementBalanceMinor);
            const diff = stmt === null ? null : stmt - ledger;
            return (
              <div className="ai3-card" key={a.id}>
                <div className="ai3-toolbar" style={{ marginBottom: 6 }}>
                  <h3 style={{ margin: 0 }}>{a.name} <span className={`ai3-badge ${a.feed === 'upload' ? 'draft' : walletFor(a.id)?.lastError || connFor(a.id)?.revokedAt ? 'bad' : 'issued'}`}>{a.feed === 'upload' ? 'upload' : a.feed === 'stripe' ? 'Stripe feed' : a.feed === 'chain' || a.feed === 'tempo' ? 'on-chain feed' : a.feed === 'exchange' ? 'exchange feed' : connFor(a.id)?.revokedAt ? 'reconnect needed' : connFor(a.id) ? 'bank feed' : 'feed pending'}</span></h3>
                  <span className="ai3-cap">{KIND_LABEL[a.kind] ?? a.kind} · {a.accountCode}</span>
                </div>
                <div className="ai3-pair">
                  <div><div className="ai3-big" style={{ fontSize: 20 }}>{fmt(ledger, { currency: a.currency })}</div><div className="ai3-cap">Balance in ledger</div></div>
                  <div><div className="ai3-big" style={{ fontSize: 20 }}>{stmt === null ? '—' : fmt(stmt, { currency: a.currency })}</div><div className="ai3-cap">{stmt === null ? 'No statement yet' : `Statement balance${a.lastLineAt ? ` (${dateLong(a.lastLineAt)})` : ''}`}</div></div>
                </div>
                {diff !== null && diff !== 0n && <div className="ai3-cap" style={{ marginTop: 6 }}>Difference {fmt(diff, { currency: a.currency })}{a.unreconciled ? `, ${a.unreconciled} line${a.unreconciled === 1 ? '' : 's'} not yet reconciled` : ''}</div>}
                {a.lastRun && <div className="ai3-cap" style={{ marginTop: 4 }}>Last run {dateLong(a.lastRun.at)}: {a.lastRun.autoPosted} posted automatically, {a.lastRun.leftForReview} left for you.</div>}
                {(() => { const c = connFor(a.id); if (!c) return null; return (
                  <div className="ai3-cap" style={{ marginTop: 4 }}>
                    {c.institutionName ?? c.provider} · via {c.provider}
                    {c.revokedAt ? <span className="red"> · the authorisation was withdrawn; reconnect on ai3.co to resume the feed</span>
                      : c.error ? <span className="red"> · last read failed: {c.error}</span>
                      : c.lastSyncedAt ? ` · read ${dateLong(c.lastSyncedAt)}` : ' · not read yet'}
                  </div>
                ); })()}
                {(() => { const w = walletFor(a.id); if (!w) return null; return (
                  <div className="ai3-cap" style={{ marginTop: 4, wordBreak: 'break-all' }}>
                    {w.kind === 'address' ? <>{w.chainName} · {w.explorer ? <a href={w.explorer} target="_blank" rel="noreferrer">{w.address}</a> : w.address}{w.balanceMinor !== null ? ` · on chain ${fmt(w.balanceMinor, { symbol: false })} ${w.symbol}` : ''}{w.proof ? ' · ownership signed' : ''}</> : <>{w.chainName} · {w.currency} · read-only key</>}
                    {w.lastError ? <span className="red"> · last read failed: {w.lastError}</span> : w.lastSyncAt ? ` · read ${dateLong(w.lastSyncAt)}` : ''}
                  </div>
                ); })()}
                <div className="ai3-actions" style={{ marginTop: 12 }}>
                  {a.unreconciled > 0 ? (
                    <a className="ai3-btn primary" {...nav.linkProps(`/ledger?tab=reconcile&account=${a.id}`)}>Reconcile {a.unreconciled} item{a.unreconciled === 1 ? '' : 's'}</a>
                  ) : stmt === null ? (
                    <button className="ai3-btn primary" onClick={() => setUploading(a.id)}>Upload a statement</button>
                  ) : (
                    <a className="ai3-btn" {...nav.linkProps(`/ledger?tab=reconcile&account=${a.id}`)}>All reconciled · view</a>
                  )}
                  {stmt !== null && <button className="ai3-btn" onClick={() => setUploading(a.id)}>Upload</button>}
                  {(() => { const c = connFor(a.id); if (!c || c.revokedAt) return null; return (
                    <button className="ai3-btn" disabled={feedBusy} onClick={() => runFeed(async () => {
                      const r = (await bankSync({ companyId })) as { imported: number; autoPosted: number; leftForReview: number; otherCurrency: number; needsReconnect: string[] };
                      toast({
                        title: r.imported > 0 ? `${r.imported} new line${r.imported === 1 ? '' : 's'}` : 'Nothing new at the bank',
                        body: `${r.autoPosted} posted automatically, ${r.leftForReview} left for you.${r.otherCurrency ? ` ${r.otherCurrency} line(s) in another currency were left out — add an account in that currency to book them.` : ''}${r.needsReconnect.length ? ` Reconnect needed: ${r.needsReconnect.join(', ')}.` : ''}`,
                        tone: r.needsReconnect.length ? 'info' : 'success', ttlMs: 9000,
                      });
                    }, 'Bank read')}>Sync now</button>
                  ); })()}
                  {(() => { const w = walletFor(a.id); if (!w) return null; return (
                    <>
                      <button className="ai3-btn" disabled={feedBusy} onClick={() => runFeed(async () => { const r = (await feedSync({ companyId, walletId: w.id })) as { imported: number; autoPosted: number; leftForReview: number; error: string | null }; if (r.error) throw new Error(r.error); toast({ title: `${w.label} read`, body: `${r.imported} new line(s), ${r.autoPosted} posted, ${r.leftForReview} to review.`, tone: 'success' }); }, `${w.label} read`)}>Read now</button>
                      <button className="ai3-btn danger" disabled={feedBusy} onClick={() => { if (window.confirm(`Stop watching ${w.label}? Its lines stay in the books; the account is archived.`)) void runFeed(() => disconnect({ companyId, walletId: w.id }), `${w.label} disconnected`); }}>Disconnect</button>
                    </>
                  ); })()}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

const PROPOSAL_LABEL: Record<Proposal['kind'], string> = { match: 'Match', batch: 'Batch match', create: 'Create', transfer: 'Transfer', ask: 'Needs you' };

function ChangePanel({ companyId, line, accounts, currentBankId, onDone }: { companyId: string; line: StatementLine; accounts: BankAccount[]; currentBankId: string; onDone: () => void }) {
  const applyAction = usePluginAction('reconcile.apply');
  const { run, busy } = useRun([onDone]);
  const inflow = BigInt(line.amountMinor) >= 0n;
  const [mode, setMode] = useState<'create' | 'transfer' | 'exclude'>('create');
  const [code, setCode] = useState(inflow ? '3000' : '5900');
  const [desc, setDesc] = useState(line.payee || line.description);
  const [other, setOther] = useState(accounts.find((a) => a.id !== currentBankId)?.id ?? '');
  const decide = () => {
    const decision = mode === 'exclude' ? { kind: 'exclude', reason: 'excluded by the board' } : mode === 'transfer' ? { kind: 'transfer', otherBankAccountId: other } : { kind: 'create', accountCode: code, description: desc };
    return run(() => applyAction({ companyId, lineId: line.id, decision }), 'Reconciled');
  };
  return (
    <div className="ai3-detail" style={{ marginTop: 6 }}>
      <div className="ai3-tabs" style={{ marginBottom: 10 }}>
        {(['create', 'transfer', 'exclude'] as const).map((m) => <button key={m} className={`ai3-tab ${mode === m ? 'on' : ''}`} onClick={() => setMode(m)}>{m === 'create' ? 'Create' : m === 'transfer' ? 'Transfer' : 'Exclude'}</button>)}
      </div>
      {mode === 'create' && (
        <div className="ai3-form-row" style={{ marginBottom: 8 }}>
          <Field label="What">
            <select className="ai3-select" value={code} onChange={(e) => setCode(e.target.value)}>
              {ACCOUNT_CHOICES.filter((a) => a.dir === 'any' || a.dir === (inflow ? 'in' : 'out')).map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
            </select>
          </Field>
          <Field label="Why"><input className="ai3-input" value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
        </div>
      )}
      {mode === 'transfer' && (
        <div className="ai3-form-row" style={{ marginBottom: 8 }}>
          <Field label={inflow ? 'From' : 'To'}>
            <select className="ai3-select" value={other} onChange={(e) => setOther(e.target.value)}>
              {accounts.filter((a) => a.id !== currentBankId).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
        </div>
      )}
      {mode === 'exclude' && <p className="ai3-note" style={{ marginTop: 0 }}>The line stays on the statement, marked excluded, and never enters the books. For money that is not the company’s.</p>}
      <button className="ai3-btn primary" disabled={busy || (mode === 'transfer' && !other)} onClick={decide}>{mode === 'create' ? 'Create and reconcile' : mode === 'transfer' ? 'Record transfer' : 'Exclude'}</button>
    </div>
  );
}


interface ReconcileSettings {
  auto: { enabled: boolean; threshold: number };
  rules: Array<{ id: string; payeeContains: string; direction: string; accountCode: string; contactName: string | null; confirmations: number; misses: number; enabled: boolean }>;
}

/**
 * What the matcher may do without being asked, and what it has learned to do.
 *
 * Both of these existed and neither was on any screen. The nightly job posted
 * at 90% confidence for every company on the box — a policy about somebody's
 * books written into our source code — and every time a person accepted a
 * proposal the reconciler wrote a rule that would post the next one like it,
 * unattended, for ever, invisibly. Automation that cannot be seen or switched
 * off is the wrong kind, however good its hit rate.
 */
function AutoReconcile({ companyId }: { companyId: string }) {
  const settings = usePluginData<ReconcileSettings>('reconcile-settings', { companyId });
  const save = usePluginAction('reconcile.settings');
  const toggleRule = usePluginAction('rule.toggle');
  const { run, busy } = useRun([settings.refresh]);
  const [open, setOpen] = useState(false);
  const auto = settings.data?.auto;
  const rules = settings.data?.rules ?? [];
  const live = rules.filter((r) => r.enabled);
  if (!auto) return null;
  return (
    <div className="ai3-card" style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <div>
          <h3 style={{ margin: 0 }}>Reconciling on its own</h3>
          <div className="ai3-cap" style={{ marginTop: 4 }}>
            {auto.enabled
              ? `Every night, anything the matcher is at least ${auto.threshold}% sure of is posted for you. The rest waits here.`
              : 'Nothing is posted without you. The matcher still works overnight, so its suggestions are ready in the morning.'}
          </div>
        </div>
        <a href="#" onClick={(e) => { e.preventDefault(); setOpen((v) => !v); }}>{open ? 'Close' : 'Change'}</a>
      </div>
      {open && (
        <div style={{ marginTop: 12, borderTop: '1px solid var(--ai3-hair, #e6e8ea)', paddingTop: 12 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={auto.enabled} disabled={busy}
              onChange={(e) => run(() => save({ companyId, enabled: e.currentTarget.checked, threshold: auto.threshold }), 'Saved')} />
            <span>Post confident matches automatically</span>
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
            <span>Only when at least</span>
            <select value={String(auto.threshold)} disabled={busy || !auto.enabled}
              onChange={(e) => run(() => save({ companyId, enabled: auto.enabled, threshold: Number(e.currentTarget.value) }), 'Saved')}>
              {[50, 60, 70, 75, 80, 85, 90, 95, 100].map((n) => <option key={n} value={n}>{n}%</option>)}
            </select>
            <span>confident</span>
          </label>
          <p className="ai3-note">A lower bar posts more and asks you less; 100% means only a certainty — an exact match to something already in the books — goes in by itself. Everything posted this way is an ordinary transaction with its reason on it, and can be reversed like any other.</p>

          <h4 style={{ marginBottom: 4 }}>What it has learned</h4>
          {rules.length === 0 && <div className="ai3-cap">Nothing yet. Confirming a suggestion teaches it to treat that payee the same way next time.</div>}
          {rules.length > 0 && (
            <table className="ai3-table">
              <thead><tr><th>When the payee looks like</th><th>Post to</th><th className="num">Confirmed</th><th></th></tr></thead>
              <tbody>
                {rules.map((r) => (
                  <tr key={r.id} className={r.enabled ? '' : 'muted'}>
                    <td>{r.payeeContains}<div className="ai3-cap">{r.direction === 'in' ? 'money in' : 'money out'}{r.contactName ? ` · ${r.contactName}` : ''}</div></td>
                    <td>{r.accountCode} {ACCOUNT_CHOICES.find((a) => a.code === r.accountCode)?.name ?? ''}</td>
                    <td className="num">{r.confirmations}{r.misses ? ` · ${r.misses} corrected` : ''}</td>
                    <td><button className="ai3-btn small" disabled={busy}
                      onClick={() => run(() => toggleRule({ companyId, ruleId: r.id, enabled: !r.enabled }), r.enabled ? 'Rule off' : 'Rule on')}>
                      {r.enabled ? 'Stop using it' : 'Use it again'}
                    </button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {live.length > 0 && <p className="ai3-note">{live.length} rule{live.length === 1 ? '' : 's'} in use. Switching one off leaves every posting it already made exactly where it is.</p>}
        </div>
      )}
    </div>
  );
}

function ReconcileTab({ companyId, company }: { companyId: string; company: Company | null }) {
  const location = useHostLocation();
  const nav = useHostNavigation();
  const accountId = new URLSearchParams(location.search).get('account') ?? '';
  const banks = usePluginData<{ accounts: BankAccount[] }>('bank-accounts', { companyId });
  const queue = usePluginData<{ bank: BankAccount; queue: StatementLine[]; recent: StatementLine[]; lastRun: { at: string; autoPosted: number; leftForReview: number; linesSeen: number; threshold: number; ranBy: string } | null }>('reconcile-queue', accountId ? { companyId, bankAccountId: accountId } : { companyId, bankAccountId: '' });
  const applyAction = usePluginAction('reconcile.apply');
  const runAction = usePluginAction('reconcile.run');
  const { run, busy } = useRun([queue.refresh, banks.refresh]);
  const [changing, setChanging] = useState<string | null>(null);
  const [showRecent, setShowRecent] = useState(false);
  const cur = company?.currency ?? 'USD';
  const accounts = banks.data?.accounts ?? [];
  const bank = queue.data?.bank;
  // Reaching this screen with no account chosen used to be a dead end: one
  // line telling you to go somewhere else. It is now the list, because
  // "reconcile" is a thing somebody comes here to do, not a thing they arrive
  // at by accident from another page.
  if (!accountId) {
    const waiting = accounts.reduce((n, a) => n + (a.unreconciled ?? 0), 0);
    return (
      <>
        <Header crumb="Reconcile" title="Reconcile" sub={accounts.length ? (waiting ? `${waiting} line${waiting === 1 ? '' : 's'} across ${accounts.length} account${accounts.length === 1 ? '' : 's'} need a decision` : 'Everything is reconciled') : undefined} />
        <AutoReconcile companyId={companyId} />
        <Failure error={banks.error} />
        {banks.loading && !banks.data && <div className="ai3-card"><Spinner /></div>}
        {banks.data && accounts.length === 0 && (
          <div className="ai3-card"><div className="ai3-empty">No bank or card account yet. <a className="ai3-btn" style={{ marginLeft: 8 }} {...nav.linkProps('/ledger?tab=banks')}>Add one</a></div></div>
        )}
        {accounts.map((a) => (
          <div className="ai3-card" key={a.id} style={{ marginBottom: 10, display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <div>
              <strong>{a.name}</strong>
              <div className="ai3-cap">{a.unreconciled ? `${a.unreconciled} line${a.unreconciled === 1 ? '' : 's'} waiting` : 'nothing waiting'} · in the books {fmt(a.ledgerBalanceMinor, { currency: a.currency })}{a.statementBalanceMinor === null ? '' : ` · per the statement ${fmt(a.statementBalanceMinor, { currency: a.currency })}`}</div>
            </div>
            <a className={`ai3-btn ${a.unreconciled ? 'primary' : ''}`} {...nav.linkProps(`/ledger?tab=reconcile&account=${a.id}`)}>{a.unreconciled ? `Reconcile ${a.unreconciled}` : 'Open'}</a>
          </div>
        ))}
      </>
    );
  }
  const items = queue.data?.queue ?? [];
  const confident = items.filter((l) => l.proposal && l.proposal.kind !== 'ask' && l.proposal.confidence >= 90);
  return (
    <>
      <Header
        crumb={<>Bank accounts › {bank?.name ?? '…'}</>}
        title="Reconcile"
        sub={bank ? `Statement balance ${bank.statementBalanceMinor === null ? '—' : fmt(bank.statementBalanceMinor, { currency: bank.currency })} · Balance in ledger ${fmt(bank.ledgerBalanceMinor, { currency: bank.currency })}` : undefined}
        actions={
          <>
            <a className="ai3-btn" {...nav.linkProps(`/ledger?tab=banks`)}>Bank accounts</a>
            <button className="ai3-btn" disabled={busy || confident.length === 0} onClick={() => run(() => runAction({ companyId, bankAccountId: accountId, threshold: 90 }), 'Confident matches posted')}>Accept all {confident.length ? `(${confident.length})` : ''} at 90%+</button>
          </>
        }
      />
      <Failure error={queue.error ?? banks.error} />
      <AutoReconcile companyId={companyId} />
      {queue.data?.lastRun && (
        <div className="ai3-card" style={{ marginBottom: 14, background: 'var(--ai3-green-soft)', borderColor: 'transparent' }}>
          <strong>{queue.data.lastRun.ranBy === 'nightly' ? 'Reconciled overnight' : 'Last run'}: {queue.data.lastRun.autoPosted} of {queue.data.lastRun.linesSeen} posted automatically at {queue.data.lastRun.threshold}%.</strong>{' '}
          {items.length} need{items.length === 1 ? 's' : ''} you. <a href="#" onClick={(e) => { e.preventDefault(); setShowRecent((v) => !v); }}>{showRecent ? 'Hide' : 'Review'} what was posted</a>
        </div>
      )}
      {queue.loading && !queue.data && <div className="ai3-card"><Spinner /></div>}
      {queue.data && items.length === 0 && <div className="ai3-card"><div className="ai3-empty">Everything on this account is reconciled. <button className="ai3-btn" style={{ marginLeft: 8 }} onClick={() => nav.navigate('/ledger?tab=banks')}>Upload another statement</button></div></div>}
      {items.map((line) => {
        const p = line.proposal;
        const amt = BigInt(line.amountMinor);
        const tone = !p ? 'ask' : p.kind;
        return (
          <div className="ai3-card" key={line.id} style={{ marginBottom: 10, padding: '12px 14px' }}>
            <div className="ai3-recon">
              <div className="ai3-line">
                <div className="ai3-cap">{dateLong(line.postedAt)}{line.reference ? ` · ref ${line.reference}` : ''}</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontWeight: 600 }}>
                  <span>{line.payee || line.description}</span>
                  <span className="ai3-num" style={{ color: amt < 0n ? undefined : 'var(--ai3-green)' }}>{amt < 0n ? '−' : '+'}{fmt(amt < 0n ? -amt : amt, { currency: cur })}</span>
                </div>
                {line.payee && line.payee !== line.description && <div className="ai3-cap">{line.description}</div>}
              </div>
              <div className="ai3-okcol">
                {p && p.kind !== 'ask' ? (
                  <button className="ai3-btn primary" disabled={busy} title="Accept the proposal" onClick={() => run(() => applyAction({ companyId, lineId: line.id, accept: true }), 'Reconciled')}>OK</button>
                ) : (
                  <span className="ai3-badge part_paid">?</span>
                )}
              </div>
              <div className={`ai3-prop ${tone}`}>
                <div className="ai3-prop-kind">
                  <span>{p ? PROPOSAL_LABEL[p.kind] : 'Thinking…'}{p?.kind === 'batch' && p.transactionIds ? ` · ${p.transactionIds.length} cost events` : ''}</span>
                  {p && <span className={`ai3-conf ${p.confidence < 75 ? 'mid' : ''}`}>{p.confidence}%</span>}
                </div>
                {p?.kind === 'create' && <div>{p.invoiceId ? `Payment on an invoice · ${p.contactName ?? ''}` : `${p.accountCode} ${ACCOUNT_CHOICES.find((a) => a.code === p.accountCode)?.name ?? ''}${p.contactName ? ` · ${p.contactName}` : ''}`}</div>}
                {p?.kind === 'transfer' && <div>{accounts.find((a) => a.id === p.otherBankAccountId)?.name ?? 'another account'}</div>}
                {p && <div className="ai3-cap" style={{ marginTop: 3 }}>{p.reason}</div>}
                {p?.kind === 'ask' && p.options && (
                  <div className="ai3-actions" style={{ marginTop: 8 }}>
                    {p.options.map((o) => <button key={o.label} className="ai3-btn small" disabled={busy} onClick={() => run(() => applyAction({ companyId, lineId: line.id, decision: o.decision }), 'Reconciled')}>{o.label}</button>)}
                  </div>
                )}
                <div style={{ marginTop: 6 }}><a href="#" onClick={(e) => { e.preventDefault(); setChanging(changing === line.id ? null : line.id); }}>{changing === line.id ? 'Close' : 'Change'}</a></div>
              </div>
            </div>
            {changing === line.id && <ChangePanel companyId={companyId} line={line} accounts={accounts} currentBankId={accountId} onDone={() => { setChanging(null); queue.refresh(); banks.refresh(); }} />}
          </div>
        );
      })}
      {showRecent && queue.data && (
        <div className="ai3-card" style={{ marginTop: 14 }}>
          <h3>Recently reconciled</h3>
          <table className="ai3-table">
            <thead><tr><th>Date</th><th>Line</th><th>How</th><th>By</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {queue.data.recent.map((l) => (
                <tr key={l.id}><td className="muted">{dateLong(l.postedAt)}</td><td>{l.payee || l.description}{l.proposal ? <div className="ai3-cap">{l.proposal.reason}</div> : null}</td><td><span className={`ai3-badge ${l.status === 'excluded' ? 'void' : 'paid'}`}>{l.status}</span></td><td className="muted">{l.reconciledBy ?? ''}</td><td className="num">{fmt(l.amountMinor, { currency: cur })}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Page + sidebar
// ---------------------------------------------------------------------------

const TABS = ['position', 'banks', 'reconcile', 'transactions', 'invoices', 'bills', 'journals', 'statements', 'import', 'settings'] as const;
type Tab = (typeof TABS)[number];


// ---------------------------------------------------------------------------
// Paying an invoice by its link: from the company wallet, or from the person's own wallet
// ---------------------------------------------------------------------------

interface RemoteInvoiceView {
  invoice: { number: string; currency: string; totalMinor: string; outstandingMinor: string; status: string; dueAt: string | null; company: { name: string }; url: string; lines: Array<{ description: string; amountMinor: string }> };
  options: Array<{ chain: ChainInfo; address: string; label: string; asset: string; memo: string | null; companyWallet: boolean }>;
}

function PayInvoiceCard({ companyId, url, onClose }: { companyId: string; url: string; onClose: () => void }) {
  const remote = usePluginData<RemoteInvoiceView>('remote-invoice', { companyId, url });
  const wallet = usePluginData<{ wallet: WalletInfo | null }>('wallet', { companyId });
  const payCompany = usePluginAction('invoice.pay');
  const book = usePluginAction('invoice.pay-book');
  const toast = usePluginToast();
  const { run, busy } = useRun([remote.refresh, wallet.refresh]);
  const [amount, setAmount] = useState('');
  const [accountCode, setAccountCode] = useState('');
  const [choosing, setChoosing] = useState<number | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [done, setDone] = useState<{ txHash: string; explorer: string; how: string } | null>(null);
  const inv = remote.data?.invoice;
  const open = inv ? inv.status === 'issued' || inv.status === 'part_paid' : false;
  const amountMinor = inv ? (AMOUNT.test(amount.replace(/,/g, '')) ? toMinor(amount.replace(/,/g, '')) : inv.outstandingMinor) : '0';
  async function fromCompany() {
    await run(async () => {
      const r = (await payCompany({ companyId, invoiceUrl: url, amountMinor, accountCode: accountCode.trim() || null })) as { txHash: string; explorer: string; amountMinor: string; asset: string };
      setDone({ txHash: r.txHash, explorer: r.explorer, how: `${fmt(r.amountMinor, { symbol: false })} ${r.asset} from the company wallet` });
    }, 'Paid from the company wallet');
  }
  async function fromMine(optionIndex: number, w: DiscoveredWallet) {
    const option = remote.data?.options[optionIndex];
    if (!option || !inv) return;
    setChoosing(null);
    try {
      setStage('Connecting to your wallet…');
      const from = await connectWallet(w.provider);
      setStage(`Confirm in ${w.name}: ${fmt(amountMinor, { symbol: false })} ${option.asset} to ${short(option.address)} on ${option.chain.name}`);
      const txHash = await sendToken(w.provider, { from, chain: option.chain, to: option.address, amountMinor: BigInt(amountMinor), memo: option.memo });
      setStage('Sent. Waiting for the chain to confirm…');
      const receipt = await waitForReceipt(w.provider, txHash);
      if (receipt.status !== 'success') throw new WalletError('The transaction reverted on chain; nothing was paid.');
      setStage('Confirmed. Booking it…');
      const r = (await book({ companyId, network: option.chain.slug, txHash, from, to: option.address, amountMinor, invoiceUrl: url, accountCode: accountCode.trim() || null })) as { explorer: string; walletLabel: string; booked: { kind: string; accountCode: string | null } };
      setDone({ txHash, explorer: r.explorer, how: `${fmt(amountMinor, { symbol: false })} ${option.asset} from ${r.walletLabel}` });
      toast({ title: `Paid ${inv.number}`, body: `Booked ${r.booked.kind === 'bill' ? 'against the bill' : `to ${r.booked.accountCode ?? 'expenses'}`} from ${r.walletLabel}; the wallet feed will match the chain line by hash.`, tone: 'success', ttlMs: 9000 });
      remote.refresh();
    } catch (err) {
      toast({ title: 'Not paid', body: err instanceof Error ? err.message : String(err), tone: 'error', ttlMs: 9000 });
    } finally {
      setStage(null);
    }
  }
  return (
    <div className="ai3-card" style={{ marginBottom: 14, borderLeft: '4px solid var(--ai3-blue)' }}>
      <div className="ai3-toolbar">
        <h3 style={{ margin: 0 }}>Pay an invoice <span className="ctx">{inv ? `${inv.number} from ${inv.company.name}` : url}</span></h3>
        <button className="ai3-btn small" onClick={onClose}>Close</button>
      </div>
      <Failure error={remote.error} />
      {inv && (
        <>
          <div className="ai3-pair" style={{ marginBottom: 10 }}>
            <div><div className="ai3-big" style={{ fontSize: 20 }}>{fmt(inv.outstandingMinor, { currency: inv.currency })}</div><div className="ai3-cap">{open ? `Amount due${inv.dueAt ? ` by ${dateLong(inv.dueAt)}` : ''}` : `This invoice is ${statusLabel(inv.status)}`}</div></div>
            <div><div className="ai3-big" style={{ fontSize: 20 }}>{fmt(inv.totalMinor, { currency: inv.currency })}</div><div className="ai3-cap">Total · <a href={inv.url} target="_blank" rel="noreferrer">open the invoice</a></div></div>
          </div>
          {done ? (
            <div className="ai3-prop" style={{ marginBottom: 8 }}>
              <div className="ai3-prop-kind"><span>Paid</span></div>
              <div>{done.how}. Transaction <a href={done.explorer} target="_blank" rel="noreferrer" style={{ wordBreak: 'break-all' }}>{done.txHash}</a>.</div>
            </div>
          ) : open && remote.data!.options.length === 0 ? (
            <p className="ai3-note" style={{ marginTop: 0 }}>This invoice offers no wallet the ledger can pay on (Tempo, Base or Ethereum stablecoins). Pay it the way the invoice says and record the payment on its bill.</p>
          ) : open ? (
            <>
              <div className="ai3-form-row" style={{ marginBottom: 8 }}>
                <Field label={`Amount to pay (${inv.currency})`}><input className="ai3-input" placeholder={fmt(inv.outstandingMinor, { symbol: false })} value={amount} inputMode="decimal" onChange={(e) => setAmount(e.target.value)} /></Field>
                <Field label="Book to (account code, optional)"><input className="ai3-input" placeholder="5900 Other operating" value={accountCode} onChange={(e) => setAccountCode(e.target.value)} /></Field>
              </div>
              {remote.data!.options.map((o, i) => (
                <div key={i} className="ai3-line" style={{ marginBottom: 8 }}>
                  <div style={{ fontWeight: 600 }}>{o.asset} on {o.chain.name}{o.chain.testnet ? ' (testnet)' : ''}</div>
                  <div className="ai3-cap" style={{ wordBreak: 'break-all' }}>To {o.address}{o.memo ? ` · memo ${o.memo}` : ''}</div>
                  <div className="ai3-actions" style={{ marginTop: 8 }}>
                    {o.companyWallet && <button className="ai3-btn primary" disabled={busy || stage !== null} onClick={fromCompany}>Pay from company wallet{wallet.data?.wallet?.balanceMinor ? ` (${fmt(wallet.data.wallet.balanceMinor, { symbol: false })} ${wallet.data.wallet.asset} there)` : ''}</button>}
                    <button className="ai3-btn" disabled={busy || stage !== null} onClick={() => setChoosing(choosing === i ? null : i)}>Pay from my wallet</button>
                  </div>
                  {choosing === i && <div style={{ marginTop: 8 }}><WalletPicker onPick={(w) => fromMine(i, w)} disabled={stage !== null} /></div>}
                </div>
              ))}
              {stage && <div className="ai3-note"><Spinner /> {stage}</div>}
              <p className="ai3-note">From the company wallet, the ledger signs and books it here. From your own wallet, your wallet signs; once the chain confirms, the payment is booked against that wallet, which is connected as a bank account if it is new.</p>
            </>
          ) : null}
        </>
      )}
    </div>
  );
}

function tabFromSearch(search: string): Tab {
  const t = new URLSearchParams(search).get('tab');
  return (TABS as readonly string[]).includes(t ?? '') ? (t as Tab) : 'position';
}

export function LedgerPage(_props: PluginPageProps) {
  useStyles();
  const context = useHostContext();
  const location = useHostLocation();
  const tab = tabFromSearch(location.search);
  const companyId = context.companyId;
  const company = usePluginData<Company>('company', companyId ? { companyId } : {});
  const nav = useHostNavigation();
  const payUrl = new URLSearchParams(location.search).get('pay');
  if (!companyId) return <div className="ai3">Pick a company to see its ledger.</div>;
  return (
    <ErrorBoundary>
      <div className="ai3">
        {payUrl && /^https:\/\/[^\s/]+\/i\/[A-Za-z0-9_-]{16,80}$/.test(payUrl) && <PayInvoiceCard companyId={companyId} url={payUrl} onClose={() => { const q = new URLSearchParams(location.search); q.delete('pay'); nav.navigate(`/ledger${q.toString() ? `?${q.toString()}` : ''}`, { replace: true }); }} />}
        {tab === 'position' && <PositionTab companyId={companyId} company={company.data} />}
        {tab === 'transactions' && <TransactionsTab companyId={companyId} company={company.data} />}
        {tab === 'invoices' && <InvoicesTab companyId={companyId} company={company.data} />}
        {tab === 'statements' && <StatementsTab companyId={companyId} company={company.data} />}
        {tab === 'banks' && <BanksTab companyId={companyId} company={company.data} />}
        {tab === 'reconcile' && <ReconcileTab companyId={companyId} company={company.data} />}
        {tab === 'settings' && <SettingsTab companyId={companyId} company={company.data} />}
        {tab === 'bills' && <BillsTab companyId={companyId} company={company.data} />}
        {tab === 'journals' && <JournalsTab companyId={companyId} company={company.data} />}
        {tab === 'import' && <ImportTab companyId={companyId} company={company.data} />}
        <p className="ai3-note" style={{ marginTop: 28 }}>AI3 Ledger · double-entry, append-only, integer minor units. Costs come from Paperclip; nothing is re-derived.</p>
      </div>
    </ErrorBoundary>
  );
}

/** Finance inside the company's own Settings, beside Members and Secrets. */
export function LedgerCompanySettings(_props: PluginPageProps) {
  useStyles();
  const context = useHostContext();
  const companyId = context.companyId;
  const company = usePluginData<Company>('company', companyId ? { companyId } : {});
  if (!companyId) return <div className="ai3">Pick a company.</div>;
  return (
    <ErrorBoundary>
      <div className="ai3">
        <SettingsTab companyId={companyId} company={company.data} />
      </div>
    </ErrorBoundary>
  );
}

const FINANCE_ITEMS: Array<{ label: string; to: string; match: (path: string, search: string) => boolean }> = [
  { label: 'Position', to: '/ledger', match: (p, s) => p.endsWith('/ledger') && !new URLSearchParams(s).get('tab') },
  { label: 'Bank accounts', to: '/ledger?tab=banks', match: (p, s) => p.endsWith('/ledger') && new URLSearchParams(s).get('tab') === 'banks' },
  // Reconciliation had no entry here at all. The screen existed, and the only
  // way to it was a button on Bank accounts that appears only when a line is
  // already waiting — so the one person who most needed it, somebody wondering
  // whether their bank matches their books, could not find it.
  { label: 'Reconciliation', to: '/ledger?tab=reconcile', match: (p, s) => p.endsWith('/ledger') && new URLSearchParams(s).get('tab') === 'reconcile' },
  { label: 'Transactions', to: '/ledger?tab=transactions', match: (p, s) => p.endsWith('/ledger') && new URLSearchParams(s).get('tab') === 'transactions' },
  { label: 'Invoices', to: '/ledger?tab=invoices', match: (p, s) => p.endsWith('/ledger') && new URLSearchParams(s).get('tab') === 'invoices' },
  { label: 'Bills', to: '/ledger?tab=bills', match: (p, s) => p.endsWith('/ledger') && new URLSearchParams(s).get('tab') === 'bills' },
  { label: 'Journals', to: '/ledger?tab=journals', match: (p, s) => p.endsWith('/ledger') && new URLSearchParams(s).get('tab') === 'journals' },
  { label: 'Profit and loss', to: '/ledger?tab=statements', match: (p, s) => p.endsWith('/ledger') && new URLSearchParams(s).get('tab') === 'statements' && !s.includes('view=balance') && !s.includes('view=trial') },
  { label: 'Balance sheet', to: '/ledger?tab=statements&view=balance', match: (p, s) => p.endsWith('/ledger') && s.includes('view=balance') },
  { label: 'Trial balance', to: '/ledger?tab=statements&view=trial', match: (p, s) => p.endsWith('/ledger') && s.includes('view=trial') },
  { label: 'Import', to: '/ledger?tab=import', match: (p, s) => p.endsWith('/ledger') && new URLSearchParams(s).get('tab') === 'import' },
  { label: 'Costs', to: '/costs', match: (p) => p.endsWith('/costs') },
  { label: 'Settings', to: '/company/settings/finance', match: (p) => p.endsWith('/company/settings/finance') },
];

export function LedgerSidebarItem(_props: PluginSidebarProps) {
  useStyles();
  const nav = useHostNavigation();
  const location = useHostLocation();
  return (
    <div>
      <div className="ai3-side-label">Finance</div>
      {FINANCE_ITEMS.map((item) => (
        <a key={item.label} {...nav.linkProps(item.to)} className={`ai3-side ${item.match(location.pathname, location.search) ? 'on' : ''}`}>
          {item.label}
        </a>
      ))}
    </div>
  );
}
