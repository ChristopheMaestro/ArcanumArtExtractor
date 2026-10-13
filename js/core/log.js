// On-page log panel.

import { logEl } from './dom.js';

export function log(message, kind) {
  if (!logEl) return;   // the on-page log was removed; messages are dropped
  const p = document.createElement('p');
  if (kind) p.className = kind;
  p.textContent = message;
  logEl.appendChild(p);
  logEl.classList.add('has-entries');
  logEl.scrollTop = logEl.scrollHeight;
}
