/**
 * AI3 Ledger — the page inside Paperclip (M5).
 *
 * Four tabs: Position, Transactions, Invoices, Statements. Everything is read
 * through `usePluginData` (worker data providers) and changed through
 * `usePluginAction` (worker actions); the host scopes both to the company the
 * person is looking at, so the page never names a company id itself.
 *
 * React and the SDK UI kit are provided by the host and left external.
 */
import React, { useMemo, useState } from 'react';
import {
  useHostContext,
  useHostNavigation,
  usePluginAction,
  usePluginData,
  usePluginToast,
  MetricCard,
  StatusBadge,
  DataTable,
  Spinner,
  ErrorBoundary,
} from '@paperclipai/plugin-sdk/ui';
import type { PluginPageProps, PluginSidebarProps, StatusBadgeVariant } from '@paperclipai/plugin-sdk/ui';

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

function money(minor: string | number | null | undefined, currency = 'USD'): string {
  if (minor === null || minor === undefined || minor === '') return '—';
  const n = typeof minor === 'number' ? BigInt(Math.trunc(minor)) : BigInt(minor);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const whole = abs / 100n;
  const cents = abs % 100n;
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sym = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : `${currency} `;
  return `${neg ? '−' : ''}${sym}${grouped}.${cents.toString().padStart(2, '0')}`;
}

function day(iso: string | null | undefined): string {
  if (!iso) return '—';
  return iso.slice(0, 10);
}

const invoiceTone: Record<string, StatusBadgeVariant> = {
  draft: 'pending',
  issued: 'info',
  part_paid: 'warning',
  paid: 'ok',
  written_off: 'error',
  void: 'error',
};

// ---------------------------------------------------------------------------
// Types mirrored from the core (kept loose on purpose: the page renders JSON)
// ---------------------------------------------------------------------------

interface Position {
  currency: string | null;
  treasuryMinor: string;
  receivablesMinor: string;
  payablesMinor: string;
  monthToDate: { incomeMinor: string; expenseMinor: string; netMinor: string };
  trailing30d: { expenseMinor: string; dailyBurnMinor: string };
  runwayDays: number | null;
  balanceSheet: { assetsMinor: string; liabilitiesMinor: string; equityMinor: string; retainedMinor: string; balances: boolean };
  trial: { entryCount: number; netMinor: string };
  accounts: Array<{ code: string; name: string; type: string; balanceMinor: string }>;
}

interface Tx {
  id: string;
  occurredAt: string;
  description: string;
  sourceKind: string;
  entries: Array<{ accountCode: string; accountName: string; direction: string; amountMinor: string; subject: { agent?: string } }>;
}

interface Invoice {
  id: string;
  number: string;
  status: string;
  customerName: string;
  customerId: string;
  currency: string;
  issuedAt: string | null;
  dueAt: string | null;
  totalMinor: string;
  paidMinor: string;
  outstandingMinor: string;
}

interface Customer {
  id: string;
  name: string;
  email: string | null;
}

interface Period {
  id: string;
  label: string;
  startsOn: string;
  endsOn: string;
  status: 'open' | 'closed';
}

interface Pnl {
  from: string;
  to: string;
  incomeMinor: string;
  expenseMinor: string;
  netMinor: string;
  lines: Array<{ code: string; name: string; type: string; amountMinor: string }>;
  groups: Array<{ key: string | null; incomeMinor: string; expenseMinor: string; netMinor: string }>;
}

interface BalanceSheet {
  asOf: string;
  assets: { lines: Array<{ code: string; name: string; balanceMinor: string }>; totalMinor: string };
  liabilities: { lines: Array<{ code: string; name: string; balanceMinor: string }>; totalMinor: string };
  equity: { lines: Array<{ code: string; name: string; balanceMinor: string }>; totalMinor: string };
  balances: boolean;
}

// ---------------------------------------------------------------------------
// Small bits
// ---------------------------------------------------------------------------

const box: React.CSSProperties = { border: '1px solid rgba(127,127,127,.25)', borderRadius: 8, padding: '12px 14px' };
const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 };
const label: React.CSSProperties = { fontSize: 12, opacity: 0.7, display: 'block', marginBottom: 4 };
const input: React.CSSProperties = { padding: '6px 8px', border: '1px solid rgba(127,127,127,.35)', borderRadius: 6, background: 'transparent', color: 'inherit', minWidth: 120 };
const btn: React.CSSProperties = { padding: '6px 12px', border: '1px solid rgba(127,127,127,.4)', borderRadius: 6, background: 'transparent', color: 'inherit', cursor: 'pointer' };
const btnPrimary: React.CSSProperties = { ...btn, background: 'rgba(11,110,79,.9)', borderColor: 'transparent', color: '#fff' };

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

function Failure({ error }: { error: { message: string } | null }) {
  if (!error) return null;
  return <div style={{ ...box, borderColor: 'rgba(200,60,40,.5)', marginBottom: 12 }}>{error.message}</div>;
}

function LinesTable({ rows, valueKey, currency }: { rows: Array<{ code: string; name: string; [k: string]: unknown }>; valueKey: string; currency: string }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <tbody>
        {rows.map((r) => (
          <tr key={r.code}>
            <td style={{ padding: '4px 0', opacity: 0.7, width: 60 }}>{r.code}</td>
            <td style={{ padding: '4px 0' }}>{r.name}</td>
            <td style={{ padding: '4px 0', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money(String(r[valueKey] ?? '0'), currency)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function PositionTab({ companyId }: { companyId: string }) {
  const { data, loading, error, refresh } = usePluginData<Position>('position', { companyId });
  const sweep = usePluginAction('sweep');
  const fund = usePluginAction('funding');
  const toast = usePluginToast();
  const [amount, setAmount] = useState('');
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const cur = data?.currency ?? 'USD';

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await fn();
      toast({ title: done, tone: 'success' });
      refresh();
    } catch (err) {
      toast({ title: 'That did not work', body: err instanceof Error ? err.message : String(err), tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  if (loading && !data) return <Spinner />;
  return (
    <div>
      <Failure error={error} />
      {data && (
        <>
          <div style={{ ...grid, marginBottom: 16 }}>
            <MetricCard label="Treasury" value={money(data.treasuryMinor, cur)} />
            <MetricCard label="Burn this month" value={money(data.monthToDate.expenseMinor, cur)} />
            <MetricCard label="Receivables" value={money(data.receivablesMinor, cur)} />
            <MetricCard label="Runway" value={data.runwayDays === null ? 'No burn yet' : `${data.runwayDays} days`} />
          </div>
          <div style={{ ...grid, marginBottom: 16 }}>
            <div style={box}>
              <span style={label}>Month to date</span>
              <div>Income {money(data.monthToDate.incomeMinor, cur)}</div>
              <div>Expenses {money(data.monthToDate.expenseMinor, cur)}</div>
              <div style={{ fontWeight: 600 }}>Net {money(data.monthToDate.netMinor, cur)}</div>
            </div>
            <div style={box}>
              <span style={label}>Trailing 30 days</span>
              <div>Spent {money(data.trailing30d.expenseMinor, cur)}</div>
              <div>Per day {money(data.trailing30d.dailyBurnMinor, cur)}</div>
            </div>
            <div style={box}>
              <span style={label}>Books</span>
              <div>{data.trial.entryCount} entries, net {money(data.trial.netMinor, cur)}</div>
              <div style={{ marginTop: 4 }}>
                <StatusBadge label={data.balanceSheet.balances ? 'Balance sheet balances' : 'Balance sheet does not balance'} status={data.balanceSheet.balances ? 'ok' : 'error'} />
              </div>
            </div>
          </div>
          <Section title="Accounts">
            <LinesTable rows={data.accounts} valueKey="balanceMinor" currency={cur} />
          </Section>
          <Section title="Fund the treasury">
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
              <label>
                <span style={label}>Amount ({cur})</span>
                <input style={input} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1000.00" inputMode="decimal" />
              </label>
              <label>
                <span style={label}>Description</span>
                <input style={input} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Initial float" />
              </label>
              <button
                style={btnPrimary}
                disabled={busy || !/^\d+(\.\d{1,2})?$/.test(amount)}
                onClick={() => run(() => fund({ companyId, amountMinor: toMinor(amount), description: desc || 'Funding' }), 'Funding recorded')}
              >
                Record funding
              </button>
              <button style={btn} disabled={busy} onClick={() => run(() => sweep({ companyId }), 'Costs swept')}>
                Sweep costs now
              </button>
            </div>
            <p style={{ fontSize: 12, opacity: 0.7, marginTop: 8 }}>Funding records money that arrived. Costs are swept from Paperclip every fifteen minutes on their own.</p>
          </Section>
        </>
      )}
    </div>
  );
}

function toMinor(amount: string): string {
  const [w, c = ''] = amount.split('.');
  return `${BigInt(w || '0') * 100n + BigInt((c + '00').slice(0, 2))}`;
}

function TransactionsTab({ companyId }: { companyId: string }) {
  const { data, loading, error } = usePluginData<{ transactions: Tx[] }>('transactions', { companyId, limit: 200 });
  const rows = useMemo(
    () =>
      (data?.transactions ?? []).map((t) => {
        const debit = t.entries.find((e) => e.direction === 'debit');
        const credit = t.entries.find((e) => e.direction === 'credit');
        return {
          id: t.id,
          date: day(t.occurredAt),
          kind: t.sourceKind.replace('_', ' '),
          description: t.description,
          debit: debit ? `${debit.accountCode} ${debit.accountName}` : '',
          credit: credit ? `${credit.accountCode} ${credit.accountName}` : '',
          amount: money(debit?.amountMinor ?? credit?.amountMinor ?? '0'),
          agent: debit?.subject?.agent ? debit.subject.agent.slice(0, 8) : '',
        };
      }),
    [data],
  );
  return (
    <div>
      <Failure error={error} />
      <DataTable
        loading={loading}
        emptyMessage="No transactions yet. Fund the treasury or let the sweep find some costs."
        rows={rows}
        columns={[
          { key: 'date', header: 'Date', width: '100px' },
          { key: 'kind', header: 'Kind', width: '90px' },
          { key: 'description', header: 'Description' },
          { key: 'debit', header: 'Debit' },
          { key: 'credit', header: 'Credit' },
          { key: 'amount', header: 'Amount', width: '110px' },
          { key: 'agent', header: 'Agent', width: '90px' },
        ]}
      />
    </div>
  );
}

function InvoicesTab({ companyId }: { companyId: string }) {
  const invoices = usePluginData<{ invoices: Invoice[] }>('invoices', { companyId });
  const customers = usePluginData<{ customers: Customer[] }>('customers', { companyId });
  const createCustomer = usePluginAction('customer.create');
  const createInvoice = usePluginAction('invoice.create');
  const issue = usePluginAction('invoice.issue');
  const pay = usePluginAction('invoice.payment');
  const writeOff = usePluginAction('invoice.writeoff');
  const toast = usePluginToast();
  const [busy, setBusy] = useState(false);
  const [custName, setCustName] = useState('');
  const [custEmail, setCustEmail] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [lineDesc, setLineDesc] = useState('');
  const [lineAmount, setLineAmount] = useState('');
  const [payAmount, setPayAmount] = useState<Record<string, string>>({});

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await fn();
      toast({ title: done, tone: 'success' });
      invoices.refresh();
      customers.refresh();
    } catch (err) {
      toast({ title: 'That did not work', body: err instanceof Error ? err.message : String(err), tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  const list = invoices.data?.invoices ?? [];
  const custs = customers.data?.customers ?? [];
  return (
    <div>
      <Failure error={invoices.error ?? customers.error} />
      <Section title="Invoices">
        {invoices.loading && !invoices.data ? (
          <Spinner />
        ) : list.length === 0 ? (
          <p style={{ opacity: 0.7 }}>No invoices yet.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', opacity: 0.7 }}>
                <th>Number</th><th>Customer</th><th>Status</th><th>Issued</th><th style={{ textAlign: 'right' }}>Total</th><th style={{ textAlign: 'right' }}>Outstanding</th><th></th>
              </tr>
            </thead>
            <tbody>
              {list.map((inv) => (
                <tr key={inv.id} style={{ borderTop: '1px solid rgba(127,127,127,.2)' }}>
                  <td style={{ padding: '6px 0' }}>{inv.number}</td>
                  <td>{inv.customerName}</td>
                  <td><StatusBadge label={inv.status.replace('_', ' ')} status={invoiceTone[inv.status] ?? 'info'} /></td>
                  <td>{day(inv.issuedAt)}</td>
                  <td style={{ textAlign: 'right' }}>{money(inv.totalMinor, inv.currency)}</td>
                  <td style={{ textAlign: 'right' }}>{money(inv.outstandingMinor, inv.currency)}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {inv.status === 'draft' && (
                      <button style={btnPrimary} disabled={busy} onClick={() => run(() => issue({ companyId, invoiceId: inv.id }), `${inv.number} issued`)}>Issue</button>
                    )}
                    {(inv.status === 'issued' || inv.status === 'part_paid') && (
                      <>
                        <input
                          style={{ ...input, minWidth: 90, marginRight: 6 }}
                          placeholder={money(inv.outstandingMinor, inv.currency).replace(/[^\d.]/g, '')}
                          value={payAmount[inv.id] ?? ''}
                          onChange={(e) => setPayAmount({ ...payAmount, [inv.id]: e.target.value })}
                          inputMode="decimal"
                        />
                        <button
                          style={btnPrimary}
                          disabled={busy}
                          onClick={() => {
                            const raw = payAmount[inv.id] ?? '';
                            const amountMinor = /^\d+(\.\d{1,2})?$/.test(raw) ? toMinor(raw) : inv.outstandingMinor;
                            void run(() => pay({ companyId, invoiceId: inv.id, amountMinor }), `Payment on ${inv.number} recorded`);
                          }}
                        >
                          Record payment
                        </button>{' '}
                        <button style={btn} disabled={busy} onClick={() => run(() => writeOff({ companyId, invoiceId: inv.id }), `${inv.number} written off`)}>Write off</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <div style={grid}>
        <Section title="New customer">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
            <label><span style={label}>Name</span><input style={input} value={custName} onChange={(e) => setCustName(e.target.value)} /></label>
            <label><span style={label}>Email</span><input style={input} value={custEmail} onChange={(e) => setCustEmail(e.target.value)} /></label>
            <button style={btn} disabled={busy || custName.trim().length < 1} onClick={() => run(async () => { await createCustomer({ companyId, name: custName, email: custEmail }); setCustName(''); setCustEmail(''); }, 'Customer added')}>Add</button>
          </div>
        </Section>
        <Section title="New draft invoice">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
            <label>
              <span style={label}>Customer</span>
              <select style={input} value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                <option value="">Choose…</option>
                {custs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label><span style={label}>Line</span><input style={input} value={lineDesc} onChange={(e) => setLineDesc(e.target.value)} placeholder="What was done" /></label>
            <label><span style={label}>Amount</span><input style={input} value={lineAmount} onChange={(e) => setLineAmount(e.target.value)} placeholder="250.00" inputMode="decimal" /></label>
            <button
              style={btn}
              disabled={busy || !customerId || !lineDesc.trim() || !/^\d+(\.\d{1,2})?$/.test(lineAmount)}
              onClick={() => run(async () => { await createInvoice({ companyId, customerId, lines: [{ description: lineDesc, unitAmountMinor: toMinor(lineAmount) }] }); setLineDesc(''); setLineAmount(''); }, 'Draft created')}
            >
              Create draft
            </button>
          </div>
          <p style={{ fontSize: 12, opacity: 0.7, marginTop: 8 }}>A draft changes nothing until you issue it. Issuing books the receivable and the income on that day.</p>
        </Section>
      </div>
    </div>
  );
}

function StatementsTab({ companyId }: { companyId: string }) {
  const periods = usePluginData<{ periods: Period[] }>('periods', { companyId });
  const [periodId, setPeriodId] = useState('');
  const [groupBy, setGroupBy] = useState('');
  const [asOf, setAsOf] = useState('');
  const now = new Date();
  const thisMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const pnl = usePluginData<Pnl>('pnl', { companyId, ...(periodId ? { periodId } : {}), ...(groupBy ? { groupBy } : {}) });
  const sheet = usePluginData<BalanceSheet>('balance-sheet', { companyId, ...(asOf ? { asOf: `${asOf}T23:59:59.999Z` } : {}) });
  const createPeriod = usePluginAction('period.create');
  const closePeriod = usePluginAction('period.close');
  const toast = usePluginToast();
  const [month, setMonth] = useState(thisMonth);
  const [busy, setBusy] = useState(false);
  const cur = 'USD';

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await fn();
      toast({ title: done, tone: 'success' });
      periods.refresh();
      pnl.refresh();
    } catch (err) {
      toast({ title: 'That did not work', body: err instanceof Error ? err.message : String(err), tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  const list = periods.data?.periods ?? [];
  const selected = list.find((p) => p.id === periodId);
  return (
    <div>
      <Failure error={periods.error ?? pnl.error ?? sheet.error} />
      <Section
        title="Profit and loss"
        right={
          <div style={{ display: 'flex', gap: 8 }}>
            <select style={input} value={periodId} onChange={(e) => setPeriodId(e.target.value)}>
              <option value="">This month so far</option>
              {list.map((p) => <option key={p.id} value={p.id}>{p.label}{p.status === 'closed' ? ' (closed)' : ''}</option>)}
            </select>
            <select style={input} value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
              <option value="">Whole company</option>
              <option value="agent">By agent</option>
              <option value="project">By project</option>
              <option value="goal">By goal</option>
            </select>
          </div>
        }
      >
        {pnl.loading && !pnl.data ? (
          <Spinner />
        ) : pnl.data ? (
          <div style={grid}>
            <div style={box}>
              <span style={label}>{day(pnl.data.from)} to {day(pnl.data.to)}</span>
              <div>Income {money(pnl.data.incomeMinor, cur)}</div>
              <div>Expenses {money(pnl.data.expenseMinor, cur)}</div>
              <div style={{ fontWeight: 600 }}>Net {money(pnl.data.netMinor, cur)}</div>
            </div>
            <div style={box}>
              <span style={label}>By account</span>
              {pnl.data.lines.length === 0 ? <div style={{ opacity: 0.7 }}>Nothing in this window.</div> : <LinesTable rows={pnl.data.lines} valueKey="amountMinor" currency={cur} />}
            </div>
            {groupBy && (
              <div style={box}>
                <span style={label}>By {groupBy}</span>
                {pnl.data.groups.map((g) => (
                  <div key={g.key ?? 'none'} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <span>{g.key ? g.key.slice(0, 8) : 'unattributed'}</span>
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>{money(g.netMinor, cur)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}
        {selected && selected.status === 'open' && (
          <p style={{ marginTop: 8 }}>
            <button style={btn} disabled={busy} onClick={() => run(() => closePeriod({ companyId, periodId: selected.id }), `${selected.label} closed`)}>Close {selected.label}</button>
            <span style={{ fontSize: 12, opacity: 0.7, marginLeft: 8 }}>Closing locks it: nothing dated inside can be posted afterwards.</span>
          </p>
        )}
      </Section>

      <Section
        title="Balance sheet"
        right={<input type="date" style={input} value={asOf} onChange={(e) => setAsOf(e.target.value)} />}
      >
        {sheet.loading && !sheet.data ? (
          <Spinner />
        ) : sheet.data ? (
          <div style={grid}>
            <div style={box}><span style={label}>Assets · {money(sheet.data.assets.totalMinor, cur)}</span><LinesTable rows={sheet.data.assets.lines} valueKey="balanceMinor" currency={cur} /></div>
            <div style={box}><span style={label}>Liabilities · {money(sheet.data.liabilities.totalMinor, cur)}</span><LinesTable rows={sheet.data.liabilities.lines} valueKey="balanceMinor" currency={cur} /></div>
            <div style={box}><span style={label}>Equity · {money(sheet.data.equity.totalMinor, cur)}</span><LinesTable rows={sheet.data.equity.lines} valueKey="balanceMinor" currency={cur} /></div>
            <div style={box}>
              <span style={label}>As of {day(sheet.data.asOf)}</span>
              <StatusBadge label={sheet.data.balances ? 'Balances' : 'Does not balance'} status={sheet.data.balances ? 'ok' : 'error'} />
            </div>
          </div>
        ) : null}
      </Section>

      <Section title="Periods">
        {list.length === 0 ? <p style={{ opacity: 0.7 }}>No periods yet. Create the current month to be able to close it later.</p> : (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {list.map((p) => <li key={p.id}>{p.label} <StatusBadge label={p.status} status={p.status === 'closed' ? 'ok' : 'pending'} /></li>)}
          </ul>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'end', marginTop: 8 }}>
          <label><span style={label}>Month</span><input type="month" style={input} value={month} onChange={(e) => setMonth(e.target.value)} /></label>
          <button style={btn} disabled={busy || !/^\d{4}-\d{2}$/.test(month)} onClick={() => run(() => createPeriod({ companyId, month }), `${month} created`)}>Create month</button>
        </div>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page + sidebar
// ---------------------------------------------------------------------------

const TABS = ['Position', 'Transactions', 'Invoices', 'Statements'] as const;

export function LedgerPage(_props: PluginPageProps) {
  const context = useHostContext();
  const [tab, setTab] = useState<(typeof TABS)[number]>('Position');
  const companyId = context.companyId;
  if (!companyId) return <div style={{ padding: 16 }}>Pick a company to see its ledger.</div>;
  return (
    <ErrorBoundary>
      <div style={{ padding: 16, maxWidth: 1100 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Ledger</h2>
          <nav style={{ display: 'flex', gap: 4 }}>
            {TABS.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                style={{ ...btn, borderColor: tab === t ? 'rgba(11,110,79,.9)' : 'rgba(127,127,127,.3)', fontWeight: tab === t ? 600 : 400 }}
              >
                {t}
              </button>
            ))}
          </nav>
        </div>
        {tab === 'Position' && <PositionTab companyId={companyId} />}
        {tab === 'Transactions' && <TransactionsTab companyId={companyId} />}
        {tab === 'Invoices' && <InvoicesTab companyId={companyId} />}
        {tab === 'Statements' && <StatementsTab companyId={companyId} />}
        <p style={{ fontSize: 11, opacity: 0.55, marginTop: 24 }}>AI3 Ledger · double-entry, append-only, integer minor units. Costs come from Paperclip; nothing here is re-derived.</p>
      </div>
    </ErrorBoundary>
  );
}

export function LedgerSidebarItem(_props: PluginSidebarProps) {
  const nav = useHostNavigation();
  return (
    <a {...nav.linkProps('/ledger')} style={{ display: 'block', padding: '6px 10px', textDecoration: 'none', color: 'inherit' }}>
      Ledger
    </a>
  );
}
