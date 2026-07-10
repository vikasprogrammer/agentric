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

// Outbound-connection verbs → the protocol they imply. Word-boundary matched so `sync`≠`nc`, `func`≠`nc`.
const EGRESS_VERBS: { re: RegExp; protocol: EgressProtocol }[] = [
  { re: /\bssh\b/i, protocol: 'ssh' },
  { re: /\bscp\b/i, protocol: 'ssh' },
  { re: /\bsftp\b/i, protocol: 'ssh' },
  { re: /\brsync\b/i, protocol: 'ssh' },
  { re: /\bcurl\b/i, protocol: 'http' },
  { re: /\bwget\b/i, protocol: 'http' },
  { re: /\bpsql\b/i, protocol: 'postgres' },
  { re: /\bpg_dump\b/i, protocol: 'postgres' },
  { re: /\bmysql\b/i, protocol: 'any' },
  { re: /\bmongosh?\b/i, protocol: 'any' },
  { re: /\bredis-cli\b/i, protocol: 'any' },
  { re: /\bncat\b/i, protocol: 'any' },
  { re: /\bnc\b/i, protocol: 'any' },
  { re: /\btelnet\b/i, protocol: 'any' },
];

const SCHEME_PROTOCOL: Record<string, EgressProtocol> = {
  http: 'http', https: 'http', postgres: 'postgres', postgresql: 'postgres',
};

/** Split a URL authority (`user:pass@host:port`) into host + port, dropping any credentials. */
function parseAuthority(authority: string): { host: string; port?: number } {
  let a = authority.trim();
  const at = a.lastIndexOf('@');
  if (at >= 0) a = a.slice(at + 1); // drop user[:pass]@
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
 * Does this Bash command reach out to a host, and which one? Best-effort; `unknown:true` when egress
 * is clear but the host isn't pinnable. Only the FIRST target is extracted (v1).
 */
export function extractEgress(command: string): Egress {
  const cmd = (command || '').trim();
  if (!cmd) return { egress: false, unknown: false };
  const verb = EGRESS_VERBS.find((v) => v.re.test(cmd));
  if (!verb) return { egress: false, unknown: false };

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

  // 4. ssh/telnet positional host: the first non-flag, non-verb token that looks like a host.
  if (verb.protocol === 'ssh' || verb.re.source.includes('telnet') || verb.re.source.includes('\\bnc')) {
    const tokens = cmd.split(/\s+/);
    let seenVerb = false;
    for (const raw of tokens) {
      const t = raw.replace(/^['"]|['"]$/g, '');
      if (!seenVerb) { if (EGRESS_VERBS.some((v) => v.re.test(t))) seenVerb = true; continue; }
      if (t.startsWith('-')) continue; // an option
      if (/^\d+$/.test(t)) continue;   // a bare port (nc host port) handled by the token before it
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

/** Does `host` match a granted host matcher — an exact host, a `*.wildcard`, a CIDR, or `host:port`?
 *  Port in the matcher is ignored for host comparison in v1 (the host is the blast-radius unit). */
export function hostMatches(host: string, matcher: string): boolean {
  const h = (host || '').toLowerCase().replace(/\.$/, '').replace(/:\d+$/, '');
  const m = (matcher || '').trim().toLowerCase();
  if (!h || !m) return false;
  if (m.includes('/') && ipv4ToInt(h) !== null) return cidrMatch(h, m);
  const mHost = m.replace(/:\d+$/, '');
  if (mHost.includes('*')) {
    const re = new RegExp('^' + mHost.split('*').map(escapeRe).join('.*') + '$');
    return re.test(h);
  }
  return h === mHost;
}

/** True if `host` looks internal/sensitive: private/loopback/link-local IPs, localhost, a bare
 *  single-label hostname, or an internal TLD (.internal/.local/.lan/.corp/.home/.intranet). Public
 *  FQDNs (api.stripe.com) are NOT internal — they stay ungoverned under netMode 'open'. */
export function isInternalHost(host: string): boolean {
  const h = (host || '').toLowerCase().replace(/\.$/, '').replace(/:\d+$/, '');
  if (!h) return false;
  if (h === 'localhost' || h === '::1' || h.startsWith('[::1')) return true;
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
