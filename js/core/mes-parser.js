// Parser for Arcanum .mes brace-delimited tables.

export function parseMesText(text) {
  const map = new Map();
  const fields = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open === -1) break;
    const close = text.indexOf('}', open + 1);
    if (close === -1) break;
    fields.push(text.slice(open + 1, close));
    i = close + 1;
  }
  for (let n = 0; n + 1 < fields.length; n += 2) {
    const keyText = fields[n].trim();
    if (!/^[-+]?\d+$/.test(keyText)) continue;
    const key = Number(keyText);
    if (!Number.isSafeInteger(key)) continue;
    map.set(key, fields[n + 1]);
  }
  return map;
}

// For tables the game reads as a plain array: the values of every `{n}{text}`
// pair, trimmed, in ascending key order (the position in the list is what the
// game uses, not the key itself). Fields are read like mes.c::parse_field() does,
// i.e. anywhere in the text, not one entry per line.
export function parseMesNameList(text) {
  return [...parseMesText(text).entries()]
    .sort((a, b) => a[0] - b[0])
    .map(e => String(e[1]).trim());
}
