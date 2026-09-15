// The pre-React half of the theme: linked from the shell's index.html by the
// box's brand step, so the sign-in page (outside the plugin shell) and the
// first paint carry AI3 before the ledger plugin has loaded.
import { installTheme } from './theme.js';

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => installTheme());
else installTheme();
