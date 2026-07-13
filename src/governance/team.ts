/**
 * Team — the humans with access to a workspace, their roles, login sessions, and which agents
 * each may run. This is the identity behind the policy's `head`/`owner` approval levels: until
 * now those levels routed to nobody in particular; now they route to real members.
 *
 * Login is invite-token / magic-link: the owner is seeded on first boot, everyone else gets a
 * one-time link that mints a long-lived session cookie. All state lives in the per-workspace
 * SQLite DB (see state/db.ts) so it survives restarts and stays isolated per data home.
 */
import { randomBytes } from 'crypto';
import { Db } from '../state/db';
import { AgentAccess, Member, MemberIdentity, IdentityProvider, Role, ApprovalLevel, canApprove, NotificationPrefs, sanitizeNotificationPrefs, sanitizeNavPins } from '../types';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // magic links valid for 7 days
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // login cookie valid for 30 days
const MEMBER_CONTEXT_MAX = 8000; // cap a member's personal context so it can't dominate every prompt

interface MemberRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: 'invited' | 'active';
  created_at: number;
  avatar: string | null;
}

interface IdentityRow {
  provider: IdentityProvider;
  external_id: string;
  member_id: string;
  created_at: number;
  created_by: string | null;
}

const token = (): string => randomBytes(32).toString('hex');

export class TeamStore {
  constructor(private readonly db: Db) {}

  // ── members ────────────────────────────────────────────────────────────────
  listMembers(): Member[] {
    return this.db
      .prepare('SELECT * FROM members ORDER BY created_at')
      .all<MemberRow>()
      .map(toMember);
  }
  getMember(id: string): Member | undefined {
    const r = this.db.prepare('SELECT * FROM members WHERE id = ?').get<MemberRow>(id);
    return r ? toMember(r) : undefined;
  }
  getMemberByEmail(email: string): Member | undefined {
    const r = this.db.prepare('SELECT * FROM members WHERE email = ?').get<MemberRow>(email.toLowerCase());
    return r ? toMember(r) : undefined;
  }
  count(): number {
    return this.db.prepare('SELECT COUNT(*) AS n FROM members').get<{ n: number }>()!.n;
  }

  // ── per-member preferences (member_prefs: one JSON blob per member) ───────────
  /** The member's raw prefs blob — notification fields live flat at the top level, `navPins` alongside.
   *  Every accessor reads/writes through this so one concern (e.g. saving notif prefs) never clobbers a
   *  sibling (e.g. the pinned nav). Missing/corrupt row → empty object. */
  private rawPrefs(memberId: string): Record<string, unknown> {
    const row = this.db.prepare('SELECT prefs FROM member_prefs WHERE member_id = ?').get<{ prefs: string }>(memberId);
    if (!row) return {};
    try {
      const o = JSON.parse(row.prefs);
      return o && typeof o === 'object' ? (o as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private writeRawPrefs(memberId: string, blob: Record<string, unknown>): void {
    this.db
      .prepare(
        `INSERT INTO member_prefs (member_id, prefs, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(member_id) DO UPDATE SET prefs = excluded.prefs, updated_at = excluded.updated_at`,
      )
      .run(memberId, JSON.stringify(blob), Date.now());
  }

  /** This member's notification prefs, merged over the defaults (missing row → all defaults). */
  notificationPrefs(memberId: string): NotificationPrefs {
    return sanitizeNotificationPrefs(this.rawPrefs(memberId));
  }

  /** Persist a member's notification prefs (sanitized over the defaults) and return the resolved set.
   *  Spreads over the existing blob so a sibling key (navPins) survives. */
  setNotificationPrefs(memberId: string, prefs: unknown): NotificationPrefs {
    const clean = sanitizeNotificationPrefs(prefs);
    this.writeRawPrefs(memberId, { ...this.rawPrefs(memberId), ...clean });
    return clean;
  }

  /** The nav items this member has pinned to the sidebar's Main section, or `null` if never set
   *  (the client then applies its default pin layout). See `sanitizeNavPins`. */
  navPins(memberId: string): string[] | null {
    return sanitizeNavPins(this.rawPrefs(memberId).navPins);
  }

  /** Persist the member's pinned nav (sanitized, deduped), preserving notification prefs in the same
   *  blob. Returns the resolved list. */
  setNavPins(memberId: string, pins: unknown): string[] {
    const clean = sanitizeNavPins(pins) ?? [];
    this.writeRawPrefs(memberId, { ...this.rawPrefs(memberId), navPins: clean });
    return clean;
  }

  /** This member's personal context — free-text they want injected into every session that runs AS
   *  them (their working style, standing preferences, domain notes). '' when never set. Read at launch
   *  by `buildCompanyMd`. Self-service: every member owns their own, no role gate. */
  memberContext(memberId: string): string {
    const v = this.rawPrefs(memberId).context;
    return typeof v === 'string' ? v : '';
  }

  /** Persist a member's personal context (trimmed + capped so it can't bloat every prompt), preserving
   *  sibling prefs (notifications, navPins) in the same blob. Returns the stored value. */
  setMemberContext(memberId: string, context: unknown): string {
    const clean = String(context ?? '').trim().slice(0, MEMBER_CONTEXT_MAX);
    this.writeRawPrefs(memberId, { ...this.rawPrefs(memberId), context: clean });
    return clean;
  }

  /**
   * Directory search for the `directory_lookup` agent tool: match members by name/email substring
   * (case-insensitive); empty query → the whole team. Capped. Returns members only — the route joins
   * each with `externalIdsFor` so the agent learns who to reach on Slack/Discord/etc.
   */
  searchMembers(q: string, limit = 10): Member[] {
    const cap = Math.max(1, Math.min(limit, 50));
    const term = (q || '').trim().toLowerCase();
    if (!term) {
      return this.db.prepare('SELECT * FROM members ORDER BY name LIMIT ?').all<MemberRow>(cap).map(toMember);
    }
    const like = `%${term.replace(/[%_]/g, (c) => '\\' + c)}%`;
    return this.db
      .prepare("SELECT * FROM members WHERE lower(name) LIKE ? ESCAPE '\\' OR lower(email) LIKE ? ESCAPE '\\' ORDER BY name LIMIT ?")
      .all<MemberRow>(like, like, cap)
      .map(toMember);
  }

  /** Seed the owner on first boot. Returns a one-time login token, or null if a member exists. */
  bootstrapOwner(email: string, name: string): string | null {
    if (this.count() > 0) return null;
    const member = this.insertMember(email, name, 'owner', 'active');
    return this.issueToken(member.email, member.role, member.id);
  }

  /**
   * Invite a person by email. New email → creates an `invited` member; existing email → just
   * re-issues a fresh link (re-auth). Returns the member and the one-time magic-link token.
   */
  invite(input: { email: string; role: Role; invitedBy?: string }): { member: Member; token: string } {
    const email = input.email.toLowerCase();
    let member = this.getMemberByEmail(email);
    if (!member) member = this.insertMember(email, email.split('@')[0], input.role, 'invited');
    const tok = this.issueToken(member.email, member.role, input.invitedBy);
    return { member, token: tok };
  }

  /** Fresh magic link for an existing member (re-auth / recovery). Returns null if unknown. */
  issueLoginLink(email: string): { member: Member; token: string } | null {
    const member = this.getMemberByEmail(email);
    if (!member) return null;
    return { member, token: this.issueToken(member.email, member.role) };
  }

  setRole(id: string, role: Role): Member | undefined {
    this.db.prepare('UPDATE members SET role = ? WHERE id = ?').run(role, id);
    return this.getMember(id);
  }

  /** Set (or, with null, clear) a member's profile picture. Returns the updated member, or undefined
   *  if the id is unknown. The caller validates the data URL (see server.ts). */
  setAvatar(id: string, avatar: string | null): Member | undefined {
    if (!this.getMember(id)) return undefined;
    this.db.prepare('UPDATE members SET avatar = ? WHERE id = ?').run(avatar, id);
    return this.getMember(id);
  }

  /**
   * Remove a member and ALL their residue this store owns: login sessions, pending magic-links, and
   * their id from every agent's allowed-members grant. (Their personal connectors live in the
   * ConnectorStore — the caller clears those; see server.ts.) Refuses to remove the last owner.
   */
  removeMember(id: string): { ok: boolean; reason?: string } {
    const m = this.getMember(id);
    if (!m) return { ok: false, reason: 'not found' };
    if (m.role === 'owner' && this.ownerCount() <= 1) return { ok: false, reason: 'cannot remove the last owner' };
    this.db.prepare('DELETE FROM auth_sessions WHERE member_id = ?').run(id);
    // Kill outstanding magic-links for this email — otherwise a still-valid (possibly leaked) invite
    // would re-authenticate as a LATER member re-created with the same email (acceptToken resolves by
    // email, not by the original member id).
    this.db.prepare('DELETE FROM invites WHERE email = ?').run(m.email);
    // Drop the member from every agent's per-member grant so no assignment references a ghost id.
    for (const [agentId, access] of Object.entries(this.listAssignments())) {
      if (access.allowedMembers.includes(id)) {
        this.setAssignment(agentId, { ...access, allowedMembers: access.allowedMembers.filter((x) => x !== id) });
      }
    }
    // Drop their external-account links so a freed id can be re-mapped to someone else cleanly.
    this.db.prepare('DELETE FROM member_identities WHERE member_id = ?').run(id);
    this.db.prepare('DELETE FROM members WHERE id = ?').run(id);
    return { ok: true };
  }

  // ── identity map (external accounts → member, for chat-trigger run-as) ─────────
  /** Resolve a provider-side external id (Slack `U…`, Discord snowflake, …) to its member, if mapped. */
  memberByExternalId(provider: IdentityProvider, externalId: string): Member | undefined {
    const ext = normalizeExternalId(provider, externalId);
    if (!ext) return undefined;
    const row = this.db
      .prepare('SELECT member_id FROM member_identities WHERE provider = ? AND external_id = ?')
      .get<{ member_id: string }>(provider, ext);
    return row ? this.getMember(row.member_id) : undefined;
  }
  /** Every external identity linked to one member. */
  externalIdsFor(memberId: string): MemberIdentity[] {
    return this.db
      .prepare('SELECT * FROM member_identities WHERE member_id = ? ORDER BY provider')
      .all<IdentityRow>(memberId)
      .map(toIdentity);
  }
  /** All identities, grouped by member id — the shape the Team page consumes. */
  identitiesByMember(): Record<string, MemberIdentity[]> {
    const out: Record<string, MemberIdentity[]> = {};
    for (const r of this.db.prepare('SELECT * FROM member_identities ORDER BY provider').all<IdentityRow>()) {
      (out[r.member_id] ??= []).push(toIdentity(r));
    }
    return out;
  }
  /**
   * Link an external account to a member. A member holds at most one id per provider (the UI is one
   * handle per provider), so this replaces any existing handle for that (member, provider). The new
   * external id is claimed exclusively: if another member held it, they lose it (the PK reassigns).
   */
  setIdentity(memberId: string, provider: IdentityProvider, externalId: string, by?: string): MemberIdentity | undefined {
    if (!this.getMember(memberId)) return undefined;
    const ext = normalizeExternalId(provider, externalId);
    if (!ext) return undefined;
    this.db.prepare('DELETE FROM member_identities WHERE member_id = ? AND provider = ?').run(memberId, provider);
    this.db
      .prepare('INSERT OR REPLACE INTO member_identities (provider, external_id, member_id, created_at, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(provider, ext, memberId, Date.now(), by ?? null);
    return { memberId, provider, externalId: ext, createdAt: Date.now(), createdBy: by };
  }
  /** Remove a member's handle for one provider. */
  clearIdentity(memberId: string, provider: IdentityProvider): void {
    this.db.prepare('DELETE FROM member_identities WHERE member_id = ? AND provider = ?').run(memberId, provider);
  }

  // ── login / sessions ─────────────────────────────────────────────────────────
  /**
   * Look up a magic-link token WITHOUT consuming it — the read the interstitial
   * landing page uses to show "sign in as <email>". Returns null if the token is
   * unknown, already consumed, or expired. Kept side-effect-free so a link
   * preview / scanner's GET can never burn a one-time token (only the POST does).
   */
  peekToken(tok: string): { email: string; role: Role } | null {
    if (!tok) return null;
    const inv = this.db
      .prepare('SELECT email, role FROM invites WHERE token = ? AND accepted_at IS NULL AND expires_at > ?')
      .get<{ email: string; role: Role }>(tok, Date.now());
    return inv ? { email: inv.email, role: inv.role } : null;
  }

  /** Consume a magic-link token: activate the member and mint a session. Null if invalid/expired. */
  acceptToken(tok: string): { member: Member; sid: string } | null {
    const now = Date.now();
    const inv = this.db
      .prepare('SELECT * FROM invites WHERE token = ? AND accepted_at IS NULL AND expires_at > ?')
      .get<{ email: string }>(tok, now);
    if (!inv) return null;
    this.db.prepare('UPDATE invites SET accepted_at = ? WHERE token = ?').run(now, tok);
    const member = this.getMemberByEmail(inv.email);
    if (!member) return null;
    if (member.status !== 'active') this.db.prepare('UPDATE members SET status = ? WHERE id = ?').run('active', member.id);
    return { member: { ...member, status: 'active' }, sid: this.createSession(member.id) };
  }

  createSession(memberId: string): string {
    const sid = token();
    const now = Date.now();
    this.db
      .prepare('INSERT INTO auth_sessions (sid, member_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(sid, memberId, now, now + SESSION_TTL_MS);
    return sid;
  }
  resolveSession(sid: string): Member | undefined {
    if (!sid) return undefined;
    const now = Date.now();
    const row = this.db
      .prepare('SELECT member_id, expires_at, last_seen_at FROM auth_sessions WHERE sid = ? AND expires_at > ?')
      .get<{ member_id: string; expires_at: number; last_seen_at: number | null }>(sid, now);
    if (!row) return undefined;
    // Sliding window: bump the 30-day expiry on activity so a daily-active user never hits the hard
    // cutoff and gets locked out. Throttled to ≤1 write/day/session (only slide once the row is >1 day
    // short of a fresh full TTL), so this stays off the per-request hot path. The BROWSER cookie is
    // re-stamped separately on GET /api/auth/me (see server.ts) — the DB slide alone can't, since the
    // cookie's Max-Age is fixed at mint time.
    // We also stamp `last_seen_at` for presence ("who's online now"), throttled to ≤1 write/min so the
    // 1.5s console poll doesn't hammer the DB. Both fold into a single UPDATE when either fires.
    const slide = now + SESSION_TTL_MS - row.expires_at > 24 * 60 * 60 * 1000;
    const touch = !row.last_seen_at || now - row.last_seen_at > 60 * 1000;
    if (slide || touch) {
      this.db
        .prepare('UPDATE auth_sessions SET expires_at = ?, last_seen_at = ? WHERE sid = ?')
        .run(slide ? now + SESSION_TTL_MS : row.expires_at, now, sid);
    }
    return this.getMember(row.member_id);
  }

  /** Presence: the most-recent `last_seen_at` per member across their live auth sessions. The caller
   *  decides the online threshold (a member is "online" when this is within the last few minutes).
   *  Only members with at least one seen session appear. */
  presence(): { memberId: string; lastSeenAt: number }[] {
    return this.db
      .prepare(
        'SELECT member_id AS memberId, MAX(last_seen_at) AS lastSeenAt FROM auth_sessions WHERE last_seen_at IS NOT NULL AND expires_at > ? GROUP BY member_id',
      )
      .all<{ memberId: string; lastSeenAt: number }>(Date.now());
  }
  destroySession(sid: string): void {
    this.db.prepare('DELETE FROM auth_sessions WHERE sid = ?').run(sid);
  }

  // ── agent assignment ─────────────────────────────────────────────────────────
  getAssignment(agentId: string): AgentAccess {
    const r = this.db
      .prepare('SELECT allowed_roles, allowed_members FROM assignments WHERE agent_id = ?')
      .get<{ allowed_roles: string; allowed_members: string }>(agentId);
    return {
      allowedRoles: r ? (JSON.parse(r.allowed_roles) as Role[]) : [],
      allowedMembers: r ? (JSON.parse(r.allowed_members) as string[]) : [],
    };
  }
  listAssignments(): Record<string, AgentAccess> {
    const out: Record<string, AgentAccess> = {};
    for (const r of this.db
      .prepare('SELECT agent_id, allowed_roles, allowed_members FROM assignments')
      .all<{ agent_id: string; allowed_roles: string; allowed_members: string }>()) {
      out[r.agent_id] = {
        allowedRoles: JSON.parse(r.allowed_roles) as Role[],
        allowedMembers: JSON.parse(r.allowed_members) as string[],
      };
    }
    return out;
  }
  setAssignment(agentId: string, access: AgentAccess): void {
    this.db
      .prepare(
        `INSERT INTO assignments (agent_id, allowed_roles, allowed_members) VALUES (?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET allowed_roles = excluded.allowed_roles, allowed_members = excluded.allowed_members`,
      )
      .run(agentId, JSON.stringify(access.allowedRoles), JSON.stringify(access.allowedMembers));
  }

  /** Drop an agent's access row — called when the agent itself is deleted. */
  clearAssignment(agentId: string): void {
    this.db.prepare('DELETE FROM assignments WHERE agent_id = ?').run(agentId);
  }

  /** May this member run this agent? owner/admin always; member iff granted by role or id. */
  canRun(member: Member, agentId: string): boolean {
    if (member.role === 'owner' || member.role === 'admin') return true;
    const a = this.getAssignment(agentId);
    return a.allowedRoles.includes(member.role) || a.allowedMembers.includes(member.id);
  }

  /** Re-exported for callers that hold a member but not the helper. */
  canApprove(member: Member, level: ApprovalLevel): boolean {
    return canApprove(member.role, level);
  }

  // ── internals ────────────────────────────────────────────────────────────────
  private insertMember(email: string, name: string, role: Role, status: 'invited' | 'active'): Member {
    const member: Member = { id: 'm_' + token().slice(0, 16), email: email.toLowerCase(), name, role, status, createdAt: Date.now() };
    this.db
      .prepare('INSERT INTO members (id, email, name, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(member.id, member.email, member.name, member.role, member.status, member.createdAt);
    return member;
  }
  private issueToken(email: string, role: Role, invitedBy?: string): string {
    const tok = token();
    const now = Date.now();
    this.db
      .prepare('INSERT INTO invites (token, email, role, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(tok, email.toLowerCase(), role, invitedBy ?? null, now, now + INVITE_TTL_MS);
    return tok;
  }
  private ownerCount(): number {
    return this.db.prepare("SELECT COUNT(*) AS n FROM members WHERE role = 'owner'").get<{ n: number }>()!.n;
  }
}

function toMember(r: MemberRow): Member {
  return { id: r.id, email: r.email, name: r.name, role: r.role, status: r.status, createdAt: r.created_at, avatar: r.avatar ?? undefined };
}

function toIdentity(r: IdentityRow): MemberIdentity {
  return { memberId: r.member_id, provider: r.provider, externalId: r.external_id, createdAt: r.created_at, createdBy: r.created_by ?? undefined };
}

/** Trim, and lowercase case-insensitive providers (email) so lookups match regardless of casing. */
function normalizeExternalId(provider: IdentityProvider, externalId: string): string {
  const ext = (externalId || '').trim();
  return provider === 'email' ? ext.toLowerCase() : ext;
}
