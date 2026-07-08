/**
 * Drag-and-drop skill install — unpack a Claude Code skill from an uploaded `.zip` and turn it into
 * the same in-memory `{ rel, data }[]` file set the remote-repo installer produces, so it flows
 * through the identical `SkillsStore.installFiles` path (name validation, path-traversal guard,
 * managed-marker stripping). A skill = any folder in the archive containing a `SKILL.md`, matching
 * how `browseRepo` (skill-registry.ts) and the CLI detect skills — so a zip of a single skill folder,
 * a bare `SKILL.md` at the root, or a multi-skill bundle all work.
 *
 * Zero-dependency by design: we parse the ZIP container ourselves (central directory + local headers)
 * and inflate DEFLATE members with the built-in `zlib`. No ZIP64 (skills are tiny — kilobytes); a
 * ZIP64 archive throws a clear error rather than silently mis-reading.
 */
import * as path from 'path';
import * as zlib from 'zlib';
import { parseFrontmatter, validSkillName } from './skills';

const EOCD_SIG = 0x06054b50; // end of central directory record
const CEN_SIG = 0x02014b50; // central directory file header
const LOC_SIG = 0x04034b50; // local file header
const SKILL_FILE = 'SKILL.md';
const MAX_FILES = 200; // per archive — guards against a hostile/huge zip
const MAX_TOTAL_BYTES = 16 * 1024 * 1024; // 16 MB of inflated content per upload

export interface ZipEntry {
  /** Forward-slashed path within the archive. */
  name: string;
  data: Buffer;
}

/** One skill found in the archive, ready for `SkillsStore.installFiles`. */
export interface ExtractedSkill {
  name: string;
  files: { rel: string; data: Buffer }[];
}

/** Locate the End-Of-Central-Directory record (it sits after an up-to-64 KB trailing comment). */
function findEOCD(buf: Buffer): number {
  const minLen = 22;
  if (buf.length < minLen) return -1;
  const start = Math.max(0, buf.length - minLen - 0xffff);
  for (let i = buf.length - minLen; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/** Parse a ZIP buffer into its file entries (directories skipped). Throws on a malformed archive. */
export function unzip(buf: Buffer): ZipEntry[] {
  const eocd = findEOCD(buf);
  if (eocd < 0) throw new Error('not a valid .zip file');
  const total = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || total === 0xffff) throw new Error('ZIP64 archives are not supported');

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  let totalBytes = 0;
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) throw new Error('corrupt zip central directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue; // directory entry — no data

    // The central directory holds the authoritative sizes; the local header gives the data offset
    // (its own name/extra lengths, which can differ from the central copy's).
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== LOC_SIG) throw new Error('corrupt zip local header');
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`unsupported zip compression method (${method})`);

    totalBytes += data.length;
    if (entries.length >= MAX_FILES) throw new Error(`archive has too many files (> ${MAX_FILES})`);
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('archive exceeds the size limit (16 MB)');
    entries.push({ name, data });
  }
  return entries;
}

/** Junk an archiver leaves behind that must never reach the library. */
export function isNoise(name: string): boolean {
  return name.startsWith('__MACOSX/') || name.includes('/__MACOSX/') || path.basename(name) === '.DS_Store';
}

/**
 * Unpack every skill (a folder containing a `SKILL.md`) from an uploaded zip into install-ready file
 * sets. Each file is assigned to the LONGEST skill-folder prefix it falls under, so a bundle of nested
 * skills splits cleanly. A skill's name is its folder basename (lowercased), falling back to the
 * SKILL.md frontmatter `name`, then to `fallbackName` (e.g. the dropped filename) for a root-level
 * SKILL.md. Throws if the archive contains no SKILL.md or a skill resolves to no valid name.
 */
export function extractSkillsFromZip(buf: Buffer, fallbackName?: string): ExtractedSkill[] {
  const entries = unzip(buf).filter((e) => !isNoise(e.name) && e.name.length > 0);
  return groupSkillsFromEntries(entries, fallbackName);
}

/**
 * Group already-unzipped `ZipEntry`s into install-ready skills. Split out from `extractSkillsFromZip`
 * so callers that have entries in hand (e.g. an AOS import bundle whose skills live under a `skills/`
 * subtree) reuse the identical longest-prefix ownership + name-derivation rules without re-parsing a zip.
 */
export function groupSkillsFromEntries(entries: ZipEntry[], fallbackName?: string): ExtractedSkill[] {
  // Skill folders = the dirs holding a SKILL.md ('' = archive root). Longest first for prefix matching.
  const skillDirs: string[] = [];
  for (const e of entries) {
    if (e.name === SKILL_FILE || e.name.endsWith('/' + SKILL_FILE)) {
      skillDirs.push(e.name === SKILL_FILE ? '' : e.name.slice(0, -(SKILL_FILE.length + 1)));
    }
  }
  if (skillDirs.length === 0) throw new Error('the zip has no SKILL.md — it is not a skill');
  skillDirs.sort((a, b) => b.length - a.length);

  const longestOwningDir = (name: string): string | undefined =>
    skillDirs.find((d) => (d === '' ? true : name === d || name.startsWith(d + '/')));

  const fallback = (fallbackName || '').trim().toLowerCase().replace(/\.zip$/, '');
  const out: ExtractedSkill[] = [];
  const seen = new Set<string>();
  for (const dir of skillDirs) {
    const prefix = dir ? dir + '/' : '';
    const files: { rel: string; data: Buffer }[] = [];
    for (const e of entries) {
      if (longestOwningDir(e.name) !== dir) continue; // belongs to a deeper skill folder
      files.push({ rel: e.name.slice(prefix.length), data: e.data });
    }
    const skillMd = files.find((f) => f.rel === SKILL_FILE);
    if (!skillMd) continue; // shouldn't happen — every skillDir came from a SKILL.md

    let name = (dir.split('/').pop() || '').toLowerCase();
    if (!validSkillName(name)) name = (parseFrontmatter(skillMd.data.toString('utf8')).name || '').trim().toLowerCase();
    if (!validSkillName(name)) name = fallback;
    if (!validSkillName(name)) throw new Error(`could not derive a valid skill name (folder "${dir || '(root)'}")`);
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, files });
  }
  if (out.length === 0) throw new Error('no installable skill found in the zip');
  return out;
}
