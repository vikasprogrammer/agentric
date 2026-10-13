// Usage: node scripts/code-exploration-share.mjs <days> <projectsDir...>
// Emits per-agent aggregates of exploration vs total tool use in CODING runs
// (a run that commits/pushes/opens a PR). Read-only; aggregates only.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const days = Number(process.argv[2] || 30);
const roots = process.argv.slice(3);
const since = Date.now() - days * 864e5;

const EXPLORE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const EXPLORE_BASH = /^\s*(cd\s+\S+\s*&&\s*)?(ls|cat|grep|rg|find|head|tail|tree|wc|sed\s+-n|awk|git\s+(log|show|grep|ls-files|blame)|less)\b/;
const CODING_BASH = /\bgit\s+(commit|push)\b|\bgh\s+pr\s+create\b/;

function norm(p) { return String(p).split('/').filter(Boolean).slice(-3).join('/'); }
function agentOf(dir) {
  const b = path.basename(dir);
  const i = b.indexOf('-agents-');
  if (i < 0) return null;
  return b.slice(i + 8).replace(/-[0-9a-f]{8}-[0-9a-f-]{27}.*$/, '');
}

async function scan(file, run) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    const c = o?.message?.content;
    if (!Array.isArray(c)) continue;
    if (o.type === 'assistant') {
      const uses = c.filter(x => x.type === 'tool_use');
      if (!uses.length) continue;
      run.turns++;
      let allExplore = true;
      for (const u of uses) {
        const n = u.name; const inp = u.input || {};
        let kind = 'other';
        if (EXPLORE_TOOLS.has(n)) kind = 'explore';
        else if (EDIT_TOOLS.has(n)) kind = 'edit';
        else if (n === 'Bash') {
          const cmd = String(inp.command || '');
          if (CODING_BASH.test(cmd)) run.coding = true;
          if (EXPLORE_BASH.test(cmd)) kind = 'explore';
        }
        if (kind !== 'explore') allExplore = false;
        run.calls++;
        run[kind]++;
        if (kind === 'edit' && run.firstEdit < 0) run.firstEdit = run.calls;
        if (n === 'Read' && inp.file_path) run.reads.push(norm(inp.file_path));
        if (n === 'Bash' && kind === 'explore') {
          const cmd = String(inp.command || '');
          run.bashExplore[(cmd.match(/^\s*(?:cd\s+\S+\s*&&\s*)?(\w+)/) || [])[1] || '?'] = (run.bashExplore[(cmd.match(/^\s*(?:cd\s+\S+\s*&&\s*)?(\w+)/) || [])[1] || '?'] || 0) + 1;
          if (/^\s*(cd\s+\S+\s*&&\s*)?(cat|head|tail|sed\s+-n)\b/.test(cmd))
            for (const t of cmd.split(/[\s|;&<>]+/)) if (/\/?[\w.-]+\/[\w./-]*\.\w{1,5}$/.test(t)) run.reads.push(norm(t));
        }
        run.kindById.set(u.id, kind);
      }
      if (allExplore) run.exploreTurns++;
    } else if (o.type === 'user') {
      for (const r of c) {
        if (r.type !== 'tool_result') continue;
        const kind = run.kindById.get(r.tool_use_id) || 'other';
        const len = typeof r.content === 'string' ? r.content.length
          : Array.isArray(r.content) ? r.content.reduce((s, x) => s + (x.text?.length || 0), 0) : 0;
        run.resultChars += len;
        if (kind === 'explore') run.exploreChars += len;
      }
    }
  }
}

const agents = {};
for (const root of roots) {
  let dirs; try { dirs = fs.readdirSync(root); } catch { continue; }
  for (const d of dirs) {
    const agent = agentOf(d); if (!agent) continue;
    const full = path.join(root, d);
    let files; try { files = fs.readdirSync(full).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const fp = path.join(full, f);
      const st = fs.statSync(fp); if (st.mtimeMs < since) continue;
      const run = { agent, mtime: st.mtimeMs, turns: 0, exploreTurns: 0, calls: 0, explore: 0, edit: 0, other: 0,
        firstEdit: -1, resultChars: 0, exploreChars: 0, bashExplore: {}, reads: [], kindById: new Map(), coding: false };
      await scan(fp, run);
      // subagent transcripts belong to the parent run
      const sub = path.join(full, f.replace(/\.jsonl$/, ''), 'subagents');
      if (fs.existsSync(sub)) for (const s of fs.readdirSync(sub)) if (s.endsWith('.jsonl')) await scan(path.join(sub, s), run);
      if (!run.calls) continue;
      (agents[agent] ||= []).push(run);
    }
  }
}

const out = {};
for (const [agent, runs] of Object.entries(agents)) {
  runs.sort((a, b) => a.mtime - b.mtime);
  const coding = runs.filter(r => r.coding);
  if (!coding.length) continue;
  const seen = new Set(); // files this agent read in ANY earlier run
  let reads = 0, repeatReads = 0, dupWithin = 0;
  for (const r of runs) {
    const thisRun = new Set();
    for (const p of r.reads) {
      if (r.coding) { reads++; if (seen.has(p) && !thisRun.has(p)) repeatReads++; if (thisRun.has(p)) dupWithin++; }
      thisRun.add(p);
    }
    for (const p of thisRun) seen.add(p);
  }
  const sum = k => coding.reduce((s, r) => s + r[k], 0);
  const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
  out[agent] = {
    runs: runs.length, codingRuns: coding.length,
    calls: sum('calls'), explore: sum('explore'), edit: sum('edit'), other: sum('other'),
    turns: sum('turns'), exploreTurns: sum('exploreTurns'),
    resultChars: sum('resultChars'), exploreChars: sum('exploreChars'),
    medCallsBeforeFirstEdit: med(coding.filter(r => r.firstEdit > 0).map(r => r.firstEdit - 1)),
    medCalls: med(coding.map(r => r.calls)),
    bashExplore: coding.reduce((m, r) => { for (const [k, v] of Object.entries(r.bashExplore)) m[k] = (m[k] || 0) + v; return m; }, {}),
    reads, repeatReadsAcrossRuns: repeatReads, dupReadsWithinRun: dupWithin,
  };
}
console.log(JSON.stringify(out));
