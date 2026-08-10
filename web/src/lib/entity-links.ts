// ── Entity-id autolinking ──────────────────────────────────────────────────────────────────────
// Every referenceable row carries a Stripe-style prefixed id (`src/id.ts` — `tsk_…`, `goal_…`,
// `art_…`). Agents quote those ids constantly in prose ("tsk_dcde91f9e81af705 is in progress"),
// which leaves the reader with a token they can only follow by hand-searching a list. So wherever
// an id is DISPLAYED — rendered markdown, raw-text cards, even the terminal buffer — a bare id is
// turned into a link to the page that shows it.
//
// Only prefixes whose console route takes the id ITSELF as its detail segment belong here: a
// session's route detail is its tmux name, not `ses_…`, so sessions are deliberately absent.
export const ENTITY_ROUTES: Record<string, string> = {
  tsk: 'tasks',
  goal: 'goals',
  art: 'artifacts',
}

/** Regex SOURCE (no flags) for a bare entity id, so callers can embed it in a bigger alternation.
 *  `\b` keeps it from firing mid-token (`x_tsk_…`, `atsk_…`), and the ≥4 hex tail keeps ordinary
 *  identifiers out (`goal_id` has no hex run). */
export const ENTITY_ID_SRC = `\\b(?:${Object.keys(ENTITY_ROUTES).join('|')})_[0-9a-f]{4,}\\b`

/** A fresh global matcher per call — a shared `g` regex carries `lastIndex` between callers. */
export const entityIdRe = () => new RegExp(ENTITY_ID_SRC, 'g')

const EXACT_ID_RE = new RegExp(`^${ENTITY_ID_SRC}$`)

/** True when the whole string is one entity id (used to linkify an id written as `code`). */
export const isEntityId = (s: string) => EXACT_ID_RE.test(s.trim())

/** In-app hash route for an entity id, or null when the prefix isn't one we route. */
export function entityHref(id: string): string | null {
  const route = ENTITY_ROUTES[id.slice(0, id.indexOf('_'))]
  return route ? `#/${route}/${encodeURIComponent(id)}` : null
}

/** Absolute URL for the same target — for surfaces outside the SPA's own anchors (the terminal
 *  linkifier opens a new tab, which needs a full URL rather than a bare `#/…` fragment). */
export function entityUrl(id: string): string | null {
  const href = entityHref(id)
  // Keep any deployment sub-path, but drop a trailing `*.html` (the terminal test bed) — the console
  // SPA that owns these routes is served from the directory, not from that page.
  const base = window.location.pathname.replace(/[^/]*\.html$/, '')
  return href ? `${window.location.origin}${base}${href}` : null
}
