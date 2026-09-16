export type { SqlClient, LedgerDb, Minor, PostingMode } from './sql.js';
export { table, toMinor, fromMinor, toIso, newId, assertPositiveMinor, assertCurrency } from './sql.js';

export type { AccountType, SeedAccount, AccountCode, AccountRole, ChartVersion } from './accounts.js';
export { ACCOUNT, CHARTS, CHART_VERSIONS, CURRENT_CHART, SEED_ACCOUNTS, codeFor, isRole, normalSide, rolesOf } from './accounts.js';

export type {
  Direction,
  SourceKind,
  Subject,
  EntryInput,
  PostInput,
  PostResult,
  AccountBalance,
  TransactionRow,
  ListTransactionsOptions,
  EntryFilter,
  EntryRow,
  EntryList,
} from './ledger.js';
export {
  LedgerError,
  validatePost,
  seedAccounts,
  resolveCode,
  resolveLineAccounts,
  accountsOf,
  chartVersionOf,
  forgetChartVersions,
  postTransaction,
  postReversal,
  cleanupPending,
  accountBalances,
  trialBalance,
  balanceOf,
  listTransactions,
  listEntries,
  getTransaction,
} from './ledger.js';

export type { CostCategory, CostRecord, CostCursor, CostBatch, CostSource } from './adapter.js';
export { expenseAccountFor } from './adapter.js';

export type { SweepOptions, SweepResult } from './sweep.js';
export { sweepCosts, readCursor, writeCursor } from './sweep.js';

export type { Position, PositionAccount } from './position.js';
export { position } from './position.js';

export type { Customer, Invoice, InvoiceLine, InvoiceLineInput, InvoiceStatus, CreateInvoiceInput } from './invoices.js';
export {
  createCustomer,
  getCustomer,
  listCustomers,
  createInvoice,
  getInvoice,
  listInvoices,
  issueInvoice,
  recordPayment,
  creditInvoice, writeOffInvoice,
  voidInvoice,
  receivablesOutstanding,
} from './invoices.js';

export type { Period } from './periods.js';
export { listPeriods, getPeriod, createPeriod, ensureMonth, closePeriod, monthBounds } from './periods.js';

export type { GroupBy, PnlLine, PnlGroup, ProfitAndLoss, BalanceSheet, BalanceSheetLine, TrialBalanceLine, TrialBalanceReport } from './reports.js';
export { profitAndLoss, balanceSheet, trialBalanceReport } from './reports.js';

export type { Journal, JournalLine, JournalLineInput, JournalStatus, CreateJournalInput } from './journals.js';
export { createJournal, updateJournal, postJournal, voidJournal, deleteJournal, getJournal, listJournals, journalForTransaction } from './journals.js';

export type { ParsedLine, ParsedStatement, DateOrder } from './statements.js';
export { parseStatement, parseCsvStatement, parseOfxStatement, parseMoney, parseDate, detectDateOrder, StatementError } from './statements.js';

export type { BankAccount, BankKind, BankFeed, StatementLine, LineStatus, Proposal, Decision, ImportResult } from './banks.js';
export { listBankAccounts, getBankAccount, createBankAccount, importStatementLines, listStatementLines, getStatementLine, saveProposal, dedupeKey } from './banks.js';

export type { ApplyResult, RunResult, RunSummary, BankRule } from './reconcile.js';
export { propose, apply as applyDecision, run as runReconciliation, decisionOf, listRules, setRuleEnabled, lastRun, payeeKey } from './reconcile.js';

export type { FeedProvider, FeedInstitution } from './feeds.js';
export { FEED_INSTITUTIONS, searchInstitutions, providerFor } from './feeds.js';

export type { CompanySettings, PaymentKind, PaymentDetails, PaymentMethod, PaymentInstruction } from './settings.js';
export { getSettings, updateSettings, markSummaryPublished, listPaymentMethods, createPaymentMethod, updatePaymentMethod, paymentInstructionsFor, MIN_AUTO_THRESHOLD, MAX_AUTO_THRESHOLD } from './settings.js';
export type { CompanySummary, SummaryWindow } from './summary.js';
export { companySummary } from './summary.js';
export type { InvoicePayment } from './invoices.js';
export { parseRate, toBase, setInvoicePaymentMethods } from './invoices.js';

export type { RateQuote, FetchLike } from './rates.js';
export { getRate, isCrypto, clearRateCache, RateError } from './rates.js';
export { setInvoiceHosted, markInvoiceSent, markInvoiceOpened, markInvoiceReminded } from './invoices.js';
export { REMINDER_DAYS, dueReminders, reminderEmail, type DueReminder } from './reminders.js';
export type { CompanyWallet, Dispute, DisputeRole } from './wallets.js';
export { getWallet, saveWallet, getChainCursor, setChainCursor, createDispute, updateDispute, listDisputes, getDispute } from './wallets.js';
export { findTransactionBySourceRef } from './ledger.js';

export type { Supplier, Bill, BillLine, BillLineInput, BillPayment, BillStatus, CreateBillInput } from './bills.js';
export { createSupplier, updateSupplier, getSupplier, listSuppliers, resolveSupplier, createBill, updateBill, getBill, findBillByNumber, openBillForReference, listBills, approveBill, payBill, voidBill, deleteBill, payablesOutstanding } from './bills.js';
export type { DocumentMeta, DocumentTarget } from './documents.js';
export { DOCUMENT_MAX_BYTES, addDocument, linkDocument, unlinkDocument, getDocument, readDocument, listDocumentsFor, documentCounts } from './documents.js';

export type { ConnectedWallet, ConnectedWalletKind } from './wallets.js';
export { EVM_ADDRESS, listConnectedWallets, getConnectedWallet, connectedWalletForBank, findConnectedAddress, createConnectedWallet, readConnectedCredentials, setConnectedSync, archiveConnectedWallet, getVaultKey, ensureVaultKey } from './wallets.js';

export type { StripeLink } from './stripe.js';
export { getStripeLink, saveStripeLink } from './stripe.js';
export type { ChartLine, ParsedChart, TrialBalanceInputLine, ParsedTrialBalance, TrialBalanceImportResult, ParsedDoc, ParsedDocLine, ParsedDocs, DocPreview, DocPreviewRow, DocImportResult } from './imports.js';
export { openingMoment, inferAccountType, parseChartCsv, parseTrialBalanceCsv, importChart, importTrialBalance, undoTrialBalance, standingConversion, conversionDateOf, parseDocumentsCsv, previewDocuments, importDocuments } from './imports.js';
export { sumPostedBySource } from './ledger.js';

export type { AgentTokens, Allocation } from './tokens.js';
export { agentTokens, allocate, modelWeight, TOKEN_WEIGHT, MODEL_CLASS, DEFAULT_MODEL_WEIGHT } from './tokens.js';

// The subledger: every agent action, and the periodic journal that summarises
// it. See src/core/subledger.ts for why the general ledger does not hear about
// each one.
export {
  authorise, aggregate, balanceFor, capture, fund, getEvent, invoiceStatement, listBalances, listEvents, record, release, reserve, statement,
} from './subledger.js';
export type { MeterEvent, MeterKind, MeterStatus, Balance, AggregateResult, Statement } from './subledger.js';

// Streams: work earned continuously, accrued as it happens and settled when
// somebody withdraws. See src/core/streams.ts.
export {
  accrue, cancelStream, getStream, headroom, listStreams, openStream, pauseStream, resumeStream, tick, withdraw,
} from './streams.js';
export type { Stream, StreamStatus, CapPeriod } from './streams.js';
export type { MeterFunding } from './subledger.js';
