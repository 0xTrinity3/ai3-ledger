/**
 * Paperclip cost adapter. Reads `public.cost_events` through the plugin's
 * `ctx.db.query` (whitelisted via `database.coreReadTables` in the manifest)
 * and hands the core platform-neutral `CostRecord`s.
 *
 * Cursor: (created_at, id), not occurred_at. Paperclip may record a cost after
 * the moment it occurred, so paging by insertion time never skips a late
 * arrival. The transaction still carries occurred_at as its date.
 */
import type { CostBatch, CostCategory, CostCursor, CostRecord, CostSource, SqlClient } from '../core/index.js';
import { toMinor } from '../core/index.js';

export const PAPERCLIP = 'paperclip';

interface CostEventRow {
  id: string;
  company_id: string;
  agent_id: string | null;
  issue_id: string | null;
  project_id: string | null;
  goal_id: string | null;
  provider: string | null;
  biller: string | null;
  billing_type: string | null;
  cost_status: string | null;
  model: string | null;
  cost_cents: number | string | null;
  occurred_at: string | Date;
  /** created_at printed by PostgreSQL with full microsecond precision; the cursor value. */
  created_at_txt: string;
}

/** Decide which expense account a Paperclip cost belongs to. Unknown falls to 'other', never dropped. */
export function categorise(row: Pick<CostEventRow, 'model' | 'provider' | 'billing_type' | 'biller'>): CostCategory {
  const text = `${row.provider ?? ''} ${row.biller ?? ''}`.toLowerCase();
  if (row.model) return 'model';
  if (/sandbox|compute|workspace|container|vm\b/.test(text)) return 'compute';
  if (/tool|api|search|browser/.test(text)) return 'tool';
  if (row.billing_type === 'metered_api') return 'model';
  return 'other';
}

export function paperclipCostSource(sql: SqlClient): CostSource {
  return {
    platform: PAPERCLIP,
    async read(companyId: string, cursor: CostCursor, limit: number): Promise<CostBatch> {
      const rows = await sql.query<CostEventRow>(
        `SELECT id, company_id, agent_id, issue_id, project_id, goal_id, provider, biller, billing_type,
                cost_status, model, cost_cents, occurred_at, created_at::text AS created_at_txt
           FROM public.cost_events
          WHERE company_id = $1::uuid
            AND ($2::timestamptz IS NULL OR (created_at, id) > ($2::timestamptz, $3::uuid))
          ORDER BY created_at, id
          LIMIT $4::int`,
        [companyId, cursor.lastOccurredAt, cursor.lastEventRef, limit],
      );
      const records: CostRecord[] = rows.map((r) => {
        const cents = r.cost_cents == null ? 0n : toMinor(r.cost_cents);
        const category = categorise(r);
        const biller = r.biller ?? r.provider;
        return {
          ref: r.id,
          occurredAt: new Date(r.occurred_at),
          amountMinor: cents,
          currency: 'USD',
          category,
          ...(biller ? { biller } : {}),
          description: describe(r, category),
          estimated: r.cost_status !== 'reported',
          subject: {
            ...(r.agent_id ? { agent: r.agent_id } : {}),
            ...(r.project_id ? { project: r.project_id } : {}),
            ...(r.goal_id ? { goal: r.goal_id } : {}),
            ...(r.issue_id ? { work: r.issue_id } : {}),
          },
        };
      });
      const last = rows[rows.length - 1];
      return {
        records,
        next: last ? { lastEventRef: last.id, lastOccurredAt: last.created_at_txt } : cursor,
      };
    },
  };
}

function describe(r: CostEventRow, category: CostCategory): string {
  const who = r.provider ?? r.biller ?? 'paperclip';
  const what = r.model ? `${r.model}` : category;
  const how = r.billing_type && r.billing_type !== 'unknown' ? ` · ${r.billing_type.replace(/_/g, ' ')}` : '';
  return `${who} · ${what}${how}`;
}

export interface CostEventDetail {
  id: string;
  agentId: string | null;
  issueId: string | null;
  projectId: string | null;
  goalId: string | null;
  runId: string | null;
  provider: string | null;
  biller: string | null;
  billingType: string | null;
  costStatus: string | null;
  model: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  costCents: string | null;
  occurredAt: string;
}

/** One cost event by id, for the drill-down from a swept expense back to the run that caused it. */
export async function costEventDetail(sql: SqlClient, companyId: string, id: string): Promise<CostEventDetail | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const rows = await sql.query<CostEventRow & { heartbeat_run_id: string | null; input_tokens: number | null; cached_input_tokens: number | null; output_tokens: number | null; occurred_at_txt: string }>(
    `SELECT id, company_id, agent_id, issue_id, project_id, goal_id, heartbeat_run_id, provider, biller, billing_type, cost_status, model,
            input_tokens, cached_input_tokens, output_tokens, cost_cents, occurred_at, occurred_at::text AS occurred_at_txt, created_at::text AS created_at_txt
       FROM public.cost_events
      WHERE company_id = $1::uuid AND id = $2::uuid`,
    [companyId, id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    agentId: r.agent_id,
    issueId: r.issue_id,
    projectId: r.project_id,
    goalId: r.goal_id,
    runId: r.heartbeat_run_id,
    provider: r.provider,
    biller: r.biller,
    billingType: r.billing_type,
    costStatus: r.cost_status,
    model: r.model,
    inputTokens: r.input_tokens === null ? null : Number(r.input_tokens),
    cachedInputTokens: r.cached_input_tokens === null ? null : Number(r.cached_input_tokens),
    outputTokens: r.output_tokens === null ? null : Number(r.output_tokens),
    costCents: r.cost_cents === null ? null : String(r.cost_cents),
    occurredAt: r.occurred_at_txt,
  };
}
