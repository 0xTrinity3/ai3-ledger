/**
 * Settings › Model: the organisation's default model, inside Paperclip's
 * company settings next to General, Members and Finance.
 *
 * One choice for every agent in the company. ai3.co holds the company's
 * OpenRouter key and writes the model into each agent, so the page reads the
 * catalogue and the current choice from the worker's `model` provider and
 * saves through the `model.set` action; the switch lands within a minute.
 */
import React, { useEffect, useState } from 'react';
import { ErrorBoundary, useHostContext, usePluginAction, usePluginData } from '@paperclipai/plugin-sdk/ui';
import type { PluginPageProps } from '@paperclipai/plugin-sdk/ui';
import { Failure, Header, useRun, useStyles, type Company } from './index.js';

interface Choice { key: string; id: string | null; name: string; vendor: string; blurb: string; color: string; mark: string }
interface Current { choice: string; id: string | null; setAt: string | null; pending: boolean }
interface ModelState { connected: boolean; hosted: boolean; current: Current | null; choices: Choice[]; creditsUrl: string | null; message?: string }

const CSS = `
.ai3-models { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 12px; margin: 14px 0; }
.ai3-model { display: grid; grid-template-columns: auto 1fr; gap: 12px; align-items: start; padding: 14px 16px; border: 1px solid var(--border, #ddd); border-radius: 10px; background: var(--card, #fff); cursor: pointer; position: relative; }
.ai3-model:hover { border-color: var(--ai3-blue); }
.ai3-model.on { border-color: var(--ai3-blue); box-shadow: inset 0 0 0 1px var(--ai3-blue); }
.ai3-model input { position: absolute; opacity: 0; width: 0; height: 0; }
.ai3-model svg { margin-top: 2px; flex: none; }
.ai3-model-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ai3-model-text strong { font-weight: 600; }
.ai3-model-text em { font-style: normal; font-size: 12px; color: var(--ai3-blue); }
.ai3-model-text span { font-size: 13px; color: var(--muted-foreground, #666); }
.ai3-model .ai3-now { position: absolute; top: 10px; right: 12px; font-size: 11px; color: var(--muted-foreground, #666); text-transform: uppercase; letter-spacing: .04em; }
`;

function useModelStyles() {
  useEffect(() => {
    const id = 'ai3-ledger-model-styles';
    if (document.getElementById(id)) return;
    const el = document.createElement('style');
    el.id = id;
    el.textContent = CSS;
    document.head.appendChild(el);
  }, []);
}

function Mark({ choice, size = 26 }: { choice: Choice; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill={choice.color} dangerouslySetInnerHTML={{ __html: choice.mark }} />;
}

export function ModelSettings(_props: PluginPageProps) {
  useStyles();
  useModelStyles();
  const context = useHostContext();
  const companyId = context.companyId;
  const company = usePluginData<Company>('company', companyId ? { companyId } : {});
  const state = usePluginData<ModelState>('model', companyId ? { companyId } : {});
  const set = usePluginAction('model.set');
  const { run, busy } = useRun([state.refresh]);
  const [picked, setPicked] = useState<string | null>(null);
  if (!companyId) return <div className="ai3">Pick a company.</div>;
  const d = state.data;
  const current = d?.current?.choice ?? null;
  const selected = picked ?? current;
  const inForce = d?.choices.find((c) => c.key === current) ?? null;
  return (
    <ErrorBoundary>
      <div className="ai3">
        <Header crumb="Settings" title="Model" sub={company.data?.name} />
        <Failure error={state.error} />
        {!d && !state.error ? <div className="ai3-cap">Loading…</div> : null}
        {d && !d.connected ? (
          <div className="ai3-card">
            <h3>Connect to ai3.co first</h3>
            <div className="ai3-cap">The organisation's model is set through ai3.co, which holds the company's model key. Paste the company key under Settings › Finance › Sending invoices, then come back here.</div>
          </div>
        ) : null}
        {d && d.connected && !d.hosted ? (
          <div className="ai3-card">
            <h3>Set per agent on this instance</h3>
            <div className="ai3-cap">{d.message ?? 'This company is not hosted by ai3.co, so each agent keeps its own model under Agents › Configuration.'}</div>
          </div>
        ) : null}
        {d && d.connected && d.hosted ? (
          <>
            <div className="ai3-cap" style={{ maxWidth: 760 }}>
              The model every agent in {company.data?.name ?? 'this company'} runs on. Pick one and it is written to each agent within a minute; agents hired later inherit it. An agent can still be given its own model under Agents › Configuration, until the organisation's choice is changed again.
            </div>
            <div className="ai3-models">
              {d.choices.map((c) => (
                <label key={c.key} className={`ai3-model${selected === c.key ? ' on' : ''}`}>
                  <input type="radio" name="ai3-model" value={c.key} checked={selected === c.key} onChange={() => setPicked(c.key)} />
                  <Mark choice={c} />
                  <span className="ai3-model-text">
                    <strong>{c.name}</strong>
                    <em>{c.vendor}</em>
                    <span>{c.blurb}</span>
                  </span>
                  {current === c.key ? <span className="ai3-now">{d.current?.pending ? 'Applying' : 'In force'}</span> : null}
                </label>
              ))}
            </div>
            <div className="ai3-actions" style={{ alignItems: 'center' }}>
              <button
                className="ai3-btn primary"
                disabled={busy || !selected || selected === current}
                onClick={() => run(async () => { await set({ companyId, choice: selected }); setPicked(null); }, 'Model saved. Every agent switches within a minute.')}
              >
                Use this model
              </button>
              {inForce && d.current ? (
                <span className="ai3-cap">
                  {d.current.pending ? `Switching to ${inForce.name}` : `${inForce.name} in force`}
                  {d.current.setAt ? ` since ${new Date(d.current.setAt).toLocaleString()}` : ''}
                </span>
              ) : null}
              {d.creditsUrl ? <a className="ai3-cap" href={d.creditsUrl} target="_blank" rel="noreferrer">Model credits on ai3.co ↗</a> : null}
            </div>
            <div className="ai3-cap" style={{ marginTop: 14, maxWidth: 760 }}>
              Every choice runs through the company's own AI3 model key on OpenRouter and is charged from its credits. <strong>Auto</strong> is OpenRouter's router for now: it reads each request and picks a model for it.
            </div>
          </>
        ) : null}
      </div>
    </ErrorBoundary>
  );
}
