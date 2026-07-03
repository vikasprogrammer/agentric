#!/usr/bin/env node
// Deterministic capture for the design-review skill.
// Playwright screenshots (multi-breakpoint) + axe-core + layout metrics.
// The agent (Claude Code) does the vision pass by reading the screenshots.

import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import fs from 'node:fs';
import path from 'node:path';

const BREAKPOINTS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 375, height: 812 },
};

function parseArgs(argv) {
  const args = { breakpoints: ['desktop', 'tablet', 'mobile'], out: 'design-review-output' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--breakpoints') args.breakpoints = argv[++i].split(',').map((s) => s.trim());
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--flow') args.flow = argv[++i];
    else if (a === '-h' || a === '--help') args.help = true;
    else rest.push(a);
  }
  args.url = rest[0];
  return args;
}

async function captureBreakpoint(browser, url, bp, outDir) {
  const vp = BREAKPOINTS[bp];
  if (!vp) throw new Error(`Unknown breakpoint: ${bp}`);
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch(() =>
    page.goto(url, { waitUntil: 'load', timeout: 60000 })
  );
  await page.waitForTimeout(1200);

  const foldPath = path.join(outDir, `${bp}-fold.png`);
  const fullPath = path.join(outDir, `${bp}-full.png`);
  await page.screenshot({ path: foldPath });
  await page.screenshot({ path: fullPath, fullPage: true });

  const metrics = await page.evaluate(() => {
    const docW = document.documentElement.scrollWidth;
    const winW = window.innerWidth;
    const colors = new Set(), fonts = new Set(), sizes = new Set();
    let tinyText = 0, smallTargets = 0;
    for (const el of document.querySelectorAll('*')) {
      const s = getComputedStyle(el);
      if (s.color) colors.add(s.color);
      if (s.backgroundColor && s.backgroundColor !== 'rgba(0, 0, 0, 0)') colors.add(s.backgroundColor);
      if (s.fontFamily) fonts.add(s.fontFamily.split(',')[0].trim().replace(/["']/g, ''));
      const fz = parseFloat(s.fontSize);
      if (fz) { sizes.add(Math.round(fz)); if (fz < 12 && el.textContent.trim()) tinyText++; }
      if ((el.tagName === 'A' || el.tagName === 'BUTTON') && el.offsetParent) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44)) smallTargets++;
      }
    }
    return {
      horizontalOverflow: docW > winW + 1 ? `${docW - winW}px (doc ${docW} > viewport ${winW})` : 'none',
      uniqueColors: colors.size,
      fontFamilies: [...fonts].slice(0, 12),
      fontSizes: [...sizes].sort((a, b) => a - b),
      tinyTextNodes: tinyText,
      smallTapTargets: smallTargets,
      h1Count: document.querySelectorAll('h1').length,
      imgMissingAlt: [...document.querySelectorAll('img')].filter((i) => !i.getAttribute('alt')).length,
      imgTotal: document.querySelectorAll('img').length,
      title: document.title,
      hasLang: !!document.documentElement.lang,
    };
  });

  await ctx.close();
  return { breakpoint: bp, viewport: vp, metrics, foldPath, fullPath };
}

async function runAxe(browser, url) {
  const ctx = await browser.newContext({ viewport: BREAKPOINTS.desktop });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch(() =>
    page.goto(url, { waitUntil: 'load', timeout: 60000 })
  );
  await page.waitForTimeout(1000);
  const headingOutline = await page.evaluate(() =>
    [...document.querySelectorAll('h1,h2,h3')].slice(0, 30).map((h) => `${h.tagName} ${h.textContent.trim().slice(0, 70)}`)
  );
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  const violations = axe.violations.map((v) => ({
    id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length,
    sample: v.nodes[0]?.html?.slice(0, 140),
  }));
  await ctx.close();
  return { violations, headingOutline };
}

async function runFlow(browser, baseUrl, flow, outDir) {
  const ctx = await browser.newContext({ viewport: BREAKPOINTS.desktop });
  const page = await ctx.newPage();
  const steps = [];
  for (let i = 0; i < flow.steps.length; i++) {
    const step = flow.steps[i];
    const label = step.label || `step-${i + 1}`;
    try {
      if (step.action === 'goto') {
        const target = step.value?.startsWith('http') ? step.value : new URL(step.value || '/', baseUrl).href;
        await page.goto(target, { waitUntil: 'networkidle', timeout: 60000 });
      } else if (step.action === 'click') {
        await page.click(step.selector, { timeout: 15000 });
      } else if (step.action === 'fill') {
        await page.fill(step.selector, step.value ?? '', { timeout: 15000 });
      } else if (step.action === 'wait') {
        await page.waitForTimeout(Number(step.value) || 1000);
      }
      await page.waitForTimeout(800);
      const shot = path.join(outDir, `flow-${String(i + 1).padStart(2, '0')}-${label}.png`);
      await page.screenshot({ path: shot });
      steps.push({ label, action: step.action, ok: true, shot });
    } catch (err) {
      steps.push({ label, action: step.action, ok: false, error: String(err).slice(0, 200) });
    }
  }
  await ctx.close();
  return steps;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.url) {
    console.log('Usage: capture.mjs <url> --out <dir> [--breakpoints desktop,tablet,mobile] [--flow flow.json]');
    process.exit(args.url ? 0 : 1);
  }
  const outDir = path.resolve(args.out);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`▶ Capturing ${args.url} → ${outDir}`);
  const browser = await chromium.launch();
  const perBp = [];
  for (const bp of args.breakpoints) {
    process.stdout.write(`  · ${bp}… `);
    const r = await captureBreakpoint(browser, args.url, bp, outDir);
    perBp.push(r);
    console.log(`overflow=${r.metrics.horizontalOverflow}`);
  }
  process.stdout.write('  · axe-core + outline… ');
  const axe = await runAxe(browser, args.url);
  console.log(`${axe.violations.length} violation(s)`);

  let flowSteps = null;
  if (args.flow) {
    const flow = JSON.parse(fs.readFileSync(path.resolve(args.flow), 'utf8'));
    process.stdout.write(`  · flow "${flow.name || 'flow'}"… `);
    flowSteps = await runFlow(browser, args.url, flow, outDir);
    console.log(`${flowSteps.filter((s) => s.ok).length}/${flowSteps.length} steps ok`);
  }
  await browser.close();

  const capture = {
    url: args.url,
    capturedAt: new Date().toISOString(),
    perBreakpoint: perBp.map((b) => ({ breakpoint: b.breakpoint, viewport: b.viewport, metrics: b.metrics, foldPath: b.foldPath, fullPath: b.fullPath })),
    axe,
    flow: flowSteps,
  };
  const jsonPath = path.join(outDir, 'capture.json');
  fs.writeFileSync(jsonPath, JSON.stringify(capture, null, 2));
  console.log(`\n✓ capture.json + screenshots in ${outDir}`);
  console.log('  Screenshots to review:', perBp.flatMap((b) => [b.foldPath]).map((p) => path.basename(p)).join(', '),
    '+', path.basename(perBp.find((b) => b.breakpoint === 'desktop')?.fullPath || perBp[0].fullPath));
}

main().catch((err) => { console.error(err); process.exit(1); });
