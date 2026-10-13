// Mutable app state shared across modules (with setters, since imports are read-only).

export let explorerMode = 'art';
export function setExplorerMode(value) {
  explorerMode = value;
  document.dispatchEvent(new CustomEvent('explorermodechange', { detail: value }));
  return explorerMode;
}

export let openGroup = null; // the single currently-open file's group, or null
export function setOpenGroup(value) { openGroup = value; return openGroup; }
