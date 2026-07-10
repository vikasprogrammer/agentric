/**
 * Deep-links for the out-of-band chat notifications (Slack/Discord DMs and thread mirrors).
 *
 * A background notification fires from the scheduler / gate with NO request Host to derive the console
 * URL from, so the tenant's public origin is resolved once (`TenantRegistry.consoleOrigin`) and passed
 * in here to build `<origin>/#/<page>[/<detail>]` hash-router links. `chatLink` then renders one as a
 * clickable label in each platform's markup — Slack mrkdwn `<url|label>`, Discord markdown `[label](url)`
 * — so "Open the console → Tasks" becomes a one-tap quick link back into the interface instead of a
 * wall of instructions. The two platforms' masked-link syntaxes are incompatible, so a message destined
 * for both is built per-platform (see `deliverDM`'s text builder).
 */

export type ChatPlatform = 'slack' | 'discord';

/** Absolute deep-link into a tenant's console (hash router `<origin>/#/<page>[/<detail>]`). */
export function consolePage(origin: string, page: string, detail?: string): string {
  const base = origin.replace(/\/+$/, '');
  return `${base}/#/${page}${detail ? '/' + encodeURIComponent(detail) : ''}`;
}

/** A clickable masked hyperlink in the given platform's markup. */
export function chatLink(platform: ChatPlatform, url: string, label: string): string {
  return platform === 'slack' ? `<${url}|${label}>` : `[${label}](${url})`;
}
