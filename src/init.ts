/**
 * `agent-os init [dir]` — scaffold a DATA HOME (the user-owned half of an instance).
 *
 * The software (this repo) and your data are separate. This creates a home you control:
 * its own folder, its own `.gitignore`, optionally its own git repo — so you can version your
 * team's agents privately without ever committing them to the open-source agent-os repo.
 *
 * Run several to host several instances on one machine; give each a distinct home + PORT:
 *   agent-os init ./brand-a   &&  AGENT_OS_HOME=./brand-a PORT=3010 agent-os serve
 *   agent-os init ./brand-b   &&  AGENT_OS_HOME=./brand-b PORT=3020 agent-os serve
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const HOME_GITIGNORE = `# Runtime/output — never commit
audit/
*.log
tmux.sock
agents/*/.claude/
agents/*/memory/
agents/*/.scratch/

# Track instead: agents/<id>/agent.json, agents/<id>/CLAUDE.md, policy/*.json
`;

function sampleManifest(id: string): string {
  return JSON.stringify(
    {
      id,
      version: '1.0.0',
      description: 'A real Claude session, opened in this folder, with every shell command gated by Agent OS.',
      principal: `svc-${id}`,
      policyContext: 'default@v3',
      runtime: 'claude-code',
      model: 'claude-opus-4-8',
      budget: { usdCap: 2.0, tokenCap: 400000, wallClockMs: 1800000 },
    },
    null,
    2,
  ) + '\n';
}

const SAMPLE_CLAUDE_MD = `# Starter Agent

A real \`claude\` session that opens in this folder. Create files and run commands here — this is
your workspace. Every \`Bash\` call is gated by Agent OS; risky ones pause for inbox approval.
`;

function writeIfAbsent(file: string, contents: string): void {
  if (!fs.existsSync(file)) fs.writeFileSync(file, contents);
}

export function init(argv: string[]): void {
  const target = path.resolve(process.cwd(), argv[0] || process.env.AGENT_OS_HOME || 'data');
  const relPath = path.relative(process.cwd(), target);
  // Show a clean relative path when inside the cwd; the absolute path when it escapes upward.
  const rel = !relPath || relPath.startsWith('..') ? target : relPath;

  fs.mkdirSync(path.join(target, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(target, 'policy'), { recursive: true });
  fs.mkdirSync(path.join(target, 'audit'), { recursive: true });

  writeIfAbsent(path.join(target, '.gitignore'), HOME_GITIGNORE);

  const sampleDir = path.join(target, 'agents', 'starter');
  if (!fs.existsSync(sampleDir)) {
    fs.mkdirSync(sampleDir, { recursive: true });
    fs.writeFileSync(path.join(sampleDir, 'agent.json'), sampleManifest('starter'));
    fs.writeFileSync(path.join(sampleDir, 'CLAUDE.md'), SAMPLE_CLAUDE_MD);
  }

  let gitNote = 'git: already a repo';
  if (!fs.existsSync(path.join(target, '.git'))) {
    const r = spawnSync('git', ['init', '-q'], { cwd: target, stdio: 'ignore' });
    gitNote = r.status === 0 ? 'git: initialized a private repo here' : 'git: not initialized (git unavailable)';
  }

  console.log(`\n  Data home ready → ${rel}`);
  console.log(`    agents/starter/   a claude-code agent to try`);
  console.log(`    policy/           drop default.policy.json here to override the bundled one`);
  console.log(`    .gitignore        ${gitNote}`);
  console.log(`\n  Start it:  AGENT_OS_HOME=${rel} agent-os serve\n`);
}
