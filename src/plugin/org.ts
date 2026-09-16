/**
 * Settings › AI3: the organisation as AI3 shows it.
 *
 * The directory profile, what the public page shows, who may join, and
 * whether the organisation is listed. The record lives on ai3.co, which
 * renders the directory from it; this file only relays, with the company's
 * key. Read: the current record with the allowed values beside each field.
 * Set: send the changed fields; ai3.co validates and answers with the record
 * as saved. A company that is not connected to ai3.co is told how to connect.
 */
import type { PluginContext } from '@paperclipai/plugin-sdk';
import type { CompanySettings } from '../core/index.js';
import { ai3Call, isConnected, type FetchLike } from './ai3.js';

export interface OrgProfile { name: string; tagline: string; about: string; website: string; category: string; logoUrl: string | null }
export interface OrgVisibility { figures: string; agents: string; members: string; activity: string }
export interface OrgOptions { categories: string[]; figures: string[]; agents: string[]; members: string[]; activity: string[]; joinPolicy: string[] }
export interface OrgState {
  connected: boolean;
  found: boolean;
  slug?: string;
  personal?: boolean;
  publicUrl?: string | null;
  profile?: OrgProfile;
  visibility?: OrgVisibility;
  joinPolicy?: string;
  listed?: boolean;
  options?: OrgOptions;
  updatedAt?: string | null;
  message?: string;
}

const NOT_CONNECTED: OrgState = { connected: false, found: false };

export function registerOrg(
  context: PluginContext,
  deps: {
    fetch: FetchLike;
    companyOf: (params: Record<string, unknown>) => Promise<string>;
    settingsOf: (companyId: string) => Promise<CompanySettings>;
    boardOnly: (ctx: { actor: { type: string; userId: string | null } }) => unknown;
  },
): void {
  context.data.register('org', async (params): Promise<OrgState> => {
    const companyId = await deps.companyOf(params);
    const settings = await deps.settingsOf(companyId);
    if (!isConnected(settings)) return NOT_CONNECTED;
    const remote = (await ai3Call(deps.fetch, settings, '/api/ledger/org', { companyId })) as Omit<OrgState, 'connected'>;
    return { connected: true, ...remote };
  });
  context.actions.register('org.set', async (params, ctx): Promise<OrgState> => {
    deps.boardOnly(ctx);
    const companyId = await deps.companyOf(params);
    const settings = await deps.settingsOf(companyId);
    const patch: Record<string, unknown> = { companyId };
    for (const k of ['profile', 'visibility', 'joinPolicy', 'listed'] as const) if (params[k] !== undefined) patch[k] = params[k];
    const remote = (await ai3Call(deps.fetch, settings, '/api/ledger/org/set', patch)) as Omit<OrgState, 'connected'>;
    return { connected: true, ...remote };
  });
}
