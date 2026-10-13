// Multi-field matching shared by every search box.
//
// The query is split on spaces; a file matches when EVERY word is found in at least one of its
// fields (file name, folder, description, text…). The first field a word was found in is reported,
// with a short excerpt, so the result card can say why the file matched.

export function splitTerms(query) {
  return String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
}

function excerpt(text, at, len) {
  const lineStart = text.lastIndexOf('\n', at) + 1;
  let lineEnd = text.indexOf('\n', at);
  if (lineEnd < 0) lineEnd = text.length;
  let from = lineStart, to = lineEnd;
  if (to - from > 100) { from = Math.max(lineStart, at - 40); to = Math.min(lineEnd, at + len + 55); }
  return `${from > lineStart ? '…' : ''}${text.slice(from, to).trim()}${to < lineEnd ? '…' : ''}`;
}

// fields: [{ label, text }]. Returns null, or { label, note } ("note" is empty for a file-name match).
export function matchFields(fields, terms) {
  let first = null;
  for (const term of terms) {
    let hit = null, at = -1;
    for (const field of fields) {
      if (!field.text) continue;
      field.lower ??= field.text.toLowerCase();
      at = field.lower.indexOf(term);
      if (at >= 0) { hit = field; break; }
    }
    if (!hit) return null;
    first ??= { hit, at, len: term.length };
  }
  if (!first) return null;
  const { hit, at, len } = first;
  const note = hit.label === 'name' ? '' : `${hit.label}: ${excerpt(hit.text, at, len)}`;
  return { label: hit.label, note };
}
