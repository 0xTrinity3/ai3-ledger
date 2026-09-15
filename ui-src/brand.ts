// The pre-React half of the theme: linked from the shell's index.html by the
// box's brand step, so the sign-in page (outside the plugin shell) and the
// first paint carry AI3 before the ledger plugin has loaded.
import { installTheme } from './theme.js';

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => installTheme());
else installTheme();

// Paperclip's own sign-in page — email and password — is not a way into AI3:
// Google on ai3.co is. So the page is left before it is seen, for ai3.co's
// sign-in, which comes back through the login handoff to the page that was
// being opened. ?manual=1 keeps the form, for the operator.
(function () {
  if (!/^\/auth(\/|$)/.test(location.pathname)) return;
  const q = new URLSearchParams(location.search);
  if (q.get('manual') === '1') return;
  const next = q.get('next') || '/';
  location.replace(`https://ai3.co/workspace?host=${encodeURIComponent(location.host)}&next=${encodeURIComponent(next)}`);
})();

