/**
 * Per-tenant console branding — apply an accent colour + favicon badge at runtime.
 *
 * The accent recolours the sidebar's active-item + focus rings and a thin brand strip (via a small
 * set of CSS custom properties layered over `index.css`); it deliberately does NOT touch `--primary`,
 * so buttons/text contrast across the rest of the app is never at risk. The favicon is generated
 * client-side as an SVG data-URI (no uploads, no server storage) so several tenants are
 * distinguishable both in the sidebar and in the browser-tab strip.
 *
 * Everything here is idempotent and reversible: passing an empty accent clears the overrides so the
 * `index.css` defaults win again.
 */

/** Black or white — whichever reads better on the given `#rrggbb` background (WCAG luminance). */
export function readableOn(hex: string): '#000000' | '#ffffff' {
  const n = parseInt(hex.slice(1), 16)
  const chan = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  const lum = 0.2126 * chan[0] + 0.7152 * chan[1] + 0.0722 * chan[2]
  return lum > 0.4 ? '#000000' : '#ffffff'
}

const VALID = /^#[0-9a-fA-F]{6}$/

/** CSS vars we drive from the accent — cleared together when the accent is removed. */
const ACCENT_VARS = ['--brand', '--brand-foreground', '--sidebar-primary', '--sidebar-primary-foreground', '--sidebar-ring', '--ring'] as const

/** Set (or clear) the accent CSS custom properties on <html>. Invalid/empty hex → clear to defaults. */
export function applyAccent(hex?: string): void {
  const root = document.documentElement
  if (!hex || !VALID.test(hex)) {
    for (const v of ACCENT_VARS) root.style.removeProperty(v)
    return
  }
  const fg = readableOn(hex)
  root.style.setProperty('--brand', hex)
  root.style.setProperty('--brand-foreground', fg)
  root.style.setProperty('--sidebar-primary', hex)
  root.style.setProperty('--sidebar-primary-foreground', fg)
  root.style.setProperty('--sidebar-ring', hex)
  root.style.setProperty('--ring', hex)
}

/** The badge glyph: an explicit emoji/initials, else the tenant name's first letter, else "•". */
export function badgeGlyph(badge?: string, tenantName?: string): string {
  const b = (badge ?? '').trim()
  if (b) return b
  const first = (tenantName ?? '').trim().charAt(0).toUpperCase()
  return first || '•'
}

/** Build an SVG favicon data-URI: a rounded square filled with the accent, centred glyph on top.
 *  With no accent, falls back to a neutral dark tile so the tab still gets a per-tenant initial. */
export function faviconDataUri(hex: string | undefined, badge?: string, tenantName?: string): string {
  const bg = hex && VALID.test(hex) ? hex : '#0b0d12'
  const fg = readableOn(bg)
  const glyph = badgeGlyph(badge, tenantName)
  // Shrink the font for multi-char initials so 2–3 letters still fit the 64px tile.
  const size = [...glyph].length >= 3 ? 26 : [...glyph].length === 2 ? 32 : 40
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<rect width="64" height="64" rx="14" fill="${bg}"/>` +
    `<text x="32" y="33" font-size="${size}" text-anchor="middle" dominant-baseline="central" ` +
    `font-family="-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif" font-weight="700" fill="${fg}">` +
    `${escapeXml(glyph)}</text></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

/** Point the tab favicon at `uri` (creating the <link rel="icon"> if the page lacks one). */
export function applyFavicon(uri: string): void {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (!link) {
    link = document.createElement('link')
    link.rel = 'icon'
    document.head.appendChild(link)
  }
  link.type = 'image/svg+xml'
  link.href = uri
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!))
}
