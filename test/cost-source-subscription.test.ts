import { describe, expect, it } from 'vitest';
import { isSubscriptionRun, listPriceCents } from '../src/plugin/cost-source.js';

describe('a subscription run is booked at list price, as an estimate', () => {
  it('recognises the zero-cost subscription row and nothing else', () => {
    expect(isSubscriptionRun({ billing_type: 'subscription_included', cost_cents: 0 })).toBe(true);
    expect(isSubscriptionRun({ billing_type: 'subscription_included', cost_cents: null })).toBe(true);
    expect(isSubscriptionRun({ billing_type: 'metered_api', cost_cents: 0 })).toBe(false);
    expect(isSubscriptionRun({ billing_type: 'subscription_included', cost_cents: 12 })).toBe(false);
  });
  it('prices tokens at the model rate, cached input at a tenth', () => {
    // 1M input on Haiku = $1, 1M output = $5.
    expect(listPriceCents({ model: 'claude-haiku-4-5-20251001', input_tokens: 1_000_000, cached_input_tokens: 0, output_tokens: 0 })).toBe(100);
    expect(listPriceCents({ model: 'claude-haiku-4-5-20251001', input_tokens: 0, cached_input_tokens: 0, output_tokens: 1_000_000 })).toBe(500);
    expect(listPriceCents({ model: 'claude-haiku-4-5-20251001', input_tokens: 1_000_000, cached_input_tokens: 1_000_000, output_tokens: 0 })).toBe(10);
    expect(listPriceCents({ model: 'gpt-5-mini', input_tokens: 1_000_000, cached_input_tokens: 0, output_tokens: 0 })).toBe(25);
    expect(listPriceCents({ model: 'something-new', input_tokens: 1_000_000, cached_input_tokens: 0, output_tokens: 0 })).toBe(300);
    expect(listPriceCents({ model: 'claude-haiku-4-5', input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 })).toBe(0);
  });
});
