/**
 * "What's new" — the user-facing feed, GENERATED from `CHANGELOG.md` rather than kept beside it.
 *
 * The changelog is written for the people who build Agentric: each entry explains the bug, the mechanism
 * and the trap. That is the wrong register for the people who USE it, who need one sentence of "you can
 * now …" and where to try it. So an entry opts into the feed with a tagged line, written in the same PR as
 * the entry itself, and this module turns those lines into the feed:
 *
 *   ## [0.430.0] - 2026-09-10
 *   ### Added
 *   - **Tasks: who filed it.** `createdBy` has always been stored… (developer prose)
 *     **For users:** Filter the Tasks board by who filed a task — pick **I filed** to find everything
 *     you asked for. [Open Tasks](#/tasks)
 *
 * `**For users:**` reaches everyone; `**For admins:**` only owners and admins. The tag runs to the end of
 * its bullet (continuation lines are the indented ones that follow). Markdown is kept — links into the
 * console (`#/tasks`) are the "try it" button. Entries under **Unreleased** are never shown: nothing in
 * them is running yet.
 *
 * One source of truth: a feature can't reach the feed without a changelog entry, and the feed can't
 * drift from what shipped. The file is read once per process — it only changes on a deploy, which
 * restarts the server.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface WhatsNewEntry {
  /** `<version>:<n>` — stable for a given changelog, used as a React key. */
  id: string;
  version: string;
  /** The release date from the heading (`YYYY-MM-DD`), when it has one. */
  date?: string;
  /** Markdown, as written after the tag. */
  text: string;
  audience: 'all' | 'admins';
}

const VERSION_HEADING = /^##\s+\[(\d+\.\d+\.\d+)\](?:\s*-\s*(\d{4}-\d{2}-\d{2}))?/;
const ANY_HEADING = /^#{1,3}\s/;
const TAG = /^\s*(?:[-*]\s+)?\*\*For (users|admins):\*\*\s*(.*)$/i;
const BULLET = /^\s{0,1}[-*]\s/;

/** Pull every tagged line out of a changelog, newest release first (the file's own order). */
export function parseWhatsNew(md: string): WhatsNewEntry[] {
  const out: WhatsNewEntry[] = [];
  let version: string | null = null;
  let date: string | undefined;
  let open: WhatsNewEntry | null = null;
  let n = 0;
  const close = () => { if (open) { open.text = open.text.trim(); if (open.text) out.push(open); open = null; } };

  for (const line of md.split('\n')) {
    const vh = line.match(VERSION_HEADING);
    if (vh || ANY_HEADING.test(line)) {
      close();
      if (vh) { version = vh[1]; date = vh[2]; n = 0; } else if (/^##\s/.test(line)) { version = null; } // `## [Unreleased]`
      continue;
    }
    const tag = line.match(TAG);
    if (tag) {
      close();
      if (version) open = { id: `${version}:${n++}`, version, date, text: tag[2], audience: tag[1].toLowerCase() === 'admins' ? 'admins' : 'all' };
      continue;
    }
    if (!open) continue;
    // A continuation is an indented, non-empty line that doesn't start the next bullet.
    if (!line.trim() || BULLET.test(line) || !/^\s/.test(line)) { close(); continue; }
    open.text += ' ' + line.trim();
  }
  close();
  return out;
}

/** -1 / 0 / 1 for dotted numeric versions. Anything unparsable sorts as 0.0.0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  return 0;
}

/** How long a member who has NEVER opened the feed treats an entry as new. Without a bound, the first
 *  visit would badge every tagged entry in history; with one, it badges what shipped recently. */
export const FIRST_VISIT_WINDOW_DAYS = 14;

/**
 * Entries this member hasn't seen. `seen` is the version they last opened the feed at: everything
 * released after it is new. Never opened → whatever shipped in the last {@link FIRST_VISIT_WINDOW_DAYS}.
 */
export function unseen(entries: WhatsNewEntry[], seen: string | null, now = Date.now()): WhatsNewEntry[] {
  if (seen) return entries.filter((e) => compareVersions(e.version, seen) > 0);
  const since = now - FIRST_VISIT_WINDOW_DAYS * 86_400_000;
  return entries.filter((e) => e.date && Date.parse(e.date) >= since);
}

let cache: WhatsNewEntry[] | null = null;

/** The running build's feed, parsed from the `CHANGELOG.md` shipped beside it (dist/edge → repo root).
 *  A missing or unreadable file is an empty feed, never a boot failure. */
export function whatsNew(): WhatsNewEntry[] {
  if (cache) return cache;
  try {
    cache = parseWhatsNew(fs.readFileSync(path.join(__dirname, '..', '..', 'CHANGELOG.md'), 'utf8'));
  } catch {
    cache = [];
  }
  return cache;
}
