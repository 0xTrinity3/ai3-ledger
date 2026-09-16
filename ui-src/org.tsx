/**
 * Settings › AI3: the organisation as AI3 shows it, inside Paperclip's
 * company settings next to General, Members, Finance and Model.
 *
 * The directory profile, what the public page shows, who may join, and
 * whether it is listed. Read from the worker's `org` provider, saved through
 * the `org.set` action; ai3.co holds the record and renders the directory
 * from it. This is the only place these are edited.
 */
import React, { useEffect, useState } from 'react';
import { ErrorBoundary, useHostContext, usePluginAction, usePluginData } from '@paperclipai/plugin-sdk/ui';
import type { PluginPageProps } from '@paperclipai/plugin-sdk/ui';
import { Failure, Header, useRun, useStyles, type Company } from './index.js';

interface Profile { name: string; tagline: string; about: string; website: string; category: string; logoUrl: string | null }
interface Visibility { figures: string; agents: string; members: string; activity: string }
interface Options { categories: string[]; figures: string[]; agents: string[]; members: string[]; activity: string[]; joinPolicy: string[] }
interface OrgState { connected: boolean; found: boolean; slug?: string; personal?: boolean; publicUrl?: string | null; profile?: Profile; visibility?: Visibility; joinPolicy?: string; listed?: boolean; options?: Options; updatedAt?: string | null; message?: string }

const CSS = `
.ai3-org { display: grid; gap: 22px; max-width: 760px; }
.ai3-org fieldset { border: 1px solid var(--border, #ddd); border-radius: 10px; padding: 14px 16px 16px; display: grid; gap: 12px; margin: 0; }
.ai3-org legend { font-size: 12px; letter-spacing: .06em; text-transform: uppercase; color: var(--ai3-blue); padding: 0 6px; }
.ai3-org label { display: grid; gap: 5px; font-size: 13px; }
.ai3-org input, .ai3-org textarea, .ai3-org select { font: inherit; padding: 8px 10px; border: 1px solid var(--border, #ccc); border-radius: 8px; background: var(--background, #fff); color: inherit; }
.ai3-org textarea { min-height: 96px; resize: vertical; }
.ai3-org .ai3-choice { display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: center; }
.ai3-org .ai3-note { font-size: 12px; color: var(--muted-foreground, #666); }
.ai3-org .ai3-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
`;

const LABEL: Record<string, string> = {
  figures: 'Figures from the books', agents: 'Agents', members: 'Members', activity: 'How it is run',
  none: 'Hidden', summary: 'Summary', full: 'Full', hidden: 'Hidden', count: 'Count only', list: 'Listed', public: 'Public',
  closed: 'Closed: invite only', request: 'People may ask; an admin approves', open: 'Anyone may join',
};
const label = (k: string) => LABEL[k] ?? k;

function useOrgStyles() {
  useEffect(() => {
    const id = 'ai3-ledger-org-styles';
    if (document.getElementById(id)) return;
    const el = document.createElement('style');
    el.id = id;
    el.textContent = CSS;
    document.head.appendChild(el);
  }, []);
}

export function Ai3Settings(_props: PluginPageProps) {
  useStyles();
  useOrgStyles();
  const context = useHostContext();
  const companyId = context.companyId;
  const company = usePluginData<Company>('company', companyId ? { companyId } : {});
  const state = usePluginData<OrgState>('org', companyId ? { companyId } : {});
  const set = usePluginAction('org.set');
  const { run, busy } = useRun([state.refresh]);
  const [draft, setDraft] = useState<{ profile: Profile; visibility: Visibility; joinPolicy: string; listed: boolean } | null>(null);
  const d = state.data;
  useEffect(() => {
    if (d?.found && d.profile && d.visibility && !draft) setDraft({ profile: { ...d.profile }, visibility: { ...d.visibility }, joinPolicy: d.joinPolicy ?? 'closed', listed: Boolean(d.listed) });
  }, [d, draft]);
  if (!companyId) return <div className="ai3">Pick a company.</div>;
  const dirty = Boolean(draft && d?.found && JSON.stringify(draft) !== JSON.stringify({ profile: d.profile, visibility: d.visibility, joinPolicy: d.joinPolicy, listed: Boolean(d.listed) }));
  const setProfile = (k: keyof Profile, v: string) => setDraft((x) => (x ? { ...x, profile: { ...x.profile, [k]: v } } : x));
  const setVis = (k: keyof Visibility, v: string) => setDraft((x) => (x ? { ...x, visibility: { ...x.visibility, [k]: v } } : x));
  return (
    <ErrorBoundary>
      <div className="ai3">
        <Header crumb="Settings" title="AI3" sub={company.data?.name} />
        <Failure error={state.error} />
        {!d && !state.error ? <div className="ai3-cap">Loading…</div> : null}
        {d && !d.connected ? (
          <div className="ai3-card">
            <h3>Connect to ai3.co first</h3>
            <div className="ai3-cap">This organisation's page on ai3.co is edited here once the company is connected. Paste the company key under Settings › Finance.</div>
          </div>
        ) : null}
        {d && d.connected && !d.found ? (
          <div className="ai3-card">
            <h3>No organisation record yet</h3>
            <div className="ai3-cap">{d.message ?? 'ai3.co has no record for this company yet.'}</div>
          </div>
        ) : null}
        {d && d.found && draft ? (
          <form className="ai3-org" onSubmit={(e) => { e.preventDefault(); void run(async () => { await set({ companyId, ...draft }); setDraft(null); }, 'Saved. The page on ai3.co shows it now.'); }}>
            <div className="ai3-cap">
              How {company.data?.name ?? 'this organisation'} appears on ai3.co: its page{d.publicUrl ? <> at <a href={d.publicUrl} target="_blank" rel="noreferrer">{d.publicUrl.replace(/^https?:\/\//, '')} ↗</a></> : ''}, the directory, the leaderboard and the feed. Figures come only from the books; nothing here is typed in as a number.
            </div>
            <fieldset>
              <legend>Profile</legend>
              <label>Name<input value={draft.profile.name} maxLength={120} onChange={(e) => setProfile('name', e.target.value)} /></label>
              <label>One line<input value={draft.profile.tagline} maxLength={160} placeholder="What it sells, in a sentence" onChange={(e) => setProfile('tagline', e.target.value)} /></label>
              <label>About<textarea value={draft.profile.about} maxLength={2000} onChange={(e) => setProfile('about', e.target.value)} /></label>
              <div className="ai3-choice">
                <label>Category
                  <select value={draft.profile.category} onChange={(e) => setProfile('category', e.target.value)}>
                    {(d.options?.categories ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </label>
                <label>Website<input value={draft.profile.website} maxLength={200} placeholder="https://" onChange={(e) => setProfile('website', e.target.value)} /></label>
              </div>
              <label>Logo URL<input value={draft.profile.logoUrl ?? ''} maxLength={300} placeholder="https://…/logo.png" onChange={(e) => setProfile('logoUrl', e.target.value)} /></label>
            </fieldset>
            <fieldset>
              <legend>What the public page shows</legend>
              {(['figures', 'agents', 'members', 'activity'] as Array<keyof Visibility>).map((k) => (
                <div className="ai3-choice" key={k}>
                  <span>{label(k)}</span>
                  <select value={draft.visibility[k]} onChange={(e) => setVis(k, e.target.value)}>
                    {((d.options as Record<string, string[]> | undefined)?.[k] ?? []).map((v) => <option key={v} value={v}>{label(v)}</option>)}
                  </select>
                </div>
              ))}
              <div className="ai3-note">Members always see everything. These settings decide what a visitor sees; figures shown come from the books, never from a claim.</div>
            </fieldset>
            {!d.personal ? (
              <fieldset>
                <legend>Joining and listing</legend>
                <div className="ai3-choice">
                  <span>Who may join</span>
                  <select value={draft.joinPolicy} onChange={(e) => setDraft((x) => (x ? { ...x, joinPolicy: e.target.value } : x))}>
                    {(d.options?.joinPolicy ?? []).map((v) => <option key={v} value={v}>{label(v)}</option>)}
                  </select>
                </div>
                <label className="ai3-row" style={{ display: 'flex' }}>
                  <input type="checkbox" checked={draft.listed} onChange={(e) => setDraft((x) => (x ? { ...x, listed: e.target.checked } : x))} />
                  <span>Show this organisation in the directory</span>
                </label>
                <div className="ai3-note">Unlisting removes it from the directory, the sitemap and the leaderboard; the page stays reachable by members only.</div>
              </fieldset>
            ) : null}
            <div className="ai3-actions" style={{ alignItems: 'center' }}>
              <button className="ai3-btn primary" type="submit" disabled={busy || !dirty}>Save</button>
              {dirty ? <button className="ai3-btn" type="button" disabled={busy} onClick={() => setDraft(null)}>Discard changes</button> : null}
              {d.updatedAt ? <span className="ai3-cap">Last saved {new Date(d.updatedAt).toLocaleString()}</span> : null}
            </div>
            <div className="ai3-note">
              To delete this organisation for good, use the Danger Zone under Settings › General: it removes the organisation from AI3, its agents and tasks here, its code repositories and its databases, and cannot be undone.
            </div>
          </form>
        ) : null}
      </div>
    </ErrorBoundary>
  );
}
