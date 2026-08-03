/**
 * Host egress extraction + matching — the parsing core of Phase 2b (docs/host-connections-plan.md).
 *
 * Two pure concerns, kept out of enricher.ts so they're independently unit-tested:
 *   1. extractEgress(command)  — does this Bash command reach out to a host, and to WHICH host?
 *   2. hostMatches / isInternalHost — does a host match a granted matcher, and does it *look* internal?
 *
 * Guiding principle (from the plan): **parse conservatively, fail loud.** We are NOT a shell
 * interpreter. We detect the common egress forms; when a command clearly reaches out but we can't
 * pin the host (a variable, a subshell, a pipe), we return `unknown: true` so the caller can ESCALATE
 * rather than wave it through. Over-escalation is acceptable; a silent false-allow is not.
 *
 * This is best-effort policy-layer governance, not a firewall (see the plan's §2 "honest constraint").
 */
import type { Decision, ApprovalLevel } from '../types';
import { riskClassForLevel } from '../types';

/** The host-row protocol vocabulary (matches src/hosts/hosts.ts HostProtocol). Finer wire protocols
 *  (mysql/redis/mongo/nc) collapse to 'any' — matching is primarily by host, protocol only narrows. */
export type EgressProtocol = 'ssh' | 'http' | 'postgres' | 'any';

export interface Egress {
  /** The command contains an outbound-connection verb (ssh/curl/psql/…). */
  egress: boolean;
  /** The extracted destination host (lowercased, no port), when we could pin it. */
  host?: string;
  port?: number;
  protocol?: EgressProtocol;
  /** Egress was detected but the host couldn't be extracted (variable/pipe/opaque) → caller should escalate. */
  unknown: boolean;
}

/**
 * Outbound-connection verbs → the protocol they imply, matched against the EXECUTABLE NAME of a
 * command invocation (see {@link egressHead}) — never as a bare substring of the whole line.
 *
 * That distinction is the whole point. A `\bssh\b` search over the command text fires on
 * `grep -i "cmd\|exec\|ssh\|sprintf"` and on `ssh -i ~/.ssh/id_rsa` twice over: the word appears, no
 * host can be pinned, and a purely local grep is escalated to an OWNER approval. Live northwind data
 * (2026-08): 10 of the last 15 host approvals were "host could not be identified", most of them this
 * shape. Matching the head token instead keeps the same governance reach (every real invocation still
 * has its verb in command position) while the word-in-a-string cases stop paging a human.
 *
 * `positional` marks the verbs whose destination is a bare token rather than a URL or -h flag
 * (`ssh box`, `nc host 22`, `telnet host`) — rule 4 below.
 */
interface EgressVerb { name: RegExp; protocol: EgressProtocol; positional?: boolean }
const EGRESS_VERBS: EgressVerb[] = [
  { name: /^ssh$/i, protocol: 'ssh', positional: true },
  { name: /^scp$/i, protocol: 'ssh', positional: true },
  { name: /^sftp$/i, protocol: 'ssh', positional: true },
  { name: /^rsync$/i, protocol: 'ssh', positional: true },
  { name: /^curl$/i, protocol: 'http' },
  { name: /^wget$/i, protocol: 'http' },
  { name: /^psql$/i, protocol: 'postgres' },
  { name: /^pg_dump$/i, protocol: 'postgres' },
  { name: /^mysql$/i, protocol: 'any' },
  { name: /^mongosh?$/i, protocol: 'any' },
  { name: /^redis-cli$/i, protocol: 'any' },
  { name: /^ncat$/i, protocol: 'any', positional: true },
  { name: /^nc$/i, protocol: 'any', positional: true },
  { name: /^telnet$/i, protocol: 'any', positional: true },
];

/** Shell words that PREFIX a command without being it — the token after them (and after their flag
 *  arguments) is still in command position, so `sudo -u deploy ssh box` is still an ssh. */
const COMMAND_PREFIX = /^(sudo|doas|env|time|timeout|nohup|exec|command|builtin|nice|ionice|stdbuf|xargs|if|then|else|elif|do|while|until|not|!)$/i;

const SCHEME_PROTOCOL: Record<string, EgressProtocol> = {
  http: 'http', https: 'http', postgres: 'postgres', postgresql: 'postgres',
};

/** Split a URL authority (`user:pass@host:port`) into host + port, dropping any credentials. */
function parseAuthority(authority: string): { host: string; port?: number } {
  let a = authority.trim();
  const at = a.lastIndexOf('@');
  if (at >= 0) a = a.slice(at + 1); // drop user[:pass]@
  // The caller's URL match runs to the end of the token, so trim the path/query/fragment first. The
  // IPv4 branch below stops at `/` on its own, but the bracketed-IPv6 pattern is anchored — without
  // this, `https://[::1]:9000/x` failed it and fell through to the IPv4 branch, which pinned the host
  // as the literal `[`.
  a = a.split(/[/?#]/)[0];
  // Bracketed IPv6 [::1]:port
  const v6 = a.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (v6) return { host: v6[1].toLowerCase(), port: v6[2] ? Number(v6[2]) : undefined };
  const m = a.match(/^([^:/]+)(?::(\d+))?/);
  if (!m) return { host: '' };
  return { host: m[1].toLowerCase(), port: m[2] ? Number(m[2]) : undefined };
}

/** A token that looks like a bare host or host:port (not a flag, not a URL, not an obvious file/glob). */
function looksLikeHost(tok: string): boolean {
  if (!tok || tok.startsWith('-')) return false;
  if (/[$`(){}*!\\]/.test(tok)) return false; // variable/subshell/glob → not a pinnable host
  const hostPart = tok.replace(/:\d+$/, '').replace(/:.*/, ''); // strip :port or scp/ssh :path
  // an IPv4 or a dotted/hyphenated hostname or a single label
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(hostPart) && /[a-z0-9]/i.test(hostPart);
}

/**
 * Split a command line into candidate INVOCATIONS — the pieces whose first token sits in the
 * executable slot. Splits on the shell's command separators (`| ; & && || newline` and the
 * subshell/group punctuation `( ) { } $( \``), but is QUOTE-AWARE: a separator inside a quoted string
 * is data, not a separator. That matters — `grep -i "cmd|exec|ssh|sprintf"` must stay ONE invocation
 * headed by `grep`, or the split alone would manufacture a segment that looks like an `ssh` command.
 *
 * Not a shell parser, and deliberately not trying to be: an approximation that keeps every real
 * invocation's verb in head position (see the module note on parsing conservatively).
 */
function splitSegments(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  const flush = (): void => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      cur += ch;
      // A backslash escape only suppresses the closing quote inside double quotes; in single quotes
      // the shell takes it literally.
      if (ch === '\\' && quote === '"' && i + 1 < command.length) { cur += command[++i]; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '\\' && i + 1 < command.length) { cur += ch + command[++i]; continue; }
    if (ch === '|' || ch === ';' || ch === '&' || ch === '\n' || ch === '(' || ch === ')' || ch === '{' || ch === '}' || ch === '`') { flush(); continue; }
    cur += ch;
  }
  flush();
  return out;
}

/** Sub-command lines hidden one level DOWN inside a segment: the quoted value of a variable assignment
 *  (`SSH="ssh -i k root@box"` — then invoked as `$SSH`), a `sh -c '…'` payload, and a `find -exec` tail.
 *  Each is its own command line, so we recurse into it rather than lose the egress it performs. */
function descend(segment: string): string[] {
  const inner: string[] = [];
  for (const m of segment.matchAll(/(?:^|\s)(?:[A-Za-z_][A-Za-z0-9_]*=|-c[=\s]+)(["'])([\s\S]*?)\1/g)) inner.push(m[2]);
  const exec = segment.match(/(?:^|\s)-exec(?:dir)?\s+([\s\S]+)$/);
  if (exec) inner.push(exec[1]);
  return inner;
}

/** The egress verb this segment INVOKES, plus the segment text from that verb onward (what the host
 *  rules below parse). Skips wrapper/keyword prefixes, their flags and flag arguments, and inline
 *  `VAR=value` prefixes. Returns null the moment a non-egress executable owns the head slot — that's
 *  what stops `grep … "ssh"` from reading as an ssh. */
function egressHead(segment: string): { verb: EgressVerb; text: string } | null {
  const tokens = segment.split(/\s+/).filter(Boolean);
  let sawPrefix = false;
  let prevWasFlag = false;
  for (let i = 0; i < tokens.length; i++) {
    // Strip surrounding quotes (`bash -c "ssh box"` leaves a leading `"`) and any leading path, so
    // `/usr/bin/ssh` is still ssh.
    const t = tokens[i].replace(/^['"]+/, '').replace(/['"]+$/, '').replace(/^.*\//, '');
    if (!t) continue;
    const verb = EGRESS_VERBS.find((v) => v.name.test(t));
    if (verb) return { verb, text: tokens.slice(i).join(' ') };
    if (COMMAND_PREFIX.test(t)) { sawPrefix = true; prevWasFlag = false; continue; }
    if (t.startsWith('-')) { prevWasFlag = !t.includes('='); continue; }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { prevWasFlag = false; continue; } // inline env assignment
    if (/^\d+[smhd]?$/i.test(t)) { prevWasFlag = false; continue; }            // `timeout 30 ssh …`
    if (sawPrefix && prevWasFlag) { prevWasFlag = false; continue; }           // a wrapper flag's argument
    return null; // a real command, and it isn't an egress verb
  }
  return null;
}

/**
 * Does this Bash command reach out to a host, and which one? Best-effort; `unknown:true` when egress
 * is clear but the host isn't pinnable. Only the FIRST invocation that reaches out is extracted (v1) —
 * first, not best, so a later pinnable-but-public target can never mask an earlier unpinnable one.
 */
export function extractEgress(command: string): Egress {
  const cmd = (command || '').trim();
  if (!cmd) return { egress: false, unknown: false };
  return findEgress(cmd, 0) ?? { egress: false, unknown: false };
}

function findEgress(command: string, depth: number): Egress | null {
  for (const seg of splitSegments(command)) {
    const head = egressHead(seg);
    if (head) return extractTarget(head.text, head.verb);
    if (depth < 3) {
      for (const inner of descend(seg)) {
        const found = findEgress(inner, depth + 1);
        if (found) return found;
      }
    }
  }
  return null;
}

/** Pin the destination of ONE invocation (`cmd` starts at the verb). */
function extractTarget(cmd: string, verb: EgressVerb): Egress {
  // 1. URL form (curl/wget/psql/redis/mongo): scheme://[user:pass@]host[:port]/…
  const url = cmd.match(/\b([a-z][a-z0-9+.-]*):\/\/([^\s'"`|;&<>]+)/i);
  if (url) {
    const scheme = url[1].toLowerCase();
    const { host, port } = parseAuthority(url[2]);
    if (host && !/[$`{}]/.test(host)) {
      return { egress: true, host, port, protocol: SCHEME_PROTOCOL[scheme] ?? verb.protocol, unknown: false };
    }
  }

  // 2. Explicit host flag: -h HOST | --host HOST | --host=HOST | -h=HOST (psql/mysql/redis-cli/mongo/nc).
  const flag = cmd.match(/(?:^|\s)(?:-h|--host)[=\s]+([^\s'"`|;&<>]+)/i);
  if (flag && looksLikeHost(flag[1])) {
    const host = flag[1].replace(/:\d+$/, '').toLowerCase();
    const portM = flag[1].match(/:(\d+)$/);
    return { egress: true, host, port: portM ? Number(portM[1]) : undefined, protocol: verb.protocol, unknown: false };
  }

  // 3. user@host token (ssh/scp/sftp/rsync). Also plain `host:path` for scp/rsync.
  const userAt = cmd.match(/(?:^|\s)([a-z0-9._-]+)@([a-z0-9][a-z0-9.-]*)(?::(\d+))?(?:\s|:|$)/i);
  if (userAt && verb.protocol === 'ssh') {
    return { egress: true, host: userAt[2].toLowerCase(), port: userAt[3] ? Number(userAt[3]) : undefined, protocol: 'ssh', unknown: false };
  }

  // 4. ssh/telnet/nc positional host: the first non-flag token after the verb that looks like a host.
  if (verb.positional) {
    const tokens = cmd.split(/\s+/).slice(1); // `cmd` starts at the verb
    for (const raw of tokens) {
      const t = raw.replace(/^['"]|['"]$/g, '');
      if (t.startsWith('-')) continue; // an option
      if (/^\d+$/.test(t)) continue;   // a bare port (nc host port) handled by the token before it
      if (/^[.~/]/.test(t)) continue;  // a local path — `scp ./file box:/tmp/` puts the source first
      if (looksLikeHost(t)) {
        const host = t.replace(/:\d+$/, '').replace(/:.*/, '').toLowerCase();
        const portM = t.match(/:(\d+)$/);
        return { egress: true, host, port: portM ? Number(portM[1]) : undefined, protocol: verb.protocol, unknown: false };
      }
      // a token that isn't a flag and isn't a host (a variable, a quoted string) → stop guessing.
      break;
    }
  }

  // Egress verb present but no host pinned → fail loud.
  return { egress: true, unknown: true, protocol: verb.protocol };
}

// ── matching ────────────────────────────────────────────────────────────────────────

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const o = Number(p);
    if (o > 255) return null;
    n = n * 256 + o;
  }
  return n >>> 0;
}

function cidrMatch(host: string, cidr: string): boolean {
  const [net, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const hostInt = ipv4ToInt(host);
  const netInt = ipv4ToInt(net);
  if (hostInt === null || netInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
  return (hostInt & mask) === (netInt & mask);
}

/**
 * Normalise a host for comparison: lowercase, drop a trailing root dot, unwrap `[ipv6]`, and strip a
 * `:port` — but NEVER from a bare IPv6 literal, where the colons are the address. `'::1'.replace(/:\d+$/)`
 * yields `':'`, which made every IPv6 host collapse to the same string: `hostMatches('::1', '::2')` was
 * true, and the loopback/internal checks were matching on the wreckage rather than the address.
 */
function normalizeHost(host: string): string {
  const h = (host || '').trim().toLowerCase().replace(/\.$/, '');
  const bracketed = h.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) return bracketed[1];
  if ((h.match(/:/g) || []).length > 1) return h; // bare IPv6 — there is no port to strip
  return h.replace(/:\d+$/, '');
}

/** Does `host` match a granted host matcher — an exact host, a `*.wildcard`, a CIDR, or `host:port`?
 *  Port in the matcher is ignored for host comparison in v1 (the host is the blast-radius unit). */
export function hostMatches(host: string, matcher: string): boolean {
  const h = normalizeHost(host);
  const m = (matcher || '').trim().toLowerCase();
  if (!h || !m) return false;
  if (m.includes('/') && ipv4ToInt(h) !== null) return cidrMatch(h, m);
  const mHost = normalizeHost(m);
  if (mHost.includes('*')) {
    const re = new RegExp('^' + mHost.split('*').map(escapeRe).join('.*') + '$');
    return re.test(h);
  }
  return h === mHost;
}

/**
 * True if `host` is THIS machine — loopback (`127.0.0.0/8`, `::1`) or `localhost`.
 *
 * Such a "reach" never leaves the box, so it isn't egress and there is nothing for host governance to
 * protect: anything listening on loopback is already reachable by the shell the agent is holding, and
 * `shell.exec` governs that. Treating it as egress bought no safety and cost a great deal of noise —
 * on live northwind, `127.0.0.1` + `localhost` accounted for **35 of the 49** host approvals ever
 * raised (an agent curling its own dev server, or the Agent OS API, at owner/admin tier).
 *
 * Deliberate limit: a loopback port that is an `ssh -L` tunnel to somewhere else is invisible to us.
 * That's the same honest constraint as the rest of this module (§2 of the plan) — a policy layer, not
 * a firewall.
 */
export function isLoopbackHost(host: string): boolean {
  const h = normalizeHost(host);
  if (!h) return false;
  if (h === 'localhost' || h === 'localhost.localdomain' || h === '::1' || h.startsWith('[::1')) return true;
  return ipv4ToInt(h) !== null && cidrMatch(h, '127.0.0.0/8');
}

/** True if `host` looks internal/sensitive: private/loopback/link-local IPs, localhost, a bare
 *  single-label hostname, or an internal TLD (.internal/.local/.lan/.corp/.home/.intranet). Public
 *  FQDNs (api.stripe.com) are NOT internal — they stay ungoverned under netMode 'open'. */
export function isInternalHost(host: string): boolean {
  const h = normalizeHost(host);
  if (!h) return false;
  if (isLoopbackHost(h)) return true;
  if (h.includes(':')) return true; // any other IPv6 literal — treat as internal (fail toward escalation)
  const ip = ipv4ToInt(h);
  if (ip !== null) {
    return cidrMatch(h, '10.0.0.0/8') || cidrMatch(h, '172.16.0.0/12') || cidrMatch(h, '192.168.0.0/16')
      || cidrMatch(h, '127.0.0.0/8') || cidrMatch(h, '169.254.0.0/16');
  }
  if (/\.(internal|local|lan|corp|home|intranet)$/.test(h)) return true;
  // A bare single-label hostname (no dots) — resolves via internal DNS / an ssh-config alias, not a public FQDN.
  if (!h.includes('.')) return true;
  return false;
}

// ── fact computation (what the enricher merges in) ────────────────────────────────────

/** A granted host row, reduced to what matching needs. */
export interface HostGrant { match: string; protocol: EgressProtocol; posture: 'allow' | 'ask' | 'never' }

/** The host facts an enriched attempt carries (all optional; absent when the command isn't egress). */
export interface HostFacts {
  netEgress: boolean;
  netProtocol?: EgressProtocol;
  host?: string;
  hostUnknown?: boolean;   // egress but host not pinnable → escalate
  hostInternal?: boolean;  // private/loopback/internal-TLD/bare-hostname
  hostListed?: boolean;    // matches an enabled granted host row
  hostAllowed?: boolean;   // === hostListed (explicitly granted); the policy fact
  hostPosture?: 'allow' | 'ask' | 'never'; // the matched row's default tier
}

/** Does a grant apply to this egress? Host must match; protocol narrows (row 'any' or wire 'any' → any). */
function grantApplies(host: string, wire: EgressProtocol, g: HostGrant): boolean {
  if (!hostMatches(host, g.match)) return false;
  return g.protocol === 'any' || wire === 'any' || g.protocol === wire;
}

/**
 * Compute host facts for a Bash command against the agent's granted hosts. Pure. The govern/reclassify
 * decision (which uses netMode) stays with the caller (gate()); this only reports what the command IS.
 */
export function computeHostFacts(command: string, grants: HostGrant[]): HostFacts {
  const e = extractEgress(command);
  if (!e.egress) return { netEgress: false };
  const facts: HostFacts = { netEgress: true, netProtocol: e.protocol };
  if (e.unknown || !e.host) { facts.hostUnknown = true; facts.hostAllowed = false; return facts; }
  // A pinned LOOPBACK target isn't a reach at all — it never leaves the box (see isLoopbackHost). Report
  // no egress, so the gate leaves the call as plain `shell.exec` and the ordinary policy governs it.
  // Only a PINNED host can be loopback; an unpinnable one is still unknown → escalated above.
  if (isLoopbackHost(e.host)) return { netEgress: false };
  facts.host = e.host;
  facts.hostInternal = isInternalHost(e.host);
  const wire = e.protocol ?? 'any';
  const match = grants.find((g) => grantApplies(e.host as string, wire, g));
  if (match) { facts.hostListed = true; facts.hostAllowed = true; facts.hostPosture = match.posture; }
  else { facts.hostListed = false; facts.hostAllowed = false; }
  return facts;
}

// ── the built-in host-governance decision (engine-level, Phase 2b) ────────────────────

/**
 * The host-governance verdict, computed IN CODE from the enriched facts — applied by the gate whenever
 * host governance is enabled, independent of the editable policy document. This is the fix for the
 * propagation gap: a tenant whose persisted policy predates the host rules still gets governed, because
 * the rules live here, not in the JSON the tenant may never have adopted. The editable policy still
 * contributes the never-tier (destructive / over-cap spend / bulk delete) via its `*` rules; the gate
 * combines the two with `stricterDecision` (the more restrictive wins), so `ssh box 'rm -rf /'` is still
 * denied. Per-host `posture` is the owner's knob; the approval LEVEL is fixed by capability
 * (ssh.exec → owner, net.connect → admin/head). Only meaningful for the reclassified host capabilities.
 */
export function hostGovernanceDecision(capability: string, facts: Record<string, unknown>): Decision {
  const level: ApprovalLevel = capability === 'ssh.exec' ? 'owner' : 'head';
  const rc = riskClassForLevel(level);
  if (facts.hostPosture === 'never') return { effect: 'deny', riskClass: 'deny', reason: `${capability}: host posture is never` };
  if (facts.hostUnknown === true) return { effect: 'approve', level, riskClass: rc, reason: `${capability}: host could not be identified` };
  if (facts.hostAllowed === false) return { effect: 'approve', level, riskClass: rc, reason: `${capability}: host is not a granted connection` };
  if (facts.hostPosture === 'ask') return { effect: 'approve', level, riskClass: rc, reason: `${capability}: host posture is ask` };
  return { effect: 'allow', riskClass: 'green', reason: `${capability}: granted host` };
}

/** Restrictiveness rank of a decision: deny (3) > approve@owner (2) > approve@head (1) > allow (0). */
export function decisionRank(d: Decision): number {
  if (d.effect === 'deny') return 3;
  if (d.effect === 'approve') return d.level === 'owner' ? 2 : 1;
  return 0;
}

/** The more restrictive of two decisions (a tie keeps `a` — the editable-policy verdict). */
export function stricterDecision(a: Decision, b: Decision): Decision {
  return decisionRank(b) > decisionRank(a) ? b : a;
}
