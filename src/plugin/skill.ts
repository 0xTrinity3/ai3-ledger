/**
 * The company skill that teaches an agent to use the ledger over HTTP.
 *
 * Paperclip delivers every company skill into every agent run, so this is the
 * path that always works: the plugin's own API routes, called with the run's
 * Paperclip credentials. The same tools are also on the MCP tool gateway as
 * ai3.ledger:<name> when the company has a runtime MCP connection installed.
 */
import type { PluginManagedSkillDeclaration } from '@paperclipai/plugin-sdk';
import { TOOL_DECLARATIONS } from './tools.js';

export const LEDGER_SKILL_KEY = 'ai3-ledger';

function schemaSummary(schema: Record<string, unknown>): string {
  const props = (schema['properties'] ?? {}) as Record<string, { type?: string; description?: string; enum?: string[] }>;
  const required = new Set((schema['required'] as string[] | undefined) ?? []);
  const keys = Object.keys(props);
  if (keys.length === 0) return 'no parameters';
  return keys
    .map((k) => {
      const p = props[k]!;
      const kind = p.enum ? p.enum.join('|') : p.type ?? 'any';
      return `\`${k}\` (${kind}${required.has(k) ? ', required' : ''})${p.description ? `: ${p.description}` : ''}`;
    })
    .join('; ');
}

export function ledgerSkillMarkdown(): string {
  const rows = TOOL_DECLARATIONS.map((t) => `### ${t.name}\n${t.description}\n\nParameters: ${schemaSummary(t.parametersSchema as Record<string, unknown>)}\n`).join('\n');
  return `---
name: AI3 Ledger
description: The company's books. Read the financial position, raise and email invoices, record payments, reconcile bank lines, and pull profit and loss or the balance sheet.
---

# AI3 Ledger

The company keeps double-entry books in the AI3 Ledger plugin. You can read and
change them through the plugin's HTTP API with the Paperclip credentials every
run already has. Amounts are strings in major units, like "1250.00".

## How to call a tool

\`\`\`bash
BASE="\${PAPERCLIP_API_URL%/}"; BASE="\${BASE%/api}"
curl -s -X POST "$BASE/api/plugins/ai3.ledger/api/tools/position" \\
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d "{\\"companyId\\":\\"$PAPERCLIP_COMPANY_ID\\"}"
\`\`\`

Every call is \`POST $BASE/api/plugins/ai3.ledger/api/tools/<name>\` with a JSON
body of \`{"companyId": "...", ...parameters}\`. The reply is
\`{"content": "<one-line summary>", "data": {...}}\` or \`{"error": "<what went wrong>"}\`.
\`GET $BASE/api/plugins/ai3.ledger/api/tools?companyId=...\` lists the tools with
their parameter schemas.

If the same tools appear in your tool list as \`ai3.ledger:<name>\`, use those
instead; they are the same functions.

## Working rules

- Money in and out is real. Read \`position\` or \`invoices\` before acting.
- \`create-invoice\` issues by default and posts the receivable. Pass \`sendTo\`
  to email it in the same call; the email goes from the company owner's Gmail.
- \`record-payment\` defaults to the full outstanding amount.
- \`reconcile-queue\` shows each unexplained bank line with the ledger's proposal
  and confidence. Accept confident ones with \`reconcile\` \`{lineId, accept: true}\`;
  decide the rest with a \`decision\`; \`reconcile-all\` posts everything above a
  threshold in one go.
- Report what you did with the invoice number, amounts and links from the
  tool's reply. Never invent an invoice number.

## Tools

${rows}`;
}

export const LEDGER_SKILL: PluginManagedSkillDeclaration = {
  skillKey: LEDGER_SKILL_KEY,
  displayName: 'AI3 Ledger',
  slug: 'ai3-ledger',
  description: 'Read the books, raise and email invoices, record payments, reconcile bank lines, and pull reports through the AI3 Ledger.',
  markdown: ledgerSkillMarkdown(),
};
