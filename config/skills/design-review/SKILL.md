---
name: design-review
description: Review a website's design with AI — capture multi-breakpoint screenshots + deterministic checks (axe-core WCAG, responsive overflow, tap targets, tiny text), then visually critique the screenshots against a design rubric. Use when the user asks to review/critique/audit a site's design, UI, UX, accessibility, or responsiveness for a live URL or local dev server.
---

# Design review

Two passes that cover each other's blind spots, merged into one report:

1. **Deterministic** (`capture.mjs`, Playwright + axe-core) — screenshots at
   desktop/tablet/mobile, WCAG violations, horizontal overflow, tiny text,
   small tap targets, missing alt, colour sprawl, heading outline. Reproducible.
2. **Vision** — **you** (this agent) read the captured screenshots with the Read
   tool and critique them against `rubric.md`, grounded in the deterministic
   metrics. This replaces the API call in the standalone tool — you ARE the
   vision model, so no `ANTHROPIC_API_KEY` is needed.

## When to use
The user wants a website's **design** reviewed (visual/aesthetic, UX, flows,
accessibility, responsiveness) — a live URL or a local dev server. Not for
pure code review or functional E2E testing.

## Steps

### 1. First-run setup (once per session)
`SKILL_DIR` = the directory this `SKILL.md` lives in (`.claude/skills/design-review`
under your working dir). If `node_modules` is missing there, install deps:
```bash
cd "$SKILL_DIR" && npm install && npx playwright install chromium
```
Check the URL is reachable first: `curl -s -o /dev/null -w "%{http_code}" <url>`.

### 2. Capture (deterministic)
Run the capture script. Use an output dir inside the user's project or the
scratchpad (NOT the skill dir):
```bash
node "$SKILL_DIR/capture.mjs" <url> --out <outdir> [--breakpoints desktop,tablet,mobile] [--flow flow.json]
```
It writes `<outdir>/capture.json` (metrics + axe) and `<outdir>/*.png`
(screenshots). The console prints overflow per breakpoint and axe count.

### 3. Vision pass (you do this)
- Read `rubric.md` from the skill dir for the dimensions and severity scale.
- Read the screenshots with the Read tool: at minimum every `*-fold.png`, plus
  `desktop-full.png` for full-page layout. If a flow ran, read `flow-*.png` in
  order and review the journey.
- Read `<outdir>/capture.json` for the deterministic measurements. Use them to
  GROUND your critique — don't just restate numbers; add the visual/experiential
  judgment they can't capture (hierarchy, brand cohesion, tonal breaks, crowding,
  flow friction).

### 4. Report
Produce a merged review for the user covering all four dimensions. Each finding:
**severity** (critical / major / minor / praise), **dimension** (visual / ux /
accessibility / responsive), **breakpoint**, the issue, and a concrete fix.
Sort by severity. Lead with a 2–3 sentence overall impression. Prefer fewer,
high-signal findings over a long low-value list. Call out which findings came
from the deterministic pass vs. your visual judgment when it adds clarity.

## Customising
- `rubric.md` — what "good design" means. Editable per brand/project.
- `--flow flow.json` — a journey (goto/click/fill/wait steps); each step is
  screenshotted and should be reviewed as a sequence (see `flow.example.json`).

## Notes
- Works on live URLs and `http://localhost:...` alike.
- For a CI-friendly / no-agent variant that calls the Claude API for the vision
  pass instead, see the standalone `vision-uat-review` project.
