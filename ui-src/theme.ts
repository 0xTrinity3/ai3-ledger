/**
 * AI3 inside Paperclip: the one theme, applied two ways.
 *
 *   1. From the ledger plugin, on every page of the signed-in shell
 *      (installTheme, called by the Finance sidebar item).
 *   2. From the shell's own index.html on the box, so the sign-in page and the
 *      first paint carry it too (brand.ts, built to dist/ui/brand.js and
 *      dist/ui/theme.css; deploy/paperclip-brand.sh on the site links them).
 *
 * Nothing upstream is patched. The stylesheet overrides the host's own tokens;
 * the observer below renames and hides by text what CSS cannot reach:
 * Paperclip's title, its "Create new organization" and "Sign out" entries
 * (ai3.co owns both), its version line, and the sign-in page's wording.
 */
import THEME_CSS from './theme.css';

export const AI3_ORIGIN = 'https://ai3.co';
export { THEME_CSS };

const STYLE_ID = 'ai3-theme';

/** Elements whose exact text marks a duplicate of something ai3.co owns. */
const HIDE_EXACT = new Set(['Create new organization...', 'Create new organization…', 'Sign out', 'New Organization', 'Create one']);
const HIDE_PREFIX = ['Paperclip v'];

const RENAME: Array<[RegExp, string]> = [
  [/^Sign in to Paperclip$/, 'Sign in to AI3'],
  [/^Use your email and password to access this instance\.$/, 'AI3 signs you in from ai3.co. Open your organisation there and you arrive here signed in.'],
  [/^Create your Paperclip account$/, 'Accounts are made at ai3.co'],
];

function textOf(el: Element): string {
  return (el.textContent || '').replace(/\s+/g, ' ').trim();
}

function mark(el: Element) {
  if (!el.hasAttribute('data-ai3-hide')) el.setAttribute('data-ai3-hide', '1');
}

/** One pass over what is on screen. Cheap, and idempotent, so it runs on every mutation. */
function groom(root: ParentNode) {
  // Menu entries and buttons that duplicate ai3.co.
  root.querySelectorAll('[role="menuitem"], button').forEach((el) => {
    const t = textOf(el);
    if (HIDE_EXACT.has(t)) mark(el);
  });
  // The version line under the account menu, and the "Need an account?" line on sign-in.
  root.querySelectorAll('p, div.mt-5').forEach((el) => {
    const t = textOf(el);
    if (HIDE_PREFIX.some((p) => t.startsWith(p))) mark(el);
    if (/^(Need an account\?|Already have an account\?)/.test(t) && el.querySelector('button')) mark(el);
  });
  // Wording that names the host.
  root.querySelectorAll('h1, p').forEach((el) => {
    const t = textOf(el);
    for (const [re, to] of RENAME) if (re.test(t) && el.textContent !== to) { el.textContent = to; break; }
  });
  // The "Plugins › AI3 Ledger" crumb over the books: the ledger is Finance
  // here, not an add-on. The crumb and its chevron go; the name changes.
  root.querySelectorAll('nav[aria-label="breadcrumb"] a').forEach((a) => {
    if (textOf(a) === 'Plugins' && /\/plugins$/.test(a.getAttribute('href') || '')) {
      const li = a.closest('li');
      const next = li?.nextElementSibling;
      if (next && (next.getAttribute('role') === 'presentation' || next.getAttribute('aria-hidden') === 'true')) mark(next);
      mark(li || a);
    }
  });
  root.querySelectorAll('nav[aria-label="breadcrumb"] span[role="link"], nav[aria-label="breadcrumb"] a').forEach((el) => {
    if (textOf(el) === 'AI3 Ledger') el.textContent = 'Finance';
  });
  const title = document.title;
  const renamed = title
    .replace(/^AI3 Ledger • Plugins • /, 'Finance • ')
    .replace(/(\s•\s)?Paperclip$/, (m, sep) => (sep ? `${sep}AI3` : 'AI3'));
  if (renamed !== title) document.title = renamed;
}

let observing = false;

/** Put the theme in the document once, and keep grooming as the host re-renders. */
export function installTheme(doc: Document = document) {
  if (!doc.getElementById(STYLE_ID)) {
    const el = doc.createElement('style');
    el.id = STYLE_ID;
    el.textContent = THEME_CSS;
    doc.head.appendChild(el);
  }
  groom(doc);
  if (observing) return;
  observing = true;
  let scheduled = false;
  const obs = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; groom(doc); });
  });
  obs.observe(doc.documentElement, { childList: true, subtree: true, characterData: true });
  const head = doc.querySelector('title');
  if (head) obs.observe(head, { childList: true, characterData: true, subtree: true });
}
