#!/usr/bin/env node
/**
 * Pins the Docs → Use cases "Create this agent" briefs.
 *
 * Each ```create-agent fence in web/src/docs/use-cases.md is a one-shot brief the console hands to
 * `agent-author` (App.tsx → DocsPage intercepts the fence at `pre` and renders CreateAgentBlock).
 * The fence is content, so nothing else fails when a brief rots: a malformed one just spawns a paid
 * session with a bad prompt. This is the falsifier.
 *
 * No build needed — it reads the markdown and the source.
 */
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const doc = fs.readFileSync(path.join(root, 'web/src/docs/use-cases.md'), 'utf8')
const app = fs.readFileSync(path.join(root, 'web/src/App.tsx'), 'utf8')

let failed = 0
const check = (name, ok, detail) => {
  if (ok) console.log(`  ok  ${name}`)
  else { failed++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}

// 1) The fences parse: every opener has a closer, and nothing nests.
const lines = doc.split('\n')
const blocks = []
let open = null
for (let i = 0; i < lines.length; i++) {
  const l = lines[i]
  if (open === null) { if (l.startsWith('```')) open = { lang: l.slice(3).trim(), start: i, body: [] } }
  else if (l === '```') { blocks.push(open); open = null }
  else open.body.push(l)
}
check('every fence is closed', open === null, open ? `unclosed \`\`\`${open.lang} at line ${open.start + 1}` : '')

const briefs = blocks.filter((b) => b.lang === 'create-agent')
check('the page ships briefs', briefs.length >= 30, `found ${briefs.length}`)

// 2) Each brief is shaped the way agent-author is told to read it, and names a DNS-safe agent id.
const slugs = []
for (const b of briefs) {
  const text = b.body.join('\n')
  const first = b.body[0] ?? ''
  const m = /^Create an agent called "([a-z0-9][a-z0-9-]*)"\.$/.exec(first)
  if (!m) { check(`brief at line ${b.start + 1} opens with a valid name`, false, JSON.stringify(first)); continue }
  slugs.push(m[1])
  const name = m[1]
  if (!text.includes('Job:')) check(`${name} states a job`, false)
  if (!text.includes('Trigger:')) check(`${name} states a trigger`, false)
  // The posture is the decision the page exists to teach — a brief without one is the failure mode.
  if (!text.includes('Safety posture:')) check(`${name} states a safety posture`, false)
}
check('every brief names a DNS-safe agent, a job, a trigger and a posture', slugs.length === briefs.length)

// 3) No two briefs would create the same agent.
const dupes = slugs.filter((s, i) => slugs.indexOf(s) !== i)
check('no two briefs claim the same agent id', dupes.length === 0, dupes.join(', '))

// 4) `agent-author` builds the others; a brief telling it to create ITSELF would be a no-op run.
check('no brief targets agent-author itself', !slugs.includes('agent-author'))

// 5) The console half: the fence language, the run target, and the Docs-only scoping.
check('DocsPage intercepts the fence language', app.includes("language-create-agent"))
check('the run target is the agent-author constant', /const AGENT_AUTHOR = 'agent-author'/.test(app) && app.includes('runAgent(AGENT_AUTHOR, task)'))
// Scoping matters: the shared mdComponents also renders KB/task/goal markdown, which the tenant writes.
const sharedPre = /const mdComponents = \{[\s\S]*?\n\}/.exec(app)
check('the runnable block is NOT in the shared mdComponents', !!sharedPre && !sharedPre[0].includes('create-agent'))

console.log(failed === 0 ? '\nall create-agent brief checks passed' : `\n${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
