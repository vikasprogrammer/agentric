// Stripe-style prefixed entity ids — one source of truth for the whole codebase.
//
// Every referenceable persisted entity gets an opaque, namespaced id of the form
// `<prefix>_<hex>` (e.g. `ses_a1b2c3d4e5f60718`). The prefix makes an id
// self-describing in logs, URLs, audit trails and API responses — you can tell a
// session id from a task id at a glance, exactly like Stripe's `cus_`/`sub_`/`txn_`.
//
// Rollout is FORWARD-ONLY: new rows get prefixed ids; pre-existing bare-hex ids stay
// valid. Nothing in the codebase parses or validates an id prefix, so old and new ids
// coexist safely (see `parseId`/`isId` below — provided for optional, non-load-bearing
// introspection, never as a gate).
//
// NOT every id lives here. Deliberately excluded because they are bearer secrets or
// carry an externally-imposed format, not referenceable entity ids:
//   - auth-session cookie sid, invite token, session/webhook secrets, artifact share
//     token  → high-entropy secrets, must stay unguessable and unprefixed.
//   - claudeSessionId                                → a raw UUID handed to `claude --session-id`.
//   - audit_events.id                                → numeric AUTOINCREMENT.
//   - connectors.id, tenants.slug, settings.key      → human-readable slugs / caller keys.

import { randomBytes } from 'crypto';

/**
 * The prefix registry. Keys are logical entity names used at call sites; values are the
 * wire prefix (without the trailing underscore). Keep this the ONLY place a prefix is
 * spelled out — adding an entity means adding one line here.
 */
export const ID_PREFIX = {
  member: 'm', // pre-existing prefix; kept as-is so historical `m_…` ids stay uniform
  session: 'ses', // agent/terminal sessions (term_sessions)
  message: 'msg', // inbox messages
  question: 'qst', // ask-a-human questions
  agentAsk: 'ask', // agent-to-agent asks
  approval: 'apr', // governance approvals
  automation: 'au', // pre-existing prefix; automations/triggers
  artifact: 'art', // published artifacts
  videoJob: 'vid', // video render jobs
  memory: 'mem', // agent memories
  kbPage: 'kbp', // knowledge-base pages
  kbRevision: 'kbr', // knowledge-base revisions
  task: 'tsk', // work-queue tasks
  taskEvent: 'tev', // task event-log entries
  taskAttachment: 'tatt', // task file attachments
  goal: 'goal', // goals
  goalEvent: 'gev', // goal event-log entries
  agentRevision: 'arev', // agent self-edit revisions
  policyRevision: 'prev', // policy revisions
} as const;

export type IdEntity = keyof typeof ID_PREFIX;

/** 8 random bytes → 16 hex chars (64 bits). Comfortably collision-free per tenant. */
const ENTROPY_BYTES = 8;

/**
 * Mint a fresh, namespaced id for `entity`, e.g. `newId('session')` → `ses_1f3a…`.
 * This is the ONLY sanctioned way to generate an entity id.
 */
export function newId(entity: IdEntity): string {
  return `${ID_PREFIX[entity]}_${randomBytes(ENTROPY_BYTES).toString('hex')}`;
}

/** Reverse-lookup: prefix string → logical entity name (or undefined). */
const ENTITY_BY_PREFIX: Record<string, IdEntity> = Object.fromEntries(
  (Object.entries(ID_PREFIX) as [IdEntity, string][]).map(([entity, prefix]) => [prefix, entity]),
);

/**
 * Best-effort introspection — split a `<prefix>_<rest>` id. Returns null for bare/legacy
 * ids (no known prefix). NON-LOAD-BEARING: never use this to authorize or route; ids are
 * opaque and forward-only means many valid ids have no prefix.
 */
export function parseId(id: string): { entity: IdEntity; prefix: string; rest: string } | null {
  const underscore = id.indexOf('_');
  if (underscore <= 0) return null;
  const prefix = id.slice(0, underscore);
  const entity = ENTITY_BY_PREFIX[prefix];
  if (!entity) return null;
  return { entity, prefix, rest: id.slice(underscore + 1) };
}

/** True if `id` carries the prefix registered for `entity`. Introspection only — not a gate. */
export function isId(id: string, entity: IdEntity): boolean {
  return id.startsWith(`${ID_PREFIX[entity]}_`);
}
