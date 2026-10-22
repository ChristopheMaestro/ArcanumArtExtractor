// The library's bitmap-font text layout: the game's own fonts and papers drawn into a canvas (the Library screen of the Atlas)

(window.AtlasParts = window.AtlasParts || {}).library = function (env) {
  const { LB, LIB_BG, LIB_BG_VENDIGROTH, LIB_BOOK, LIB_H, LIB_NEWS, LIB_NOTE, LIB_PAPER_PARTS, LIB_PLAQUE, LIB_SIDEBAR, LIB_TELE_FINE, LIB_TELE_PARTS, LIB_TELE_TEXT, LIB_TEN, LIB_VENDIGROTH_PARTS, LIB_W, R } = env;

// the pictures (atlas/graphics/library/): loaded once, on first use. A font is its strip in black; the white ink (the plaque) is that
// strip with its ink coloured white
let libReady = null;
function libLoad() {
  if (!libReady) {
    const img = src => new Promise((ok, no) => { const im = new Image(); im.onload = () => ok(im); im.onerror = no; im.src = src; });
    const tint = (im, color) => {
      const c = document.createElement("canvas"); c.width = im.width; c.height = im.height;
      const g = c.getContext("2d"); g.drawImage(im, 0, 0); g.globalCompositeOperation = "source-in"; g.fillStyle = color; g.fillRect(0, 0, c.width, c.height);
      return c;
    };
    // the backgrounds are stacked in one sheet, the fonts in another: each is cut out by its y (and the sheet's width)
    const cut = (im, y, w, h) => {
      const c = document.createElement("canvas"); c.width = w; c.height = h;
      c.getContext("2d").drawImage(im, 0, y, w, h, 0, 0, w, h);
      return c;
    };
    const sheet = group => { const first = Object.values(group)[0]; return first ? img(first.src) : Promise.resolve(null); };
    LB.pics = { bg: {}, font: {} };
    libReady = Promise.all([sheet(LB.backgrounds), sheet(LB.fonts)]).then(([bgs, fonts]) => {
      for (const [n, b] of Object.entries(LB.backgrounds)) LB.pics.bg[n] = cut(bgs, b.y, b.w, b.h);
      for (const [n, f] of Object.entries(LB.fonts)) {
        const w = Math.max(...Object.values(f.glyphs).map(g => g[0] + g[1]), 1), black = cut(fonts, f.y, w, f.h);
        LB.pics.font[n] = { black, white: tint(black, "#fff") };
      }
    });
  }
  return libReady;
}

// a font's glyphs are numbered by the game's one-byte code page (Windows-1251 for the Russian Mod Pack, 1252 otherwise); the
// texts are Unicode: a character above 255 (Cyrillic, curly quotes, dashes) is looked up by its byte in that code page
const LIB_CP = (() => {
  const m = new Map();
  try { [...new TextDecoder(window.AtlasVer === "ru" ? "windows-1251" : "windows-1252").decode(Uint8Array.from({ length: 128 }, (_, i) => i + 128))].forEach((c, i) => m.set(c.charCodeAt(0), i + 128)); } catch (_) {}
  return m;
})();
const libCode = ch => { const c = ch.charCodeAt(0); return c > 255 ? LIB_CP.get(c) ?? c : c; };
// text in a bitmap font: the pen advances by each glyph's advance, the last glyph counts its own width
const libAdv = (f, ch, last) => { const g = f.glyphs[libCode(ch)]; return g ? (last ? g[1] : g[2]) : 4; };
const libWidth = (f, s) => { let w = 0; for (let i = 0; i < s.length; i++) w += libAdv(f, s[i], i === s.length - 1); return w; };
function libWrap(f, text, maxW) {
  const lines = [];
  for (const hard of text.split("\n")) {
    let line = "";
    for (const word of hard.split(" ")) {
      const next = line ? line + " " + word : word;
      if (!line || libWidth(f, next) <= maxW) line = next; else { lines.push(line); line = word; }
    }
    lines.push(line);
  }
  return lines;
}
function libDrawLines(ctx, num, color, lines, r, centered) {
  const f = LB.fonts[num], strip = LB.pics.font[num][color];
  ctx.save();
  ctx.beginPath(); ctx.rect(r.x - LIB_SIDEBAR, r.y, r.w, r.h); ctx.clip();
  lines.forEach((line, row) => {
    let x = r.x - LIB_SIDEBAR + (centered ? Math.floor((r.w - libWidth(f, line)) / 2) : 0);
    const y = r.y + row * f.h;
    for (let i = 0; i < line.length; i++) {
      const g = f.glyphs[libCode(line[i])];
      if (g && g[1]) ctx.drawImage(strip, g[0], 0, g[1], f.h, x, y, g[1], f.h);
      x += libAdv(f, line[i], i === line.length - 1);
    }
  });
  ctx.restore();
}
const libWrite = (ctx, text, num, color, r, centered) => libDrawLines(ctx, num, color, libWrap(LB.fonts[num], text, r.w), r, centered);
function libElement(ctx, text, num, x, y, align) {              // one line placed by its left edge, centre or right edge
  const f = LB.fonts[num], w = libWidth(f, text);
  libDrawLines(ctx, num, "black", [text], R(align === 0 ? x : align === 1 ? x - Math.floor(w / 2) : x - w, y, w + 2, f.h), false);
}
// "492c text": font number, c = centred (anything else = left), then the text
function libParse(s) {
  let i = 0;
  while (i < s.length && s[i] >= "0" && s[i] <= "9") i++;
  const font = parseInt(s, 10) || 0, centered = s[i] === "c" || s[i] === "C";
  if (i < s.length) i++;
  if (/\s/.test(s[i] || "")) i++;
  return [font, centered, s.slice(i)];
}
// a paragraph in a rectangle: { fit: true, used: height } or, when it does not fit, the part that does is drawn
// and { fit: false, off: characters used } says where the next column or page goes on
function libParagraph(ctx, str, num, centered, r, color) {
  const f = LB.fonts[num];
  if (!f) return { fit: true, used: 0 };
  const height = s => libWrap(f, s, r.w).length * f.h;
  if (height(str) > r.h) {
    let cut = 0;
    for (let pos = 0; pos < str.length; pos++) {
      if (str[pos] === " " || str[pos] === "\n") { if (height(str.slice(0, pos)) > r.h) break; cut = pos; }
    }
    if (cut > 0) libDrawLines(ctx, num, color, libWrap(f, str.slice(0, cut), r.w), r, centered);
    return { fit: false, off: cut };
  }
  libDrawLines(ctx, num, color, libWrap(f, str, r.w), r, centered);
  return { fit: true, used: height(str) };
}
// a book page or a plaque: paragraphs one after another until one does not fit; returns where the next page starts
function libPageLike(ctx, kind, base, r, at, color) {
  const T = env.libText[kind];
  let n = at.num;
  if (n >= base + LIB_TEN || !(n in T)) return null;
  let [fn, c, str] = libParse(T[n]);
  let box = { ...r }, res = libParagraph(ctx, str.slice(at.off), fn, c, box, color);
  if (!res.fit) return { num: n, off: at.off + res.off };
  for (;;) {
    box.y += res.used; box.h -= res.used;
    n++;
    if (n >= base + LIB_TEN || !(n in T)) return null;
    [fn, c, str] = libParse(T[n]);
    res = libParagraph(ctx, str, fn, c, box, color);
    if (!res.fit) return { num: n, off: res.off };
  }
}
function libBookPages(base) {                                   // where each page starts; two are shown at a time
  const scratch = document.createElement("canvas").getContext("2d"), pages = [{ num: base, off: 0 }];
  for (let i = 0; i < pages.length && pages.length < 100; i += 2) {
    let at = pages[i];
    for (let side = 0; side < 2 && at; side++) {
      const next = libPageLike(scratch, 0, base, LIB_BOOK[side], at, "black");
      at = next && (next.num !== at.num || next.off !== at.off) ? next : null;
      if (at && pages.length === i + side + 1) pages.push(at);
    }
  }
  return pages;
}
function libPaper(ctx, num, vendigroth) {                       // headline, then the story over the columns, then filler articles
  const T = env.libText[2], rects = LIB_NEWS.map(r => ({ ...r }));
  for (const [font, line, x, y, align] of vendigroth ? LIB_VENDIGROTH_PARTS : LIB_PAPER_PARTS) libElement(ctx, T[line] || "", font, x, y, align);
  if (num in T) { const [fn, c, str] = libParse(T[num]); libParagraph(ctx, str, fn, c, rects[0], "black"); }
  let n = num + 1;
  if (!(n in T)) return;
  let [fn, c, str] = libParse(T[n]), col = 1, box = { ...rects[1] }, res;
  const flow = () => {                                          // false when the columns are full
    while (!(res = libParagraph(ctx, str, fn, c, box, "black")).fit) {
      if (++col >= rects.length) return false;
      box = { ...rects[col] }; str = str.slice(res.off);
    }
    return true;
  };
  for (;;) {
    if (!flow()) return;
    box.y += res.used; box.h -= res.used;
    if (++n >= num + LIB_TEN || !(n in T)) break;
    [fn, c, str] = libParse(T[n]);
  }
  const fillers = Object.keys(T).filter(k => k >= 10 && k <= 999).length;
  let f = Math.floor(num / LIB_TEN) + 10;
  if (f >= fillers + 10) f = 10;
  if (!(f in T)) return;
  [fn, c, str] = libParse(T[f]);
  for (let guard = 0; guard < 200; guard++) {
    if (!flow()) return;
    if (++f >= fillers + 10) f = 10;
    if (!(f in T)) return;
    [fn, c, str] = libParse(T[f]);
    box.y += res.used; box.h -= res.used;
  }
}
// draws a document into the 668 x 400 canvas; `page` is the left page of a book. Returns the number of book pages.
function libDraw(canvas, d, page) {
  env.libText = d.g ? LB.modMes[d.g] : LB.mes;
  const ctx = canvas.getContext("2d"), T = env.libText[d.k], s = d.s;
  canvas.width = LIB_W; canvas.height = LIB_H;
  ctx.drawImage(LB.pics.bg[d.v ? LIB_BG_VENDIGROTH : LIB_BG[d.k]], 0, 0);
  if (d.k === 0) {
    const pages = libBookPages(s);
    for (let side = 0; side < 2; side++) if (pages[page + side]) libPageLike(ctx, 0, s, LIB_BOOK[side], pages[page + side], "black");
    return pages.length;
  }
  if (d.k === 1 || d.k === 3) {
    let text = "";
    for (let i = 0; i < LIB_TEN && (s + i) in T; i++) text += T[s + i] + (d.k === 1 ? "\n" : T[1012]);
    if (d.k === 1) libWrite(ctx, text, 497, "black", LIB_NOTE, false);
    else {
      for (const [font, line, x, y, align] of LIB_TELE_PARTS) libElement(ctx, T[line] || "", font, x, y, align);
      libWrite(ctx, T[1011], 481, "black", LIB_TELE_FINE, false);
      libWrite(ctx, text, 480, "black", LIB_TELE_TEXT, false);
    }
  } else if (d.k === 2) libPaper(ctx, s, d.v);
  else if (d.k === 6) libPageLike(ctx, 6, s, LIB_PLAQUE, { num: s, off: 0 }, "white");
  return 1;
}

  return { libLoad, libParse, libDraw };
};
