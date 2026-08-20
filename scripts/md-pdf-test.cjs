#!/usr/bin/env node
/* Markdown → PDF test.
 *
 * Writing a PDF by hand means the file can be "produced successfully" and still be garbage in a reader,
 * so this asserts on the STRUCTURE a reader actually parses — header, an xref entry per object whose
 * offset really points at that object, a trailer — and on the text being present and correctly escaped.
 * Streams are uncompressed by design, which is what makes those assertions possible at all.
 *
 * The layout assertions are the ones that pin real bugs: no line may exceed the text column (a wrap bug
 * shows up as text running off the page, which nothing else here would catch), a fence's contents must
 * not be parsed as markdown, and a long document must actually paginate.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-mdpdf-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { markdownToPdf, parseBlocks, parseInline, isMarkdownArtifact, textWidth, fitColumns } = require(path.join(ROOT, 'dist/edge/md-pdf.js'));

console.log('\n\x1b[1m1) Block parsing — a fence is text, not markdown\x1b[0m');
const blocks = parseBlocks([
  '# Title', '', 'A paragraph with **bold**.', '', '```bash', '# not a heading', 'echo hi', '```', '',
  '- one', '- two', '  continued', '', '> quoted', '', '---', '', '| a | b |', '| --- | --- |', '| 1 | 2 |',
].join('\n'));
const kinds = blocks.map((b) => b.kind).join(',');
assert(kinds === 'heading,para,code,list,quote,rule,table', 'every block type is recognised in order', kinds);
assert(blocks[2].lines.join('|') === '# not a heading|echo hi', 'a `#` comment inside a fence stays code');
assert(blocks[3].items.length === 2 && /continued/.test(blocks[3].items[1].text), 'an indented continuation joins its list item');
assert(blocks[6].rows.length === 2 && blocks[6].rows[1][1] === '2', 'the table keeps its cells (separator row dropped)');
assert(parseBlocks('a | b\nc | d')[0].kind === 'para', 'pipes without a separator row are prose, not a table');

console.log('\n\x1b[1m2) Inline parsing\x1b[0m');
const spans = parseInline('plain **bold** and `code` and [link](https://example.com/x)', 'F1', 10);
assert(spans.some((s) => s.font === 'F2' && s.text === 'bold'), 'bold becomes the bold font');
assert(spans.some((s) => s.font === 'F5' && s.text === 'code'), 'inline code becomes the mono font');
const link = spans.find((s) => s.link);
assert(link && link.link === 'https://example.com/x' && link.text === 'link', 'a link carries its href and shows its label');
assert(parseInline('2 * 3 * 4', 'F1', 10).map((s) => s.text).join('') === '2 * 3 * 4', 'a stray asterisk stays literal');

console.log('\n\x1b[1m3) The file a reader parses\x1b[0m');
const pdf = markdownToPdf('# Hello\n\nWorld of **reports**.\n', { title: 'My report', subtitle: 'agent · today' });
const buf = pdf.toString('latin1');
assert(pdf.slice(0, 5).toString() === '%PDF-', 'starts with the PDF header');
assert(/%%EOF\s*$/.test(buf), 'ends with %%EOF');
assert(/\/Type \/Catalog/.test(buf) && /\/Type \/Pages/.test(buf) && /\/Type \/Page\b/.test(buf), 'catalog, page tree and page objects are present');
assert((buf.match(/\/BaseFont \/(Helvetica|Courier)/g) || []).length === 5, 'the five standard fonts are declared (no embedding)');
assert(/\/Encoding \/WinAnsiEncoding/.test(buf), 'fonts declare WinAnsi, matching the bytes written');
// Every xref offset must point at "<n> 0 obj" — an off-by-one here is the classic hand-rolled-PDF bug
// that opens fine in a lenient viewer and fails in a strict one.
const xrefAt = Number(/startxref\s+(\d+)/.exec(buf)[1]);
const size = Number(/\/Size (\d+)/.exec(buf)[1]);
// row 0 of the table is the free object (`… 65535 f`), so the real entries start one line later.
const rows = buf.slice(xrefAt).split('\n').slice(3, 3 + size - 1);
let offsetsOk = rows.length === size - 1;
rows.forEach((row, i) => {
  const off = Number(row.slice(0, 10));
  if (!buf.startsWith(`${i + 1} 0 obj`, off)) offsetsOk = false;
});
assert(offsetsOk, `every xref offset points at its object (${size - 1} objects)`);
assert(/\(Hello\) Tj/.test(buf) && /\(World\) Tj/.test(buf), 'the document text is in the content stream');
// Text is emitted one word per run (each with its own position), so grep for a word, not the phrase.
assert(/\(My\) Tj/.test(buf) && /\(report\) Tj/.test(buf), 'the title block is drawn');
assert(/\(1 \/ 1\) Tj/.test(buf), 'the page number is stamped');

console.log('\n\x1b[1m4) Escaping and encoding\x1b[0m');
const tricky = markdownToPdf('A (paren) and a back\\\\slash and a )brace(.\n').toString('latin1');
assert(/\\\(paren\\\)/.test(tricky), 'parentheses are escaped — unescaped they truncate the string object');
assert(/\\\\/.test(tricky), 'a backslash is escaped');
const uni = markdownToPdf('José said “hi” — café ✓ 中\n').toString('latin1');
assert(/\\350|è|caf/.test(uni), 'Latin-1 text survives');
// The fonts are WinAnsi, so 0x91-0x94 / 0x97 are the real curly quotes and em dash — folding them to
// ASCII would be a downgrade, and emitting them as raw UTF-8 would corrupt the stream.
assert(/\x93hi\x94/.test(uni), 'curly quotes keep their real WinAnsi glyphs');
assert(/\x97/.test(uni), 'an em dash is the WinAnsi em dash, not -- and not ?');
assert(/\?/.test(uni), 'a meaningful glyph no standard font has becomes ? instead of corrupting the stream');
// …but a decorative one is dropped: "## 🧬 Decode" rendering as "## ? Decode" reads as a broken renderer.
const emoji = markdownToPdf('# \u{1F9EC} Decode\n\nDone \u2705\n').toString('latin1');
assert(/\(Decode\) Tj/.test(emoji) && !/\(\?\) Tj/.test(emoji), 'emoji are dropped, not questioned');
const circled = markdownToPdf('Phase \u2460 and \u2461, roughly \u2248 3\n').toString('latin1');
assert(/\(1\) Tj/.test(circled) && /\(2,\) Tj/.test(circled), 'circled digits become digits');
assert(/~/.test(circled) && !/\?/.test(circled), 'maths symbols get ASCII equivalents');
const arrows = markdownToPdf('one → two ✓\n').toString('latin1');
assert(/->/.test(arrows) && /\(one\) Tj/.test(arrows), 'a character with no WinAnsi glyph falls back to ASCII');

console.log('\n\x1b[1m5) Layout — nothing runs off the page\x1b[0m');
const longParts = ['# A very long document'];
for (let i = 0; i < 12; i++) {
  longParts.push(`## Section ${i}`, 'lorem ipsum dolor sit amet '.repeat(20), '- ' + 'item text '.repeat(30), '```', 'y'.repeat(400), '```');
}
longParts.push('https://example.com/' + 'a'.repeat(300));
const long = markdownToPdf(longParts.join('\n\n')).toString('latin1');
const PAGE_W = 595.28, MARGIN = 56;
// Measured with the same metrics the layout used — an approximation here would let a real overflow pass.
const xs = [...long.matchAll(/\/(F\d) ([\d.]+) Tf 1 0 0 1 ([\d.]+) ([\d.]+) Tm \((.*?)\) Tj/g)]
  .map((m) => ({ font: m[1], size: Number(m[2]), x: Number(m[3]), text: m[5] }));
assert(xs.length > 20, 'the long document produced plenty of text runs');
assert(xs.every((r) => r.x >= MARGIN - 12), 'no run starts left of the margin');
const over = xs.filter((r) => r.x + textWidth(r.text, r.font, r.size) > PAGE_W - MARGIN + 0.5);
assert(over.length === 0, 'no run extends past the right margin', over.slice(0, 2).map((r) => `${r.text.slice(0, 30)}@${r.x}`).join(' | '));
assert(/\/Type \/Page\b[\s\S]*\/Type \/Page\b/.test(long), 'a long document paginates onto more than one page');
const pageCount = Number(/\/Count (\d+)/.exec(long)[1]);
assert(pageCount >= 2, `the page tree reports ${pageCount} pages`);
assert(new RegExp(`\\(1 / ${pageCount}\\) Tj`).test(long), 'page numbers know the total');

console.log('\n\x1b[1m5b) Table columns: clip the wide ones, keep the narrow ones whole\x1b[0m');
// A table with room to spare keeps every column's natural width and hands the slack to the widest one,
// so the grid spans the text column instead of stopping halfway across the page.
const roomy = fitColumns([5, 8, 10], 100);
assert(roomy[0] === 5 && roomy[1] === 8 && roomy.reduce((a, w) => a + w, 0) === 100, 'a table that fits keeps its columns and fills the width', JSON.stringify(roomy));
const squeezed = fitColumns([6, 90, 12], 60);
assert(squeezed[0] === 6 && squeezed[2] === 12, 'narrow columns survive a squeeze intact — they carry the labels');
assert(squeezed[1] < 90 && squeezed.reduce((a, w) => a + w, 0) <= 60, 'only the wide column is clipped, and the row fits');
assert(fitColumns([80, 80, 80], 12).every((w) => w >= 4), 'an impossible budget still leaves every column readable');
const tbl = markdownToPdf(['| Field | Value | Source |', '| --- | --- | --- |',
  ['| Name | Airbtics, LLC | ', 'site footer plus a very long provenance note '.repeat(4), '|'].join('')].join('\n')).toString('latin1');
assert(/\(Field/.test(tbl) && /Name/.test(tbl), 'the label column is not truncated away');

console.log('\n\x1b[1m6) Links become real annotations\x1b[0m');
const linked = markdownToPdf('See [the docs](https://example.com/docs) for more.\n').toString('latin1');
assert(/\/Subtype \/Link/.test(linked) && /\/URI \(https:\/\/example.com\/docs\)/.test(linked), 'a link is a clickable annotation, not just blue text');
assert(/\/Annots \[/.test(linked), 'the annotation is attached to its page');

console.log('\n\x1b[1m7) Which artifacts qualify\x1b[0m');
assert(isMarkdownArtifact('text/markdown', 'report.md'), 'a markdown mime qualifies');
assert(isMarkdownArtifact('text/plain', 'report.md'), 'a .md filename qualifies even with a generic mime');
assert(!isMarkdownArtifact('application/pdf', 'report.pdf') && !isMarkdownArtifact('image/png', 'chart.png'), 'binaries do not');
assert(!isMarkdownArtifact('text/plain', 'notes.txt'), 'plain text does not — the button promises Markdown');

console.log('\n\x1b[1mHTTP: the download route\x1b[0m');
const { TenantRegistry } = require(path.join(ROOT, 'dist/tenant-registry.js'));
const { createHttpServer } = require(path.join(ROOT, 'dist/server.js'));
const registry = new TenantRegistry(ROOT, 0);
registry.bootAll();
const { os: aos } = registry.get('testco');
const mkMember = (email, role) => {
  const { member } = aos.team.invite({ email, role });
  aos.db.prepare("UPDATE members SET status='active' WHERE id=?").run(member.id);
  return aos.team.getMember(member.id);
};
const owner = aos.team.listMembers().find((m) => m.role === 'owner');
const stranger = mkMember('other@testco.dev', 'member');

const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-mdpdf-src-'));
fs.writeFileSync(path.join(srcDir, 'report.md'), '# Quarterly report\n\nRevenue **up**.\n');
fs.writeFileSync(path.join(srcDir, 'chart.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
const mdArt = aos.artifacts.publish({ sessionId: 'ses_x', agent: 'analyst', source: owner.id, title: 'Quarterly report', allowRoot: srcDir, srcPath: 'report.md' });
const pngArt = aos.artifacts.publish({ sessionId: 'ses_x', agent: 'analyst', source: owner.id, title: 'Chart', allowRoot: srcDir, srcPath: 'chart.png' });

(async () => {
  assert(mdArt.ok && pngArt.ok, 'test artifacts published', JSON.stringify(mdArt.error || pngArt.error || ''));
  const srv = createHttpServer(registry);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const get = async (p, cookie) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { headers: cookie ? { cookie } : {} });
    const body = Buffer.from(await res.arrayBuffer());
    return { status: res.status, type: res.headers.get('content-type'), disp: res.headers.get('content-disposition'), body };
  };
  const ownerCookie = `aos_sid=${aos.team.createSession(owner.id)}`;
  const strangerCookie = `aos_sid=${aos.team.createSession(stranger.id)}`;

  const r = await get(`/api/artifacts/${mdArt.artifact.id}/pdf`, ownerCookie);
  assert(r.status === 200 && r.type === 'application/pdf', 'the markdown artifact renders as a PDF', `${r.status} ${r.type}`);
  assert(/attachment; filename="report\.pdf"/.test(r.disp || ''), 'it downloads as report.pdf, not report.md.pdf', r.disp);
  assert(r.body.slice(0, 5).toString() === '%PDF-' && r.body.length > 800, 'the bytes are a real PDF');
  assert(/\(Quarterly\) Tj/.test(r.body.toString('latin1')), "the artifact's title heads the document");

  const bin = await get(`/api/artifacts/${pngArt.artifact.id}/pdf`, ownerCookie);
  assert(bin.status === 400, 'a non-markdown artifact is refused, not silently rendered as gibberish');
  assert((await get(`/api/artifacts/${mdArt.artifact.id}/pdf`, '')).status === 401, 'unauthenticated is refused');
  assert((await get(`/api/artifacts/${mdArt.artifact.id}/pdf`, strangerCookie)).status === 403, 'a member who cannot see the artifact cannot export it');
  aos.artifacts.setTeamShared(mdArt.artifact.id, true);
  assert((await get(`/api/artifacts/${mdArt.artifact.id}/pdf`, strangerCookie)).status === 200, 'sharing it with the team opens the export too — same gate as /raw');
  assert((await get('/api/artifacts/art_nope/pdf', ownerCookie)).status === 404, 'a missing artifact is a 404');
  assert(aos.db.prepare("SELECT COUNT(*) c FROM audit_events WHERE type='artifact.pdf.exported'").get().c >= 1, 'each export is audited');

  srv.close();
  registry.stopAll();
  console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m`);
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(srcDir, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
})();
