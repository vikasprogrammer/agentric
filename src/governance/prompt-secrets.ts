/**
 * Credentials a HUMAN types or pastes into a session.
 *
 * Mining 30 days of fleet chats (2026-10-26) turned up people pasting live credentials straight into an
 * agent conversation — X API keys and OAuth tokens, a LinkedIn client secret, an OpenRouter key ("key
 * store -> sk-or-v1-…"), a customer site's API key — on three tenants. Whatever lands there is sent to the
 * model provider, sits in the transcript, and is free to be echoed into a script, a memory, a KB page or a
 * PR. The product already has the safe path (Settings → Secrets, and `secret_request` so an agent never has
 * to ask for a value in chat); nothing stopped the unsafe one.
 *
 * So the human-input paths — a prompt typed into the TUI (the claude-code UserPromptSubmit hook), the
 * console chat composer, and the console's inject box — hold a message that carries a credential and say
 * where it belongs instead. This is a convenience guard on HUMAN input, not governance: it fails open, it
 * never inspects text the server itself delivered, and a person who really means to send it can say so.
 *
 * Precision over recall, deliberately. A held message costs the human a retype, so this only matches
 * shapes that are credentials by construction (vendor prefixes, private-key armour) or a value explicitly
 * labelled as one (`API_KEY=…`, `password: …`, `access token …`). A bare opaque string is NOT matched —
 * that is also what a commit sha, a UUID, a base64 blob in a pasted log and a ticket id look like.
 */

/** Typing this anywhere in the message sends it as-is. Named in every hold message. */
export const ALLOW_SECRET_MARKER = '[allow-secret]';

interface Rule { kind: string; re: RegExp }

// Vendor-prefixed tokens. Each prefix is specific enough that a match is a credential, not prose.
const PREFIXED: Rule[] = [
  { kind: 'private key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/ },
  { kind: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: 'OpenRouter API key', re: /\bsk-or-v1-[A-Za-z0-9]{20,}/ },
  // The body must mix upper case and digits: a URL slug like `sk-129-pu-salon-chair-with-gold-…` (seen in a
  // live tenant's chat) is lowercase words and must not read as a key.
  { kind: 'OpenAI API key', re: /\bsk-(?:proj-|svcacct-|admin-)?(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,}/ },
  { kind: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/ },
  { kind: 'GitLab token', re: /\bglpat-[A-Za-z0-9_-]{20,}/ },
  { kind: 'Slack token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}|\bxapp-\d-[A-Za-z0-9-]{20,}/ },
  { kind: 'AWS access key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: 'Stripe secret key', re: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/ },
  { kind: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: 'Google OAuth token', re: /\bya29\.[0-9A-Za-z_-]{20,}|\b1\/\/0[0-9A-Za-z_-]{30,}/ },
  { kind: 'LinkedIn client secret', re: /\bWPL_AP\d\.[A-Za-z0-9./+=]{10,}/ },
  { kind: 'Hugging Face token', re: /\bhf_[A-Za-z]{30,}\b/ },
  { kind: 'Telegram bot token', re: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/ },
];

// A value someone LABELLED as a secret. The label carries the signal, so the value only has to look like
// a value (long enough, not a placeholder).
const LABELLED: RegExp[] = [
  // ENV-style: OPENAI_API_KEY=…, DB_PASSWORD: …, export GH_TOKEN="…"
  /\b[A-Z][A-Z0-9_]*(?:API_KEY|_KEY|TOKEN|SECRET|PASSWORD|PASSWD)\s*[:=]\s*['"]?([^\s'"]{8,})/,
  // prose: "password: hunter2!!", "api key = …", "client secret: …"
  /\b(?:password|passwd|api[ _-]?key|client[ _-]?secret|secret[ _-]?key|private[ _-]?key|auth[ _-]?token|bearer)\s*[:=]\s*['"]?([^\s'"]{8,})/i,
  // "access token <value>" / "refresh token: <value>" — no separator needed, but then the value must look
  // like a token: long, and not an English word.
  /\b(?:access|refresh|bot|api)[ _-]?token\s*[:=]?\s*['"]?([A-Za-z0-9._~+/=-]{24,})/i,
];

/** Values that are a reference or a redaction, not a credential. */
function isPlaceholder(v: string): boolean {
  if (/^[<{[(]|[>}\])]$/.test(v)) return true;          // <your-key>, {token}, [redacted]
  if (/^\$\{?[A-Za-z_]/.test(v)) return true;           // $GH_TOKEN, ${API_KEY}
  if (/\*{3,}|•{3,}|…|\.{3,}/.test(v)) return true;     // masked: sk-***, dzM*****
  if (/^(?:x+|X+|0+|placeholder|changeme|redacted|example|your[_-]?\w*|none|null|undefined|true|false)$/i.test(v)) return true;
  if (/^https?:\/\//i.test(v)) return true;             // a URL, not a value
  return false;
}

/** A labelled value must have SOME entropy: mixed classes or a digit, so "password: reset" passes. */
function looksLikeValue(v: string): boolean {
  if (isPlaceholder(v)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(v)).length;
  return classes >= 2;
}

/**
 * The credential this human-typed text carries, or null. `kind` names it for the hold message and the
 * audit row; the value itself is never returned, so a caller cannot log it by accident.
 */
export function detectPastedCredential(text: string): { kind: string } | null {
  if (!text || text.includes(ALLOW_SECRET_MARKER)) return null;
  for (const r of PREFIXED) if (r.re.test(text)) return { kind: r.kind };
  for (const re of LABELLED) {
    const m = text.match(re);
    if (m && m[1] && looksLikeValue(m[1])) return { kind: 'labelled secret' };
  }
  return null;
}

/** The message a held prompt shows the human — where the credential belongs, and the override. */
export function credentialHoldMessage(kind: string, agent?: string): string {
  const who = agent ? `"${agent}"` : 'the agent';
  return (
    `Agentric held this message: it looks like it contains a ${kind}. Anything typed here is sent to the ` +
    `model and kept in the session transcript, so a credential pasted into chat can end up in scripts, ` +
    `memory, or a pull request. Store it in Settings → Secrets and assign it to ${who} (it arrives as an ` +
    `environment variable on the next session), or ask ${who} to request it with secret_request — then ` +
    `send your message again without the value. To send it as-is anyway, include ${ALLOW_SECRET_MARKER}.`
  );
}
