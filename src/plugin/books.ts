/**
 * Page data and actions for the books proper: journals, the trial balance,
 * the drill-down from a report figure to entries, transactions and their
 * sources, suppliers and bills with their documents, and imports from another
 * system. Registered from the worker in one call so the worker stays readable.
 */
import type { PluginContext } from '@paperclipai/plugin-sdk';
import {
  LedgerError,
  accountBalances,
  addDocument,
  approveBill,
  createBill,
  createJournal,
  createSupplier,
  deleteBill,
  deleteJournal,
  documentCounts,
  getBill,
  getJournal,
  getSettings,
  getTransaction,
  importChart,
  importDocuments,
  importTrialBalance,
  journalForTransaction,
  linkDocument,
  listBills,
  listDocumentsFor,
  listEntries,
  listJournals,
  listSuppliers,
  parseChartCsv,
  parseDocumentsCsv,
  parseTrialBalanceCsv,
  payBill,
  postJournal,
  previewDocuments,
  readDocument,
  resolveSupplier,
  trialBalanceReport,
  undoTrialBalance,
  unlinkDocument,
  updateBill,
  updateJournal,
  updateSupplier,
  voidBill,
  voidJournal,
  type AccountType,
  type BillStatus,
  type DocumentTarget,
  type EntryFilter,
  type JournalStatus,
  type LedgerDb,
  type ParsedDocs,
  type SourceKind,
} from '../core/index.js';
import { ai3Call, isConnected, type FetchLike } from './ai3.js';
import { bankLinksFor, describeSource } from './sources.js';

export interface BooksDeps {
  ledger: () => LedgerDb;
  companyOf: (params: Record<string, unknown>) => Promise<string>;
  boardOnly: (ctx: { actor: { type: string; userId: string | null } }) => string;
  httpFetch: FetchLike;
  currency: string;
}

const DOC_TARGETS: DocumentTarget[] = ['bill', 'invoice', 'journal', 'transaction', 'statement_line', 'supplier', 'customer'];
const ACCOUNT_TYPES: AccountType[] = ['asset', 'liability', 'equity', 'income', 'expense'];

function s(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function linesOf(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
}

export interface ExtractedBill {
  supplier: string | null;
  supplierEmail: string | null;
  number: string | null;
  date: string | null;
  dueDate: string | null;
  currency: string | null;
  subtotal: string | null;
  tax: string | null;
  total: string | null;
  lines: Array<{ description: string; quantity: string; unitAmount: string; tax: string }>;
  confidence: number;
  notes: string | null;
  source: string;
}

/** Ask ai3.co to read a supplier's PDF or image into bill fields. Needs the company key. */
export async function extractBill(fetch: FetchLike, db: LedgerDb, companyId: string, currency: string, file: { filename: string; mime: string; contentBase64: string }): Promise<ExtractedBill> {
  const settings = await getSettings(db, companyId, currency);
  if (!isConnected(settings)) throw new Error('Reading a bill needs the ai3.co connection. Add the company key under Finance › Settings, or fill the bill in by hand with the file attached.');
  const r = (await ai3Call(fetch, settings, '/api/ledger/extract', { companyId, kind: 'bill', filename: file.filename, mime: file.mime, contentBase64: file.contentBase64 })) as Partial<ExtractedBill>;
  return {
    supplier: r.supplier ?? null,
    supplierEmail: r.supplierEmail ?? null,
    number: r.number ?? null,
    date: r.date ?? null,
    dueDate: r.dueDate ?? null,
    currency: r.currency ?? null,
    subtotal: r.subtotal ?? null,
    tax: r.tax ?? null,
    total: r.total ?? null,
    lines: Array.isArray(r.lines) ? r.lines : [],
    confidence: Number(r.confidence ?? 0),
    notes: r.notes ?? null,
    source: String(r.source ?? 'ai3.co'),
  };
}

export function registerBooks(context: PluginContext, deps: BooksDeps): void {
  const { ledger, companyOf, boardOnly } = deps;

  // ---- Chart, journals, trial balance -------------------------------------
  context.data.register('chart', async (params) => {
    const companyId = await companyOf(params);
    const rows = await accountBalances(ledger(), companyId);
    return { companyId, accounts: rows.map((a) => ({ code: a.code, name: a.name, type: a.type, currency: a.currency, balanceMinor: a.balanceMinor.toString(), parentId: a.parentId, accountId: a.accountId })) };
  });
  context.data.register('journals', async (params) => {
    const companyId = await companyOf(params);
    const status = s(params['status']) as JournalStatus | undefined;
    return { companyId, journals: await listJournals(ledger(), companyId, status ? { status } : {}) };
  });
  context.data.register('journal', async (params) => {
    const companyId = await companyOf(params);
    const j = await getJournal(ledger(), companyId, String(params['journalId'] ?? ''));
    if (!j) throw new Error('Journal not found');
    return { ...j, documents: await listDocumentsFor(ledger(), companyId, 'journal', j.id) };
  });
  context.data.register('trial-balance', async (params) => {
    const companyId = await companyOf(params);
    return trialBalanceReport(ledger(), companyId, s(params['asOf']) ?? new Date(), s(params['from']));
  });

  // ---- Drill-down ------------------------------------------------------------
  context.data.register('entries', async (params) => {
    const companyId = await companyOf(params);
    const filter: EntryFilter = {};
    if (s(params['accountCode'])) filter.accountCode = s(params['accountCode'])!;
    if (s(params['accountType']) && (ACCOUNT_TYPES as string[]).includes(s(params['accountType'])!)) filter.accountType = s(params['accountType']) as AccountType;
    if (params['withChildren'] === true) filter.withChildren = true;
    if (s(params['from'])) filter.from = s(params['from'])!;
    if (s(params['to'])) filter.to = s(params['to'])!;
    const g = s(params['groupBy']);
    if (g === 'agent' || g === 'project' || g === 'goal') {
      filter.groupBy = g;
      filter.groupKey = typeof params['groupKey'] === 'string' && params['groupKey'] ? params['groupKey'] : null;
    }
    if (s(params['sourceKind'])) filter.sourceKind = s(params['sourceKind']) as SourceKind;
    const limit = Number(params['limit'] ?? 500);
    if (Number.isFinite(limit)) filter.limit = limit;
    return listEntries(ledger(), companyId, filter);
  });
  context.data.register('transaction', async (params) => {
    const companyId = await companyOf(params);
    const tx = await getTransaction(ledger(), companyId, String(params['transactionId'] ?? ''));
    if (!tx) throw new Error('Transaction not found');
    const source = await describeSource(ledger(), companyId, tx);
    const bankLinks = await bankLinksFor(ledger(), companyId, tx.id);
    const documents = await listDocumentsFor(ledger(), companyId, 'transaction', tx.id);
    if (source.kind === 'bill') documents.push(...(await listDocumentsFor(ledger(), companyId, 'bill', source.billId)));
    if (source.kind === 'invoice') documents.push(...(await listDocumentsFor(ledger(), companyId, 'invoice', source.invoiceId)));
    if (source.kind === 'journal') documents.push(...(await listDocumentsFor(ledger(), companyId, 'journal', source.journalId)));
    const reverses = tx.reversesId ? await getTransaction(ledger(), companyId, tx.reversesId) : null;
    const reversedBy = tx.reversedBy ? await getTransaction(ledger(), companyId, tx.reversedBy) : null;
    const reversalOf = reverses ? await describeSource(ledger(), companyId, reverses) : null;
    let agentName: string | null = null;
    if (source.kind === 'cost' && source.event.agentId) {
      try {
        const a = await context.agents.get(source.event.agentId, companyId);
        agentName = a?.name ?? null;
      } catch { agentName = null; }
    }
    return { ...tx, source, reversalOf, reverses: reverses ? { id: reverses.id, description: reverses.description, occurredAt: reverses.occurredAt } : null, reversedBy: reversedBy ? { id: reversedBy.id, description: reversedBy.description, occurredAt: reversedBy.occurredAt } : null, bankLinks, documents, agentName };
  });

  // ---- Suppliers, bills, documents -------------------------------------------
  context.data.register('suppliers', async (params) => {
    const companyId = await companyOf(params);
    return { companyId, suppliers: await listSuppliers(ledger(), companyId) };
  });
  context.data.register('bills', async (params) => {
    const companyId = await companyOf(params);
    const status = s(params['status']) as BillStatus | undefined;
    const bills = await listBills(ledger(), companyId, { ...(status ? { status } : {}), limit: 500 });
    const docs = await documentCounts(ledger(), companyId, 'bill', bills.map((b) => b.id));
    return { companyId, bills: bills.map((b) => ({ ...b, documents: docs.get(b.id) ?? 0 })) };
  });
  context.data.register('bill', async (params) => {
    const companyId = await companyOf(params);
    const b = await getBill(ledger(), companyId, String(params['billId'] ?? ''));
    if (!b) throw new Error('Bill not found');
    return { ...b, documents: await listDocumentsFor(ledger(), companyId, 'bill', b.id) };
  });
  context.data.register('documents', async (params) => {
    const companyId = await companyOf(params);
    const kind = s(params['targetKind']) as DocumentTarget | undefined;
    if (!kind || !DOC_TARGETS.includes(kind)) throw new Error('targetKind is required');
    return { companyId, documents: await listDocumentsFor(ledger(), companyId, kind, String(params['targetId'] ?? '')) };
  });
  context.data.register('document', async (params) => {
    const companyId = await companyOf(params);
    const d = await readDocument(ledger(), companyId, String(params['documentId'] ?? ''));
    if (!d) throw new Error('Document not found');
    return { ...d.meta, contentBase64: d.contentBase64 };
  });

  // ---- Actions: journals -----------------------------------------------------
  const journalLines = (v: unknown) => linesOf(v).map((l) => ({
    accountCode: String(l['accountCode'] ?? ''),
    direction: (l['direction'] === 'credit' ? 'credit' : 'debit') as 'debit' | 'credit',
    amountMinor: String(l['amountMinor'] ?? ''),
    description: s(l['description']) ?? null,
    ...(s(l['agentRef']) ? { subject: { agent: s(l['agentRef'])! } } : {}),
  }));
  context.actions.register('journal.create', async (params, ctx) => {
    const by = boardOnly(ctx);
    const companyId = await companyOf(params);
    return createJournal(ledger(), companyId, { occurredAt: s(params['occurredAt']) ?? new Date().toISOString(), narration: s(params['narration']) ?? null, lines: journalLines(params['lines']), createdBy: by, post: params['post'] === true });
  });
  context.actions.register('journal.update', async (params, ctx) => {
    boardOnly(ctx);
    const companyId = await companyOf(params);
    return updateJournal(ledger(), companyId, String(params['journalId'] ?? ''), {
      ...(s(params['occurredAt']) ? { occurredAt: s(params['occurredAt'])! } : {}),
      ...(params['narration'] !== undefined ? { narration: s(params['narration']) ?? '' } : {}),
      ...(Array.isArray(params['lines']) ? { lines: journalLines(params['lines']) } : {}),
    });
  });
  context.actions.register('journal.post', async (params, ctx) => {
    const by = boardOnly(ctx);
    return postJournal(ledger(), await companyOf(params), String(params['journalId'] ?? ''), { createdBy: by });
  });
  context.actions.register('journal.void', async (params, ctx) => {
    const by = boardOnly(ctx);
    return voidJournal(ledger(), await companyOf(params), String(params['journalId'] ?? ''), { createdBy: by, ...(s(params['reason']) ? { reason: s(params['reason'])! } : {}) });
  });
  context.actions.register('journal.delete', async (params, ctx) => {
    boardOnly(ctx);
    return deleteJournal(ledger(), await companyOf(params), String(params['journalId'] ?? ''));
  });

  // ---- Actions: suppliers and bills ------------------------------------------
  context.actions.register('supplier.create', async (params, ctx) => {
    boardOnly(ctx);
    return createSupplier(ledger(), await companyOf(params), { name: String(params['name'] ?? ''), email: s(params['email']) ?? null, defaultAccountCode: s(params['defaultAccountCode']) ?? null });
  });
  context.actions.register('supplier.update', async (params, ctx) => {
    boardOnly(ctx);
    return updateSupplier(ledger(), await companyOf(params), String(params['supplierId'] ?? ''), {
      ...(s(params['name']) ? { name: s(params['name'])! } : {}),
      ...(params['email'] !== undefined ? { email: s(params['email']) ?? null } : {}),
      ...(params['defaultAccountCode'] !== undefined ? { defaultAccountCode: s(params['defaultAccountCode']) ?? null } : {}),
    });
  });
  const billLines = (v: unknown) => linesOf(v).map((l) => ({
    description: String(l['description'] ?? ''),
    quantity: typeof l['quantity'] === 'number' || typeof l['quantity'] === 'string' ? l['quantity'] : 1,
    unitAmountMinor: String(l['unitAmountMinor'] ?? ''),
    taxMinor: s(l['taxMinor']) ?? null,
    accountCode: s(l['accountCode']) ?? null,
  }));
  context.actions.register('bill.create', async (params, ctx) => {
    const by = boardOnly(ctx);
    const companyId = await companyOf(params);
    let supplierId = s(params['supplierId']);
    if (!supplierId && s(params['supplierName'])) {
      const sup = await resolveSupplier(ledger(), companyId, s(params['supplierName'])!, { create: true, email: s(params['supplierEmail']) ?? null });
      supplierId = sup?.id;
    }
    const bill = await createBill(ledger(), companyId, {
      supplierId: supplierId ?? '',
      currency: s(params['currency']) ?? null,
      rateToBase: s(params['rateToBase']) ?? null,
      issuedAt: s(params['issuedAt']) ?? null,
      dueAt: s(params['dueAt']) ?? null,
      reference: s(params['reference']) ?? null,
      notes: s(params['notes']) ?? null,
      lines: billLines(params['lines']),
      createdBy: by,
    });
    if (s(params['documentId'])) await addLink(ledger(), companyId, s(params['documentId'])!, 'bill', bill.id);
    if (params['approve'] === true) return approveBill(ledger(), companyId, bill.id, { createdBy: by });
    return getBill(ledger(), companyId, bill.id);
  });
  context.actions.register('bill.update', async (params, ctx) => {
    boardOnly(ctx);
    return updateBill(ledger(), await companyOf(params), String(params['billId'] ?? ''), {
      ...(s(params['supplierId']) ? { supplierId: s(params['supplierId'])! } : {}),
      ...(params['issuedAt'] !== undefined ? { issuedAt: s(params['issuedAt']) ?? null } : {}),
      ...(params['dueAt'] !== undefined ? { dueAt: s(params['dueAt']) ?? null } : {}),
      ...(params['reference'] !== undefined ? { reference: s(params['reference']) ?? null } : {}),
      ...(params['notes'] !== undefined ? { notes: s(params['notes']) ?? null } : {}),
      ...(Array.isArray(params['lines']) ? { lines: billLines(params['lines']) } : {}),
      ...(params['currency'] !== undefined ? { currency: s(params['currency']) ?? null } : {}),
      ...(params['rateToBase'] !== undefined ? { rateToBase: s(params['rateToBase']) ?? null } : {}),
    });
  });
  context.actions.register('bill.approve', async (params, ctx) => {
    const by = boardOnly(ctx);
    return approveBill(ledger(), await companyOf(params), String(params['billId'] ?? ''), { createdBy: by, ...(s(params['approvedAt']) ? { approvedAt: s(params['approvedAt'])! } : {}) });
  });
  context.actions.register('bill.pay', async (params, ctx) => {
    const by = boardOnly(ctx);
    return payBill(ledger(), await companyOf(params), String(params['billId'] ?? ''), {
      amountMinor: s(params['amountMinor']) ?? null,
      reference: s(params['reference']) ?? null,
      cashAccountCode: s(params['cashAccountCode']) ?? null,
      rateToBase: s(params['rateToBase']) ?? null,
      createdBy: by,
      ...(s(params['occurredAt']) ? { occurredAt: s(params['occurredAt'])! } : {}),
    });
  });
  context.actions.register('bill.void', async (params, ctx) => {
    const by = boardOnly(ctx);
    return voidBill(ledger(), await companyOf(params), String(params['billId'] ?? ''), { createdBy: by, ...(s(params['reason']) ? { reason: s(params['reason'])! } : {}) });
  });
  context.actions.register('bill.delete', async (params, ctx) => {
    boardOnly(ctx);
    return deleteBill(ledger(), await companyOf(params), String(params['billId'] ?? ''));
  });
  // Read a supplier's PDF or photo into bill fields. The file itself is stored first so nothing is lost if reading fails.
  context.actions.register('bill.extract', async (params, ctx) => {
    const by = boardOnly(ctx);
    const companyId = await companyOf(params);
    const file = { filename: String(params['filename'] ?? 'bill.pdf'), mime: String(params['mime'] ?? 'application/pdf'), contentBase64: String(params['contentBase64'] ?? '') };
    const doc = await addDocument(ledger(), companyId, { ...file, uploadedBy: by, kind: 'bill' });
    try {
      const fields = await extractBill(deps.httpFetch, ledger(), companyId, deps.currency, file);
      return { document: doc, fields, error: null };
    } catch (err) {
      return { document: doc, fields: null, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ---- Actions: documents ----------------------------------------------------
  context.actions.register('document.add', async (params, ctx) => {
    const by = boardOnly(ctx);
    const companyId = await companyOf(params);
    const kind = s(params['targetKind']) as DocumentTarget | undefined;
    return addDocument(ledger(), companyId, {
      filename: String(params['filename'] ?? 'document'),
      mime: String(params['mime'] ?? 'application/octet-stream'),
      contentBase64: String(params['contentBase64'] ?? ''),
      uploadedBy: by,
      ...(s(params['kind']) ? { kind: s(params['kind'])! } : {}),
      link: kind && DOC_TARGETS.includes(kind) && s(params['targetId']) ? { targetKind: kind, targetId: s(params['targetId'])! } : null,
    });
  });
  // Reading bytes is an action so the page can fetch a file on click rather than on render.
  context.actions.register('document.read', async (params, ctx) => {
    boardOnly(ctx);
    const companyId = await companyOf(params);
    const d = await readDocument(ledger(), companyId, String(params['documentId'] ?? ''));
    if (!d) throw new Error('Document not found');
    return { ...d.meta, contentBase64: d.contentBase64 };
  });
  context.actions.register('document.link', async (params, ctx) => {
    boardOnly(ctx);
    const companyId = await companyOf(params);
    const kind = s(params['targetKind']) as DocumentTarget | undefined;
    if (!kind || !DOC_TARGETS.includes(kind)) throw new Error('targetKind is required');
    await addLink(ledger(), companyId, String(params['documentId'] ?? ''), kind, String(params['targetId'] ?? ''));
    return { ok: true };
  });
  context.actions.register('document.unlink', async (params, ctx) => {
    boardOnly(ctx);
    const companyId = await companyOf(params);
    const kind = s(params['targetKind']) as DocumentTarget | undefined;
    if (!kind || !DOC_TARGETS.includes(kind)) throw new Error('targetKind is required');
    await unlinkDocument(ledger(), companyId, String(params['documentId'] ?? ''), kind, String(params['targetId'] ?? ''));
    return { ok: true };
  });

  // ---- Actions: imports -----------------------------------------------------
  // Reading a file is an action (it carries the file); nothing is written until the matching import action.
  const content = (params: Record<string, unknown>): string => {
    const c = String(params['content'] ?? '');
    if (!c.trim()) throw new Error('The file is empty');
    if (c.length > 4_000_000) throw new Error('Files up to 4 MB');
    return c;
  };
  context.actions.register('import.read-chart', async (params, ctx) => {
    boardOnly(ctx);
    await companyOf(params);
    return parseChartCsv(content(params));
  });
  context.actions.register('import.read-trial-balance', async (params, ctx) => {
    boardOnly(ctx);
    const companyId = await companyOf(params);
    const parsed = parseTrialBalanceCsv(content(params));
    // Types from the chart already in the books win over guesses.
    const known = new Map((await accountBalances(ledger(), companyId)).map((a) => [a.code, a]));
    const lines = parsed.lines.map((l) => (known.has(l.code) ? { ...l, name: known.get(l.code)!.name, type: known.get(l.code)!.type, guessed: false } : l));
    const settings = await getSettings(ledger(), companyId, deps.currency);
    return { ...parsed, lines, existingConversionDate: settings.conversionDate, guessed: lines.filter((l) => l.guessed).length };
  });
  context.actions.register('import.chart', async (params, ctx) => {
    boardOnly(ctx);
    const companyId = await companyOf(params);
    const lines = linesOf(params['lines']).map((l) => ({ code: String(l['code'] ?? ''), name: String(l['name'] ?? ''), type: String(l['type'] ?? '') as AccountType }));
    return importChart(ledger(), companyId, lines);
  });
  context.actions.register('import.trial-balance', async (params, ctx) => {
    const by = boardOnly(ctx);
    const companyId = await companyOf(params);
    const lines = linesOf(params['lines']).map((l) => ({
      code: String(l['code'] ?? ''),
      name: String(l['name'] ?? ''),
      ...(s(l['type']) && (ACCOUNT_TYPES as string[]).includes(s(l['type'])!) ? { type: s(l['type']) as AccountType } : {}),
      debitMinor: String(l['debitMinor'] ?? '0'),
      creditMinor: String(l['creditMinor'] ?? '0'),
    }));
    return importTrialBalance(ledger(), companyId, { conversionDate: String(params['conversionDate'] ?? ''), lines, createdBy: by, plugToRetainedEarnings: params['plugToRetainedEarnings'] === true });
  });
  context.actions.register('import.undo-trial-balance', async (params, ctx) => {
    const by = boardOnly(ctx);
    const r = await undoTrialBalance(ledger(), await companyOf(params), { createdBy: by });
    if (!r) throw new Error('There are no standing opening balances to undo');
    return r;
  });
  context.actions.register('import.read-documents', async (params, ctx) => {
    boardOnly(ctx);
    const companyId = await companyOf(params);
    const kind = params['kind'] === 'bill' ? 'bill' : 'invoice';
    const parsed = parseDocumentsCsv(content(params), kind);
    const preview = await previewDocuments(ledger(), companyId, parsed, { conversionDate: s(params['conversionDate']) ?? null });
    return { parsed, preview };
  });
  context.actions.register('import.documents', async (params, ctx) => {
    const by = boardOnly(ctx);
    const companyId = await companyOf(params);
    const parsed = params['parsed'] as ParsedDocs | undefined;
    if (!parsed || !Array.isArray(parsed.docs) || (parsed.kind !== 'invoice' && parsed.kind !== 'bill')) throw new Error('Read the file first');
    const rates = params['rateToBase'] && typeof params['rateToBase'] === 'object' ? (params['rateToBase'] as Record<string, string>) : {};
    try {
      return await importDocuments(ledger(), companyId, parsed, { conversionDate: s(params['conversionDate']) ?? null, cashAccountCode: s(params['cashAccountCode']) ?? null, defaultAccountCode: s(params['defaultAccountCode']) ?? null, createdBy: by, rateToBase: rates });
    } catch (err) {
      if (err instanceof LedgerError) throw new Error(err.message);
      throw err;
    }
  });
  context.data.register('journal-for-transaction', async (params) => {
    const companyId = await companyOf(params);
    return journalForTransaction(ledger(), companyId, String(params['transactionId'] ?? ''));
  });
}

async function addLink(db: LedgerDb, companyId: string, documentId: string, kind: DocumentTarget, targetId: string): Promise<void> {
  await linkDocument(db, companyId, documentId, kind, targetId);
}
