#!/usr/bin/env node
// Agent OS status line — the persistent info bar at the bottom of a governed claude TUI.
//
// Claude Code invokes this on every event (and on the refreshInterval below) with the live session
// JSON on stdin (model, context window, cost, diff — see code.claude.com/docs/en/statusline). We
// blend those native metrics with the two things ONLY Agent OS knows: how many approvals this run
// has waiting in the inbox, and which human identity it's running as. The governance bit comes from
// a single tight-timeout loopback GET to /api/agent/status (session-secret gated, same lane as the
// gate hook); if the server is old or slow the fetch fails silent and we still render the local part.
//
// Zero deps, Node built-ins only (matches the repo's stance). Wired in by claude-launch.sh, which
// writes `statusLine.command = node <this>` into the per-session .claude/aos-settings.json.

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', gray: '\x1b[90m',
};
const sep = `${C.gray} · ${C.reset}`;

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    if (process.stdin.isTTY) return resolve({});
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (buf += c));
    process.stdin.on('end', () => {
      try { resolve(JSON.parse(buf || '{}')); } catch { resolve({}); }
    });
    // Never hang the TUI: if stdin never closes, bail with what we have.
    setTimeout(() => resolve((() => { try { return JSON.parse(buf || '{}'); } catch { return {}; } })()), 400);
  });
}

// Live governance for THIS run: pending approvals + run-as. Best-effort, fails to nulls.
async function governance() {
  const base = process.env.AOS_URL, session = process.env.SESSION, secret = process.env.AOS_SECRET;
  if (!base || !session || !secret) return {};
  try {
    const r = await fetch(`${base}/api/agent/status?session=${encodeURIComponent(session)}`, {
      headers: { 'x-aos-secret': secret, 'x-aos-tenant': process.env.AOS_TENANT || '' },
      signal: AbortSignal.timeout(700),
    });
    if (!r.ok) return {};
    return await r.json();
  } catch { return {}; }
}

// Green under half, yellow past half, red near the ceiling — shared by context + usage meters.
const pctColor = (pct) => (pct >= 80 ? C.red : pct >= 50 ? C.yellow : C.green);

function contextBar(cw) {
  const pct = cw && cw.used_percentage != null ? Math.round(cw.used_percentage) : null;
  if (pct == null) return `${C.gray}context —${C.reset}`;
  const width = 10, filled = Math.max(0, Math.min(width, Math.round((pct * width) / 100)));
  const color = pctColor(pct);
  const bar = '▓'.repeat(filled) + '░'.repeat(width - filled);
  return `${color}${bar}${C.reset} ${color}${pct}%${C.reset}`;
}

// Compact working dir: ~ for $HOME, and collapse to the last two segments when deep.
function folderLabel(cwd) {
  if (!cwd) return null;
  const home = process.env.HOME || '';
  let p = home && cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;
  const segs = p.split('/').filter(Boolean);
  if (segs.length > 2) p = (p.startsWith('~') ? '~/…/' : '…/') + segs.slice(-2).join('/');
  return p;
}

(async () => {
  const [d, g] = await Promise.all([readStdin(), governance()]);

  const parts = [];

  // Agent + short AOS session id (maps the TUI to the console row) + run-as identity.
  const agent = process.env.AGENT || (d.agent && d.agent.name) || 'agent';
  const sid = process.env.SESSION ? String(process.env.SESSION).slice(-4) : '';
  let head = `${C.cyan}${C.bold}◆ ${agent}${C.reset}`;
  if (sid) head += ` ${C.gray}#${sid}${C.reset}`;
  parts.push(head);
  if (g.runAs) parts.push(`${C.dim}as ${g.runAs}${C.reset}`);

  // Current working folder (compact).
  const folder = folderLabel((d.workspace && d.workspace.current_dir) || d.cwd);
  if (folder) parts.push(`${C.cyan}${folder}${C.reset}`);

  // Model · effort (JSON first, env fallback for either).
  const model = (d.model && d.model.display_name) || process.env.CLAUDE_MODEL;
  const effort = (d.effort && d.effort.level) || process.env.CLAUDE_EFFORT;
  if (model) parts.push(`${C.dim}${model}${effort ? `·${effort}` : ''}${C.reset}`);

  // Context window bar.
  parts.push(contextBar(d.context_window));

  // Weekly usage limit (Pro/Max only, present after the first API response — else skip silently).
  const wk = d.rate_limits && d.rate_limits.seven_day && d.rate_limits.seven_day.used_percentage;
  if (typeof wk === 'number') {
    const p = Math.round(wk);
    parts.push(`${C.gray}wk ${C.reset}${pctColor(p)}${p}%${C.reset}`);
  }

  // Cost (skip when free/zero).
  const cost = d.cost && typeof d.cost.total_cost_usd === 'number' ? d.cost.total_cost_usd : 0;
  if (cost > 0) parts.push(`${C.dim}$${cost < 1 ? cost.toFixed(3) : cost.toFixed(2)}${C.reset}`);

  // Diff churn this session.
  const add = (d.cost && d.cost.total_lines_added) || 0;
  const del = (d.cost && d.cost.total_lines_removed) || 0;
  if (add || del) parts.push(`${C.green}+${add}${C.reset}${C.gray}/${C.reset}${C.red}-${del}${C.reset}`);

  // The Agent-OS-distinctive signal: approvals this run is blocked on, right in the bar.
  if (g.pending > 0) parts.push(`${C.yellow}${C.bold}⏸ ${g.pending} waiting${C.reset}`);

  process.stdout.write(parts.join(sep));
})();
