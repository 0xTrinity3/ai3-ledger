/**
 * The books proper: journals, trial balance, the drill-down from a figure to
 * its entries and on to the source document, suppliers and bills with their
 * PDFs, and imports from another system. Same idiom as index.tsx.
 */
import React, { useEffect, useState } from 'react';
import { useHostLocation, useHostNavigation, usePluginAction, usePluginData, usePluginToast, Spinner } from '@paperclipai/plugin-sdk/ui';
import { AMOUNT, CURRENCIES, Failure, Field, Header, dateLong, fmt, plusDays, today, toMinor, useRun, type Company } from './index.js';

// ---------------------------------------------------------------------------
// Shapes (loose mirrors of the worker's JSON)
// ---------------------------------------------------------------------------

export interface ChartAccount { code: string; name: string; type: string; balanceMinor: string; parentId: string | null; accountId: string }
interface JournalLine { position: number; accountCode: string; accountName: string; direction: 'debit' | 'credit'; amountMinor: string; description: string | null; subject: { agent?: string } }
interface Journal { id: string; number: string; occurredAt: string; narration: string; status: 'draft' | 'posted' | 'voided'; transactionId: string | null; reversalId: string | null; createdBy: string; createdAt: string; postedAt: string | null; voidedAt: string | null; debitMinor: string; creditMinor: string; lines: JournalLine[]; documents?: DocumentMeta[] }
export interface DocumentMeta { id: string; filename: string; mime: string; sizeBytes: number; kind: string; uploadedBy: string; createdAt: string }
interface EntryRow { entryId: string; transactionId: string; occurredAt: string; description: string; sourceKind: string; sourceRef: string | null; reversesId: string | null; accountCode: string; accountName: string; accountType: string; direction: 'debit' | 'credit'; amountMinor: string; signedMinor: string; runningMinor: string; subject: { agent?: string } }
interface EntryList { rows: EntryRow[]; totalMinor: string; debitMinor: string; creditMinor: string; count: number; truncated: boolean; currency: string | null }
interface TxEntry { accountCode: string; accountName: string; direction: 'debit' | 'credit'; amountMinor: string; subject: { agent?: string; project?: string; goal?: string; work?: string } }
type Source =
  | { kind: 'invoice'; invoiceId: string; number: string; customer: string; what: string }
  | { kind: 'bill'; billId: string; number: string; supplier: string; what: string }
  | { kind: 'journal'; journalId: string; number: string; status: string }
  | { kind: 'bank'; lineId: string; bankAccountId: string; bankName: string; description: string }
  | { kind: 'cost'; event: { id: string; agentId: string | null; issueId: string | null; runId: string | null; provider: string | null; model: string | null; billingType: string | null; costStatus: string | null; inputTokens: number | null; cachedInputTokens: number | null; outputTokens: number | null; costCents: string | null; occurredAt: string } }
  | { kind: 'conversion'; asOf: string }
  | { kind: 'funding' | 'reversal' | 'manual' | 'unknown' };
interface TxDetail { id: string; occurredAt: string; description: string; sourceKind: string; sourceRef: string | null; reversesId: string | null; createdBy: string; entries: TxEntry[]; source: Source; reversalOf: Source | null; reverses: { id: string; description: string; occurredAt: string } | null; reversedBy: { id: string; description: string; occurredAt: string } | null; bankLinks: Array<{ lineId: string; bankAccountId: string; bankName: string; postedAt: string; description: string; amountMinor: string }>; documents: DocumentMeta[]; agentName: string | null }
interface TrialBalance { asOf: string; from: string | null; currency: string | null; lines: Array<{ code: string; name: string; type: string; debitMinor: string; creditMinor: string }>; debitMinor: string; creditMinor: string; balances: boolean; differenceMinor: string }
interface Supplier { id: string; name: string; email: string | null; defaultAccountCode: string | null }
interface BillLine { position: number; description: string; quantity: string; unitAmountMinor: string; amountMinor: string; taxMinor: string; accountCode: string; accountName: string }
interface Bill { id: string; number: string; reference: string | null; status: 'draft' | 'approved' | 'part_paid' | 'paid' | 'void'; supplierId: string; supplierName: string; supplierEmail: string | null; currency: string; baseCurrency: string; rateToBase: string; issuedAt: string | null; dueAt: string | null; subtotalMinor: string; taxMinor: string; totalMinor: string; paidMinor: string; outstandingMinor: string; openingPaidMinor: string; conversion: boolean; notes: string | null; transactionId: string | null; createdAt: string; lines: BillLine[]; payments: Array<{ id: string; occurredAt: string; amountMinor: string; reference: string | null; cashAccountCode: string; transactionId: string | null }>; documents?: DocumentMeta[] | number }
interface BankAccountLite { id: string; name: string; accountCode: string; currency: string }

const TYPE_ORDER = ['asset', 'liability', 'equity', 'income', 'expense'];

// ---------------------------------------------------------------------------
// Links: where a click on a figure goes
// ---------------------------------------------------------------------------

export function entriesLink(q: { account?: string; type?: string; from?: string; to?: string; groupBy?: string; groupKey?: string | null; withChildren?: boolean; sourceKind?: string; label?: string }): string {
  const p = new URLSearchParams({ tab: 'transactions' });
  if (q.account) p.set('account', q.account);
  if (q.type) p.set('type', q.type);
  if (q.from) p.set('from', q.from);
  if (q.to) p.set('to', q.to);
  if (q.groupBy) { p.set('groupBy', q.groupBy); p.set('groupKey', q.groupKey ?? ''); }
  if (q.withChildren) p.set('children', '1');
  if (q.sourceKind) p.set('source', q.sourceKind);
  if (q.label) p.set('label', q.label);
  return `/ledger?${p.toString()}`;
}

function sourceLabel(kind: string): string {
  return { cost_sweep: 'Cost sweep', funding: 'Funding', invoice: 'Invoice', payment: 'Payment', manual: 'Manual', reversal: 'Reversal', journal: 'Journal', bill: 'Bill', conversion: 'Opening balances' }[kind] ?? kind;
}

function useFileReader() {
  return async (file: File): Promise<{ filename: string; mime: string; contentBase64: string }> => {
    const buf = await file.arrayBuffer();
    let bin = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { filename: file.name, mime: file.type || (file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream'), contentBase64: btoa(bin) };
  };
}

function openBase64(contentBase64: string, mime: string, filename: string) {
  const bin = atob(contentBase64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const w = window.open(url, '_blank');
  if (!w) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function kb(n: number): string {
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Documents on anything
// ---------------------------------------------------------------------------

export function DocumentList({ companyId, targetKind, targetId, documents, onChanged, compact }: { companyId: string; targetKind: string; targetId: string; documents: DocumentMeta[]; onChanged: () => void; compact?: boolean }) {
  const read = usePluginAction('document.read');
  const add = usePluginAction('document.add');
  const unlink = usePluginAction('document.unlink');
  const readFile = useFileReader();
  const { run, busy } = useRun([onChanged]);
  const toast = usePluginToast();
  async function open(d: DocumentMeta) {
    try {
      const r = (await read({ companyId, documentId: d.id })) as { contentBase64: string; mime: string; filename: string };
      openBase64(r.contentBase64, r.mime, r.filename);
    } catch (err) {
      toast({ title: 'Could not open the file', body: err instanceof Error ? err.message : String(err), tone: 'error' });
    }
  }
  async function attach(file: File | null) {
    if (!file) return;
    const f = await readFile(file);
    await run(() => add({ companyId, ...f, targetKind, targetId }), `${file.name} attached`);
  }
  return (
    <div>
      {documents.length === 0 && !compact && <div className="ai3-cap">No documents attached.</div>}
      {documents.map((d) => (
        <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '4px 0', fontSize: 13 }}>
          <a href="#" onClick={(e) => { e.preventDefault(); void open(d); }}>{d.mime.includes('pdf') ? '📄' : d.mime.startsWith('image/') ? '🖼' : '📎'} {d.filename}</a>
          <span className="ai3-cap" style={{ marginTop: 0 }}>{kb(d.sizeBytes)} · {dateLong(d.createdAt)} <a href="#" onClick={(e) => { e.preventDefault(); void run(() => unlink({ companyId, documentId: d.id, targetKind, targetId }), 'Detached'); }}>detach</a></span>
        </div>
      ))}
      <label className="ai3-btn small" style={{ marginTop: 6, cursor: busy ? 'default' : 'pointer' }}>
        {busy ? 'Working…' : 'Attach a file'}
        <input type="file" accept=".pdf,image/*,.csv,.txt,.xlsx,.docx" style={{ display: 'none' }} disabled={busy} onChange={(e) => { void attach(e.target.files?.[0] ?? null); e.target.value = ''; }} />
      </label>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Transaction detail: every line, the source, the documents
// ---------------------------------------------------------------------------

export function TransactionDetail({ companyId, transactionId, cur, onClose }: { companyId: string; transactionId: string; cur: string; onClose?: () => void }) {
  const tx = usePluginData<TxDetail>('transaction', { companyId, transactionId });
  const nav = useHostNavigation();
  const t = tx.data;
  if (tx.error) return <div className="ai3-detail"><Failure error={tx.error} /></div>;
  if (!t) return <div className="ai3-detail"><Spinner /></div>;
  const src = t.source;
  const sourceCard = (() => {
    switch (src.kind) {
      case 'invoice':
        return <>{src.what === 'issue' ? 'Issue of' : src.what === 'payment' ? 'Payment on' : 'Write-off of'} invoice <a {...nav.linkProps(`/ledger?tab=invoices&open=${src.invoiceId}`)}>{src.number}</a> · {src.customer}</>;
      case 'bill':
        return <>{src.what === 'approve' ? 'Approval of' : 'Payment of'} bill <a {...nav.linkProps(`/ledger?tab=bills&open=${src.billId}`)}>{src.number}</a> · {src.supplier}</>;
      case 'journal':
        return <>Manual journal <a {...nav.linkProps(`/ledger?tab=journals&open=${src.journalId}`)}>{src.number}</a> ({src.status})</>;
      case 'bank':
        return <>Bank line on <a {...nav.linkProps(`/ledger?tab=reconcile&account=${src.bankAccountId}`)}>{src.bankName}</a> · {src.description}</>;
      case 'cost': {
        const e = src.event;
        const tokens = [e.inputTokens ? `${e.inputTokens.toLocaleString()} in` : '', e.cachedInputTokens ? `${e.cachedInputTokens.toLocaleString()} cached` : '', e.outputTokens ? `${e.outputTokens.toLocaleString()} out` : ''].filter(Boolean).join(', ');
        return (
          <>
            Paperclip cost event · {e.provider ?? 'provider'}{e.model ? ` · ${e.model}` : ''}{e.billingType ? ` · ${e.billingType.replace(/_/g, ' ')}` : ''}
            <div className="ai3-cap">
              {t.agentName ? <>Agent <a {...nav.linkProps(`/agents/${e.agentId}`)}>{t.agentName}</a></> : e.agentId ? <>Agent <a {...nav.linkProps(`/agents/${e.agentId}`)}>{e.agentId.slice(0, 8)}</a></> : 'No agent'}
              {e.runId ? <> · run <a {...nav.linkProps(`/agents/${e.agentId}/runs/${e.runId}`)}>{e.runId.slice(0, 8)}</a></> : null}
              {e.issueId ? <> · <a {...nav.linkProps(`/issues/${e.issueId}`)}>task</a></> : null}
              {tokens ? ` · ${tokens} tokens` : ''}{e.costStatus && e.costStatus !== 'reported' ? ` · ${e.costStatus}` : ''}
              {' · '}<a {...nav.linkProps('/costs')}>Costs</a>
            </div>
          </>
        );
      }
      case 'conversion':
        return <>Opening balances imported as at {dateLong(src.asOf)} · <a {...nav.linkProps('/ledger?tab=import')}>Import</a></>;
      case 'funding':
        return <>Funding recorded by the board</>;
      case 'reversal':
        return <>Reversal{t.reverses ? <> of <a href="#" onClick={(e) => { e.preventDefault(); nav.navigate(`/ledger?tab=transactions&open=${t.reverses!.id}`); }}>{t.reverses.description}</a> ({dateLong(t.reverses.occurredAt)})</> : null}{t.reversalOf && t.reversalOf.kind !== 'unknown' ? <span className="ai3-cap"> · originally {sourceLabel(t.reversalOf.kind)}</span> : null}</>;
      case 'manual':
        return <>Posted by hand ({t.createdBy})</>;
      default:
        return <>Source not on record{t.sourceRef ? ` (${t.sourceRef})` : ''}</>;
    }
  })();
  return (
    <div className="ai3-detail">
      <div className="ai3-toolbar">
        <div>
          <strong>{t.description}</strong> <span className="ai3-badge draft">{sourceLabel(t.sourceKind)}</span>
          <div className="ai3-note" style={{ marginTop: 4 }}>{dateLong(t.occurredAt)} · by {t.createdBy}{t.reversedBy ? <span style={{ color: 'var(--ai3-red)' }}> · reversed by <a href="#" onClick={(e) => { e.preventDefault(); nav.navigate(`/ledger?tab=transactions&open=${t.reversedBy!.id}`); }}>{t.reversedBy.description}</a></span> : null}</div>
        </div>
        {onClose && <button className="ai3-btn small" onClick={onClose}>Close</button>}
      </div>
      <div className="ai3-grid two">
        <div>
          <table className="ai3-table">
            <thead><tr><th>Account</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
            <tbody>
              {t.entries.map((e, i) => (
                <tr key={i}>
                  <td><a {...nav.linkProps(entriesLink({ account: e.accountCode, label: `${e.accountCode} ${e.accountName}` }))}>{e.accountCode} {e.accountName}</a>{e.subject.agent ? <span className="muted"> · agent {e.subject.agent.slice(0, 8)}</span> : null}</td>
                  <td className="num">{e.direction === 'debit' ? fmt(e.amountMinor, { currency: cur, symbol: false }) : ''}</td>
                  <td className="num">{e.direction === 'credit' ? fmt(e.amountMinor, { currency: cur, symbol: false }) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Where it came from</div>
          <div style={{ fontSize: 13.5 }}>{sourceCard}</div>
          {t.bankLinks.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Matched bank line{t.bankLinks.length === 1 ? '' : 's'}</div>
              {t.bankLinks.map((b) => <div key={b.lineId} style={{ fontSize: 13 }}><a {...nav.linkProps(`/ledger?tab=reconcile&account=${b.bankAccountId}`)}>{b.bankName}</a> · {dateLong(b.postedAt)} · {b.description} · {fmt(b.amountMinor, { currency: cur })}</div>)}
            </div>
          )}
          <div style={{ marginTop: 10 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Documents</div>
            <DocumentList companyId={companyId} targetKind={src.kind === 'bill' ? 'bill' : src.kind === 'invoice' ? 'invoice' : src.kind === 'journal' ? 'journal' : 'transaction'} targetId={src.kind === 'bill' ? src.billId : src.kind === 'invoice' ? src.invoiceId : src.kind === 'journal' ? src.journalId : t.id} documents={t.documents} onChanged={tx.refresh} compact />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Entries behind a figure
// ---------------------------------------------------------------------------

export function EntriesView({ companyId, company }: { companyId: string; company: Company | null }) {
  const location = useHostLocation();
  const nav = useHostNavigation();
  const q = new URLSearchParams(location.search);
  const account = q.get('account') ?? undefined;
  const type = q.get('type') ?? undefined;
  const from = q.get('from') ?? undefined;
  const to = q.get('to') ?? undefined;
  const groupBy = q.get('groupBy') ?? undefined;
  const groupKey = q.get('groupKey');
  const source = q.get('source') ?? undefined;
  const cur = company?.currency ?? 'USD';
  const params: Record<string, unknown> = { companyId, limit: 1000 };
  if (account) params['accountCode'] = account;
  if (type) params['accountType'] = type;
  if (from) params['from'] = from;
  if (to) params['to'] = to;
  if (groupBy) { params['groupBy'] = groupBy; params['groupKey'] = groupKey ?? ''; }
  if (q.get('children') === '1') params['withChildren'] = true;
  if (source) params['sourceKind'] = source;
  const list = usePluginData<EntryList>('entries', params);
  const [openId, setOpenId] = useState<string | null>(q.get('open'));
  const label = q.get('label') ?? (account ? `Account ${account}` : type ? `${type[0]!.toUpperCase()}${type.slice(1)} accounts` : source ? sourceLabel(source) : 'Entries');
  const window = from || to ? `${from ? dateLong(from) : 'the start'} to ${to ? dateLong(to) : 'today'}` : 'all dates';
  const group = groupBy ? ` · ${groupBy} ${groupKey ? groupKey.slice(0, 8) : 'unattributed'}` : '';
  const rows = list.data?.rows ?? [];
  return (
    <>
      <Header crumb={<><a {...nav.linkProps('/ledger?tab=transactions')}>Transactions</a> › {label}</>} title={label} sub={`${window}${group}`} actions={<a className="ai3-btn" {...nav.linkProps('/ledger?tab=transactions')}>All transactions</a>} />
      <Failure error={list.error} />
      <div className="ai3-card">
        <div className="ai3-toolbar">
          <span className="summary"><b>{list.data?.count ?? 0}</b> entries{list.data?.truncated ? ' (first 1,000)' : ''} | debits <b>{fmt(list.data?.debitMinor ?? '0', { currency: cur })}</b> | credits <b>{fmt(list.data?.creditMinor ?? '0', { currency: cur })}</b> | net <b>{fmt(list.data?.totalMinor ?? '0', { currency: cur, paren: true })}</b></span>
          <span className="ai3-cap">Click a row for the transaction and where it came from.</span>
        </div>
        <table className="ai3-table">
          <thead><tr><th>Date</th><th>Description</th><th>Source</th>{!account && <th>Account</th>}<th className="num">Debit</th><th className="num">Credit</th>{account && <th className="num">Balance</th>}</tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={7} className="ai3-empty">{list.loading ? 'Loading…' : 'Nothing posted here.'}</td></tr>}
            {rows.map((e) => {
              const isOpen = openId === e.transactionId;
              return (
                <React.Fragment key={e.entryId}>
                  <tr className="click" onClick={() => setOpenId(isOpen ? null : e.transactionId)}>
                    <td className="muted" style={{ whiteSpace: 'nowrap' }}>{dateLong(e.occurredAt)}</td>
                    <td>{e.description}{e.subject.agent ? <span className="muted"> · agent {e.subject.agent.slice(0, 8)}</span> : null}</td>
                    <td className="muted">{sourceLabel(e.sourceKind)}</td>
                    {!account && <td>{e.accountCode} {e.accountName}</td>}
                    <td className="num">{e.direction === 'debit' ? fmt(e.amountMinor, { symbol: false }) : ''}</td>
                    <td className="num">{e.direction === 'credit' ? fmt(e.amountMinor, { symbol: false }) : ''}</td>
                    {account && <td className="num">{fmt(e.runningMinor, { symbol: false, paren: true })}</td>}
                  </tr>
                  {isOpen && <tr><td colSpan={7} style={{ padding: '0 0 8px' }}><TransactionDetail companyId={companyId} transactionId={e.transactionId} cur={cur} onClose={() => setOpenId(null)} /></td></tr>}
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
// Trial balance
// ---------------------------------------------------------------------------

export function TrialBalanceCard({ companyId, company, asOf, from }: { companyId: string; company: Company | null; asOf: string; from?: string }) {
  const nav = useHostNavigation();
  const cur = company?.currency ?? 'USD';
  const tb = usePluginData<TrialBalance>('trial-balance', { companyId, asOf: `${asOf}T23:59:59.999Z`, ...(from ? { from: `${from}T00:00:00.000Z` } : {}) });
  const b = tb.data;
  return (
    <div className="ai3-report">
      <h2>Trial Balance</h2>
      <div className="who">{company?.name ?? ''}</div>
      <div className="when">{from ? `Movements ${dateLong(from)} to ${dateLong(asOf)}` : `As at ${dateLong(asOf)}`}</div>
      <Failure error={tb.error} />
      {b && (
        <table className="ai3-stmt">
          <thead><tr><th style={{ textAlign: 'left' }}>Account</th><th>Debit {cur}</th><th>Credit {cur}</th></tr></thead>
          <tbody>
            {TYPE_ORDER.map((type) => {
              const lines = b.lines.filter((l) => l.type === type);
              if (lines.length === 0) return null;
              return (
                <React.Fragment key={type}>
                  <tr className="section"><td colSpan={3} style={{ textTransform: 'capitalize' }}>{type}</td></tr>
                  {lines.map((l) => (
                    <tr className="line" key={l.code}>
                      <td><a {...nav.linkProps(entriesLink({ account: l.code, to: `${asOf}T23:59:59.999Z`, ...(from ? { from: `${from}T00:00:00.000Z` } : {}), label: `${l.code} ${l.name}` }))}>{l.code} {l.name}</a></td>
                      <td className="num">{BigInt(l.debitMinor) ? fmt(l.debitMinor, { symbol: false }) : ''}</td>
                      <td className="num">{BigInt(l.creditMinor) ? fmt(l.creditMinor, { symbol: false }) : ''}</td>
                    </tr>
                  ))}
                </React.Fragment>
              );
            })}
            <tr className="grand"><td>Total</td><td className="num">{fmt(b.debitMinor, { symbol: false })}</td><td className="num">{fmt(b.creditMinor, { symbol: false })}</td></tr>
          </tbody>
        </table>
      )}
      {b && (
        <p className="ai3-note" style={{ marginTop: 12 }}>
          <span className={`ai3-badge ${b.balances ? 'ok' : 'bad'}`}>{b.balances ? 'In agreement' : `Out by ${fmt(b.differenceMinor, { currency: cur })}`}</span>
          <span style={{ marginLeft: 8 }}>Each account's net balance on one side. Click an account for the entries behind it.</span>
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Journals
// ---------------------------------------------------------------------------

function useChart(companyId: string) {
  const chart = usePluginData<{ accounts: ChartAccount[] }>('chart', { companyId });
  return { accounts: chart.data?.accounts ?? [], refresh: chart.refresh };
}

function AccountSelect({ accounts, value, onChange, types }: { accounts: ChartAccount[]; value: string; onChange: (code: string) => void; types?: string[] }) {
  const list = types ? accounts.filter((a) => types.includes(a.type)) : accounts;
  return (
    <select className="ai3-select" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Account…</option>
      {TYPE_ORDER.filter((t) => list.some((a) => a.type === t)).map((t) => (
        <optgroup key={t} label={t[0]!.toUpperCase() + t.slice(1)}>
          {list.filter((a) => a.type === t).map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

interface JLine { accountCode: string; debit: string; credit: string; description: string }
const emptyJLine = (): JLine => ({ accountCode: '', debit: '', credit: '', description: '' });

function JournalForm({ companyId, accounts, cur, existing, onDone, onCancel }: { companyId: string; accounts: ChartAccount[]; cur: string; existing?: Journal; onDone: () => void; onCancel: () => void }) {
  const create = usePluginAction('journal.create');
  const update = usePluginAction('journal.update');
  const post = usePluginAction('journal.post');
  const { run, busy } = useRun([]);
  const [date, setDate] = useState(existing ? existing.occurredAt.slice(0, 10) : today());
  const [narration, setNarration] = useState(existing?.narration ?? '');
  const [lines, setLines] = useState<JLine[]>(existing ? existing.lines.map((l) => ({ accountCode: l.accountCode, debit: l.direction === 'debit' ? fmt(l.amountMinor, { symbol: false }).replace(/,/g, '') : '', credit: l.direction === 'credit' ? fmt(l.amountMinor, { symbol: false }).replace(/,/g, '') : '', description: l.description ?? '' })) : [emptyJLine(), emptyJLine()]);
  const amt = (s: string) => (AMOUNT.test(s.replace(/,/g, '')) ? BigInt(toMinor(s.replace(/,/g, ''))) : 0n);
  const debits = lines.reduce((s, l) => s + amt(l.debit), 0n);
  const credits = lines.reduce((s, l) => s + amt(l.credit), 0n);
  const valid = lines.length >= 2 && lines.every((l) => l.accountCode && ((amt(l.debit) > 0n) !== (amt(l.credit) > 0n))) && debits === credits && debits > 0n;
  const set = (i: number, patch: Partial<JLine>) => setLines(lines.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  async function save(thenPost: boolean) {
    const payload = { companyId, occurredAt: `${date}T12:00:00.000Z`, narration, lines: lines.map((l) => ({ accountCode: l.accountCode, direction: amt(l.debit) > 0n ? 'debit' : 'credit', amountMinor: (amt(l.debit) > 0n ? amt(l.debit) : amt(l.credit)).toString(), description: l.description })) };
    const ok = await run(async () => {
      if (existing) {
        await update({ ...payload, journalId: existing.id });
        if (thenPost) await post({ companyId, journalId: existing.id });
      } else {
        await create({ ...payload, post: thenPost });
      }
    }, thenPost ? 'Journal posted' : 'Draft saved');
    if (ok) onDone();
  }
  return (
    <div className="ai3-card" style={{ marginBottom: 14 }}>
      <div className="ai3-toolbar">
        <h3 style={{ margin: 0 }}>{existing ? existing.number : 'New journal'} <span className="ai3-badge draft">Draft</span></h3>
        <div className="ai3-actions">
          <button className="ai3-btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="ai3-btn" onClick={() => save(false)} disabled={busy || !valid}>Save as draft</button>
          <button className="ai3-btn primary" onClick={() => save(true)} disabled={busy || !valid}>Post</button>
        </div>
      </div>
      <div className="ai3-form-row">
        <Field label="Date"><input className="ai3-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Narration" style={{ gridColumn: 'span 3' }}><input className="ai3-input" placeholder="Why this journal exists" value={narration} onChange={(e) => setNarration(e.target.value)} /></Field>
      </div>
      <table className="ai3-table ai3-lines">
        <thead><tr><th style={{ width: '32%' }}>Account</th><th>Description</th><th style={{ width: 130 }} className="num">Debit {cur}</th><th style={{ width: 130 }} className="num">Credit {cur}</th><th style={{ width: 40 }}></th></tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td><AccountSelect accounts={accounts} value={l.accountCode} onChange={(code) => set(i, { accountCode: code })} /></td>
              <td><input className="ai3-input" value={l.description} onChange={(e) => set(i, { description: e.target.value })} /></td>
              <td><input className="ai3-input" placeholder="0.00" inputMode="decimal" value={l.debit} onChange={(e) => set(i, { debit: e.target.value, credit: e.target.value ? '' : l.credit })} /></td>
              <td><input className="ai3-input" placeholder="0.00" inputMode="decimal" value={l.credit} onChange={(e) => set(i, { credit: e.target.value, debit: e.target.value ? '' : l.debit })} /></td>
              <td><button className="ai3-btn small" disabled={lines.length <= 2} onClick={() => setLines(lines.filter((_, j) => j !== i))}>×</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="ai3-toolbar" style={{ marginTop: 8 }}>
        <button className="ai3-btn small" onClick={() => setLines([...lines, emptyJLine()])}>+ Add line</button>
        <span className="summary">Debits <b>{fmt(debits, { currency: cur })}</b> · Credits <b>{fmt(credits, { currency: cur })}</b>{debits !== credits ? <span style={{ color: 'var(--ai3-red)' }}> · out by {fmt(debits > credits ? debits - credits : credits - debits, { currency: cur })}</span> : <span style={{ color: 'var(--ai3-green)' }}> · balanced</span>}</span>
      </div>
    </div>
  );
}

function JournalDetail({ companyId, journal, cur, accounts, onChanged }: { companyId: string; journal: Journal; cur: string; accounts: ChartAccount[]; onChanged: () => void }) {
  const full = usePluginData<Journal>('journal', { companyId, journalId: journal.id });
  const post = usePluginAction('journal.post');
  const voidIt = usePluginAction('journal.void');
  const del = usePluginAction('journal.delete');
  const nav = useHostNavigation();
  const { run, busy } = useRun([full.refresh, onChanged]);
  const [editing, setEditing] = useState(false);
  const [showTx, setShowTx] = useState<string | null>(null);
  const j = full.data ?? journal;
  if (editing) return <JournalForm companyId={companyId} accounts={accounts} cur={cur} existing={j} onDone={() => { setEditing(false); full.refresh(); onChanged(); }} onCancel={() => setEditing(false)} />;
  return (
    <div className="ai3-detail">
      <div className="ai3-toolbar">
        <div>
          <strong>{j.number}</strong> · {dateLong(j.occurredAt)} · <span className={`ai3-badge ${j.status === 'posted' ? 'paid' : j.status === 'voided' ? 'void' : 'draft'}`}>{j.status}</span>
          <div className="ai3-note" style={{ marginTop: 4 }}>{j.narration || 'No narration'} · by {j.createdBy}{j.voidedAt ? ` · voided ${dateLong(j.voidedAt)}` : ''}</div>
        </div>
        <div className="ai3-actions">
          {j.status === 'draft' && <button className="ai3-btn" disabled={busy} onClick={() => setEditing(true)}>Edit</button>}
          {j.status === 'draft' && <button className="ai3-btn primary" disabled={busy} onClick={() => run(() => post({ companyId, journalId: j.id }), `${j.number} posted`)}>Post</button>}
          {j.status === 'draft' && <button className="ai3-btn danger" disabled={busy} onClick={() => { if (confirm(`Delete draft ${j.number}?`)) void run(() => del({ companyId, journalId: j.id }), 'Draft deleted'); }}>Delete</button>}
          {j.status === 'posted' && <button className="ai3-btn danger" disabled={busy} onClick={() => { const reason = prompt(`Void ${j.number}? A reversing transaction is posted; the journal stays on record. Reason (optional):`); if (reason !== null) void run(() => voidIt({ companyId, journalId: j.id, reason }), `${j.number} voided`); }}>Void</button>}
        </div>
      </div>
      <table className="ai3-table">
        <thead><tr><th>Account</th><th>Description</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
        <tbody>
          {j.lines.map((l) => (
            <tr key={l.position}>
              <td><a {...nav.linkProps(entriesLink({ account: l.accountCode, label: `${l.accountCode} ${l.accountName}` }))}>{l.accountCode} {l.accountName}</a></td>
              <td className="muted">{l.description ?? ''}</td>
              <td className="num">{l.direction === 'debit' ? fmt(l.amountMinor, { symbol: false }) : ''}</td>
              <td className="num">{l.direction === 'credit' ? fmt(l.amountMinor, { symbol: false }) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="ai3-note" style={{ marginTop: 8 }}>
        {j.transactionId && <a href="#" onClick={(e) => { e.preventDefault(); setShowTx(showTx === j.transactionId ? null : j.transactionId); }}>{showTx === j.transactionId ? 'Hide' : 'Show'} the posted transaction</a>}
        {j.reversalId && <> · <a href="#" onClick={(e) => { e.preventDefault(); setShowTx(showTx === j.reversalId ? null : j.reversalId); }}>{showTx === j.reversalId ? 'Hide' : 'Show'} the reversal</a></>}
      </div>
      {showTx && <div style={{ marginTop: 8 }}><TransactionDetail companyId={companyId} transactionId={showTx} cur={cur} onClose={() => setShowTx(null)} /></div>}
      <div style={{ marginTop: 10 }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>Documents</div>
        <DocumentList companyId={companyId} targetKind="journal" targetId={j.id} documents={full.data?.documents ?? []} onChanged={full.refresh} compact />
      </div>
    </div>
  );
}

export function JournalsTab({ companyId, company }: { companyId: string; company: Company | null }) {
  const location = useHostLocation();
  const cur = company?.currency ?? 'USD';
  const list = usePluginData<{ journals: Journal[] }>('journals', { companyId });
  const { accounts } = useChart(companyId);
  const [filter, setFilter] = useState<'all' | 'draft' | 'posted' | 'voided'>('all');
  const [showNew, setShowNew] = useState(new URLSearchParams(location.search).get('new') === '1');
  const [openId, setOpenId] = useState<string | null>(new URLSearchParams(location.search).get('open'));
  const all = list.data?.journals ?? [];
  const rows = filter === 'all' ? all : all.filter((j) => j.status === filter);
  return (
    <>
      <Header crumb="Journals" title="Manual journals" sub="Accruals, corrections and anything no other screen covers. Posted journals are voided by reversal, never edited." actions={<button className="ai3-btn primary" onClick={() => setShowNew(true)}>New journal</button>} />
      <Failure error={list.error} />
      {showNew && <JournalForm companyId={companyId} accounts={accounts} cur={cur} onDone={() => { setShowNew(false); list.refresh(); }} onCancel={() => setShowNew(false)} />}
      <div className="ai3-tabs">
        {(['all', 'draft', 'posted', 'voided'] as const).map((f) => <button key={f} className={`ai3-tab ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>{f === 'all' ? 'All' : f[0]!.toUpperCase() + f.slice(1)}{f !== 'all' ? <span className="n">({all.filter((j) => j.status === f).length})</span> : null}</button>)}
      </div>
      <div className="ai3-card">
        <table className="ai3-table">
          <thead><tr><th>Number</th><th>Date</th><th>Narration</th><th>Status</th><th className="num">Amount</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={5} className="ai3-empty">{list.loading ? 'Loading…' : 'No journals yet.'}</td></tr>}
            {rows.map((j) => {
              const isOpen = openId === j.id;
              return (
                <React.Fragment key={j.id}>
                  <tr className="click" onClick={() => setOpenId(isOpen ? null : j.id)}>
                    <td><a href="#" onClick={(e) => e.preventDefault()}>{j.number}</a></td>
                    <td className="muted">{dateLong(j.occurredAt)}</td>
                    <td>{j.narration || <span className="muted">—</span>}</td>
                    <td><span className={`ai3-badge ${j.status === 'posted' ? 'paid' : j.status === 'voided' ? 'void' : 'draft'}`}>{j.status}</span></td>
                    <td className="num">{fmt(j.debitMinor, { symbol: false })}</td>
                  </tr>
                  {isOpen && <tr><td colSpan={5} style={{ padding: '0 0 8px' }}><JournalDetail companyId={companyId} journal={j} cur={cur} accounts={accounts} onChanged={list.refresh} /></td></tr>}
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
// Bills
// ---------------------------------------------------------------------------

type BillFilter = 'all' | 'draft' | 'open' | 'paid' | 'void';
const BILL_FILTERS: Array<{ key: BillFilter; label: string; test: (b: Bill) => boolean }> = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'draft', label: 'Draft', test: (b) => b.status === 'draft' },
  { key: 'open', label: 'Awaiting payment', test: (b) => b.status === 'approved' || b.status === 'part_paid' },
  { key: 'paid', label: 'Paid', test: (b) => b.status === 'paid' },
  { key: 'void', label: 'Void', test: (b) => b.status === 'void' },
];
function billStatusLabel(s: string): string {
  return { draft: 'Draft', approved: 'Awaiting payment', part_paid: 'Part paid', paid: 'Paid', void: 'Void' }[s] ?? s;
}
function billBadge(s: string): string {
  return { draft: 'draft', approved: 'issued', part_paid: 'part_paid', paid: 'paid', void: 'void' }[s] ?? 'draft';
}

interface BLine { description: string; quantity: string; unit: string; tax: string; accountCode: string }
const emptyBLine = (account = ''): BLine => ({ description: '', quantity: '1', unit: '', tax: '', accountCode: account });

interface Extracted { supplier: string | null; supplierEmail: string | null; number: string | null; date: string | null; dueDate: string | null; currency: string | null; subtotal: string | null; tax: string | null; total: string | null; lines: Array<{ description: string; quantity: string; unitAmount: string; tax: string }>; confidence: number; notes: string | null; source: string }

function BillForm({ companyId, suppliers, accounts, cur, existing, prefill, onDone, onCancel }: { companyId: string; suppliers: Supplier[]; accounts: ChartAccount[]; cur: string; existing?: Bill; prefill?: { fields: Extracted | null; documentId: string | null; filename: string } | null; onDone: () => void; onCancel: () => void }) {
  const createSupplier = usePluginAction('supplier.create');
  const create = usePluginAction('bill.create');
  const update = usePluginAction('bill.update');
  const approve = usePluginAction('bill.approve');
  const { run, busy } = useRun([]);
  const f = prefill?.fields ?? null;
  const supplierMatch = f?.supplier ? suppliers.find((s) => s.name.toLowerCase() === f.supplier!.toLowerCase()) : undefined;
  const [supplierId, setSupplierId] = useState(existing?.supplierId ?? supplierMatch?.id ?? '');
  const [newSupplier, setNewSupplier] = useState(Boolean(f?.supplier && !supplierMatch));
  const [supName, setSupName] = useState(f?.supplier ?? '');
  const [supEmail, setSupEmail] = useState(f?.supplierEmail ?? '');
  const [reference, setReference] = useState(existing?.reference ?? f?.number ?? '');
  const [date, setDate] = useState(existing?.issuedAt?.slice(0, 10) ?? f?.date ?? today());
  const [due, setDue] = useState(existing?.dueAt?.slice(0, 10) ?? f?.dueDate ?? plusDays(f?.date ?? today(), 30));
  const [currency, setCurrency] = useState(existing?.currency ?? f?.currency ?? cur);
  const [rate, setRate] = useState(existing && existing.currency !== existing.baseCurrency ? existing.rateToBase : '');
  const [notes, setNotes] = useState(existing?.notes ?? f?.notes ?? '');
  const defaultAccount = suppliers.find((s) => s.id === supplierId)?.defaultAccountCode ?? '5900';
  const [lines, setLines] = useState<BLine[]>(
    existing ? existing.lines.map((l) => ({ description: l.description, quantity: String(Number(l.quantity)), unit: fmt(l.unitAmountMinor, { symbol: false }).replace(/,/g, ''), tax: BigInt(l.taxMinor) ? fmt(l.taxMinor, { symbol: false }).replace(/,/g, '') : '', accountCode: l.accountCode }))
      : f && f.lines.length ? f.lines.map((l) => ({ description: l.description, quantity: l.quantity, unit: l.unitAmount, tax: l.tax && l.tax !== '0.00' ? l.tax : '', accountCode: defaultAccount }))
      : f && f.total ? [{ description: `Invoice ${f.number ?? ''}`.trim(), quantity: '1', unit: f.subtotal ?? f.total, tax: f.tax && f.tax !== '0.00' ? f.tax : '', accountCode: defaultAccount }]
      : [emptyBLine(defaultAccount)],
  );
  const foreign = currency !== cur;
  const fx = usePluginData<{ rate: string; source: string; date: string }>('fx-rate', foreign ? { companyId, from: currency, to: cur, date } : { companyId, from: cur, to: cur });
  const [rateTouched, setRateTouched] = useState(Boolean(existing));
  useEffect(() => { if (foreign && fx.data && !rateTouched) setRate(fx.data.rate); }, [foreign, fx.data, rateTouched]);
  const amt = (s: string) => (AMOUNT.test(s.replace(/,/g, '')) ? BigInt(toMinor(s.replace(/,/g, ''))) : 0n);
  const lineTotal = (l: BLine) => {
    if (!AMOUNT.test(l.unit.replace(/,/g, '')) || !/^\d+(\.\d+)?$/.test(l.quantity)) return 0n;
    return (amt(l.unit) * BigInt(Math.round(Number(l.quantity) * 10_000)) + 5_000n) / 10_000n;
  };
  const subtotal = lines.reduce((s, l) => s + lineTotal(l), 0n);
  const tax = lines.reduce((s, l) => s + amt(l.tax), 0n);
  const valid = (supplierId || (newSupplier && supName.trim())) && lines.every((l) => l.description.trim() && AMOUNT.test(l.unit.replace(/,/g, '')) && l.accountCode) && subtotal > 0n && (!foreign || /^\d+(\.\d{1,10})?$/.test(rate));
  const set = (i: number, patch: Partial<BLine>) => setLines(lines.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  async function save(thenApprove: boolean) {
    const ok = await run(async () => {
      let sid = supplierId;
      if (newSupplier) {
        const s = (await createSupplier({ companyId, name: supName, email: supEmail })) as { id: string };
        sid = s.id;
      }
      const payload = {
        companyId, supplierId: sid, reference, issuedAt: `${date}T12:00:00.000Z`, dueAt: `${due}T23:59:59.000Z`, currency, rateToBase: foreign ? rate : null, notes,
        lines: lines.map((l) => ({ description: l.description, quantity: l.quantity || '1', unitAmountMinor: toMinor(l.unit.replace(/,/g, '')), taxMinor: l.tax ? toMinor(l.tax.replace(/,/g, '')) : null, accountCode: l.accountCode })),
      };
      if (existing) {
        await update({ ...payload, billId: existing.id });
        if (thenApprove) await approve({ companyId, billId: existing.id });
      } else {
        await create({ ...payload, approve: thenApprove, documentId: prefill?.documentId ?? null });
      }
    }, thenApprove ? 'Bill approved' : 'Draft saved');
    if (ok) onDone();
  }
  return (
    <div className="ai3-card" style={{ marginBottom: 14 }}>
      <div className="ai3-toolbar">
        <h3 style={{ margin: 0 }}>{existing ? existing.number : 'New bill'} <span className="ai3-badge draft">Draft</span>{prefill ? <span className="ai3-cap" style={{ display: 'inline', marginLeft: 8 }}>{f ? `read from ${prefill.filename} (${f.confidence}% sure, ${f.source})` : `${prefill.filename} attached; fill in the bill`}</span> : null}</h3>
        <div className="ai3-actions">
          <button className="ai3-btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="ai3-btn" onClick={() => save(false)} disabled={busy || !valid}>Save as draft</button>
          <button className="ai3-btn primary" onClick={() => save(true)} disabled={busy || !valid}>Approve</button>
        </div>
      </div>
      <div className="ai3-form-row">
        <Field label="Supplier">
          {newSupplier ? (
            <input className="ai3-input" placeholder="Supplier name" value={supName} onChange={(e) => setSupName(e.target.value)} autoFocus />
          ) : (
            <select className="ai3-select" value={supplierId} onChange={(e) => (e.target.value === '__new' ? setNewSupplier(true) : setSupplierId(e.target.value))}>
              <option value="">Choose a supplier…</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              <option value="__new">+ New supplier</option>
            </select>
          )}
        </Field>
        {newSupplier && <Field label="Supplier email"><input className="ai3-input" value={supEmail} onChange={(e) => setSupEmail(e.target.value)} /></Field>}
        <Field label="Supplier's invoice number"><input className="ai3-input" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="R0012345" /></Field>
        <Field label="Bill date"><input className="ai3-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Due date"><input className="ai3-input" type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
        <Field label="Currency">
          <select className="ai3-select" value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {[cur, ...CURRENCIES.filter((c) => c !== cur)].map((c) => <option key={c} value={c}>{c}{c === cur ? ' (base)' : ''}</option>)}
          </select>
        </Field>
        {foreign && <Field label={`Rate: 1 ${currency} = ? ${cur}`}><input className="ai3-input" value={rate} inputMode="decimal" placeholder={fx.loading ? 'fetching…' : '1.0850'} onChange={(e) => { setRate(e.target.value); setRateTouched(true); }} /><span className="ai3-cap">{fx.data && !rateTouched ? `${fx.data.source}, ${dateLong(fx.data.date)}` : ''}</span></Field>}
      </div>
      <table className="ai3-table ai3-lines">
        <thead><tr><th style={{ width: '34%' }}>Description</th><th style={{ width: 70 }}>Qty</th><th style={{ width: 120 }}>Price</th><th style={{ width: 100 }}>Tax</th><th>Account</th><th className="num" style={{ width: 120 }}>Amount</th><th style={{ width: 40 }}></th></tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td><input className="ai3-input" placeholder="What was bought" value={l.description} onChange={(e) => set(i, { description: e.target.value })} /></td>
              <td><input className="ai3-input" value={l.quantity} inputMode="decimal" onChange={(e) => set(i, { quantity: e.target.value })} /></td>
              <td><input className="ai3-input" placeholder="0.00" value={l.unit} inputMode="decimal" onChange={(e) => set(i, { unit: e.target.value })} /></td>
              <td><input className="ai3-input" placeholder="0.00" value={l.tax} inputMode="decimal" onChange={(e) => set(i, { tax: e.target.value })} /></td>
              <td><AccountSelect accounts={accounts} value={l.accountCode} onChange={(code) => set(i, { accountCode: code })} types={['expense', 'asset', 'liability']} /></td>
              <td className="num" style={{ paddingTop: 12 }}>{fmt(lineTotal(l) + amt(l.tax), { symbol: false })}</td>
              <td><button className="ai3-btn small" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))}>×</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ marginTop: 8 }}><button className="ai3-btn small" onClick={() => setLines([...lines, emptyBLine(defaultAccount)])}>+ Add row</button></div>
      <div className="ai3-totals">
        <table><tbody>
          <tr><td>Subtotal</td><td>{fmt(subtotal, { symbol: false })}</td></tr>
          {tax > 0n && <tr><td>Tax</td><td>{fmt(tax, { symbol: false })}</td></tr>}
          <tr className="total"><td>Total {currency}</td><td>{fmt(subtotal + tax, { symbol: false })}</td></tr>
          {f?.total && amt(f.total) !== subtotal + tax && <tr><td style={{ fontWeight: 400, color: 'var(--ai3-red)' }}>On the document</td><td style={{ fontWeight: 400, color: 'var(--ai3-red)' }}>{f.total}</td></tr>}
        </tbody></table>
      </div>
      <Field label="Notes" style={{ marginTop: 10 }}><textarea className="ai3-input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      <p className="ai3-note">Approving books each line to its account (and tax to 2100 Tax payable) and the total to 2000 Payables, dated the bill date.</p>
    </div>
  );
}

function BillDetail({ companyId, bill, cur, suppliers, accounts, banks, onChanged }: { companyId: string; bill: Bill; cur: string; suppliers: Supplier[]; accounts: ChartAccount[]; banks: BankAccountLite[]; onChanged: () => void }) {
  const full = usePluginData<Bill & { documents: DocumentMeta[] }>('bill', { companyId, billId: bill.id });
  const approve = usePluginAction('bill.approve');
  const pay = usePluginAction('bill.pay');
  const voidIt = usePluginAction('bill.void');
  const del = usePluginAction('bill.delete');
  const nav = useHostNavigation();
  const { run, busy } = useRun([full.refresh, onChanged]);
  const [editing, setEditing] = useState(false);
  const [paying, setPaying] = useState(false);
  const [payAmount, setPayAmount] = useState('');
  const [payDate, setPayDate] = useState(today());
  const [payRef, setPayRef] = useState('');
  const [payFrom, setPayFrom] = useState(banks[0]?.accountCode ?? '1000');
  const [showTx, setShowTx] = useState<string | null>(null);
  const b = full.data ?? bill;
  const open = b.status === 'approved' || b.status === 'part_paid';
  if (editing) return <BillForm companyId={companyId} suppliers={suppliers} accounts={accounts} cur={cur} existing={b} onDone={() => { setEditing(false); full.refresh(); onChanged(); }} onCancel={() => setEditing(false)} />;
  return (
    <div className="ai3-detail">
      <div className="ai3-toolbar">
        <div>
          <strong>{b.number}</strong> · {b.supplierName}{b.reference ? ` · ${b.reference}` : ''} · <span className={`ai3-badge ${billBadge(b.status)}`}>{billStatusLabel(b.status)}</span>{b.conversion ? <span className="ai3-badge draft" style={{ marginLeft: 6 }}>from the previous system</span> : null}
          <div className="ai3-note" style={{ marginTop: 4 }}>{b.issuedAt ? `Dated ${dateLong(b.issuedAt)}` : `Created ${dateLong(b.createdAt)}`}{b.dueAt ? ` · Due ${dateLong(b.dueAt)}` : ''}{open && b.dueAt && b.dueAt.slice(0, 10) < today() ? <span style={{ color: 'var(--ai3-red)' }}> · Overdue</span> : null}{b.currency !== b.baseCurrency ? ` · ${b.currency} at ${b.rateToBase} ${b.baseCurrency}` : ''}</div>
        </div>
        <div className="ai3-actions">
          {b.status === 'draft' && <button className="ai3-btn" disabled={busy} onClick={() => setEditing(true)}>Edit</button>}
          {b.status === 'draft' && <button className="ai3-btn primary" disabled={busy} onClick={() => run(() => approve({ companyId, billId: b.id }), `${b.number} approved`)}>Approve</button>}
          {open && <button className="ai3-btn primary" disabled={busy} onClick={() => { setPaying((v) => !v); setPayAmount(fmt(b.outstandingMinor, { symbol: false }).replace(/,/g, '')); }}>Record payment</button>}
          {b.status === 'draft' && <button className="ai3-btn danger" disabled={busy} onClick={() => { if (confirm(`Delete draft ${b.number}?`)) void run(() => del({ companyId, billId: b.id }), 'Draft deleted'); }}>Delete</button>}
          {(b.status === 'approved') && BigInt(b.paidMinor) === 0n && <button className="ai3-btn danger" disabled={busy} onClick={() => { const reason = prompt(`Void ${b.number}? The approval is reversed. Reason (optional):`); if (reason !== null) void run(() => voidIt({ companyId, billId: b.id, reason }), `${b.number} voided`); }}>Void</button>}
        </div>
      </div>
      {paying && (
        <div className="ai3-card" style={{ marginBottom: 10 }}>
          <div className="ai3-form-row">
            <Field label={`Amount (${b.currency})`}><input className="ai3-input" value={payAmount} inputMode="decimal" onChange={(e) => setPayAmount(e.target.value)} /></Field>
            <Field label="Date"><input className="ai3-input" type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} /></Field>
            <Field label="From">
              <select className="ai3-select" value={payFrom} onChange={(e) => setPayFrom(e.target.value)}>
                <option value="1000">1000 Treasury</option>
                {banks.map((k) => <option key={k.id} value={k.accountCode}>{k.name}</option>)}
              </select>
            </Field>
            <Field label="Reference"><input className="ai3-input" value={payRef} onChange={(e) => setPayRef(e.target.value)} placeholder="wire, card, transfer id" /></Field>
          </div>
          <div className="ai3-actions">
            <button className="ai3-btn primary" disabled={busy || !AMOUNT.test(payAmount.replace(/,/g, ''))} onClick={async () => { const ok = await run(() => pay({ companyId, billId: b.id, amountMinor: toMinor(payAmount.replace(/,/g, '')), occurredAt: `${payDate}T12:00:00.000Z`, reference: payRef || null, cashAccountCode: payFrom }), 'Payment recorded'); if (ok) setPaying(false); }}>Save payment</button>
            <button className="ai3-btn" onClick={() => setPaying(false)}>Cancel</button>
          </div>
        </div>
      )}
      <div className="ai3-grid two">
        <div>
          <table className="ai3-table">
            <thead><tr><th>Description</th><th>Account</th><th className="num">Qty</th><th className="num">Price</th><th className="num">Tax</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {b.lines.map((l) => (
                <tr key={l.position}>
                  <td>{l.description}</td>
                  <td><a {...nav.linkProps(entriesLink({ account: l.accountCode, label: `${l.accountCode} ${l.accountName}` }))}>{l.accountCode} {l.accountName}</a></td>
                  <td className="num">{Number(l.quantity)}</td>
                  <td className="num">{fmt(l.unitAmountMinor, { symbol: false })}</td>
                  <td className="num">{BigInt(l.taxMinor) ? fmt(l.taxMinor, { symbol: false }) : ''}</td>
                  <td className="num">{fmt(BigInt(l.amountMinor) + BigInt(l.taxMinor), { symbol: false })}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="ai3-totals">
            <table><tbody>
              <tr><td>Subtotal</td><td>{fmt(b.subtotalMinor, { symbol: false })}</td></tr>
              {BigInt(b.taxMinor) > 0n && <tr><td>Tax</td><td>{fmt(b.taxMinor, { symbol: false })}</td></tr>}
              <tr className="total"><td>Total {b.currency}</td><td>{fmt(b.totalMinor, { symbol: false })}</td></tr>
              {BigInt(b.openingPaidMinor) > 0n && <tr><td>Paid before conversion</td><td>{fmt(b.openingPaidMinor, { symbol: false })}</td></tr>}
              {BigInt(b.paidMinor) > 0n && <tr><td>Paid</td><td>{fmt(b.paidMinor, { symbol: false })}</td></tr>}
              {open && <tr className="total"><td>Still owed</td><td>{fmt(b.outstandingMinor, { symbol: false })}</td></tr>}
            </tbody></table>
          </div>
        </div>
        <div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Documents</div>
          <DocumentList companyId={companyId} targetKind="bill" targetId={b.id} documents={full.data?.documents ?? []} onChanged={full.refresh} />
          {b.payments.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Payments</div>
              {b.payments.map((p) => <div key={p.id} style={{ fontSize: 13 }}>{dateLong(p.occurredAt)} · {fmt(p.amountMinor, { currency: b.currency })} from {p.cashAccountCode}{p.reference ? ` · ${p.reference}` : ''}{p.transactionId ? <> · <a href="#" onClick={(e) => { e.preventDefault(); setShowTx(showTx === p.transactionId ? null : p.transactionId); }}>transaction</a></> : null}</div>)}
            </div>
          )}
          {b.notes && <p style={{ whiteSpace: 'pre-wrap', fontSize: 13, marginTop: 12 }}>{b.notes}</p>}
          <div className="ai3-note" style={{ marginTop: 10 }}>{b.transactionId && <a href="#" onClick={(e) => { e.preventDefault(); setShowTx(showTx === b.transactionId ? null : b.transactionId); }}>{showTx === b.transactionId ? 'Hide' : 'Show'} the posted transaction</a>}</div>
        </div>
      </div>
      {showTx && <div style={{ marginTop: 8 }}><TransactionDetail companyId={companyId} transactionId={showTx} cur={cur} onClose={() => setShowTx(null)} /></div>}
    </div>
  );
}

function DropZone({ companyId, onRead, busyOutside }: { companyId: string; onRead: (r: { fields: Extracted | null; documentId: string | null; filename: string; error: string | null }) => void; busyOutside: boolean }) {
  const extract = usePluginAction('bill.extract');
  const readFile = useFileReader();
  const toast = usePluginToast();
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  async function handle(file: File | null) {
    if (!file) return;
    if (file.size > 6 * 1024 * 1024) { toast({ title: 'Files up to 6 MB', tone: 'error' }); return; }
    setBusy(true);
    try {
      const f = await readFile(file);
      const r = (await extract({ companyId, ...f })) as { document: { id: string }; fields: Extracted | null; error: string | null };
      onRead({ fields: r.fields, documentId: r.document?.id ?? null, filename: file.name, error: r.error });
      if (r.error) toast({ title: 'File attached, but not read', body: r.error, tone: 'info', ttlMs: 9000 });
    } catch (err) {
      toast({ title: 'That did not work', body: err instanceof Error ? err.message : String(err), tone: 'error' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <label
      className="ai3-card"
      style={{ display: 'block', marginBottom: 14, textAlign: 'center', padding: 22, borderStyle: 'dashed', cursor: busy || busyOutside ? 'default' : 'pointer', background: over ? 'var(--ai3-blue-soft)' : undefined }}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); void handle(e.dataTransfer.files?.[0] ?? null); }}
    >
      <div style={{ fontWeight: 600 }}>{busy ? 'Reading the bill…' : 'Drop a supplier’s PDF or photo here, or click to choose'}</div>
      <div className="ai3-cap">The file is attached to a draft bill and read into its fields for you to check. Nothing posts until you approve.</div>
      <input type="file" accept=".pdf,image/*" style={{ display: 'none' }} disabled={busy || busyOutside} onChange={(e) => { void handle(e.target.files?.[0] ?? null); e.target.value = ''; }} />
    </label>
  );
}

export function BillsTab({ companyId, company }: { companyId: string; company: Company | null }) {
  const location = useHostLocation();
  const nav = useHostNavigation();
  const cur = company?.currency ?? 'USD';
  const bills = usePluginData<{ bills: Array<Bill & { documents: number }> }>('bills', { companyId });
  const sups = usePluginData<{ suppliers: Supplier[] }>('suppliers', { companyId });
  const banks = usePluginData<{ accounts: BankAccountLite[] }>('bank-accounts', { companyId });
  const { accounts } = useChart(companyId);
  const q = new URLSearchParams(location.search);
  const [filter, setFilter] = useState<BillFilter>((q.get('status') as BillFilter) && BILL_FILTERS.some((f) => f.key === q.get('status')) ? (q.get('status') as BillFilter) : 'all');
  const [showNew, setShowNew] = useState(q.get('new') === '1');
  const [prefill, setPrefill] = useState<{ fields: Extracted | null; documentId: string | null; filename: string } | null>(null);
  const [openId, setOpenId] = useState<string | null>(q.get('open'));
  const all = bills.data?.bills ?? [];
  const rows = all.filter(BILL_FILTERS.find((f) => f.key === filter)!.test);
  const owed = rows.reduce((s, b) => s + BigInt(b.status === 'draft' ? b.totalMinor : b.outstandingMinor), 0n);
  const refreshAll = () => { bills.refresh(); sups.refresh(); };
  return (
    <>
      <Header crumb="Bills" title="Bills" sub="What suppliers have charged you. Approve to book the expense; pay when the money leaves." actions={<button className="ai3-btn primary" onClick={() => { setPrefill(null); setShowNew(true); }}>New bill</button>} />
      <Failure error={bills.error ?? sups.error} />
      {!showNew && <DropZone companyId={companyId} busyOutside={false} onRead={(r) => { setPrefill(r); setShowNew(true); }} />}
      {showNew && <BillForm companyId={companyId} suppliers={sups.data?.suppliers ?? []} accounts={accounts} cur={cur} prefill={prefill} onDone={() => { setShowNew(false); setPrefill(null); refreshAll(); }} onCancel={() => { setShowNew(false); setPrefill(null); }} />}
      <div className="ai3-tabs">
        {BILL_FILTERS.map((f) => <button key={f.key} className={`ai3-tab ${filter === f.key ? 'on' : ''}`} onClick={() => { setFilter(f.key); nav.navigate(`/ledger?tab=bills&status=${f.key}`, { replace: true }); }}>{f.label}{f.key !== 'all' ? <span className="n">({all.filter(f.test).length})</span> : null}</button>)}
      </div>
      <div className="ai3-card">
        <div className="ai3-toolbar"><span className="summary"><b>{rows.length}</b> items | <b>{fmt(owed, { currency: cur })}</b> {filter === 'paid' ? 'paid' : 'owed'}</span></div>
        <table className="ai3-table">
          <thead><tr><th>Number</th><th>From</th><th>Ref</th><th>Date</th><th>Due</th><th>Status</th><th></th><th className="num">Total</th><th className="num">Owed</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={9} className="ai3-empty">{bills.loading ? 'Loading…' : 'No bills here. Drop a PDF above or add one.'}</td></tr>}
            {rows.map((b) => {
              const isOpen = openId === b.id;
              const overdue = (b.status === 'approved' || b.status === 'part_paid') && b.dueAt && b.dueAt.slice(0, 10) < today();
              return (
                <React.Fragment key={b.id}>
                  <tr className="click" onClick={() => setOpenId(isOpen ? null : b.id)}>
                    <td><a href="#" onClick={(e) => e.preventDefault()}>{b.number}</a></td>
                    <td>{b.supplierName}</td>
                    <td className="muted">{b.reference ?? ''}</td>
                    <td className="muted">{dateLong(b.issuedAt ?? b.createdAt)}</td>
                    <td className={overdue ? 'red' : 'muted'}>{dateLong(b.dueAt)}</td>
                    <td><span className={`ai3-badge ${billBadge(b.status)}`}>{billStatusLabel(b.status)}</span></td>
                    <td className="muted">{b.documents ? `📄 ${b.documents}` : ''}</td>
                    <td className="num">{fmt(b.totalMinor, { symbol: false })}</td>
                    <td className="num">{fmt(b.status === 'draft' ? b.totalMinor : b.outstandingMinor, { symbol: false })}</td>
                  </tr>
                  {isOpen && <tr><td colSpan={9} style={{ padding: '0 0 8px' }}><BillDetail companyId={companyId} bill={b} cur={cur} suppliers={sups.data?.suppliers ?? []} accounts={accounts} banks={banks.data?.accounts ?? []} onChanged={refreshAll} /></td></tr>}
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
// Import from another system
// ---------------------------------------------------------------------------

interface TbLine { code: string; name: string; type: string; guessed: boolean; debitMinor: string; creditMinor: string }
interface TbRead { lines: TbLine[]; debitMinor: string; creditMinor: string; balances: boolean; differenceMinor: string; reading: string; warnings: string[]; existingConversionDate: string | null; guessed: number }
interface ChartRead { lines: Array<{ code: string; name: string; type: string; guessed: boolean }>; reading: string; warnings: string[] }
interface DocsRead { parsed: unknown; preview: { kind: string; conversionDate: string | null; rows: Array<{ number: string; contact: string; date: string | null; totalMinor: string; paidMinor: string; outstandingMinor: string; currency: string; preConversion: boolean; duplicate: boolean; skip: string | null; unknownAccounts: string[]; lines: number }>; toImport: number; duplicates: number; skipped: number; preConversionOutstandingMinor: string; controlMinor: string | null; differenceMinor: string | null; postConversionTotalMinor: string; currency: string } }

function TypeSelect({ value, onChange }: { value: string; onChange: (t: string) => void }) {
  return <select className="ai3-select" style={{ padding: '4px 6px' }} value={value} onChange={(e) => onChange(e.target.value)}>{TYPE_ORDER.map((t) => <option key={t} value={t}>{t}</option>)}</select>;
}

function ChartImport({ companyId, onDone }: { companyId: string; onDone: () => void }) {
  const read = usePluginAction('import.read-chart');
  const doImport = usePluginAction('import.chart');
  const { run, busy } = useRun([]);
  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<ChartRead | null>(null);
  const [result, setResult] = useState<{ added: number; existing: number } | null>(null);
  return (
    <div className="ai3-card">
      <h3>Chart of accounts <span className="ctx">optional, before the trial balance</span></h3>
      {!parsed && !result && (
        <>
          <p className="ai3-note" style={{ marginTop: 0 }}>A CSV with a code, a name and (ideally) a type per account, as Xero or QuickBooks export it. Accounts already in the books are left alone.</p>
          <div className="ai3-form-row"><Field label="File"><input className="ai3-input" type="file" accept=".csv,.txt,.tsv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field></div>
          <button className="ai3-btn primary" disabled={busy || !file} onClick={async () => { const content = await file!.text(); await run(async () => setParsed((await read({ companyId, content })) as ChartRead), 'File read'); }}>Read the file</button>
        </>
      )}
      {parsed && !result && (
        <>
          <p className="ai3-note" style={{ marginTop: 0 }}>Read as: {parsed.reading}.{parsed.warnings.length ? ` ${parsed.warnings.join('; ')}.` : ''}</p>
          <div style={{ maxHeight: 320, overflow: 'auto' }}>
            <table className="ai3-table">
              <thead><tr><th>Code</th><th>Name</th><th>Type</th></tr></thead>
              <tbody>{parsed.lines.map((l, i) => <tr key={i}><td className="muted">{l.code}</td><td>{l.name}</td><td><TypeSelect value={l.type} onChange={(t) => setParsed({ ...parsed, lines: parsed.lines.map((x, j) => (j === i ? { ...x, type: t, guessed: false } : x)) })} />{l.guessed ? <span className="ai3-cap" style={{ display: 'inline', marginLeft: 6 }}>guessed</span> : null}</td></tr>)}</tbody>
            </table>
          </div>
          <div className="ai3-actions" style={{ marginTop: 10 }}>
            <button className="ai3-btn primary" disabled={busy} onClick={() => run(async () => { setResult((await doImport({ companyId, lines: parsed.lines })) as { added: number; existing: number }); onDone(); }, 'Accounts imported')}>Import {parsed.lines.length} accounts</button>
            <button className="ai3-btn" onClick={() => setParsed(null)}>Cancel</button>
          </div>
        </>
      )}
      {result && <p style={{ margin: 0 }}><strong>{result.added} added</strong>, {result.existing} already there. <a href="#" onClick={(e) => { e.preventDefault(); setResult(null); setParsed(null); setFile(null); }}>Import another</a></p>}
    </div>
  );
}

function TrialBalanceImport({ companyId, cur, conversionDate, onDone }: { companyId: string; cur: string; conversionDate: string | null; onDone: () => void }) {
  const read = usePluginAction('import.read-trial-balance');
  const doImport = usePluginAction('import.trial-balance');
  const undo = usePluginAction('import.undo-trial-balance');
  const nav = useHostNavigation();
  const { run, busy } = useRun([]);
  const [file, setFile] = useState<File | null>(null);
  const [date, setDate] = useState(conversionDate ?? `${today().slice(0, 4)}-01-01`);
  const [parsed, setParsed] = useState<TbRead | null>(null);
  const [plug, setPlug] = useState(false);
  const [result, setResult] = useState<{ transactionId: string; conversionDate: string; accountsAdded: number; lines: number; plugMinor: string } | null>(null);
  const debit = parsed ? parsed.lines.reduce((s, l) => s + BigInt(l.debitMinor), 0n) : 0n;
  const credit = parsed ? parsed.lines.reduce((s, l) => s + BigInt(l.creditMinor), 0n) : 0n;
  return (
    <div className="ai3-card">
      <h3>Trial balance <span className="ctx">opening balances as at the conversion date</span></h3>
      {conversionDate && !result && (
        <p className="ai3-note" style={{ marginTop: 0 }}>Opening balances stand as at <strong>{dateLong(conversionDate)}</strong>. <a href="#" onClick={(e) => { e.preventDefault(); if (confirm('Reverse the standing opening balances so they can be imported again?')) void run(async () => { await undo({ companyId }); onDone(); }, 'Opening balances reversed'); }}>Undo that import</a> to load a different one.</p>
      )}
      {!parsed && !result && (
        <>
          <p className="ai3-note" style={{ marginTop: 0 }}>Export the trial balance from the old system as at the day before you start here. Debit and credit columns, or one balance column. Receivables and Payables come in as totals; the unpaid invoices and bills behind them are imported next and checked against these figures.</p>
          <div className="ai3-form-row">
            <Field label="Conversion date (first day in these books)"><input className="ai3-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            <Field label="File"><input className="ai3-input" type="file" accept=".csv,.txt,.tsv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
          </div>
          <button className="ai3-btn primary" disabled={busy || !file || !/^\d{4}-\d{2}-\d{2}$/.test(date)} onClick={async () => { const content = await file!.text(); await run(async () => setParsed((await read({ companyId, content })) as TbRead), 'File read'); }}>Read the file</button>
        </>
      )}
      {parsed && !result && (
        <>
          <p className="ai3-note" style={{ marginTop: 0 }}>Read as: {parsed.reading}.{parsed.warnings.length ? ` ${parsed.warnings.join('; ')}.` : ''} Balances post as at the end of {dateLong(plusDays(date, -1))}, so reports from {dateLong(date)} start clean.</p>
          <div style={{ maxHeight: 360, overflow: 'auto' }}>
            <table className="ai3-table">
              <thead><tr><th>Code</th><th>Name</th><th>Type</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
              <tbody>{parsed.lines.map((l, i) => <tr key={i}><td className="muted">{l.code || <span className="red">missing</span>}</td><td>{l.name}</td><td><TypeSelect value={l.type} onChange={(t) => setParsed({ ...parsed, lines: parsed.lines.map((x, j) => (j === i ? { ...x, type: t, guessed: false } : x)) })} />{l.guessed ? <span className="ai3-cap" style={{ display: 'inline', marginLeft: 6 }}>guessed</span> : null}</td><td className="num">{BigInt(l.debitMinor) ? fmt(l.debitMinor, { symbol: false }) : ''}</td><td className="num">{BigInt(l.creditMinor) ? fmt(l.creditMinor, { symbol: false }) : ''}</td></tr>)}</tbody>
              <tfoot><tr><td colSpan={3} style={{ fontWeight: 600 }}>Total</td><td className="num" style={{ fontWeight: 600 }}>{fmt(debit, { symbol: false })}</td><td className="num" style={{ fontWeight: 600 }}>{fmt(credit, { symbol: false })}</td></tr></tfoot>
            </table>
          </div>
          {debit !== credit && (
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, cursor: 'pointer' }}>
              <input type="checkbox" checked={plug} onChange={(e) => setPlug(e.target.checked)} />
              <span style={{ color: 'var(--ai3-red)' }}>Out by {fmt(debit > credit ? debit - credit : credit - debit, { currency: cur })}. Put the difference to 3900 Retained earnings.</span>
            </label>
          )}
          <div className="ai3-actions" style={{ marginTop: 10 }}>
            <button className="ai3-btn primary" disabled={busy || (debit !== credit && !plug) || parsed.lines.some((l) => !l.code)} onClick={() => run(async () => { setResult((await doImport({ companyId, conversionDate: date, lines: parsed.lines, plugToRetainedEarnings: plug })) as typeof result); onDone(); }, 'Opening balances posted')}>Post opening balances</button>
            <button className="ai3-btn" onClick={() => setParsed(null)}>Cancel</button>
          </div>
        </>
      )}
      {result && (
        <p style={{ margin: 0 }}>
          <strong>Opening balances posted</strong> as at {dateLong(result.conversionDate)}: {result.lines} accounts, {result.accountsAdded} created{BigInt(result.plugMinor) !== 0n ? `, ${fmt(result.plugMinor, { currency: cur })} to retained earnings` : ''}.{' '}
          <a {...nav.linkProps('/ledger?tab=statements&view=trial')}>See the trial balance</a> · <a href="#" onClick={(e) => { e.preventDefault(); nav.navigate(`/ledger?tab=transactions&open=${result.transactionId}`); }}>the transaction</a>
        </p>
      )}
    </div>
  );
}

function DocsImport({ companyId, kind, cur, conversionDate, banks, accounts, onDone }: { companyId: string; kind: 'invoice' | 'bill'; cur: string; conversionDate: string | null; banks: BankAccountLite[]; accounts: ChartAccount[]; onDone: () => void }) {
  const read = usePluginAction('import.read-documents');
  const doImport = usePluginAction('import.documents');
  const nav = useHostNavigation();
  const { run, busy } = useRun([]);
  const [file, setFile] = useState<File | null>(null);
  const [data, setData] = useState<DocsRead | null>(null);
  const [cash, setCash] = useState('1000');
  const [defaultAccount, setDefaultAccount] = useState('5900');
  const [result, setResult] = useState<{ created: number; skipped: number; failed: Array<{ number: string; contact: string; error: string }>; numbers: string[] } | null>(null);
  const label = kind === 'invoice' ? 'Sales invoices' : 'Bills';
  const p = data?.preview;
  return (
    <div className="ai3-card">
      <h3>{label} <span className="ctx">one row per line, as exported</span></h3>
      {!data && !result && (
        <>
          <p className="ai3-note" style={{ marginTop: 0 }}>{kind === 'invoice' ? 'Customer, invoice number, dates, description, quantity, unit price, tax, account code, and amount paid or status.' : 'Supplier, their invoice number, dates, description, quantity, unit price, tax, account code, and amount paid or status.'} {conversionDate ? <>Anything dated before {dateLong(conversionDate)} is a record only; from that date on it posts.</> : <>Set a conversion date by importing a trial balance first, or everything will post.</>}</p>
          <div className="ai3-form-row"><Field label="File"><input className="ai3-input" type="file" accept=".csv,.txt,.tsv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field></div>
          <button className="ai3-btn primary" disabled={busy || !file} onClick={async () => { const content = await file!.text(); await run(async () => setData((await read({ companyId, kind, content })) as DocsRead), 'File read'); }}>Read the file</button>
        </>
      )}
      {data && p && !result && (
        <>
          <div className="ai3-grid" style={{ marginBottom: 10 }}>
            <div><div className="ai3-big" style={{ fontSize: 20 }}>{p.toImport}</div><div className="ai3-cap">to import{p.skipped ? `, ${p.skipped} skipped (${p.duplicates} already here)` : ''}</div></div>
            <div><div className="ai3-big" style={{ fontSize: 20 }}>{fmt(p.preConversionOutstandingMinor, { currency: cur })}</div><div className="ai3-cap">unpaid before conversion</div></div>
            {p.controlMinor !== null && <div><div className="ai3-big" style={{ fontSize: 20, color: BigInt(p.differenceMinor ?? '0') !== 0n ? 'var(--ai3-red)' : 'var(--ai3-green)' }}>{fmt(p.controlMinor, { currency: cur })}</div><div className="ai3-cap">{kind === 'invoice' ? 'Receivables' : 'Payables'} in the opening balances{BigInt(p.differenceMinor ?? '0') !== 0n ? ` · out by ${fmt(p.differenceMinor!, { currency: cur })}` : ' · matches'}</div></div>}
            <div><div className="ai3-big" style={{ fontSize: 20 }}>{fmt(p.postConversionTotalMinor, { currency: cur })}</div><div className="ai3-cap">will post from {p.conversionDate ? dateLong(p.conversionDate) : 'the start'}</div></div>
          </div>
          <div className="ai3-form-row">
            <Field label="Payments came from">
              <select className="ai3-select" value={cash} onChange={(e) => setCash(e.target.value)}><option value="1000">1000 Treasury</option>{banks.map((b) => <option key={b.id} value={b.accountCode}>{b.name}</option>)}</select>
            </Field>
            {kind === 'bill' && <Field label="Lines without an account go to"><AccountSelect accounts={accounts} value={defaultAccount} onChange={setDefaultAccount} types={['expense', 'asset']} /></Field>}
          </div>
          <div style={{ maxHeight: 360, overflow: 'auto' }}>
            <table className="ai3-table">
              <thead><tr><th>Number</th><th>{kind === 'invoice' ? 'Customer' : 'Supplier'}</th><th>Date</th><th>Lines</th><th className="num">Total</th><th className="num">Paid</th><th>Will</th></tr></thead>
              <tbody>{p.rows.map((r, i) => <tr key={i} style={{ opacity: r.skip ? 0.5 : 1 }}><td>{r.number || <span className="muted">assigned</span>}</td><td>{r.contact}</td><td className="muted">{r.date ? dateLong(r.date) : '—'}</td><td className="muted">{r.lines}{r.unknownAccounts.length ? <span className="red"> · unknown account {r.unknownAccounts.join(', ')}</span> : ''}</td><td className="num">{fmt(r.totalMinor, { symbol: false })} {r.currency !== cur ? r.currency : ''}</td><td className="num">{fmt(r.paidMinor, { symbol: false })}</td><td className="muted">{r.skip ? `skip: ${r.skip}` : r.preConversion ? 'record only' : BigInt(r.paidMinor) > 0n ? 'post and pay' : 'post'}</td></tr>)}</tbody>
            </table>
          </div>
          <div className="ai3-actions" style={{ marginTop: 10 }}>
            <button className="ai3-btn primary" disabled={busy || p.toImport === 0} onClick={() => run(async () => { setResult((await doImport({ companyId, parsed: data.parsed, cashAccountCode: cash, defaultAccountCode: defaultAccount })) as typeof result); onDone(); }, `${label} imported`)}>Import {p.toImport}</button>
            <button className="ai3-btn" onClick={() => setData(null)}>Cancel</button>
          </div>
        </>
      )}
      {result && (
        <div>
          <p style={{ margin: 0 }}><strong>{result.created} imported</strong>, {result.skipped} skipped{result.failed.length ? `, ${result.failed.length} failed` : ''}. <a {...nav.linkProps(kind === 'invoice' ? '/ledger?tab=invoices' : '/ledger?tab=bills')}>Open {label.toLowerCase()}</a> · <a href="#" onClick={(e) => { e.preventDefault(); setResult(null); setData(null); setFile(null); }}>Import another file</a></p>
          {result.failed.length > 0 && <ul className="ai3-list" style={{ marginTop: 8 }}>{result.failed.map((f, i) => <li key={i}><span className="l">{f.number || f.contact}</span><span className="r" style={{ color: 'var(--ai3-red)', whiteSpace: 'normal', textAlign: 'right' }}>{f.error}</span></li>)}</ul>}
        </div>
      )}
    </div>
  );
}

export function ImportTab({ companyId, company }: { companyId: string; company: Company | null }) {
  const cur = company?.currency ?? 'USD';
  const settings = usePluginData<{ settings: { conversionDate: string | null } }>('settings', { companyId });
  const banks = usePluginData<{ accounts: BankAccountLite[] }>('bank-accounts', { companyId });
  const chart = useChart(companyId);
  const conversionDate = settings.data?.settings.conversionDate ?? null;
  const refresh = () => { settings.refresh(); chart.refresh(); };
  return (
    <>
      <Header crumb="Import" title="Import from another system" sub="Chart of accounts, then the trial balance as at your conversion date, then the invoices and bills. Every step shows what it read before writing anything." />
      <Failure error={settings.error} />
      <div className="ai3-grid two">
        <ChartImport companyId={companyId} onDone={refresh} />
        <TrialBalanceImport companyId={companyId} cur={cur} conversionDate={conversionDate} onDone={refresh} />
        <DocsImport companyId={companyId} kind="invoice" cur={cur} conversionDate={conversionDate} banks={banks.data?.accounts ?? []} accounts={chart.accounts} onDone={refresh} />
        <DocsImport companyId={companyId} kind="bill" cur={cur} conversionDate={conversionDate} banks={banks.data?.accounts ?? []} accounts={chart.accounts} onDone={refresh} />
      </div>
      <p className="ai3-note">The conversion date is the rule: the trial balance posts as at the day before it, documents dated before it are records whose receivable or payable is already inside the trial balance, and documents from that date on post normally. Bank statements are imported under Bank accounts.</p>
    </>
  );
}

