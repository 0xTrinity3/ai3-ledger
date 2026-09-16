/**
 * Connecting wallets and paying from them.
 *
 * Three ways money leaves or is watched, one module:
 *  - an address the company connects (hot or hardware wallet, watched by
 *    address on a chain the ledger knows), with an optional signed proof
 *    that the person holds its key;
 *  - an exchange account read with a read-only key;
 *  - a payment: from the company's own Tempo wallet, signed here, or from
 *    the person's wallet in the browser, booked here once the chain has it.
 *
 * Everything that touches a chain goes through chains.ts; everything that
 * touches an exchange through exchanges.ts. This file only orchestrates.
 */
import { verifyMessage } from 'viem';
import {
  ACCOUNT,
  LedgerError,
  archiveConnectedWallet,
  createBankAccount,
  createConnectedWallet,
  findConnectedAddress,
  getBankAccount,
  getConnectedWallet,
  importStatementLines,
  listConnectedWallets,
  openBillForReference,
  payBill,
  postTransaction,
  readConnectedCredentials,
  runReconciliation,
  setChainCursor,
  setConnectedSync,
  type ConnectedWallet,
  type LedgerDb,
} from '../core/index.js';
import { CHAINS, blockDaysAgo, chainForPaymentOption, chainOf, chainSummary, explorerTx, publicClientFor, syncChainAccount, tokenBalanceCents, type ChainSpec, type ChainSyncResult } from './chains.js';
import { EXCHANGES, exchangeOf, linesFromEntries, type ExchangeCredentials, type ExchangeId, type FetchLike } from './exchanges.js';
import { fetchInvoiceDocument, type RemoteInvoice } from './tools.js';
import { PATH_USD_SYMBOL, balanceCents, ensureWallet, pay as tempoPay } from './tempo.js';
import { seal, unseal } from './vault.js';

const WALLET_CURRENCY = 'USD';

// ---------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------

/** The message a wallet signs to prove it is the person's. Plain text, no chain call. */
export function ownershipMessage(companyName: string, address: string, at: string): string {
  return `${companyName} connects this wallet to its AI3 Ledger.\n\nAddress: ${address}\nAt: ${at}\n\nSigning costs nothing and moves nothing.`;
}

export async function verifyOwnership(address: string, message: string, signature: string): Promise<boolean> {
  try {
    return await verifyMessage({ address: address as `0x${string}`, message, signature: signature as `0x${string}` });
  } catch {
    return false;
  }
}

export interface ConnectAddressInput {
  label?: string | null;
  network: string;
  address: string;
  proof?: { message: string; signature: string } | null;
  /**
   * A credit top-up ai3.co saw arrive from this address. The transfer was
   * signed by the address to exist at all, so it stands in for an ownership
   * signature — and unlike a card, a public ledger names the actual account.
   */
  topUp?: { txHash: string; amountMinor: string; memo?: string | null } | null;
  sinceDays?: number | null;
}

/** Watch an address: a bank account of kind wallet with an on-chain feed. */
export async function connectAddressWallet(db: LedgerDb, companyId: string, input: ConnectAddressInput, by: string): Promise<{ wallet: ConnectedWallet; chain: ChainSpec; proven: boolean }> {
  const chain = chainOf(input.network);
  if (!chain) throw new LedgerError(`unknown network ${input.network}; the ledger reads ${Object.keys(CHAINS).join(', ')}`, 'invalid');
  const address = String(input.address ?? '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new LedgerError('the address must be a 0x address of 40 hex characters', 'invalid');
  let proven = false;
  if (input.proof?.message && input.proof.signature) {
    proven = await verifyOwnership(address, input.proof.message, input.proof.signature);
    if (!proven) throw new LedgerError('the signature does not match the address', 'invalid');
  } else if (input.topUp?.txHash) {
    // ai3.co saw the funds arrive from this address in its own books. The
    // ledger already trusts it for the credit balance itself.
    proven = true;
  }
  const short = `${address.slice(0, 6)}…${address.slice(-4)}`;
  const label = (input.label ?? '').trim() || `${chain.name} wallet ${short}`;
  if (await findConnectedAddress(db, companyId, chain.slug, address)) throw new LedgerError('that address is already connected on this network', 'invalid');
  const bank = await createBankAccount(db, companyId, { name: label, kind: 'wallet', currency: WALLET_CURRENCY, feed: 'chain', externalRef: `${chain.slug}:${address}` });
  // Start reading from now, or from a little history if asked. Never from genesis.
  let start: bigint;
  try {
    const days = Number(input.sinceDays ?? 0);
    start = days > 0 ? await blockDaysAgo(chain, days) : (await publicClientFor(chain).getBlockNumber()) - 1n;
  } catch {
    start = 0n;
  }
  if (start > 0n) await setChainCursor(db, bank.id, start);
  const wallet = await createConnectedWallet(db, companyId, {
    kind: 'address', label, network: chain.slug, address, currency: WALLET_CURRENCY, bankAccountId: bank.id, createdBy: by,
    proof: proven && input.proof?.signature
      ? { message: input.proof.message, signature: input.proof.signature, at: new Date().toISOString() }
      : proven && input.topUp?.txHash
        ? { via: 'ai3-credit-top-up' as const, txHash: input.topUp.txHash, amountMinor: String(input.topUp.amountMinor ?? '0'), memo: input.topUp.memo ?? null, at: new Date().toISOString() }
        : null,
  });
  return { wallet, chain, proven };
}

export interface ConnectExchangeInput { label?: string | null; exchange: string; apiKey: string; secret: string; passphrase?: string | null; currency: string; sinceDays?: number | null }

/** Read an exchange account: a bank account of kind wallet with an exchange feed. Credentials are checked, then sealed. */
export async function connectExchangeAccount(db: LedgerDb, fetch: FetchLike, companyId: string, input: ConnectExchangeInput, by: string): Promise<{ wallet: ConnectedWallet; detail: string }> {
  const ex = exchangeOf(input.exchange);
  if (!ex) throw new LedgerError(`unknown exchange ${input.exchange}; the ledger reads ${Object.keys(EXCHANGES).join(', ')}`, 'invalid');
  const currency = String(input.currency ?? '').trim().toUpperCase();
  if (!ex.currencies.includes(currency)) throw new LedgerError(`${ex.name} feeds here read ${ex.currencies.join(', ')}`, 'invalid');
  const creds: ExchangeCredentials = { apiKey: String(input.apiKey ?? '').trim(), secret: String(input.secret ?? '').trim(), ...(input.passphrase ? { passphrase: String(input.passphrase).trim() } : {}) };
  if (!creds.apiKey || !creds.secret) throw new LedgerError('the API key and its secret are both needed', 'invalid');
  const check = await ex.validate(fetch, creds);
  if (!check.ok) throw new LedgerError(`${ex.name} refused the key: ${check.detail}`, 'invalid');
  const label = (input.label ?? '').trim() || `${ex.name} · ${currency}`;
  const bank = await createBankAccount(db, companyId, { name: label, kind: 'wallet', currency, feed: 'exchange', externalRef: `${ex.id}:${currency}` });
  const days = Math.min(Math.max(Number(input.sinceDays ?? 30), 0), 365);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const wallet = await createConnectedWallet(db, companyId, { kind: 'exchange', label, exchange: ex.id, currency, credentials: await seal(db, JSON.stringify(creds)), bankAccountId: bank.id, cursor: { since }, createdBy: by });
  return { wallet, detail: check.detail };
}

export async function disconnectWallet(db: LedgerDb, companyId: string, walletId: string): Promise<ConnectedWallet> {
  return archiveConnectedWallet(db, companyId, walletId);
}

// ---------------------------------------------------------------------------
// Feeds
// ---------------------------------------------------------------------------

export interface WalletSyncResult { walletId: string; label: string; imported: number; duplicates: number; autoPosted: number; leftForReview: number; error: string | null }

/** Read one connected wallet into its bank account. Errors are recorded on the wallet and returned, never thrown. */
export async function syncConnectedWallet(db: LedgerDb, fetch: FetchLike, companyId: string, wallet: ConnectedWallet, opts: { autoPost?: boolean; by?: string } = {}): Promise<WalletSyncResult> {
  const out: WalletSyncResult = { walletId: wallet.id, label: wallet.label, imported: 0, duplicates: 0, autoPosted: 0, leftForReview: 0, error: null };
  if (!wallet.bankAccountId || wallet.archivedAt) return out;
  try {
    if (wallet.kind === 'address') {
      const chain = chainOf(wallet.network);
      if (!chain || !wallet.address) throw new LedgerError('this wallet has no readable network', 'invalid');
      const r: ChainSyncResult | null = await syncChainAccount(db, companyId, { chain, address: wallet.address, bankAccountId: wallet.bankAccountId }, opts);
      if (r) Object.assign(out, { imported: r.imported, duplicates: r.duplicates, autoPosted: r.autoPosted, leftForReview: r.leftForReview });
    } else {
      const ex = exchangeOf(wallet.exchange);
      const sealed = await readConnectedCredentials(db, companyId, wallet.id);
      if (!ex || !sealed) throw new LedgerError('this account has no readable credentials', 'invalid');
      const creds = JSON.parse(await unseal(db, sealed)) as ExchangeCredentials;
      // Overlap by a day so a late-arriving entry is not missed; duplicates are dropped by external id.
      const since = new Date(new Date(String(wallet.cursor?.['since'] ?? new Date(Date.now() - 30 * 86_400_000).toISOString())).getTime() - 86_400_000).toISOString();
      const entries = await ex.entries(fetch, creds, wallet.currency, since);
      const r = await importStatementLines(db, companyId, wallet.bankAccountId, linesFromEntries(ex.id as ExchangeId, entries));
      out.imported = r.imported;
      out.duplicates = r.duplicates;
      if (r.imported > 0) {
        const run = await runReconciliation(db, companyId, wallet.bankAccountId, { autoPost: opts.autoPost ?? true, by: opts.by ?? 'exchange-feed' });
        out.autoPosted = run.autoPosted;
        out.leftForReview = run.leftForReview;
      }
      await setConnectedSync(db, companyId, wallet.id, { cursor: { since: new Date().toISOString() }, lastError: null });
      return out;
    }
    await setConnectedSync(db, companyId, wallet.id, { lastError: null });
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
    await setConnectedSync(db, companyId, wallet.id, { lastError: out.error }).catch(() => {});
  }
  return out;
}

export async function syncAllConnected(db: LedgerDb, fetch: FetchLike, companyId: string, opts: { autoPost?: boolean; by?: string } = {}): Promise<WalletSyncResult[]> {
  const out: WalletSyncResult[] = [];
  for (const w of await listConnectedWallets(db, companyId)) out.push(await syncConnectedWallet(db, fetch, companyId, w, opts));
  return out;
}

/** Sync the wallet behind a bank account, by bank account id. */
export async function syncWalletForBank(db: LedgerDb, fetch: FetchLike, companyId: string, walletId: string, opts: { autoPost?: boolean; by?: string } = {}): Promise<WalletSyncResult> {
  const w = await getConnectedWallet(db, companyId, walletId);
  if (!w) throw new LedgerError('wallet not found', 'invalid');
  return syncConnectedWallet(db, fetch, companyId, w, opts);
}

/** The connected wallets with a live balance where the chain can tell us one. */
export async function connectedWalletsView(db: LedgerDb, companyId: string): Promise<Array<ConnectedWallet & { balanceMinor: string | null; explorer: string | null; chainName: string | null; symbol: string | null }>> {
  const out = [];
  for (const w of await listConnectedWallets(db, companyId)) {
    const chain = w.kind === 'address' ? chainOf(w.network) : null;
    let balanceMinor: string | null = null;
    if (chain && w.address) balanceMinor = await tokenBalanceCents(chain, w.address).then((b) => b.toString()).catch(() => null);
    out.push({ ...w, balanceMinor, explorer: chain && w.address ? `${chain.explorer}/address/${w.address}` : null, chainName: chain?.name ?? (w.exchange ? EXCHANGES[w.exchange as ExchangeId]?.name ?? null : null), symbol: chain?.token.symbol ?? w.currency });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Paying
// ---------------------------------------------------------------------------

export interface PayableOption { chain: ReturnType<typeof chainSummary>; address: string; label: string; asset: string; memo: string | null; companyWallet: boolean }

/** An invoice by its link, with the ways this company can pay it from here. */
export async function remoteInvoiceView(fetch: FetchLike, url: string, companyWalletAddress: string | null): Promise<{ invoice: RemoteInvoice; options: PayableOption[] }> {
  const invoice = await fetchInvoiceDocument(fetch, url);
  const options: PayableOption[] = [];
  for (const m of invoice.paymentMethods) {
    if (m.kind !== 'crypto' || !m.details.address) continue;
    const chain = chainForPaymentOption(m.details);
    if (!chain) continue;
    const memo = chain.token.memo ? invoice.number : null;
    options.push({ chain: chainSummary(chain), address: m.details.address, label: m.label, asset: chain.token.symbol, memo, companyWallet: chain.slug === 'tempo-moderato' && Boolean(companyWalletAddress) && invoice.currency === 'USD' });
  }
  return { invoice, options };
}

export interface PayFromCompanyWalletInput { invoiceUrl?: string | null; to?: string | null; amountMinor?: string | bigint | null; memo?: string | null; description?: string | null; accountCode?: string | null; billId?: string | null }

/** Pay in pathUSD from the company wallet and book it. The wallet line arrives with the feed and matches by hash. */
export async function payFromCompanyWallet(db: LedgerDb, fetch: FetchLike, companyId: string, input: PayFromCompanyWalletInput, by: string, baseCurrency: string) {
  const { wallet } = await ensureWallet(db, companyId, baseCurrency);
  const tempo = CHAINS['tempo-moderato']!;
  let to = input.to?.trim() || null;
  let amountCents = input.amountMinor !== undefined && input.amountMinor !== null && input.amountMinor !== '' ? BigInt(input.amountMinor) : null;
  let memo = input.memo?.trim() || null;
  let description = input.description?.trim() || null;
  let remote: RemoteInvoice | null = null;
  if (input.invoiceUrl) {
    remote = await fetchInvoiceDocument(fetch, input.invoiceUrl);
    const option = remote.paymentMethods.find((m: RemoteInvoice['paymentMethods'][number]) => m.kind === 'crypto' && m.details.address && chainForPaymentOption(m.details)?.slug === tempo.slug);
    if (!option?.details.address) throw new LedgerError(`invoice ${remote.number} offers no Tempo wallet to pay into`, 'invalid');
    if (remote.currency !== 'USD') throw new LedgerError(`invoice ${remote.number} is in ${remote.currency}; the wallet pays ${PATH_USD_SYMBOL} (USD) only`, 'invalid');
    to = option.details.address;
    amountCents = amountCents ?? BigInt(remote.outstandingMinor);
    memo = memo ?? remote.number;
    description = description ?? `Invoice ${remote.number} from ${remote.company.name}`;
  }
  if (!to) throw new LedgerError('give an invoice link or a payee address', 'invalid');
  if (amountCents === null) throw new LedgerError('give an amount', 'invalid');
  if (!memo) memo = description?.slice(0, 32) ?? 'payment';
  // The marketplace may already have written this invoice into our books as a
  // bill. Paying it settles that bill; booking an expense beside it counted
  // the first cross-organisation payment twice.
  let billId = input.billId ?? null;
  if (!billId && remote?.number) billId = (await openBillForReference(db, companyId, remote.number))?.id ?? null;
  const result = await tempoPay(wallet, { to, amountCents, memo });
  const bank = wallet.bankAccountId ? await getBankAccount(db, companyId, wallet.bankAccountId) : null;
  const booked = await bookOutgoing(db, companyId, { chain: tempo, txHash: result.txHash, bankAccountCode: bank?.accountCode ?? null, amountMinor: amountCents, description: description ?? `Paid ${to} · ${memo}`, accountCode: input.accountCode ?? null, billId }, by);
  return { txHash: result.txHash, explorer: result.explorer, to, amountMinor: amountCents.toString(), asset: PATH_USD_SYMBOL, memo, invoice: remote?.number ?? null, booked };
}

export interface BookWalletPaymentInput { network: string; txHash: string; from: string; to: string; amountMinor: string | bigint; description?: string | null; accountCode?: string | null; billId?: string | null; invoiceUrl?: string | null }

/**
 * A payment the person sent from their own wallet in the browser: confirm it
 * on the chain, connect the paying address if it is new, and book it against
 * that wallet's bank account (an expense, or the bill it pays).
 */
export async function bookBrowserPayment(db: LedgerDb, fetch: FetchLike, companyId: string, input: BookWalletPaymentInput, by: string) {
  const chain = chainOf(input.network);
  if (!chain) throw new LedgerError(`unknown network ${input.network}`, 'invalid');
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.txHash)) throw new LedgerError('the transaction hash must be 0x and 64 hex characters', 'invalid');
  const from = String(input.from).trim();
  const to = String(input.to).trim();
  const amountMinor = BigInt(input.amountMinor);
  if (amountMinor <= 0n) throw new LedgerError('the amount must be positive', 'invalid');
  const proof = await confirmTransfer(chain, input.txHash, from, to, amountMinor);
  if (!proof.ok) throw new LedgerError(`the chain does not show that transfer yet: ${proof.detail}`, 'invalid');
  let wallet = await findConnectedAddress(db, companyId, chain.slug, from);
  if (!wallet) wallet = (await connectAddressWallet(db, companyId, { network: chain.slug, address: from }, by)).wallet;
  const bank = wallet.bankAccountId ? await getBankAccount(db, companyId, wallet.bankAccountId) : null;
  let description = input.description?.trim() || null;
  if (!description && input.invoiceUrl) {
    try { const inv = await fetchInvoiceDocument(fetch, input.invoiceUrl); description = `Invoice ${inv.number} from ${inv.company.name}`; } catch { description = null; }
  }
  const booked = await bookOutgoing(db, companyId, { chain, txHash: input.txHash, bankAccountCode: bank?.accountCode ?? null, amountMinor, description: description ?? `Paid ${to} from ${wallet.label}`, accountCode: input.accountCode ?? null, billId: input.billId ?? null }, by);
  return { walletId: wallet.id, walletLabel: wallet.label, explorer: explorerTx(chain, input.txHash), booked };
}

/** Book a send from a wallet's bank account: against a bill when given, else as an expense. Replay-safe on the tx hash. */
async function bookOutgoing(db: LedgerDb, companyId: string, input: { chain: ChainSpec; txHash: string; bankAccountCode: string | null; amountMinor: bigint; description: string; accountCode: string | null; billId: string | null }, by: string): Promise<{ kind: 'bill' | 'expense' | 'none'; transactionId: string | null; accountCode: string | null }> {
  if (!input.bankAccountCode) return { kind: 'none', transactionId: null, accountCode: null };
  if (input.billId) {
    const bill = await payBill(db, companyId, input.billId, { amountMinor: input.amountMinor, reference: `${input.chain.refPrefix}:${input.txHash}`, createdBy: by, cashAccountCode: input.bankAccountCode });
    return { kind: 'bill', transactionId: bill.transactionId, accountCode: ACCOUNT.PAYABLES };
  }
  const code = input.accountCode?.trim() || ACCOUNT.OTHER_OPERATING;
  const r = await postTransaction(db, {
    companyId, occurredAt: new Date(), description: input.description, sourcePlatform: input.chain.refPrefix, sourceKind: 'payment', sourceRef: `${input.chain.refPrefix}:${input.txHash}`, currency: WALLET_CURRENCY,
    entries: [{ accountCode: code, direction: 'debit', amountMinor: input.amountMinor }, { accountCode: input.bankAccountCode, direction: 'credit', amountMinor: input.amountMinor }], createdBy: by,
  });
  return { kind: 'expense', transactionId: r.transactionId, accountCode: code };
}

/** Does the chain show this token transfer? Waits briefly for a receipt that is still in flight. */
export async function confirmTransfer(chain: ChainSpec, txHash: string, from: string, to: string, amountMinor: bigint): Promise<{ ok: true; blockNumber: string } | { ok: false; detail: string }> {
  const client = publicClientFor(chain);
  const units = amountMinor * 10n ** BigInt(chain.token.decimals - 2);
  const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const pad = (a: string) => `0x${a.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
  for (let attempt = 0; attempt < 6; attempt++) {
    const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` }).catch(() => null);
    if (receipt) {
      if (receipt.status !== 'success') return { ok: false, detail: 'the transaction reverted' };
      const hit = receipt.logs.find((l) => l.address.toLowerCase() === chain.token.address.toLowerCase() && l.topics[0] === transferTopic && l.topics[1] === pad(from) && l.topics[2] === pad(to) && BigInt(l.data) >= units);
      if (!hit) return { ok: false, detail: 'no matching token transfer in that transaction' };
      return { ok: true, blockNumber: receipt.blockNumber.toString() };
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { ok: false, detail: 'no receipt yet; try again in a moment' };
}

export async function companyWalletBalance(address: string): Promise<bigint | null> {
  return balanceCents(address).catch(() => null);
}

export { chainSummary };
