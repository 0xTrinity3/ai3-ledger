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
const HIDE_EXACT = new Set(['Create new organization...', 'Create new organization…', 'New Organization', 'Create one']);
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
  const section = /[?&]tab=network(&|$)/.test(location.search) ? 'Network' : 'Finance';
  root.querySelectorAll('nav[aria-label="breadcrumb"] span[role="link"], nav[aria-label="breadcrumb"] a').forEach((el) => {
    const t = textOf(el);
    if (t === 'AI3 Ledger' || ((t === 'Finance' || t === 'Network') && t !== section)) el.textContent = section;
  });
  // Paperclip names itself in a few hundred places in its bundle — "Paperclip
  // could not…", "Paperclip host", the docs entry — and those are literals no
  // setting reaches. The text nodes on screen are rewritten instead, whole
  // word only, never inside a field, a code sample or the books' own pages.
  renameHost(root);
  groomAccountMenu(root);
  const title = document.title;
  const renamed = title
    .replace(/^AI3 Ledger • Plugins • /, 'Finance • ')
    .replace(/(\s•\s)?Paperclip$/, (m, sep) => (sep ? `${sep}AI3` : 'AI3'));
  if (renamed !== title) document.title = renamed;
}

/**
 * The account menu is Paperclip's, and it is the only one: ai3.co has none of
 * its own. So it carries every setting a person has, each under the header
 * it belongs to, beside the host's own entries:
 *
 *   Profile        View profile · Edit profile (host) · Public profile on AI3
 *   Notifications  Email notifications · Daily digest
 *   Network        Invitations · What the bar shows · Connectors for Claude and ChatGPT
 *   App            Documentation · Feedback · dark mode (host)
 *   Account        Sign out (host, ends both sessions) · Delete account
 *
 * The host's nodes are never moved (React owns them); headers and AI3's
 * entries are inserted beside them. AI3's pages open inside the company,
 * through the rail's Network frame, at the section asked for.
 */
type MenuEntry = { key: string; label: string; description: string; path: string; icon: string };
type MenuHeader = { key: string; label: string; before: string };
const ICONS: Record<string, string> = {
  profile: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  invite: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6"/><path d="M22 11h-6"/>',
  bar: '<path d="M3 3v18h18"/><path d="M7 16l4-6 4 3 5-7"/>',
  plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a6 6 0 0 1-12 0V8z"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
};
/** Headers, placed before the host entry named; AI3's entries follow the host entry named in `after`, or the header. */
const MENU_HEADERS: MenuHeader[] = [
  { key: 'profile', label: 'Profile', before: 'View profile' },
  { key: 'notifications', label: 'Notifications', before: 'Documentation' },
  { key: 'network', label: 'Network', before: 'Documentation' },
  { key: 'app', label: 'App', before: 'Documentation' },
  { key: 'account', label: 'Account', before: 'Sign out' },
];
const MENU_ENTRIES: Array<MenuEntry & { after: string }> = [
  { key: 'public-profile', label: 'Public profile on AI3', description: 'Your headline and about, and whether you are listed.', path: '/me/settings#profile', icon: 'profile', after: 'Edit profile' },
  { key: 'notify', label: 'Email notifications', description: 'What AI3 emails you about your organisations.', path: '/me/settings#notifications', icon: 'bell', after: 'header:notifications' },
  { key: 'digest', label: 'Daily digest', description: 'When the one message a day lands, and in which time zone.', path: '/me/settings#digest', icon: 'clock', after: 'notify' },
  { key: 'invites', label: 'Invitations', description: 'Invite people to AI3, and see who used yours.', path: '/invites', icon: 'invite', after: 'header:network' },
  { key: 'navfig', label: 'What the bar shows', description: 'Portfolio, revenue, runway, credits, or nothing.', path: '/me/settings#nav', icon: 'bar', after: 'invites' },
  { key: 'connectors', label: 'Connectors', description: 'Work from Claude or ChatGPT: tokens, and who has access.', path: '/me/settings#connectors', icon: 'plug', after: 'navfig' },
  { key: 'delete', label: 'Delete account', description: 'Your profile and memberships go; your organisations do not.', path: '/me/settings#leaving', icon: 'trash', after: 'Sign out' },
];
const REPOINT: Record<string, string> = { Documentation: `${AI3_ORIGIN}/docs`, Feedback: `${AI3_ORIGIN}/contact` };

/** ai3.co's pages open inside the company, through the rail's Network frame. */
function insideHref(path: string): string {
  const prefix = location.pathname.split('/')[1] || '';
  return `/${prefix}/ledger?tab=network&p=${encodeURIComponent(path)}`;
}

function groomAccountMenu(root: ParentNode) {
  const items = Array.from(root.querySelectorAll('a.rounded-xl.items-start, button.rounded-xl.items-start')) as HTMLElement[];
  if (!items.length) return;
  const labelOf = (el: Element) => (el.querySelector('span.block.text-sm')?.textContent || '').trim();
  const byLabel = new Map(items.map((el) => [labelOf(el), el]));
  const docs = byLabel.get('Documentation');
  const menu = docs?.parentElement;
  if (!docs || !menu) return;
  for (const [label, href] of Object.entries(REPOINT)) {
    const el = byLabel.get(label);
    if (el instanceof HTMLAnchorElement && el.href !== href) el.href = href;
  }
  const mine = (key: string) => menu.querySelector(`[data-ai3-menu="${key}"]`) as HTMLElement | null;
  for (const h of MENU_HEADERS) {
    if (mine(`header:${h.key}`)) continue;
    const anchor = byLabel.get(h.before);
    if (!anchor) continue;
    const el = document.createElement('div');
    el.className = 'ai3-menu-head';
    el.textContent = h.label;
    el.setAttribute('data-ai3-menu', `header:${h.key}`);
    el.setAttribute('data-ai3-keep', '1');
    menu.insertBefore(el, anchor);
  }
  for (const e of MENU_ENTRIES) {
    if (mine(e.key)) continue;
    const after = e.after.startsWith('header:') ? mine(e.after) : (mine(e.after) || byLabel.get(e.after) || null);
    if (!after) continue;
    const node = document.createElement('a');
    node.className = docs.className;
    node.innerHTML = docs.innerHTML;
    node.href = insideHref(e.path);
    node.setAttribute('data-ai3-menu', e.key);
    node.setAttribute('data-ai3-keep', '1');
    const icon = node.querySelector('svg');
    if (icon) { icon.innerHTML = ICONS[e.icon] || ''; icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('fill', 'none'); icon.setAttribute('stroke', 'currentColor'); icon.setAttribute('stroke-width', '2'); icon.setAttribute('stroke-linecap', 'round'); icon.setAttribute('stroke-linejoin', 'round'); }
    const l = node.querySelector('span.block.text-sm');
    const d = node.querySelector('span.block.text-xs');
    if (l) l.textContent = e.label;
    if (d) d.textContent = e.description;
    if (e.key === 'delete') node.classList.add('ai3-menu-danger');
    after.insertAdjacentElement('afterend', node);
  }
  const out = byLabel.get('Sign out');
  if (out && !out.hasAttribute('data-ai3-out')) {
    out.setAttribute('data-ai3-out', '1');
    out.addEventListener('click', () => {
      try { fetch(`${AI3_ORIGIN}/logout`, { credentials: 'include', mode: 'no-cors', redirect: 'manual', keepalive: true }).catch(() => {}); } catch { /* the host still signs out of the tenant */ }
    }, { capture: true });
    const d = out.querySelector('span.block.text-xs');
    if (d) d.textContent = 'End this session, here and on ai3.co.';
  }
}

const HOST_WORD = /\bPaperclip\b/g;
const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'CODE', 'PRE', 'KBD', 'SAMP']);
function renameHost(root: ParentNode) {
  const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      HOST_WORD.lastIndex = 0;
      if (!HOST_WORD.test(node.nodeValue || '')) return NodeFilter.FILTER_REJECT;
      let el: Element | null = node.parentElement;
      while (el) {
        if (SKIP.has(el.tagName) || el.classList.contains('ai3') || el.hasAttribute('data-ai3-keep')) return NodeFilter.FILTER_REJECT;
        el = el.parentElement;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  for (const n of nodes) {
    HOST_WORD.lastIndex = 0;
    n.nodeValue = (n.nodeValue || '').replace(HOST_WORD, 'AI3');
  }
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
