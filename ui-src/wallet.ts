/**
 * The person's own wallet in the browser: MetaMask, Rabby, Coinbase Wallet,
 * a hardware wallet behind any of them. EIP-6963 to find them, EIP-1193 to
 * talk to them. No wallet library: the four calls the ledger needs are
 * small, and the plugin page ships nothing it does not use.
 *
 * WalletConnect (mobile wallets by QR) goes through the same provider
 * interface when a project id is configured; that lives on the hosted
 * invoice page, not here, because the plugin page runs inside Paperclip
 * where a browser extension is the common case.
 */

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

export interface DiscoveredWallet { uuid: string; name: string; icon: string | null; rdns: string; provider: Eip1193Provider }

export interface ChainInfo { slug: string; name: string; chainId: number; chainIdHex: string; rpc: string; explorer: string; testnet: boolean; nativeCurrency: { name: string; symbol: string; decimals: number }; token: { address: string; symbol: string; decimals: number; memo: boolean } }

const SELECTORS = { transfer: '0xa9059cbb', transferWithMemo: '0x95777d59' };

export class WalletError extends Error {}

/** Every wallet that announces itself, plus a legacy window.ethereum if nothing announced. */
export function discoverWallets(timeoutMs = 400): Promise<DiscoveredWallet[]> {
  return new Promise((resolve) => {
    const found = new Map<string, DiscoveredWallet>();
    const onAnnounce = (ev: Event) => {
      const d = (ev as CustomEvent<{ info: { uuid: string; name: string; icon?: string; rdns: string }; provider: Eip1193Provider }>).detail;
      if (d?.info?.uuid && d.provider) found.set(d.info.uuid, { uuid: d.info.uuid, name: d.info.name, icon: d.info.icon ?? null, rdns: d.info.rdns, provider: d.provider });
    };
    window.addEventListener('eip6963:announceProvider', onAnnounce as EventListener);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    setTimeout(() => {
      window.removeEventListener('eip6963:announceProvider', onAnnounce as EventListener);
      const legacy = (window as unknown as { ethereum?: Eip1193Provider & { isMetaMask?: boolean } }).ethereum;
      if (found.size === 0 && legacy) found.set('legacy', { uuid: 'legacy', name: legacy.isMetaMask ? 'MetaMask' : 'Browser wallet', icon: null, rdns: 'window.ethereum', provider: legacy });
      resolve([...found.values()]);
    }, timeoutMs);
  });
}

function errorOf(err: unknown): WalletError {
  const e = err as { code?: number; message?: string; data?: { message?: string } };
  if (e?.code === 4001 || /rejected|denied/i.test(e?.message ?? '')) return new WalletError('You cancelled in the wallet.');
  return new WalletError(e?.data?.message ?? e?.message ?? 'The wallet refused.');
}

export async function connectWallet(p: Eip1193Provider): Promise<string> {
  try {
    const accounts = (await p.request({ method: 'eth_requestAccounts' })) as string[];
    const a = accounts?.[0];
    if (!a) throw new WalletError('The wallet gave no account.');
    return a;
  } catch (err) {
    throw errorOf(err);
  }
}

/** Switch the wallet to the chain, adding it first when the wallet does not know it. */
export async function ensureChain(p: Eip1193Provider, chain: ChainInfo): Promise<void> {
  const current = (await p.request({ method: 'eth_chainId' })) as string;
  if (parseInt(current, 16) === chain.chainId) return;
  try {
    await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chain.chainIdHex }] });
  } catch (err) {
    const e = err as { code?: number; message?: string };
    const unknown = e?.code === 4902 || /unrecognized|not added|Unrecognized chain/i.test(e?.message ?? '');
    if (!unknown) throw errorOf(err);
    try {
      await p.request({ method: 'wallet_addEthereumChain', params: [{ chainId: chain.chainIdHex, chainName: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls: [chain.rpc], blockExplorerUrls: [chain.explorer] }] });
    } catch (err2) {
      throw errorOf(err2);
    }
  }
  const after = (await p.request({ method: 'eth_chainId' })) as string;
  if (parseInt(after, 16) !== chain.chainId) throw new WalletError(`The wallet is not on ${chain.name}.`);
}

/** personal_sign of a plain message; returns the signature. */
export async function signMessage(p: Eip1193Provider, address: string, message: string): Promise<string> {
  const hex = `0x${Array.from(new TextEncoder().encode(message)).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  try {
    return (await p.request({ method: 'personal_sign', params: [hex, address] })) as string;
  } catch (err) {
    throw errorOf(err);
  }
}

function pad32(hex: string): string {
  return hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
}

export function memoHex(text: string): string {
  const bytes = new TextEncoder().encode(text.trim().slice(0, 32));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('').padEnd(64, '0');
}

/** The calldata for a stablecoin transfer: transferWithMemo on chains that have it and a memo to carry, else transfer. */
export function transferCalldata(chain: ChainInfo, to: string, amountMinor: bigint, memo: string | null): string {
  const units = amountMinor * 10n ** BigInt(chain.token.decimals - 2);
  const amount = units.toString(16).padStart(64, '0');
  if (chain.token.memo && memo) return `${SELECTORS.transferWithMemo}${pad32(to)}${amount}${memoHex(memo)}`;
  return `${SELECTORS.transfer}${pad32(to)}${amount}`;
}

/** Send the stablecoin. Resolves with the transaction hash once the wallet has broadcast it. */
export async function sendToken(p: Eip1193Provider, input: { from: string; chain: ChainInfo; to: string; amountMinor: bigint; memo: string | null }): Promise<string> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.to)) throw new WalletError('The payee address is not a 0x address.');
  if (input.amountMinor <= 0n) throw new WalletError('The amount must be positive.');
  await ensureChain(p, input.chain);
  try {
    return (await p.request({ method: 'eth_sendTransaction', params: [{ from: input.from, to: input.chain.token.address, data: transferCalldata(input.chain, input.to, input.amountMinor, input.memo), value: '0x0' }] })) as string;
  } catch (err) {
    throw errorOf(err);
  }
}

/** Poll the wallet's node for the receipt. */
export async function waitForReceipt(p: Eip1193Provider, txHash: string, timeoutMs = 120_000): Promise<{ status: 'success' | 'reverted'; blockNumber: string }> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const r = (await p.request({ method: 'eth_getTransactionReceipt', params: [txHash] }).catch(() => null)) as { status?: string; blockNumber?: string } | null;
    if (r?.blockNumber) return { status: r.status === '0x1' ? 'success' : 'reverted', blockNumber: String(parseInt(r.blockNumber, 16)) };
    await new Promise((res) => setTimeout(res, 1500));
  }
  throw new WalletError('No confirmation yet. The transaction may still land; check the explorer before paying again.');
}

export function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
