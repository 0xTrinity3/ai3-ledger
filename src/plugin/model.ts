/**
 * Settings › Model: the organisation's default model.
 *
 * One choice for every agent in the company. The choice itself lives on
 * ai3.co, which holds the company's OpenRouter key and writes the model into
 * each agent's adapter config; this file only relays. Read: the current
 * choice and the catalogue. Set: ask ai3.co to switch, applied within a
 * minute. A company without a key sees how to connect; a self-hosted company
 * is told the model is set per agent instead.
 */
import type { PluginContext } from '@paperclipai/plugin-sdk';
import type { CompanySettings } from '../core/index.js';
import { ai3Call, isConnected, type FetchLike } from './ai3.js';

export interface ModelChoice { key: string; id: string | null; name: string; vendor: string; blurb: string; color: string; mark: string }
export interface ModelCurrent { choice: string; id: string | null; setAt: string | null; pending: boolean }
export interface ModelState { connected: boolean; hosted: boolean; current: ModelCurrent | null; choices: ModelChoice[]; creditsUrl: string | null; message?: string }

const NOT_CONNECTED: ModelState = { connected: false, hosted: false, current: null, choices: [], creditsUrl: null };

export function registerModel(
  context: PluginContext,
  deps: {
    fetch: FetchLike;
    companyOf: (params: Record<string, unknown>) => Promise<string>;
    settingsOf: (companyId: string) => Promise<CompanySettings>;
    boardOnly: (ctx: { actor: { type: string; userId: string | null } }) => unknown;
  },
): void {
  context.data.register('model', async (params): Promise<ModelState> => {
    const companyId = await deps.companyOf(params);
    const settings = await deps.settingsOf(companyId);
    if (!isConnected(settings)) return NOT_CONNECTED;
    const remote = (await ai3Call(deps.fetch, settings, '/api/ledger/model', { companyId })) as Omit<ModelState, 'connected'>;
    return { connected: true, ...remote };
  });
  context.actions.register('model.set', async (params, ctx): Promise<ModelState> => {
    deps.boardOnly(ctx);
    const companyId = await deps.companyOf(params);
    const choice = typeof params['choice'] === 'string' ? params['choice'] : '';
    if (!/^[a-z0-9-]{1,32}$/.test(choice)) throw new Error('Pick one of the listed models');
    const settings = await deps.settingsOf(companyId);
    const remote = (await ai3Call(deps.fetch, settings, '/api/ledger/model/set', { companyId, choice })) as Omit<ModelState, 'connected'>;
    return { connected: true, ...remote };
  });
}
