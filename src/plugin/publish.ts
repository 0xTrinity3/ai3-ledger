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
import { companySummary, getSettings, markSummaryPublished, type CompanySettings, type CompanySummary, type LedgerDb } from '../core/index.js';
import { ai3Call, isConnected, type FetchLike } from './ai3.js';

export interface SummaryPayload {
  companyId: string;
  companyName: string;
  leaderboardOptIn: boolean;
  summary: CompanySummary;
  /** Paperclip tasks moved to done in the trailing 30 days, and open now. */
  tasks: { completed30d: number; open: number } | null;
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
  return {
    companyId: input.companyId,
    companyName: input.settings.legalName || input.companyName,
    leaderboardOptIn: input.settings.leaderboardOptIn,
    summary: await companySummary(db, input.companyId, now),
    tasks: input.issues ? countTasks(input.issues, now) : null,
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
