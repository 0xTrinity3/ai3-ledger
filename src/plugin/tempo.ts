/**
 * Tempo: the company's stablecoin wallet on Stripe's payments chain.
 *
 * Testnet (Moderato) for now. Every company gets one wallet: it is a payment
 * option printed on invoices (pay in pathUSD to this address, invoice number
 * in the memo), a bank account of kind wallet whose feed reads the chain, and
 * the key the company uses to sign for itself at a dispute venue.
 *
 * Money on chain is in token units (6 decimals); the ledger keeps cents.
 * 1 pathUSD = 1 USD, so units / 10_000 = cents.
 */
import { createClient, Addresses } from 'viem/tempo';
import { tempoModerato } from 'viem/chains';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { http, parseAbiItem, stringToHex, hexToString, pad, getAddress, type Hex } from 'viem';
import {
  LedgerError,
  ACCOUNT,
  applyDecision,
  createBankAccount,
  createPaymentMethod,
  findTransactionBySourceRef,
  listStatementLines,
  getBankAccount,
  getChainCursor,
  getWallet,
  importStatementLines,
  listPaymentMethods,
  runReconciliation,
  saveWallet,
  setChainCursor,
  type CompanyWallet,
  type LedgerDb,
  type ParsedLine,
} from '../core/index.js';

export const TEMPO_NETWORK = 'tempo-moderato';
export const TEMPO_NETWORK_LABEL = 'Tempo Moderato testnet';
export const TEMPO_EXPLORER = 'https://explore.testnet.tempo.xyz';
export const TEMPO_RPC = 'https://rpc.moderato.tempo.xyz';
export const TEMPO_FAUCET = 'https://tempo.xyz/developers/api/faucet';
export const PATH_USD: Hex = Addresses.pathUsd as Hex;
export const PATH_USD_SYMBOL = 'pathUSD';
const ZERO = '0x0000000000000000000000000000000000000000';
const FEE_MANAGER = String(Addresses.feeManager).toLowerCase();
const UNITS_PER_CENT = 10_000n; // 6 decimals → 2

const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 amount)');
const TRANSFER_MEMO_EVENT = parseAbiItem('event TransferWithMemo(address indexed from, address indexed to, uint256 amount, bytes32 indexed memo)');

export function centsToUnits(cents: bigint): bigint {
  return cents * UNITS_PER_CENT;
}

export function unitsToCents(units: bigint): bigint {
  return units / UNITS_PER_CENT;
}

/** A memo is 32 bytes; invoice numbers fit with room to spare. */
export function encodeMemo(text: string): Hex {
  const clean = text.trim().slice(0, 32);
  return pad(stringToHex(clean), { size: 32, dir: 'right' });
}

export function decodeMemo(memo: Hex | null | undefined): string {
  if (!memo || memo === '0x' || /^0x0+$/.test(memo)) return '';
  try {
    return hexToString(memo, { size: 32 }).replace(/\0+$/g, '').replace(/^\0+/g, '').trim();
  } catch {
    return '';
  }
}

export function explorerTx(hash: string): string {
  return `${TEMPO_EXPLORER}/tx/${hash}`;
}

export function explorerAddress(address: string): string {
  return `${TEMPO_EXPLORER}/address/${address}`;
}

function publicClient() {
  return createClient({ chain: tempoModerato, transport: http(TEMPO_RPC) });
}

function walletClient(privateKey: Hex) {
  return createClient({ chain: tempoModerato, transport: http(TEMPO_RPC), account: privateKeyToAccount(privateKey) });
}

/** Ask the testnet faucet for the four test stablecoins. Free; no auth. */
export async function requestFaucet(address: string): Promise<{ ok: boolean; detail: string }> {
  const r = await fetch(TEMPO_FAUCET, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: address.toLowerCase() }) });
  const text = await r.text().catch(() => '');
  return { ok: r.ok, detail: text.slice(0, 300) };
}

export async function balanceCents(address: string, token: Hex = PATH_USD): Promise<bigint> {
  const raw = (await publicClient().token.getBalance({ account: getAddress(address.toLowerCase()), token })) as unknown;
  // viem answers { amount, decimals, formatted }; older shapes were a bare bigint.
  const rec = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  const units = typeof raw === 'bigint' ? raw : rec && rec['amount'] !== undefined ? BigInt(String(rec['amount'])) : rec && rec['value'] !== undefined ? BigInt(String(rec['value'])) : BigInt(String(raw ?? 0));
  return unitsToCents(units);
}

/**
 * Give a company its wallet: key, chain bank account under Treasury, and a
 * payment option printed on invoices. Idempotent. Funds it from the faucet on
 * first creation so a fresh company can pay straight away.
 */
export async function ensureWallet(db: LedgerDb, companyId: string, currency: string): Promise<{ wallet: CompanyWallet; created: boolean; faucet?: { ok: boolean; detail: string } }> {
  const existing = await getWallet(db, companyId);
  if (existing && existing.bankAccountId && existing.paymentMethodId) return { wallet: existing, created: false };
  const privateKey = existing?.privateKey ?? generatePrivateKey();
  const address = existing?.address ?? privateKeyToAccount(privateKey as Hex).address;
  let bankAccountId = existing?.bankAccountId ?? null;
  if (!bankAccountId) {
    const bank = await createBankAccount(db, companyId, { name: `Tempo wallet (${PATH_USD_SYMBOL})`, kind: 'wallet', currency, feed: 'tempo', externalRef: `tempo:${address}` });
    bankAccountId = bank.id;
    // Start reading the chain from now, not from genesis.
    const head = await publicClient().getBlockNumber().catch(() => 0n);
    if (head > 0n) await setChainCursor(db, bankAccountId, head - 1n);
  }
  let paymentMethodId = existing?.paymentMethodId ?? null;
  if (!paymentMethodId) {
    const have = (await listPaymentMethods(db, companyId)).find((m) => m.kind === 'crypto' && m.details.address?.toLowerCase() === address.toLowerCase());
    paymentMethodId = have?.id ?? (await createPaymentMethod(db, companyId, { kind: 'crypto', label: `${PATH_USD_SYMBOL} on Tempo`, currency: 'USD', details: { asset: PATH_USD_SYMBOL, network: TEMPO_NETWORK_LABEL, address }, isDefault: true })).id;
  }
  const wallet = await saveWallet(db, { companyId, network: TEMPO_NETWORK, address, privateKey, bankAccountId, paymentMethodId });
  const out: { wallet: CompanyWallet; created: boolean; faucet?: { ok: boolean; detail: string } } = { wallet, created: !existing };
  if (!existing) out.faucet = await requestFaucet(address).catch((err) => ({ ok: false, detail: err instanceof Error ? err.message : String(err) }));
  return out;
}

export interface PaymentResult { txHash: string; blockNumber: bigint; amountCents: bigint; to: string; memo: string; explorer: string }

/** Send pathUSD from the company wallet. Waits for the receipt (about a second on Moderato). */
export async function pay(wallet: CompanyWallet, input: { to: string; amountCents: bigint; memo: string; token?: Hex }): Promise<PaymentResult> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.to)) throw new LedgerError('the destination must be a 0x address', 'invalid');
  const to = getAddress(input.to.toLowerCase()); // any casing in, checksummed out
  if (input.amountCents <= 0n) throw new LedgerError('the amount must be positive', 'invalid');
  const have = await balanceCents(wallet.address, input.token ?? PATH_USD);
  if (have < input.amountCents) throw new LedgerError(`the wallet holds ${(Number(have) / 100).toFixed(2)} ${PATH_USD_SYMBOL}, less than the ${(Number(input.amountCents) / 100).toFixed(2)} to send`, 'invalid');
  const client = walletClient(wallet.privateKey as Hex);
  const { receipt } = await client.token.transferSync({ amount: centsToUnits(input.amountCents), to, token: input.token ?? PATH_USD, memo: encodeMemo(input.memo) });
  if (receipt.status !== 'success') throw new LedgerError(`the transfer was not accepted by the chain (${receipt.status})`, 'invalid');
  return { txHash: receipt.transactionHash, blockNumber: receipt.blockNumber, amountCents: input.amountCents, to, memo: input.memo, explorer: explorerTx(receipt.transactionHash) };
}

export interface ChainTransfer { txHash: string; logIndex: number; blockNumber: bigint; from: string; to: string; units: bigint; memo: string }

/** Every pathUSD transfer touching the address between two blocks, with memos joined on. */
export async function transfersFor(address: string, fromBlock: bigint, toBlock: bigint, token: Hex = PATH_USD): Promise<ChainTransfer[]> {
  const client = publicClient();
  const a = getAddress(address.toLowerCase());
  const [inbound, outbound, memosIn, memosOut] = await Promise.all([
    client.getLogs({ address: token, event: TRANSFER_EVENT, args: { to: a }, fromBlock, toBlock }),
    client.getLogs({ address: token, event: TRANSFER_EVENT, args: { from: a }, fromBlock, toBlock }),
    client.getLogs({ address: token, event: TRANSFER_MEMO_EVENT, args: { to: a }, fromBlock, toBlock }),
    client.getLogs({ address: token, event: TRANSFER_MEMO_EVENT, args: { from: a }, fromBlock, toBlock }),
  ]);
  const memos = new Map<string, string>();
  for (const l of [...memosIn, ...memosOut]) memos.set(`${l.transactionHash}:${String(l.args.from).toLowerCase()}:${String(l.args.to).toLowerCase()}:${String(l.args.amount)}`, decodeMemo(l.args.memo as Hex));
  const seen = new Set<string>();
  const out: ChainTransfer[] = [];
  for (const l of [...inbound, ...outbound]) {
    const key = `${l.transactionHash}:${l.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const from = String(l.args.from);
    const to = String(l.args.to);
    const units = BigInt(String(l.args.amount));
    out.push({ txHash: l.transactionHash, logIndex: l.logIndex, blockNumber: l.blockNumber, from, to, units, memo: memos.get(`${l.transactionHash}:${from.toLowerCase()}:${to.toLowerCase()}:${String(units)}`) ?? '' });
  }
  return out.sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1));
}

/** Turn chain transfers into statement lines the reconciliation engine reads. */
export function linesFrom(address: string, transfers: ChainTransfer[], timestamps: Map<bigint, string>): ParsedLine[] {
  const me = address.toLowerCase();
  // Fee dust (sub-cent transfers to the fee manager) is not a line anyone reconciles.
  return transfers.filter((t) => unitsToCents(t.units) > 0n || t.to.toLowerCase() !== FEE_MANAGER).filter((t) => unitsToCents(t.units) > 0n).map((t) => {
    const inbound = t.to.toLowerCase() === me;
    const other = inbound ? t.from : t.to;
    const cents = unitsToCents(t.units);
    return {
      postedAt: timestamps.get(t.blockNumber) ?? new Date().toISOString(),
      amountMinor: inbound ? cents : -cents,
      description: `${PATH_USD_SYMBOL} ${inbound ? 'from' : 'to'} ${other}${t.memo ? ` · ${t.memo}` : ''}`,
      payee: other,
      reference: t.memo || t.txHash.slice(0, 18),
      externalId: `${t.txHash}:${t.logIndex}`,
    };
  });
}

const MAX_SPAN = 5_000n;

/**
 * Read new transfers for the company wallet into its bank account, then let
 * the matcher post what it is sure of. Returns what happened.
 */
export async function syncWalletFeed(db: LedgerDb, companyId: string, opts: { autoPost?: boolean; by?: string } = {}): Promise<{ imported: number; duplicates: number; autoPosted: number; leftForReview: number; fromBlock: string; toBlock: string } | null> {
  const wallet = await getWallet(db, companyId);
  if (!wallet?.bankAccountId) return null;
  const bank = await getBankAccount(db, companyId, wallet.bankAccountId);
  if (!bank) return null;
  const client = publicClient();
  const head = await client.getBlockNumber();
  const cursor = await getChainCursor(db, bank.id);
  const from = cursor > 0n ? cursor + 1n : head - 1n;
  if (from > head) return { imported: 0, duplicates: 0, autoPosted: 0, leftForReview: 0, fromBlock: from.toString(), toBlock: head.toString() };
  let imported = 0;
  let duplicates = 0;
  let cur = from;
  while (cur <= head) {
    const to = cur + MAX_SPAN - 1n > head ? head : cur + MAX_SPAN - 1n;
    const transfers = await transfersFor(wallet.address, cur, to);
    if (transfers.length > 0) {
      const timestamps = new Map<bigint, string>();
      for (const b of new Set(transfers.map((t) => t.blockNumber))) {
        const blk = await client.getBlock({ blockNumber: b });
        timestamps.set(b, new Date(Number(blk.timestamp) * 1000).toISOString());
      }
      const r = await importStatementLines(db, companyId, bank.id, linesFrom(wallet.address, transfers, timestamps));
      imported += r.imported;
      duplicates += r.duplicates;
    }
    await setChainCursor(db, bank.id, to);
    cur = to + 1n;
  }
  // What the chain tells us outright, before the matcher guesses: a transfer
  // this company sent (the booked payment carries the tx hash) is that
  // payment; a mint from the zero address is the testnet faucet, i.e. funding.
  let settled = 0;
  if (imported > 0) {
    const by = opts.by ?? 'chain-feed';
    for (const line of await listStatementLines(db, companyId, bank.id, { status: 'unreconciled', limit: 500 })) {
      const hash = line.externalId?.split(':')[0];
      const cents = BigInt(line.amountMinor);
      try {
        if (hash && cents < 0n) {
          const txId = await findTransactionBySourceRef(db, companyId, 'tempo', `tempo:${hash}`);
          if (txId) { await applyDecision(db, companyId, line.id, { kind: 'match', transactionIds: [txId], reason: 'Same transaction hash as the payment booked when it was sent.' }, by); settled += 1; continue; }
        }
        if (cents > 0n && (line.payee ?? '').toLowerCase() === ZERO) {
          await applyDecision(db, companyId, line.id, { kind: 'create', accountCode: ACCOUNT.CONTRIBUTED_FUNDS, description: 'Test funds from the Tempo faucet', contactName: 'Tempo faucet', reason: 'Minted to this wallet by the testnet faucet.' }, by);
          settled += 1;
        }
      } catch { /* leave it for the matcher and the person */ }
    }
  }
  const run = imported > 0 ? await runReconciliation(db, companyId, bank.id, { autoPost: opts.autoPost ?? true, by: opts.by ?? 'chain-feed' }) : { autoPosted: 0, leftForReview: 0 };
  return { imported, duplicates, autoPosted: run.autoPosted + settled, leftForReview: run.leftForReview, fromBlock: from.toString(), toBlock: head.toString() };
}
