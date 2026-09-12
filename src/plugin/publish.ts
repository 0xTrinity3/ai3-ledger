/**
 * Publishing the company summary to ai3.co.
 *
 * Every connected company pushes its summary once a day (and whenever the
 * board toggles the leaderboard). ai3.co keeps the latest copy for the
 * owner's portfolio page; the public leaderboard only ever shows companies
 * whose `leaderboardOptIn` travelled as true. The payload is figures only:
 * no customers, no invoice lines, nothing from Paperclip's own tables beyond
 * a count of tasks finished.
 */
import { companySummary, getSettings, markSummaryPublished, profitAndLoss, type CompanySettings, type CompanySummary, type LedgerDb } from '../core/index.js';
import { ai3Call, isConnected, type FetchLike } from './ai3.js';

export interface SummaryPayload {
  companyId: string;
  companyName: string;
  leaderboardOptIn: boolean;
  summary: CompanySummary;
  /** Paperclip tasks moved to done in the trailing 30 days, and open now. */
  tasks: { completed30d: number; open: number } | null;
  /**
   * Each agent as its own profit unit: what it earned and what it cost over the
   * trailing 30 days, from entries already tagged with the agent that caused
   * them. Unattributed entries are left out rather than spread around, so the
   * per-agent figures never add up to more than the company's own.
   *
   * ai3.co needs this to charge a markup on the cost of one listing's work
   * rather than on a company's whole model spend.
   */
  agents: AgentUnit[] | null;
}

export interface AgentUnit { agent: string; revenueMinor: string; costMinor: string; netMinor: string }

/** At most this many agents travel; a company with more has bigger problems than this payload. */
const MAX_AGENTS = 100;

/** Per-agent income and expense for the window, strongest cost first. */
export async function agentUnits(db: LedgerDb, companyId: string, window: { from: Date; to: Date }): Promise<AgentUnit[]> {
  const pnl = await profitAndLoss(db, companyId, window, 'agent');
  return pnl.groups
    // A null group is everything nobody attributed. Reporting it as an agent
    // called "null" would invite someone to bill for it.
    .filter((g) => g.key !== null && g.key !== '')
    .map((g) => ({ agent: String(g.key), revenueMinor: g.incomeMinor, costMinor: g.expenseMinor, netMinor: g.netMinor }))
    .sort((a, b) => (BigInt(b.costMinor) > BigInt(a.costMinor) ? 1 : BigInt(b.costMinor) < BigInt(a.costMinor) ? -1 : 0))
    .slice(0, MAX_AGENTS);
}

export interface IssueLike { status: string; updatedAt: string }

export function countTasks(issues: IssueLike[], now: Date): { completed30d: number; open: number } {
  const since = now.getTime() - 30 * 24 * 60 * 60 * 1000;
  return {
    completed30d: issues.filter((i) => i.status === 'done' && Date.parse(i.updatedAt) >= since).length,
    open: issues.filter((i) => i.status !== 'done' && i.status !== 'cancelled').length,
  };
}

export async function buildSummaryPayload(
  db: LedgerDb,
  input: { companyId: string; companyName: string; settings: CompanySettings; issues: IssueLike[] | null; now?: Date },
): Promise<SummaryPayload> {
  const now = input.now ?? new Date();
  const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  let agents: AgentUnit[] | null = null;
  try {
    agents = await agentUnits(db, input.companyId, { from, to: now });
  } catch {
    // Per-agent figures are an addition, not the point of the payload. A company
    // whose books cannot produce them still publishes everything else.
    agents = null;
  }
  return {
    companyId: input.companyId,
    companyName: input.settings.legalName || input.companyName,
    leaderboardOptIn: input.settings.leaderboardOptIn,
    summary: await companySummary(db, input.companyId, now),
    tasks: input.issues ? countTasks(input.issues, now) : null,
    agents,
  };
}

/** Push one company's summary. Returns false when the company is not connected. */
export async function publishSummary(
  db: LedgerDb,
  fetch: FetchLike,
  input: { companyId: string; companyName: string; issues: IssueLike[] | null; now?: Date; baseCurrency?: string },
): Promise<{ published: boolean; payload?: SummaryPayload }> {
  const settings = await getSettings(db, input.companyId, input.baseCurrency);
  if (!isConnected(settings)) return { published: false };
  const payload = await buildSummaryPayload(db, { ...input, settings });
  await ai3Call(fetch, settings, '/api/ledger/summary', payload);
  await markSummaryPublished(db, input.companyId, input.now ?? new Date());
  return { published: true, payload };
}
