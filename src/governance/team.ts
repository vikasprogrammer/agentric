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
import { AgentAccess, Member, Role, ApprovalLevel, canApprove } from '../types';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // magic links valid for 7 days
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // login cookie valid for 30 days

interface MemberRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: 'invited' | 'active';
  created_at: number;
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
    this.db.prepare('DELETE FROM members WHERE id = ?').run(id);
    return { ok: true };
  }

  // ── login / sessions ─────────────────────────────────────────────────────────
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
    const row = this.db
      .prepare('SELECT member_id FROM auth_sessions WHERE sid = ? AND expires_at > ?')
      .get<{ member_id: string }>(sid, Date.now());
    return row ? this.getMember(row.member_id) : undefined;
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
  return { id: r.id, email: r.email, name: r.name, role: r.role, status: r.status, createdAt: r.created_at };
}
