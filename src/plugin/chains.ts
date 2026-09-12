/**
 * The chains a company can watch and pay on, and the feed that reads them.
 *
 * One stablecoin per chain: pathUSD on Tempo (testnet), USDC on Base and on
 * Ethereum. A wallet is watched by address; hot and hardware wallets look the
 * same from here. Transfers in and out become statement lines in the wallet's
 * bank account and the matcher takes it from there. Sends the company booked
 * itself (the payment carries the tx hash) settle without a guess.
 *
 * Token amounts are 6 decimals on every chain here; the ledger keeps cents.
 */
import { createPublicClient, http, parseAbiItem, getAddress, hexToString, pad, stringToHex, type Hex, type Chain, type PublicClient } from 'viem';
import { base, mainnet, tempoModerato } from 'viem/chains';
import { Addresses } from 'viem/tempo';
import {
  ACCOUNT,
  applyDecision,
  findTransactionBySourceRef,
  getBankAccount,
  getChainCursor,
  importStatementLines,
  listStatementLines,
  runReconciliation,
  setChainCursor,
  type LedgerDb,
  type ParsedLine,
} from '../core/index.js';

export interface ChainSpec {
  slug: string;
  name: string;
  chainId: number;
  rpc: string;
  explorer: string;
  testnet: boolean;
  /** what a browser wallet needs to add the chain */
  nativeCurrency: { name: string; symbol: string; decimals: number };
  token: { address: Hex; symbol: string; decimals: number; memo: boolean };
  /** what the invoice's payment option calls this network, for matching */
  labels: RegExp;
  /** the source ref prefix on payments booked when sent, kept stable for Tempo */
  refPrefix: string;
  viem: Chain;
}

const ZERO = '0x0000000000000000000000000000000000000000';
const TEMPO_FEE_MANAGER = String(Addresses.feeManager).toLowerCase();

export const CHAINS: Record<string, ChainSpec> = {
  'tempo-moderato': {
    slug: 'tempo-moderato',
    name: 'Tempo Moderato testnet',
    chainId: tempoModerato.id,
    rpc: 'https://rpc.moderato.tempo.xyz',
    explorer: 'https://explore.testnet.tempo.xyz',
    testnet: true,
    nativeCurrency: tempoModerato.nativeCurrency,
    token: { address: Addresses.pathUsd as Hex, symbol: 'pathUSD', decimals: 6, memo: true },
    labels: /tempo/i,
    refPrefix: 'tempo',
    viem: tempoModerato,
  },
  base: {
    slug: 'base',
    name: 'Base',
    chainId: base.id,
    rpc: 'https://mainnet.base.org',
    explorer: 'https://basescan.org',
    testnet: false,
    nativeCurrency: base.nativeCurrency,
    token: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6, memo: false },
    labels: /\bbase\b/i,
    refPrefix: 'base',
    viem: base,
  },
  ethereum: {
    slug: 'ethereum',
    name: 'Ethereum',
    chainId: mainnet.id,
    rpc: 'https://ethereum-rpc.publicnode.com',
    explorer: 'https://etherscan.io',
    testnet: false,
    nativeCurrency: mainnet.nativeCurrency,
    token: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6, memo: false },
    labels: /ethereum|mainnet|erc-?20/i,
    refPrefix: 'ethereum',
    viem: mainnet,
  },
};

export function chainOf(slug: string | null | undefined): ChainSpec | null {
  return slug ? CHAINS[slug.trim().toLowerCase()] ?? null : null;
}

/** The chain an invoice's crypto payment option means: its chain slug when it carries one, else the network label. */
export function chainForPaymentOption(details: { chain?: string | null; network?: string | null; asset?: string | null }): ChainSpec | null {
  const bySlug = chainOf(details.chain);
  if (bySlug) return bySlug;
  const label = details.network ?? '';
  for (const c of Object.values(CHAINS)) if (c.labels.test(label)) {
    // The asset must be the stablecoin this feed reads; anything else is not payable from here.
    if (details.asset && details.asset.trim().toUpperCase() !== c.token.symbol.toUpperCase()) return null;
    return c;
  }
  return null;
}

/** What the page and the plugin UI need to add a chain to a wallet and send on it. */
export function chainSummary(c: ChainSpec) {
  return { slug: c.slug, name: c.name, chainId: c.chainId, chainIdHex: `0x${c.chainId.toString(16)}`, rpc: c.rpc, explorer: c.explorer, testnet: c.testnet, nativeCurrency: c.nativeCurrency, token: { address: c.token.address, symbol: c.token.symbol, decimals: c.token.decimals, memo: c.token.memo } };
}

export function explorerTx(c: ChainSpec, hash: string): string {
  return `${c.explorer}/tx/${hash}`;
}

export function explorerAddress(c: ChainSpec, address: string): string {
  return `${c.explorer}/address/${address}`;
}

// ---------------------------------------------------------------------------
// Units and memos
// ---------------------------------------------------------------------------

export function centsToUnits(c: ChainSpec, cents: bigint): bigint {
  return cents * 10n ** BigInt(c.token.decimals - 2);
}

export function unitsToCents(c: ChainSpec, units: bigint): bigint {
  return units / 10n ** BigInt(c.token.decimals - 2);
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

// ---------------------------------------------------------------------------
// Reading the chain
// ---------------------------------------------------------------------------

const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 amount)');
const TRANSFER_MEMO_EVENT = parseAbiItem('event TransferWithMemo(address indexed from, address indexed to, uint256 amount, bytes32 indexed memo)');

export function publicClientFor(c: ChainSpec): PublicClient {
  return createPublicClient({ chain: c.viem, transport: http(c.rpc) }) as PublicClient;
}

export async function tokenBalanceCents(c: ChainSpec, address: string): Promise<bigint> {
  const client = publicClientFor(c);
  const units = await client.readContract({ address: c.token.address, abi: [parseAbiItem('function balanceOf(address) view returns (uint256)')], functionName: 'balanceOf', args: [getAddress(address.toLowerCase())] });
  return unitsToCents(c, BigInt(units));
}

export interface ChainTransfer { txHash: string; logIndex: number; blockNumber: bigint; from: string; to: string; units: bigint; memo: string }

/** Every stablecoin transfer touching the address between two blocks, with memos joined on where the chain has them. */
export async function transfersFor(c: ChainSpec, address: string, fromBlock: bigint, toBlock: bigint): Promise<ChainTransfer[]> {
  const client = publicClientFor(c);
  const a = getAddress(address.toLowerCase());
  const token = c.token.address;
  const [inbound, outbound] = await Promise.all([
    client.getLogs({ address: token, event: TRANSFER_EVENT, args: { to: a }, fromBlock, toBlock }),
    client.getLogs({ address: token, event: TRANSFER_EVENT, args: { from: a }, fromBlock, toBlock }),
  ]);
  const memos = new Map<string, string>();
  if (c.token.memo) {
    const [memosIn, memosOut] = await Promise.all([
      client.getLogs({ address: token, event: TRANSFER_MEMO_EVENT, args: { to: a }, fromBlock, toBlock }),
      client.getLogs({ address: token, event: TRANSFER_MEMO_EVENT, args: { from: a }, fromBlock, toBlock }),
    ]);
    for (const l of [...memosIn, ...memosOut]) memos.set(`${l.transactionHash}:${String(l.args.from).toLowerCase()}:${String(l.args.to).toLowerCase()}:${String(l.args.amount)}`, decodeMemo(l.args.memo as Hex));
  }
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
export function linesFrom(c: ChainSpec, address: string, transfers: ChainTransfer[], timestamps: Map<bigint, string>): ParsedLine[] {
  const me = address.toLowerCase();
  // Fee dust (sub-cent transfers) is not a line anyone reconciles.
  return transfers.filter((t) => unitsToCents(c, t.units) > 0n).map((t) => {
    const inbound = t.to.toLowerCase() === me;
    const other = inbound ? t.from : t.to;
    const cents = unitsToCents(c, t.units);
    return {
      postedAt: timestamps.get(t.blockNumber) ?? new Date().toISOString(),
      amountMinor: inbound ? cents : -cents,
      description: `${c.token.symbol} ${inbound ? 'from' : 'to'} ${other}${t.memo ? ` · ${t.memo}` : ''}`,
      payee: other,
      reference: t.memo || t.txHash.slice(0, 18),
      externalId: `${t.txHash}:${t.logIndex}`,
    };
  });
}

const MAX_SPAN = 5_000n;
const MAX_CATCH_UP = 400_000n;

/** The block about `days` ago, from the chain's recent pace. Never more than MAX_CATCH_UP blocks back. */
export async function blockDaysAgo(c: ChainSpec, days: number): Promise<bigint> {
  const client = publicClientFor(c);
  const head = await client.getBlockNumber();
  const sample = head > 2000n ? head - 2000n : 0n;
  const [a, b] = await Promise.all([client.getBlock({ blockNumber: head }), client.getBlock({ blockNumber: sample })]);
  const seconds = Number(a.timestamp - b.timestamp);
  const perBlock = seconds > 0 && head > sample ? seconds / Number(head - sample) : 2;
  const back = BigInt(Math.floor((Math.max(0, Math.min(days, 30)) * 86_400) / Math.max(perBlock, 0.2)));
  const capped = back > MAX_CATCH_UP ? MAX_CATCH_UP : back;
  return head > capped ? head - capped : 0n;
}

export interface ChainSyncResult { imported: number; duplicates: number; autoPosted: number; leftForReview: number; fromBlock: string; toBlock: string }

/**
 * Read new transfers for one address into its bank account, settle what the
 * chain proves outright, then let the matcher post what it is sure of.
 */
export async function syncChainAccount(
  db: LedgerDb,
  companyId: string,
  input: { chain: ChainSpec; address: string; bankAccountId: string },
  opts: { autoPost?: boolean; by?: string } = {},
): Promise<ChainSyncResult | null> {
  const { chain: c, address } = input;
  const bank = await getBankAccount(db, companyId, input.bankAccountId);
  if (!bank) return null;
  const client = publicClientFor(c);
  const head = await client.getBlockNumber();
  const cursor = await getChainCursor(db, bank.id);
  const from = cursor > 0n ? cursor + 1n : head - 1n;
  if (from > head) return { imported: 0, duplicates: 0, autoPosted: 0, leftForReview: 0, fromBlock: from.toString(), toBlock: head.toString() };
  let imported = 0;
  let duplicates = 0;
  let cur = from;
  while (cur <= head) {
    const to = cur + MAX_SPAN - 1n > head ? head : cur + MAX_SPAN - 1n;
    const transfers = await transfersFor(c, address, cur, to);
    if (transfers.length > 0) {
      const timestamps = new Map<bigint, string>();
      for (const b of new Set(transfers.map((t) => t.blockNumber))) {
        const blk = await client.getBlock({ blockNumber: b });
        timestamps.set(b, new Date(Number(blk.timestamp) * 1000).toISOString());
      }
      const r = await importStatementLines(db, companyId, bank.id, linesFrom(c, address, transfers, timestamps));
      imported += r.imported;
      duplicates += r.duplicates;
    }
    await setChainCursor(db, bank.id, to);
    cur = to + 1n;
  }
  // What the chain tells us outright, before the matcher guesses: a transfer
  // this company sent (the booked payment carries the tx hash) is that
  // payment; on the testnet, a mint from the zero address is faucet money.
  let settled = 0;
  if (imported > 0) {
    const by = opts.by ?? 'chain-feed';
    for (const line of await listStatementLines(db, companyId, bank.id, { status: 'unreconciled', limit: 500 })) {
      const hash = line.externalId?.split(':')[0];
      const cents = BigInt(line.amountMinor);
      try {
        if (hash && cents < 0n) {
          const txId = await findTransactionBySourceRef(db, companyId, c.refPrefix, `${c.refPrefix}:${hash}`);
          if (txId) { await applyDecision(db, companyId, line.id, { kind: 'match', transactionIds: [txId], reason: 'Same transaction hash as the payment booked when it was sent.' }, by); settled += 1; continue; }
        }
        // A send with the memo credit:<slug> is a top-up of the company's model credits at ai3.co: prepaid, not spent.
        if (cents < 0n && /^credit:[a-z0-9-]+$/i.test(line.reference ?? '')) {
          await applyDecision(db, companyId, line.id, { kind: 'create', accountCode: ACCOUNT.PREPAID_CREDITS, description: `Model credits topped up at ai3.co · ${line.reference}`, contactName: 'AI3', reason: 'Sent to the AI3 platform wallet with a credit memo.' }, by);
          settled += 1;
          continue;
        }
        if (c.testnet && cents > 0n && (line.payee ?? '').toLowerCase() === ZERO) {
          await applyDecision(db, companyId, line.id, { kind: 'create', accountCode: ACCOUNT.CONTRIBUTED_FUNDS, description: 'Test funds from the Tempo faucet', contactName: 'Tempo faucet', reason: 'Minted to this wallet by the testnet faucet.' }, by);
          settled += 1;
        }
      } catch { /* leave it for the matcher and the person */ }
    }
  }
  const run = imported > 0 ? await runReconciliation(db, companyId, bank.id, { autoPost: opts.autoPost ?? true, by: opts.by ?? 'chain-feed' }) : { autoPosted: 0, leftForReview: 0 };
  return { imported, duplicates, autoPosted: run.autoPosted + settled, leftForReview: run.leftForReview, fromBlock: from.toString(), toBlock: head.toString() };
}

export { TEMPO_FEE_MANAGER };
