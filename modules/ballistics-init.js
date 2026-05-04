// Calculator bootstrap. Loaded as `<script type="module" src="..."></script>`
// from ballistics.html. Lives here rather than as an inline script because
// ballistics.html's CSP forbids inline execution (`script-src 'self'
// https://cdnjs.cloudflare.com`, no `'unsafe-inline'`) — same posture as
// index.html / diary.html / deerschool.html. An inline `<script type="module">`
// gets blocked with the same CSP violation as any other inline script.
import { initBallisticsUi } from './ballistics-ui.js';

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initBallisticsUi);
} else {
  initBallisticsUi();
}
