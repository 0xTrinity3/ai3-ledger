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
  createBankAccount,
  createPaymentMethod,
  getWallet,
  listPaymentMethods,
  saveWallet,
  setChainCursor,
  type CompanyWallet,
  type LedgerDb,
  type ParsedLine,
} from '../core/index.js';
import { CHAINS, linesFrom as chainLinesFrom, syncChainAccount, transfersFor as chainTransfersFor, type ChainSyncResult, type ChainTransfer } from './chains.js';

export const TEMPO_NETWORK = 'tempo-moderato';
export const TEMPO_NETWORK_LABEL = 'Tempo Moderato testnet';
export const TEMPO_EXPLORER = 'https://explore.testnet.tempo.xyz';
export const TEMPO_RPC = 'https://rpc.moderato.tempo.xyz';
export const TEMPO_FAUCET = 'https://tempo.xyz/developers/api/faucet';
export const PATH_USD: Hex = Addresses.pathUsd as Hex;
export const PATH_USD_SYMBOL = 'pathUSD';
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
    paymentMethodId = have?.id ?? (await createPaymentMethod(db, companyId, { kind: 'crypto', label: `${PATH_USD_SYMBOL} on Tempo`, currency: 'USD', details: { asset: PATH_USD_SYMBOL, network: TEMPO_NETWORK_LABEL, address, chain: TEMPO_NETWORK }, isDefault: true })).id;
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

export type { ChainTransfer } from './chains.js';

const TEMPO = CHAINS['tempo-moderato']!;

/** Every pathUSD transfer touching the address between two blocks, with memos joined on. */
export function transfersFor(address: string, fromBlock: bigint, toBlock: bigint): Promise<ChainTransfer[]> {
  return chainTransfersFor(TEMPO, address, fromBlock, toBlock);
}

/** Turn chain transfers into statement lines the reconciliation engine reads. */
export function linesFrom(address: string, transfers: ChainTransfer[], timestamps: Map<bigint, string>): ParsedLine[] {
  return chainLinesFrom(TEMPO, address, transfers, timestamps);
}

/**
 * Read new transfers for the company wallet into its bank account, then let
 * the matcher post what it is sure of. Returns what happened.
 */
export async function syncWalletFeed(db: LedgerDb, companyId: string, opts: { autoPost?: boolean; by?: string } = {}): Promise<ChainSyncResult | null> {
  const wallet = await getWallet(db, companyId);
  if (!wallet?.bankAccountId) return null;
  return syncChainAccount(db, companyId, { chain: TEMPO, address: wallet.address, bankAccountId: wallet.bankAccountId }, opts);
}
