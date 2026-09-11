/**
 * The catalogue behind "Add bank account": banks, cards and payment providers
 * a company run by agents is likely to hold, each with the aggregator that
 * would carry its feed, the way Xero lists every institution behind one search
 * box regardless of which feed network serves it.
 *
 * Feeds are behind one interface per provider (Plaid for the US, TrueLayer and
 * GoCardless for the UK and EU, Stripe by its own API). Until a provider's
 * credentials are configured on the host, choosing an institution still
 * creates the account, marks the feed as pending, and uploads work.
 */

export type FeedProvider = 'plaid' | 'truelayer' | 'gocardless' | 'stripe' | 'upload';

export interface FeedInstitution {
  id: string;
  name: string;
  kind: 'bank' | 'card' | 'stripe' | 'wallet';
  countries: string[]; // ISO-3166 alpha-2; '*' for anywhere
  provider: FeedProvider;
  connectionType: 'automatic feed' | 'API key' | 'upload';
  popular?: boolean;
}

export const FEED_INSTITUTIONS: FeedInstitution[] = [
  // Payment providers
  { id: 'stripe', name: 'Stripe', kind: 'stripe', countries: ['*'], provider: 'stripe', connectionType: 'API key', popular: true },
  { id: 'stripe-card', name: 'Stripe Corporate Card', kind: 'card', countries: ['US', 'GB', 'EU'], provider: 'stripe', connectionType: 'API key' },
  { id: 'paypal', name: 'PayPal Business', kind: 'bank', countries: ['*'], provider: 'upload', connectionType: 'upload' },
  // United States
  { id: 'mercury', name: 'Mercury', kind: 'bank', countries: ['US'], provider: 'plaid', connectionType: 'automatic feed', popular: true },
  { id: 'brex', name: 'Brex', kind: 'card', countries: ['US'], provider: 'plaid', connectionType: 'automatic feed', popular: true },
  { id: 'ramp', name: 'Ramp', kind: 'card', countries: ['US'], provider: 'plaid', connectionType: 'automatic feed' },
  { id: 'chase', name: 'Chase Business', kind: 'bank', countries: ['US'], provider: 'plaid', connectionType: 'automatic feed', popular: true },
  { id: 'bofa', name: 'Bank of America Business', kind: 'bank', countries: ['US'], provider: 'plaid', connectionType: 'automatic feed' },
  { id: 'wells', name: 'Wells Fargo Business', kind: 'bank', countries: ['US'], provider: 'plaid', connectionType: 'automatic feed' },
  { id: 'svb', name: 'Silicon Valley Bank', kind: 'bank', countries: ['US'], provider: 'plaid', connectionType: 'automatic feed' },
  { id: 'relay', name: 'Relay', kind: 'bank', countries: ['US'], provider: 'plaid', connectionType: 'automatic feed' },
  { id: 'amex-us', name: 'American Express (US)', kind: 'card', countries: ['US'], provider: 'plaid', connectionType: 'automatic feed' },
  // United Kingdom
  { id: 'monzo-biz', name: 'Monzo Business', kind: 'bank', countries: ['GB'], provider: 'truelayer', connectionType: 'automatic feed', popular: true },
  { id: 'starling', name: 'Starling Business', kind: 'bank', countries: ['GB'], provider: 'truelayer', connectionType: 'automatic feed', popular: true },
  { id: 'tide', name: 'Tide', kind: 'bank', countries: ['GB'], provider: 'truelayer', connectionType: 'automatic feed' },
  { id: 'barclays-biz', name: 'Barclays Business (UK)', kind: 'bank', countries: ['GB'], provider: 'truelayer', connectionType: 'automatic feed', popular: true },
  { id: 'hsbc-biz', name: 'HSBC Business (UK)', kind: 'bank', countries: ['GB'], provider: 'truelayer', connectionType: 'automatic feed' },
  { id: 'lloyds-biz', name: 'Lloyds Business (UK)', kind: 'bank', countries: ['GB'], provider: 'truelayer', connectionType: 'automatic feed' },
  { id: 'natwest-biz', name: 'NatWest Business', kind: 'bank', countries: ['GB'], provider: 'truelayer', connectionType: 'automatic feed' },
  { id: 'santander-uk', name: 'Santander Business (UK)', kind: 'bank', countries: ['GB'], provider: 'truelayer', connectionType: 'automatic feed' },
  { id: 'amex-uk', name: 'American Express (UK)', kind: 'card', countries: ['GB'], provider: 'truelayer', connectionType: 'automatic feed' },
  { id: 'barclaycard', name: 'Barclaycard Business', kind: 'card', countries: ['GB'], provider: 'truelayer', connectionType: 'automatic feed' },
  // Europe and multi-currency
  { id: 'wise', name: 'Wise Business', kind: 'bank', countries: ['*'], provider: 'gocardless', connectionType: 'automatic feed', popular: true },
  { id: 'revolut-biz', name: 'Revolut Business', kind: 'bank', countries: ['GB', 'EU'], provider: 'gocardless', connectionType: 'automatic feed', popular: true },
  { id: 'qonto', name: 'Qonto', kind: 'bank', countries: ['EU'], provider: 'gocardless', connectionType: 'automatic feed' },
  { id: 'n26-biz', name: 'N26 Business', kind: 'bank', countries: ['EU'], provider: 'gocardless', connectionType: 'automatic feed' },
  { id: 'bunq', name: 'bunq', kind: 'bank', countries: ['EU'], provider: 'gocardless', connectionType: 'automatic feed' },
  { id: 'ing-biz', name: 'ING Business', kind: 'bank', countries: ['EU'], provider: 'gocardless', connectionType: 'automatic feed' },
  { id: 'deutsche', name: 'Deutsche Bank Business', kind: 'bank', countries: ['EU'], provider: 'gocardless', connectionType: 'automatic feed' },
  { id: 'bnp', name: 'BNP Paribas Pro', kind: 'bank', countries: ['EU'], provider: 'gocardless', connectionType: 'automatic feed' },
  // Anywhere
  { id: 'other-bank', name: 'Another bank (upload statements)', kind: 'bank', countries: ['*'], provider: 'upload', connectionType: 'upload' },
  { id: 'other-card', name: 'A company card (upload statements)', kind: 'card', countries: ['*'], provider: 'upload', connectionType: 'upload' },
  { id: 'wallet', name: 'A wallet (upload exports)', kind: 'wallet', countries: ['*'], provider: 'upload', connectionType: 'upload' },
];

/** Search the catalogue the way Xero does: by name, filtered to a country, popular ones first when the query is empty. */
export function searchInstitutions(query: string, country = 'US'): FeedInstitution[] {
  const q = query.trim().toLowerCase();
  const inCountry = (i: FeedInstitution) => i.countries.includes('*') || i.countries.includes(country) || (country !== 'GB' && country !== 'US' && i.countries.includes('EU'));
  const hits = FEED_INSTITUTIONS.filter((i) => (q ? i.name.toLowerCase().includes(q) : true));
  const local = hits.filter(inCountry);
  const elsewhere = hits.filter((i) => !inCountry(i));
  const sortPop = (a: FeedInstitution, b: FeedInstitution) => Number(Boolean(b.popular)) - Number(Boolean(a.popular)) || a.name.localeCompare(b.name);
  return [...local.sort(sortPop), ...elsewhere.sort(sortPop)];
}

/** Which aggregator carries a country's banks. Both are wired behind one interface. */
export function providerFor(country: string): FeedProvider {
  if (country === 'US' || country === 'CA') return 'plaid';
  if (country === 'GB') return 'truelayer';
  return 'gocardless';
}
