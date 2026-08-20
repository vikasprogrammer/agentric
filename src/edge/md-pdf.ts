/**
 * Markdown → PDF, with no dependencies.
 *
 * A published Markdown deliverable is the most common thing in the Library, and the most common thing
 * asked of one is "send it to someone who doesn't have a login" — which in practice means a PDF. Every
 * off-the-shelf way to make one costs more than it looks: a headless browser is ~300MB and a second
 * runtime to keep alive on a box that already runs agents, and a PDF library is a dependency in a
 * codebase whose whole shape is "Node built-ins only".
 *
 * So this writes the PDF itself. That is affordable because of one fact: every PDF reader ships the 14
 * standard fonts, so a document that only uses Helvetica and Courier needs no font embedding — the file
 * is then just an object table, a content stream of text-positioning operators, and an xref. What we do
 * need is the METRICS (below), because wrapping a line means knowing how wide it is; those are the AFM
 * widths of the standard fonts, which are fixed by the spec and cannot drift.
 *
 * Scope is deliberately "a readable report", not "a Markdown renderer": headings, paragraphs, lists,
 * fenced code, block quotes, rules, tables (as monospaced rows), and inline bold/italic/code/links —
 * links as real PDF annotations, so they stay clickable. Images are named, not fetched: an artifact's
 * images may live anywhere (or nowhere), and silently dropping them would be worse than a visible
 * `[image: chart.png]`. Anything we don't model degrades to its literal text rather than disappearing.
 *
 * Content streams are left UNCOMPRESSED on purpose. These documents are small, and an uncompressed
 * stream means the output is greppable — the test asserts on the text actually in the file, and a
 * support question ("is the heading in there?") is answered with `strings`, not a decoder.
 */

// ── page geometry (points; 72pt = 1 inch) ────────────────────────────────────────
const PAGE_W = 595.28;   // A4
const PAGE_H = 841.89;
const MARGIN = 64;
const CONTENT_W = PAGE_W - MARGIN * 2;
const BODY_SIZE = 10.2;
const LINE_GAP = 1.55;   // multiple of the font size — generous leading is most of what makes prose read
const PARA_GAP = 9;

/** Heading sizes by level (1-6) and the space above/below each. A document is skimmed before it is read,
 *  so the jumps between levels are deliberately large enough to see from arm's length. */
const H_SIZE = [0, 19, 14.5, 12, 11, 10.4, 10.2];
const H_ABOVE = [0, 20, 18, 14, 12, 10, 9];
const H_BELOW = [0, 9, 8, 6, 5, 4, 4];

/** Ink. Pure black on white is harsh in print and unusual in a designed document; near-black plus two
 *  greys does most of the work of looking typeset. */
const INK = '0.13 0.14 0.16';
const MUTED = '0.42 0.44 0.48';
const RULE = '0.85 0.86 0.88';
const RULE_SOFT = '0.92 0.93 0.94';
const CODE_BG = '0.965 0.968 0.975';
const HEAD_BG = '0.945 0.950 0.960';
const LINK = [0.11, 0.36, 0.72] as [number, number, number];

type FontId = 'F1' | 'F2' | 'F3' | 'F4' | 'F5';   // regular, bold, italic, bold-italic, mono

// ── standard-14 metrics ──────────────────────────────────────────────────────────
// AFM widths (units per 1000 em) for ASCII 32..126. Fixed by the font spec, so this table is data, not
// a guess — and it is the only reason wrapping is accurate rather than approximate.
const W_HELV = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const W_HELV_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];
/** Courier is monospaced — every glyph is 600/1000. */
const W_MONO = 600;

/**
 * Width of one character in a font, in 1/1000 em.
 *
 * Bytes above 127 are written as WinAnsi (so `é` renders as `é`, not as a mangled pair), but their
 * widths are taken from the un-accented base letter. An accent doesn't change a Latin glyph's advance
 * by enough to matter for line breaking, and the alternative — carrying four more 96-entry tables — buys
 * precision nobody can see.
 */
function charWidth(code: number, font: FontId): number {
  if (font === 'F5') return W_MONO;
  const table = font === 'F2' || font === 'F4' ? W_HELV_BOLD : W_HELV;
  if (code >= 32 && code <= 126) return table[code - 32];
  const punct = W_WINANSI[code];
  if (punct) return punct[font === 'F2' || font === 'F4' ? 1 : 0];
  const base = ACCENT_FOLD[code];
  if (base) return table[base.charCodeAt(0) - 32];
  return table['n'.charCodeAt(0) - 32];   // unknown → an average-ish letter
}

/** WinAnsi code → the ASCII letter whose width we borrow. Covers the Latin-1 letters agents actually
 *  produce (names, French/Spanish/German prose); everything else falls back above. */
const ACCENT_FOLD: Record<number, string> = (() => {
  const m: Record<number, string> = {};
  const add = (from: number, to: number, base: string) => { for (let c = from; c <= to; c++) m[c] = base; };
  add(0xc0, 0xc5, 'A'); m[0xc6] = 'A'; m[0xc7] = 'C'; add(0xc8, 0xcb, 'E'); add(0xcc, 0xcf, 'I');
  m[0xd0] = 'D'; m[0xd1] = 'N'; add(0xd2, 0xd6, 'O'); m[0xd8] = 'O'; add(0xd9, 0xdc, 'U'); m[0xdd] = 'Y';
  m[0xdf] = 'B'; add(0xe0, 0xe5, 'a'); m[0xe6] = 'a'; m[0xe7] = 'c'; add(0xe8, 0xeb, 'e'); add(0xec, 0xef, 'i');
  m[0xf1] = 'n'; add(0xf2, 0xf6, 'o'); m[0xf8] = 'o'; add(0xf9, 0xfc, 'u'); m[0xfd] = 'y'; m[0xff] = 'y';
  return m;
})();

/** Text width in points. Exported because the layout test asserts on real advances rather than a
 *  per-character guess — a guess is what let an off-column run pass review in the first place. */
export function textWidth(s: string, font: FontId, size: number): number {
  let w = 0;
  for (const ch of toWinAnsi(s)) w += charWidth(ch.charCodeAt(0), font);
  return (w * size) / 1000;
}

/**
 * Fold a UTF-8 string into the bytes a WinAnsi-encoded font can draw.
 *
 * The fonts are declared `/WinAnsiEncoding`, so the 0x80–0x9F range is NOT Latin-1 control codes here —
 * it is exactly the typographic set an LLM writes constantly (curly quotes, en/em dash, ellipsis,
 * bullet). Mapping those to their real glyphs is why the output reads like a document rather than like
 * ASCII-fied prose. Characters with no WinAnsi glyph (arrows, check marks) fall back to an ASCII
 * lookalike, and everything else — CJK, emoji — becomes `?`, which is honest: drawing it would need an
 * embedded font, and not embedding one is this renderer's whole premise.
 */
function toWinAnsi(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    const win = WINANSI[ch];
    if (win) { out += win; continue; }
    if (c <= 0xff && !(c >= 0x80 && c <= 0x9f)) { out += ch; continue; }
    const ascii = ASCII_FALLBACK[ch];
    if (ascii !== undefined) { out += ascii; continue; }
    // Circled digits ①②③ are a favourite of agent-written headings; as `?` they read as corruption.
    if (c >= 0x2460 && c <= 0x2473) { out += String(c - 0x2460 + 1); continue; }
    // Decorative pictographs are DROPPED, not questioned. An agent's "## 🧬 Decode" rendered as
    // "## ? Decode", and a stray `?` in a heading reads as a rendering fault; the missing emoji doesn't.
    // Anything else unrepresentable (CJK, say) still becomes `?`, because there the character carried
    // meaning and silently dropping it would misreport the document.
    if (isPictograph(c)) continue;
    out += '?';
  }
  return out;
}
/** Unicode → the WinAnsi byte that draws it (as a latin1 char, since the stream is written latin1). */
const WINANSI: Record<string, string> = {
  '\u20ac': '\x80', '\u201a': '\x82', '\u0192': '\x83', '\u201e': '\x84', '\u2026': '\x85',
  '\u2020': '\x86', '\u2021': '\x87', '\u2030': '\x89', '\u2039': '\x8b', '\u2018': '\x91',
  '\u2019': '\x92', '\u201c': '\x93', '\u201d': '\x94', '\u2022': '\x95', '\u2013': '\x96',
  '\u2014': '\x97', '\u2122': '\x99', '\u203a': '\x9b',
};
/** Emoji, dingbats, arrows-as-decoration, variation selectors and ZWJ — glyphs that carry tone, not
 *  content, so losing them costs the reader nothing. */
function isPictograph(c: number): boolean {
  return (c >= 0x1f000 && c <= 0x1faff)      // emoji blocks
    || (c >= 0x2600 && c <= 0x27bf)          // misc symbols + dingbats
    || (c >= 0x2b00 && c <= 0x2bff)          // arrows/shapes
    || c === 0xfe0f || c === 0xfe0e          // variation selectors
    || c === 0x200d                          // zero-width joiner
    || (c >= 0x1f1e6 && c <= 0x1f1ff);       // regional indicators (flags)
}

/** No WinAnsi glyph, but a readable ASCII stand-in beats a `?`. */
const ASCII_FALLBACK: Record<string, string> = {
  '\u2192': '->', '\u2190': '<-', '\u21d2': '=>', '\u2713': 'v', '\u2714': 'v', '\u2717': 'x',
  '\u2718': 'x', '\u2500': '-', '\u00a0': ' ', '\u2212': '-', '\u2248': '~', '\u2264': '<=',
  '\u2265': '>=', '\u2260': '!=', '\u00d7': 'x', '\u2022': '\u2022',
};
/** AFM widths for the WinAnsi punctuation above (Helvetica / Helvetica-Bold), which differ enough from a
 *  letter's advance that guessing them visibly misplaces a line's break — an em dash is 1000 units. */
const W_WINANSI: Record<number, [number, number]> = {
  0x80: [556, 556], 0x82: [222, 278], 0x83: [556, 556], 0x84: [333, 500], 0x85: [1000, 1000],
  0x86: [556, 556], 0x87: [556, 556], 0x89: [1000, 1000], 0x8b: [333, 333], 0x91: [222, 278],
  0x92: [222, 278], 0x93: [333, 500], 0x94: [333, 500], 0x95: [350, 350], 0x96: [556, 556],
  0x97: [1000, 1000], 0x99: [1000, 1000], 0x9b: [333, 333],
};

// ── inline model ─────────────────────────────────────────────────────────────────
interface Span { text: string; font: FontId; size: number; link?: string; color?: [number, number, number] }

/** Parse inline markdown into styled spans. Deliberately small: bold, italic, inline code, links, and
 *  the escape `\*`. Unmatched markers stay literal — a stray asterisk in prose must not eat the rest of
 *  the paragraph, which is exactly what a greedy regex would do. */
export function parseInline(md: string, baseFont: FontId, size: number): Span[] {
  const spans: Span[] = [];
  let buf = '';
  const flush = () => { if (buf) { spans.push({ text: buf, font: baseFont, size }); buf = ''; } };
  /** Emphasis is matched by LOOKAHEAD, never by a running toggle. A toggle turns one stray `*` in prose
   *  ("2 * 3") into italics for the rest of the paragraph — and multiplication signs, glob patterns and
   *  footnote markers are common in the reports this renders. A marker that has no partner stays literal. */
  const emphasis = (i: number, marker: string): { text: string; end: number } | null => {
    const close = md.indexOf(marker, i + marker.length);
    if (close < 0) return null;
    const text = md.slice(i + marker.length, close);
    if (!text.trim() || /^\s/.test(text) || /\s$/.test(text)) return null;   // `a * b * c` is arithmetic
    return { text, end: close + marker.length - 1 };
  };

  for (let i = 0; i < md.length; i++) {
    const c = md[i];
    if (c === '\\' && i + 1 < md.length && '*_`[]'.includes(md[i + 1])) { buf += md[++i]; continue; }
    if ((c === '*' || c === '_') && md[i + 1] === c && baseFont !== 'F5') {
      const m = emphasis(i, c + c);
      if (m) {
        flush();
        for (const sp of parseInline(m.text, baseFont === 'F3' ? 'F4' : 'F2', size)) spans.push(sp);
        i = m.end;
        continue;
      }
    }
    if ((c === '*' || c === '_') && baseFont !== 'F5') {
      const m = emphasis(i, c);
      if (m) {
        flush();
        for (const sp of parseInline(m.text, baseFont === 'F2' ? 'F4' : 'F3', size)) spans.push(sp);
        i = m.end;
        continue;
      }
    }
    if (c === '`') {
      const end = md.indexOf('`', i + 1);
      if (end > i) { flush(); spans.push({ text: md.slice(i + 1, end), font: 'F5', size: size * 0.92 }); i = end; continue; }
    }
    if (c === '[') {
      const close = md.indexOf(']', i);
      if (close > i && md[close + 1] === '(') {
        const end = md.indexOf(')', close);
        if (end > close) {
          flush();
          const label = md.slice(i + 1, close);
          const href = md.slice(close + 2, end).split(/\s+/)[0];
          for (const s of parseInline(label, baseFont, size)) spans.push({ ...s, link: href, color: LINK });
          i = end;
          continue;
        }
      }
    }
    buf += c;
  }
  flush();
  return spans;
}

// ── block model ──────────────────────────────────────────────────────────────────
type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'list'; items: { text: string; depth: number; marker: string }[] }
  | { kind: 'code'; lines: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'rule' }
  | { kind: 'table'; rows: string[][] };

/** Split Markdown into blocks. A fenced code block swallows everything up to its closing fence — that
 *  rule comes first, because markdown INSIDE a fence is text, and treating a commented `# foo` in a
 *  shell snippet as a heading is the classic way these renderers embarrass themselves. */
export function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flushPara = () => { if (para.length) { blocks.push({ kind: 'para', text: para.join(' ') }); para = []; } };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      flushPara();
      const code: string[] = [];
      for (i++; i < lines.length && !new RegExp(`^\\s*${fence[1]}`).test(lines[i]); i++) code.push(lines[i]);
      blocks.push({ kind: 'code', lines: code });
      continue;
    }
    if (!line.trim()) { flushPara(); continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { flushPara(); blocks.push({ kind: 'heading', level: h[1].length, text: h[2].replace(/\s+#+\s*$/, '') }); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushPara(); blocks.push({ kind: 'rule' }); continue; }
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) {
      flushPara();
      const quote = [q[1]];
      while (i + 1 < lines.length && /^\s*>\s?/.test(lines[i + 1])) quote.push(lines[++i].replace(/^\s*>\s?/, ''));
      blocks.push({ kind: 'quote', text: quote.join(' ') });
      continue;
    }
    // A table needs its separator row (`| --- |`) to be a table at all; without it these are just lines
    // with pipes in them, which prose does have.
    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:-]*\|[\s|:-]*$/.test(lines[i + 1]) && /-/.test(lines[i + 1])) {
      flushPara();
      const cells = (l: string) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      const rows = [cells(line)];
      i++; // the separator
      while (i + 1 < lines.length && /\|/.test(lines[i + 1]) && lines[i + 1].trim()) rows.push(cells(lines[++i]));
      blocks.push({ kind: 'table', rows });
      continue;
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      const items: { text: string; depth: number; marker: string }[] = [];
      let n = /^\d/.test(li[2]) ? parseInt(li[2], 10) : 0;
      let cur = li;
      const ITEM_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
      for (;;) {
        const depth = Math.min(3, Math.floor(cur[1].replace(/\t/g, '  ').length / 2));
        const marker = /^\d/.test(cur[2]) ? `${n++}.` : '\u2022';
        items.push({ text: cur[3], depth, marker });
        // Absorb this item's wrapped continuation lines (indented, no marker) BEFORE looking for the
        // next item — folding them in the same step that emits an item duplicated the item.
        while (i + 1 < lines.length && lines[i + 1].trim() && !ITEM_RE.test(lines[i + 1]) && /^\s{2,}\S/.test(lines[i + 1])) {
          items[items.length - 1].text += ' ' + lines[++i].trim();
        }
        const next = i + 1 < lines.length ? ITEM_RE.exec(lines[i + 1]) : null;
        if (!next) break;
        i++; cur = next;
      }
      blocks.push({ kind: 'list', items });
      continue;
    }
    // `![alt](src)` — named, never fetched (see the file header).
    const img = /^\s*!\[([^\]]*)\]\(([^)]+)\)\s*$/.exec(line);
    if (img) { flushPara(); blocks.push({ kind: 'para', text: `[image: ${img[1] || img[2]}]` }); continue; }
    para.push(line.trim());
  }
  flushPara();
  return blocks;
}

// ── laying spans out into lines ──────────────────────────────────────────────────
interface Piece extends Span { x: number; w: number }
interface Line { pieces: Piece[]; height: number }

/** Greedy word wrap over styled spans. Breaking happens at spaces, and a single word longer than the
 *  column (a URL, a hash) is hard-split rather than allowed to run off the page. */
function layout(spans: Span[], width: number, indent = 0): Line[] {
  const lines: Line[] = [];
  let pieces: Piece[] = [];
  let x = indent;
  let maxSize = 0;
  const push = () => { if (pieces.length) { lines.push({ pieces, height: (maxSize || BODY_SIZE) * LINE_GAP }); pieces = []; x = indent; maxSize = 0; } };

  for (const span of spans) {
    const words = span.text.split(/(\s+)/).filter((w) => w !== '');
    for (const word of words) {
      let w = textWidth(word, span.font, span.size);
      if (/^\s+$/.test(word) && pieces.length === 0) continue;        // no leading space on a fresh line
      if (x + w > width + indent && pieces.length) { push(); if (/^\s+$/.test(word)) continue; }
      // Still too wide on an empty line → hard-split the word at the column edge.
      if (w > width) {
        let rest = word;
        while (rest && textWidth(rest, span.font, span.size) > width - (x - indent)) {
          let cut = rest.length;
          while (cut > 1 && textWidth(rest.slice(0, cut), span.font, span.size) > width - (x - indent)) cut--;
          const head = rest.slice(0, cut);
          pieces.push({ ...span, text: head, x, w: textWidth(head, span.font, span.size) });
          maxSize = Math.max(maxSize, span.size);
          push();
          rest = rest.slice(cut);
        }
        if (!rest) continue;
        w = textWidth(rest, span.font, span.size);
        pieces.push({ ...span, text: rest, x, w });
        x += w; maxSize = Math.max(maxSize, span.size);
        continue;
      }
      pieces.push({ ...span, text: word, x, w });
      x += w;
      maxSize = Math.max(maxSize, span.size);
    }
  }
  push();
  return lines;
}

// ── PDF object plumbing ──────────────────────────────────────────────────────────
/** Escape a PDF literal string. Missing this is how a filename with a bracket corrupts a whole file. */
const pdfStr = (s: string): string => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/** Latin-1 bytes for the content stream: the fonts are declared WinAnsiEncoding, so one char = one byte. */
const streamBuf = (s: string): Buffer => Buffer.from(s, 'latin1');

interface PageDraw { ops: string[]; annots: string[] }

export interface MdPdfOptions {
  /** Printed as the document title on page 1 and in the PDF metadata. */
  title?: string;
  /** A one-line provenance strap under the title (e.g. "agent · 12 Aug 2026"). */
  subtitle?: string;
}

/**
 * Render Markdown to PDF bytes.
 *
 * The layout pass is deliberately single-column and page-break-dumb (break when the cursor runs past the
 * bottom): a report reads fine that way, and the alternatives — keep-with-next, widow control — are a lot
 * of machinery for a document nobody typesets twice.
 */
export function markdownToPdf(md: string, opts: MdPdfOptions = {}): Buffer {
  const pages: PageDraw[] = [];
  let cur: PageDraw = { ops: [], annots: [] };
  let y = PAGE_H - MARGIN;
  const newPage = () => { pages.push(cur); cur = { ops: [], annots: [] }; y = PAGE_H - MARGIN; };
  const need = (h: number) => { if (y - h < MARGIN + 24) newPage(); };

  const drawLines = (lines: Line[], xOffset = 0) => {
    for (const line of lines) {
      need(line.height);
      y -= line.height;
      for (const p of line.pieces) {
        if (!p.text.trim()) continue;
        const px = MARGIN + xOffset + p.x;
        const color = p.color ? `${p.color[0]} ${p.color[1]} ${p.color[2]} rg ` : `${INK} rg `;
        cur.ops.push(`BT ${color}/${p.font} ${p.size} Tf 1 0 0 1 ${px.toFixed(2)} ${y.toFixed(2)} Tm (${pdfStr(toWinAnsi(p.text))}) Tj ET`);
        if (p.link) {
          // A real annotation, so the link is clickable in the reader rather than just blue text.
          cur.ops.push(`${color}${px.toFixed(2)} ${(y - 1.5).toFixed(2)} ${p.w.toFixed(2)} 0.5 re f`);
          cur.annots.push(`<< /Type /Annot /Subtype /Link /Border [0 0 0] /Rect [${px.toFixed(2)} ${(y - 2).toFixed(2)} ${(px + p.w).toFixed(2)} ${(y + p.size).toFixed(2)}] /A << /S /URI /URI (${pdfStr(p.link)}) >> >>`);
        }
      }
    }
  };

  // Title block — the artifact's own title, so a printed page identifies itself. An accent bar rather
  // than another hairline: the eye needs one thing at the top of page 1 that is not text.
  if (opts.title) {
    y -= 4;
    cur.ops.push(`${LINK.join(' ')} rg ${MARGIN} ${(y - 1).toFixed(2)} 34 2.6 re f`);
    y -= 16;
    drawLines(layout([{ text: opts.title, font: 'F2', size: 21 }], CONTENT_W));
    if (opts.subtitle) {
      y -= 3;
      drawLines(layout([{ text: opts.subtitle, font: 'F1', size: 8.6, color: [0.42, 0.44, 0.48] }], CONTENT_W));
    }
    y -= 10;
    cur.ops.push(`${RULE} RG 0.7 w ${MARGIN} ${y.toFixed(2)} m ${(PAGE_W - MARGIN).toFixed(2)} ${y.toFixed(2)} l S`);
    y -= 20;
  }

  // The artifact's title is already set above, and an agent's report almost always opens with the same
  // words as its own H1 — printing both is a stutter at the top of page 1.
  const blocks = parseBlocks(md);
  if (opts.title && blocks[0]?.kind === 'heading' && blocks[0].level === 1 && sameish(blocks[0].text, opts.title)) blocks.shift();

  for (const b of blocks) {
    switch (b.kind) {
      case 'heading': {
        const size = H_SIZE[b.level];
        y -= H_ABOVE[b.level];
        // Keep a heading with at least two lines of what follows: a heading alone at the foot of a page is
        // the single most obvious sign that nobody looked at the output.
        need(size * LINE_GAP + BODY_SIZE * LINE_GAP * 2);
        drawLines(layout(parseInline(b.text, 'F2', size), CONTENT_W));
        if (b.level <= 2) {
          y -= 4;
          cur.ops.push(`${b.level === 1 ? RULE : RULE_SOFT} RG 0.6 w ${MARGIN} ${y.toFixed(2)} m ${(PAGE_W - MARGIN).toFixed(2)} ${y.toFixed(2)} l S`);
        }
        y -= H_BELOW[b.level];
        break;
      }
      case 'para':
        drawLines(layout(parseInline(b.text, 'F1', BODY_SIZE), CONTENT_W));
        y -= PARA_GAP;
        break;
      case 'list':
        for (const it of b.items) {
          const indent = 14 + it.depth * 14;
          need(BODY_SIZE * LINE_GAP);
          // The marker is drawn on the first line's baseline, so wrapped text hangs under the text, not
          // under the bullet.
          const lines = layout(parseInline(it.text, 'F1', BODY_SIZE), CONTENT_W - indent);
          if (lines.length) {
            const markerY = y - lines[0].height;
            cur.ops.push(`BT 0 0 0 rg /F1 ${BODY_SIZE} Tf 1 0 0 1 ${(MARGIN + indent - 10).toFixed(2)} ${markerY.toFixed(2)} Tm (${pdfStr(toWinAnsi(it.marker))}) Tj ET`);
          }
          drawLines(lines, indent);
        }
        y -= PARA_GAP;
        break;
      case 'code': {
        const size = 8.8;
        const lineH = size * 1.35;
        const boxTop = y;
        const inner: string[] = [];
        for (const raw of b.lines) {
          // Monospace wrapping is arithmetic, not measurement — one more reason code sets in Courier.
          const perLine = Math.max(8, Math.floor((CONTENT_W - 16) / ((W_MONO * size) / 1000)));
          const expanded = raw.replace(/\t/g, '    ');
          if (!expanded.length) { inner.push(''); continue; }
          for (let i = 0; i < expanded.length; i += perLine) inner.push(expanded.slice(i, i + perLine));
        }
        for (const l of inner) {
          if (y - lineH < MARGIN + 24) {
            cur.ops.unshift(`${CODE_BG} rg ${(MARGIN - 6).toFixed(2)} ${(y - 6).toFixed(2)} ${(CONTENT_W + 12).toFixed(2)} ${(boxTop - y + 12).toFixed(2)} re f`);
            newPage();
          }
          y -= lineH;
          cur.ops.push(`BT 0.16 0.18 0.22 rg /F5 ${size} Tf 1 0 0 1 ${(MARGIN + 6).toFixed(2)} ${y.toFixed(2)} Tm (${pdfStr(toWinAnsi(l))}) Tj ET`);
        }
        // The tint goes UNDER the text, so it is unshifted to the front of this page's operators.
        cur.ops.unshift(`${CODE_BG} rg ${(MARGIN - 6).toFixed(2)} ${(y - 7).toFixed(2)} ${(CONTENT_W + 12).toFixed(2)} ${(Math.min(boxTop, PAGE_H - MARGIN) - y + 13).toFixed(2)} re f`);
        y -= PARA_GAP + 4;
        break;
      }
      case 'quote': {
        const top = y;
        drawLines(layout(parseInline(b.text, 'F3', BODY_SIZE), CONTENT_W - 14), 14);
        cur.ops.push(`${LINK.join(' ')} RG 2 w ${(MARGIN + 2).toFixed(2)} ${(y - 1).toFixed(2)} m ${(MARGIN + 2).toFixed(2)} ${top.toFixed(2)} l S`);
        y -= PARA_GAP;
        break;
      }
      case 'rule':
        need(12);
        y -= 6;
        cur.ops.push(`${RULE} RG 0.7 w ${MARGIN} ${y.toFixed(2)} m ${(PAGE_W - MARGIN).toFixed(2)} ${y.toFixed(2)} l S`);
        y -= 8;
        break;
      case 'table': {
        // A real grid, not monospaced rows: proportional text, wrapped cells, a tinted header and hairline
        // row separators. The earlier version set tables in Courier and truncated cells to fit, which is
        // what made a data-heavy report look like a terminal dump — and truncation loses the data.
        const size = 8.9;
        const PAD = 5;
        const cols = Math.max(...b.rows.map((r) => r.length));
        const cell = (r: number, c: number) => (b.rows[r][c] ?? '').trim();

        // Natural width = the widest cell, measured in the font it will be drawn in; then water-fill the
        // available space so narrow label columns keep their width and only wide prose columns give way.
        const natural: number[] = [];
        for (let c = 0; c < cols; c++) {
          let w = 0;
          for (let r = 0; r < b.rows.length; r++) w = Math.max(w, textWidth(cell(r, c), r === 0 ? 'F2' : 'F1', size) + PAD * 2);
          natural.push(Math.min(w, CONTENT_W * 0.6));
        }
        const widths = fitColumns(natural, CONTENT_W, MIN_COL_PT);

        // Lay every cell out first: a row is as tall as its tallest cell, and we need that before drawing
        // the header fill or deciding whether the row fits on this page.
        const rows = b.rows.map((row, r) => {
          const cells = widths.map((w, c) => layout(parseInline(cell(r, c), r === 0 ? 'F2' : 'F1', size), w - PAD * 2));
          const height = Math.max(size * 1.5, ...cells.map((ls) => ls.reduce((a, l) => a + l.height, 0))) + PAD;
          return { cells, height };
        });

        y -= 2;
        rows.forEach((row, r) => {
          if (y - row.height < MARGIN + 30) {
            newPage();
            y -= 2;
          }
          const top = y;
          if (r === 0) cur.ops.push(`${HEAD_BG} rg ${MARGIN} ${(top - row.height).toFixed(2)} ${CONTENT_W.toFixed(2)} ${row.height.toFixed(2)} re f`);
          let x = MARGIN;
          row.cells.forEach((lines, c) => {
            let cy = top - PAD * 0.6;
            for (const line of lines) {
              cy -= line.height;
              for (const piece of line.pieces) {
                if (!piece.text.trim()) continue;
                const color = piece.color ? `${piece.color[0]} ${piece.color[1]} ${piece.color[2]} rg ` : `${INK} rg `;
                cur.ops.push(`BT ${color}/${piece.font} ${piece.size} Tf 1 0 0 1 ${(x + PAD + piece.x).toFixed(2)} ${cy.toFixed(2)} Tm (${pdfStr(toWinAnsi(piece.text))}) Tj ET`);
                if (piece.link) {
                  cur.annots.push(`<< /Type /Annot /Subtype /Link /Border [0 0 0] /Rect [${(x + PAD + piece.x).toFixed(2)} ${(cy - 2).toFixed(2)} ${(x + PAD + piece.x + piece.w).toFixed(2)} ${(cy + piece.size).toFixed(2)}] /A << /S /URI /URI (${pdfStr(piece.link)}) >> >>`);
                }
              }
            }
            x += widths[c];
          });
          y = top - row.height;
          cur.ops.push(`${r === 0 ? RULE : RULE_SOFT} RG 0.5 w ${MARGIN} ${y.toFixed(2)} m ${(PAGE_W - MARGIN).toFixed(2)} ${y.toFixed(2)} l S`);
        });
        y -= PARA_GAP + 2;
        break;
      }
    }
  }
  pages.push(cur);

  // Page numbers, added once the total is known.
  pages.forEach((pg, i) => {
    const foot = (MARGIN - 26).toFixed(2);
    pg.ops.push(`${RULE_SOFT} RG 0.5 w ${MARGIN} ${(MARGIN - 16).toFixed(2)} m ${(PAGE_W - MARGIN).toFixed(2)} ${(MARGIN - 16).toFixed(2)} l S`);
    if (opts.title) {
      // Clip rather than wrap: a footer that grows to two lines is worse than a truncated one.
      let t = opts.title;
      while (textWidth(t, 'F1', 8) > CONTENT_W * 0.6 && t.length > 4) t = t.slice(0, -2);
      if (t !== opts.title) t += '…';
      pg.ops.push(`BT ${MUTED} rg /F1 8 Tf 1 0 0 1 ${MARGIN} ${foot} Tm (${pdfStr(toWinAnsi(t))}) Tj ET`);
    }
    const label = `${i + 1} / ${pages.length}`;
    const w = textWidth(label, 'F1', 8);
    pg.ops.push(`BT ${MUTED} rg /F1 8 Tf 1 0 0 1 ${(PAGE_W - MARGIN - w).toFixed(2)} ${foot} Tm (${pdfStr(label)}) Tj ET`);
  });

  return assemble(pages, opts.title);
}

/** Serialise pages into a PDF file: objects, then an xref table indexed by byte offset. */
function assemble(pages: PageDraw[], title?: string): Buffer {
  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let size = 0;
  const out = (s: string | Buffer) => { const b = typeof s === 'string' ? streamBuf(s) : s; chunks.push(b); size += b.length; };
  const obj = (n: number, body: string | Buffer) => {
    offsets[n] = size;
    out(`${n} 0 obj\n`);
    out(body);
    out('\nendobj\n');
  };

  // 1 catalog · 2 pages · 3-7 fonts · then per page: content stream, page object.
  const FONTS: [number, string][] = [[3, 'Helvetica'], [4, 'Helvetica-Bold'], [5, 'Helvetica-Oblique'], [6, 'Helvetica-BoldOblique'], [7, 'Courier']];
  const firstPageObj = 8;
  const pageIds = pages.map((_, i) => firstPageObj + i * 2 + 1);

  out('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  obj(1, `<< /Type /Catalog /Pages 2 0 R >>`);
  obj(2, `<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`);
  FONTS.forEach(([n, base], i) => obj(n, `<< /Type /Font /Subtype /Type1 /Name /F${i + 1} /BaseFont /${base} /Encoding /WinAnsiEncoding >>`));

  pages.forEach((pg, i) => {
    const content = streamBuf(pg.ops.join('\n'));
    const streamObj = firstPageObj + i * 2;
    obj(streamObj, Buffer.concat([streamBuf(`<< /Length ${content.length} >>\nstream\n`), content, streamBuf('\nendstream')]));
    const annots = pg.annots.length ? ` /Annots [${pg.annots.join(' ')}]` : '';
    obj(pageIds[i], `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << ${FONTS.map((_, k) => `/F${k + 1} ${FONTS[k][0]} 0 R`).join(' ')} >> >> /Contents ${streamObj} 0 R${annots} >>`);
  });

  const infoNum = firstPageObj + pages.length * 2;
  obj(infoNum, `<< /Title (${pdfStr(toWinAnsi(title ?? 'Document'))}) /Producer (Agentric) /Creator (Agentric) >>`);

  const xrefAt = size;
  const count = infoNum + 1;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let n = 1; n < count; n++) xref += `${String(offsets[n] ?? 0).padStart(10, '0')} 00000 n \n`;
  out(xref);
  out(`trailer\n<< /Size ${count} /Root 1 0 R /Info ${infoNum} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  return Buffer.concat(chunks);
}

/** Are these the same heading, allowing for the date/suffix an artifact title tends to carry? Compared on
 *  letters alone so "Startup DNA — Airbtics" matches "Startup DNA - Airbtics (2026-08-20)". */
function sameish(a: string, b: string): boolean {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const [x, z] = [norm(a), norm(b)];
  return !!x && (x === z || z.startsWith(x) || x.startsWith(z));
}

/** Smallest a table column may be squeezed to before it stops carrying information — characters for the
 *  monospaced callers, points for the proportional grid. */
const MIN_COL = 4;
const MIN_COL_PT = 46;

/**
 * Choose column widths that fit `budget` characters in total, clipping only the columns wide enough to
 * afford it. Raise a cap until the total reaches the budget: every column narrower than the cap keeps
 * its full width, every wider one is clipped to the cap. That is what a reader wants from a squeezed
 * table — labels intact, long prose cells truncated.
 */
export function fitColumns(want: number[], budget: number, min = MIN_COL): number[] {
  const total = want.reduce((a, w) => a + w, 0);
  if (total <= budget) {
    // Room to spare: give it to the widest column rather than leaving a short table hugging the left
    // margin — a grid that stops halfway across the page reads as broken layout, not as restraint.
    const slack = budget - total;
    if (slack > 1 && want.length) {
      const widest = want.indexOf(Math.max(...want));
      return want.map((w, i) => (i === widest ? w + slack : w));
    }
    return want.slice();
  }
  let cap = min;
  for (;;) {
    const next = want.reduce((a, w) => a + Math.min(w, cap + 1), 0);
    if (next > budget || cap > 10000) break;
    cap++;
  }
  return want.map((w) => Math.max(min, Math.min(w, cap)));
}

/** Is this artifact one we can turn into a PDF? Markdown only for now — a `.txt` would work too, but
 *  the button should promise exactly what it delivers. */
export function isMarkdownArtifact(mime: string, filename: string): boolean {
  return /markdown/i.test(mime) || /\.(md|markdown)$/i.test(filename);
}
