/**
 * Splitting a real bill between the agents that caused it.
 *
 * The amount is metered on a real key and is not computed here. The split is,
 * and the property that matters is that it always adds back to the whole.
 */
import { describe, it, expect } from 'vitest';
import { allocate, modelWeight, TOKEN_WEIGHT, DEFAULT_MODEL_WEIGHT, type AgentTokens } from '../src/core/index.js';

const t = (agent: string | null, weight: number): AgentTokens =>
  ({ agent, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, weight, reportedMinor: '0' });

const sum = (xs: Array<{ amountMinor: bigint }>) => xs.reduce((n, x) => n + x.amountMinor, 0n);

describe('model weights', () => {
  it('reads the model that actually ran, not the one that was asked for', () => {
    // openrouter/auto resolves per call; the event records what answered.
    expect(modelWeight('anthropic/claude-opus-4.1')).toBe(15);
    expect(modelWeight('anthropic/claude-sonnet-4.5')).toBe(3);
    expect(modelWeight('anthropic/claude-haiku-4.5')).toBe(1);
    expect(modelWeight('openrouter/auto')).toBe(DEFAULT_MODEL_WEIGHT);
    expect(modelWeight(null)).toBe(DEFAULT_MODEL_WEIGHT);
  });

  it('weights output above input and a cache read below both', () => {
    expect(TOKEN_WEIGHT.output).toBeGreaterThan(TOKEN_WEIGHT.input);
    expect(TOKEN_WEIGHT.cached).toBeLessThan(TOKEN_WEIGHT.input);
  });
});

describe('allocating a real charge', () => {
  it('adds back to the whole, to the penny', () => {
    // A total that cannot divide evenly by three.
    const split = allocate(10_000n, [t('a', 1), t('b', 1), t('c', 1)]);
    expect(sum(split)).toBe(10_000n);
    expect(split.map((s) => s.amountMinor).sort()).toEqual([3333n, 3333n, 3334n]);
  });

  it('never loses or invents a penny, whatever the weights', () => {
    const awkward = [t('a', 7), t('b', 11), t('c', 13), t('d', 0.5), t('e', 1e-6)];
    for (const total of [1n, 2n, 7n, 99n, 100n, 12_345n, 999_999n]) {
      expect(sum(allocate(total, awkward))).toBe(total);
    }
  });

  it('gives the busiest agent the largest share', () => {
    const split = allocate(100_000n, [t('busy', 900), t('quiet', 100)]);
    const busy = split.find((s) => s.agent === 'busy')!;
    const quiet = split.find((s) => s.agent === 'quiet')!;
    expect(busy.amountMinor).toBe(90_000n);
    expect(quiet.amountMinor).toBe(10_000n);
    expect(busy.share).toBeCloseTo(0.9, 5);
  });

  it('leaves work nobody caused unattributed rather than spreading it', () => {
    // A company where half the weight carries no agent id.
    const split = allocate(1000n, [t('a', 50), t(null, 50)]);
    expect(sum(split)).toBe(1000n);
    expect(split.find((s) => s.agent === null)!.amountMinor).toBe(500n);
    expect(split.find((s) => s.agent === 'a')!.amountMinor).toBe(500n);
  });

  it('keeps the whole charge on the company when no agent did anything', () => {
    // Real money spent, no tokens attributed to anyone: the charge is still
    // real, so it is booked whole rather than dropped or shared out evenly.
    const split = allocate(5_000n, []);
    expect(split).toEqual([{ agent: null, amountMinor: 5_000n, share: 1 }]);
    expect(sum(allocate(5_000n, [t('a', 0), t('b', 0)]))).toBe(5_000n);
    expect(allocate(5_000n, [t('a', 0)])[0]!.agent).toBe(null);
  });

  it('books nothing when nothing was charged', () => {
    expect(allocate(0n, [t('a', 10)])).toEqual([]);
    expect(allocate(-5n as unknown as bigint, [t('a', 10)])).toEqual([]);
  });

  it('drops an agent whose share rounds to nothing rather than posting a zero line', () => {
    const split = allocate(10n, [t('a', 1_000_000), t('dust', 1)]);
    expect(sum(split)).toBe(10n);
    expect(split.every((s) => s.amountMinor > 0n)).toBe(true);
    expect(split.find((s) => s.agent === 'dust')).toBeUndefined();
  });

  it('a wrong weight moves the split and cannot touch the total', () => {
    // The guarantee the design rests on: get the ratios wrong and the company
    // still owes exactly what it was charged.
    const right = allocate(100_000n, [t('a', 15), t('b', 1)]);
    const wrong = allocate(100_000n, [t('a', 3), t('b', 1)]);
    expect(sum(right)).toBe(100_000n);
    expect(sum(wrong)).toBe(100_000n);
    expect(right.find((s) => s.agent === 'a')!.amountMinor).not.toBe(wrong.find((s) => s.agent === 'a')!.amountMinor);
  });
});
