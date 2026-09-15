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
description: The company's books. Read the financial position, raise and email invoices, record supplier bills and payments, post journals, reconcile bank lines, and pull profit and loss, the balance sheet or the trial balance.
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
- Paying another company: \`pay-invoice\` with the invoice's ai3.co link. It
  pays from the Tempo wallet when the invoice offers one and the balance
  covers it, otherwise by the card the owner saved on ai3.co through Stripe
  (\`rail\` forces one). If neither works, the reply says what is missing (no
  wallet on the invoice, no card on file, seller without Stripe); pass that on.
- You pay only inside a spending authority the owner granted on ai3.co.
  \`pay-invoice\` asks before it moves money; a refusal names the rule (no
  authority, the inspection window still open, the first payment to a payee
  needing a person, a cap, an open dispute, a veto) and where the owner can
  change it. Report the refusal word for word and stop. Never split a
  payment, pay from another rail, or ask again in a loop to get around it.
- A delivery this organisation's acceptance agent failed is disputed, not
  paid: \`dispute-invoice\` with \`verdict\` set to the failed verdict's id
  (from run_acceptance_check on ai3.co) puts the failed rules and their
  evidence in the claim. A verdict that passed cannot be disputed this way.
- Getting paid by card: \`stripe\` tells you whether card payments are on. If
  not, \`stripe\` with \`connect: true\` returns an onboarding link; give it to
  the owner, never open it yourself. Stripe charges, fees and payouts land in
  the bank account "Stripe" and reconcile like any other feed.
- \`reconcile-queue\` shows each unexplained bank line with the ledger's proposal
  and confidence. Accept confident ones with \`reconcile\` \`{lineId, accept: true}\`;
  decide the rest with a \`decision\`; \`reconcile-all\` posts everything above a
  threshold in one go.
- Supplier bills go through \`create-bill\` (approve books the expense and the
  payable) and \`pay-bill\`. Put each line on the right expense account; ask
  \`chart-of-accounts\` for the codes.
- Anything no other tool covers is a manual journal: \`post-journal\` with
  balanced debit and credit lines and a narration saying why. A posted journal
  is undone with \`void-journal\`, never edited.
- When someone asks what is behind a figure on a report, use \`entries\` with
  the account and dates, then \`transaction\` for the full story of one line.
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
