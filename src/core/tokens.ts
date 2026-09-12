/**
 * Which agent burned which tokens, and how to split a real bill between them.
 *
 * Paperclip records tokens per agent per model on every cost event, but assigns
 * `cost_cents = 0` when a run goes through a flat-rate adapter — a CLI pointed at
 * OpenRouter, for instance. The tokens are real, the money is real, and the
 * price Paperclip puts on it is zero. Booking that literally would tell a company
 * its agents cost nothing.
 *
 * So the amount and the attribution come from different places, on purpose:
 *
 *   the amount   is metered on the provisioned key and arrives through credits.
 *                It is real money and nothing here computes it.
 *   the split    is this file. Measured tokens, weighted by what a model of that
 *                class costs relative to the others, then apportioned.
 *
 * That distinction is the whole point. A wrong weight moves the split a little;
 * it cannot invent a total. A rate card used to compute the total would do
 * exactly that, which is why one is not used for it.
 */
import { toMinor, type Minor, type SqlClient } from './sql.js';

/**
 * What a token costs relative to the others. Not prices — ratios, and only ever
 * used to compare one agent's usage with another's in the same period.
 *
 * Output tokens cost several times input, and a cache read is a fraction of it.
 * These are the ratios the frontier models have held to for a while; they move
 * slowly, and a change of a few points shifts an allocation by a few points.
 */
export const TOKEN_WEIGHT = { input: 1, cached: 0.1, output: 5 } as const;

/**
 * Model classes, again relative. `openrouter/auto` resolves to a real model per
 * call and the event records which, so the class is read from the name that
 * actually ran rather than from what was asked for.
 */
export const MODEL_CLASS: Array<{ match: RegExp; weight: number }> = [
  { match: /opus/i, weight: 15 },
  { match: /sonnet|gpt-4o|gpt-5|grok/i, weight: 3 },
  { match: /haiku|mini|flash|small/i, weight: 1 },
];
export const DEFAULT_MODEL_WEIGHT = 3;

export function modelWeight(model: string | null | undefined): number {
  const name = String(model ?? '');
  for (const c of MODEL_CLASS) if (c.match.test(name)) return c.weight;
  return DEFAULT_MODEL_WEIGHT;
}

export interface AgentTokens {
  /** The agent that caused it, or null for work nobody attributed. */
  agent: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** Tokens weighted for output and model class. A ratio, never a price. */
  weight: number;
  /** What Paperclip itself priced, where it priced anything. */
  reportedMinor: string;
}

interface Row {
  agent_id: string | null;
  model: string | null;
  input_tokens: unknown;
  cached_input_tokens: unknown;
  output_tokens: unknown;
  cost_cents: unknown;
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * Token usage per agent for a window, read straight from Paperclip's own cost
 * events. Grouped by model first because the weighting depends on it.
 */
export async function agentTokens(sql: SqlClient, companyId: string, window: { from: Date | string; to: Date | string }): Promise<AgentTokens[]> {
  const rows = await sql.query<Row>(
    `SELECT agent_id, model,
            SUM(input_tokens)        AS input_tokens,
            SUM(cached_input_tokens) AS cached_input_tokens,
            SUM(output_tokens)       AS output_tokens,
            SUM(cost_cents)          AS cost_cents
       FROM public.cost_events
      WHERE company_id = $1::uuid AND occurred_at >= $2::timestamptz AND occurred_at < $3::timestamptz
      GROUP BY agent_id, model`,
    [companyId, new Date(window.from).toISOString(), new Date(window.to).toISOString()],
  );
  const byAgent = new Map<string, AgentTokens>();
  for (const r of rows) {
    const key = r.agent_id ?? '';
    const acc = byAgent.get(key) ?? { agent: r.agent_id ?? null, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, weight: 0, reportedMinor: '0' };
    const input = num(r.input_tokens);
    const cached = num(r.cached_input_tokens);
    const output = num(r.output_tokens);
    acc.inputTokens += input;
    acc.cachedInputTokens += cached;
    acc.outputTokens += output;
    acc.weight += (input * TOKEN_WEIGHT.input + cached * TOKEN_WEIGHT.cached + output * TOKEN_WEIGHT.output) * modelWeight(r.model);
    acc.reportedMinor = (BigInt(acc.reportedMinor) + toMinor(num(r.cost_cents))).toString();
    byAgent.set(key, acc);
  }
  return [...byAgent.values()].sort((a, b) => b.weight - a.weight);
}

export interface Allocation { agent: string | null; amountMinor: bigint; share: number }

/**
 * Split one real amount across agents by weight, to the penny.
 *
 * Largest remainder, so the parts always add back to the whole: a company's
 * agents between them account for exactly what the company was charged, never a
 * penny more or less. With no weights at all the whole amount stays
 * unattributed rather than being spread evenly over agents that may have done
 * nothing.
 */
export function allocate(amountMinor: Minor | bigint, tokens: AgentTokens[]): Allocation[] {
  const total = typeof amountMinor === 'bigint' ? amountMinor : toMinor(amountMinor);
  if (total <= 0n) return [];
  const weights = tokens.filter((t) => t.weight > 0);
  const sum = weights.reduce((n, t) => n + t.weight, 0);
  if (sum <= 0) return [{ agent: null, amountMinor: total, share: 1 }];

  const exact = weights.map((t) => ({ agent: t.agent, share: t.weight / sum, want: (Number(total) * t.weight) / sum }));
  const out = exact.map((e) => ({ agent: e.agent, amountMinor: BigInt(Math.floor(e.want)), share: e.share, rem: e.want - Math.floor(e.want) }));
  let left = total - out.reduce((n, o) => n + o.amountMinor, 0n);
  for (const o of [...out].sort((a, b) => b.rem - a.rem)) {
    if (left <= 0n) break;
    o.amountMinor += 1n;
    left -= 1n;
  }
  return out
    .filter((o) => o.amountMinor > 0n)
    .map(({ agent, amountMinor: a, share }) => ({ agent, amountMinor: a, share }));
}
