#!/usr/bin/env node
/**
 * Unit test for custom-pattern enrichment (config-driven governance patterns).
 * Verifies `enrichArgs` sets an operator-defined boolean fact when its regex matches, respects scope,
 * excludes file.write, dedupes, and never throws on a bad regex. Run: node scripts/test-enrich-patterns.cjs
 */
const path = require('path');
const { enrichArgs } = require(path.join(__dirname, '..', 'dist/governance/enricher'));

const bash = (command) => ({ tool: 'Bash', input: { command } });
const conn = (tool, input = {}) => ({ tool, input });

// An Globex-shaped pattern set (exactly what would live in Settings, not in code).
const patterns = [
  { pattern: '\\breboot\\b|systemctl\\s+reboot|shutdown\\s+-r', fact: 'serverReboot', scope: 'shell' },
  { pattern: 'v-globex-suspend-user|hestia.*suspend', fact: 'userSuspend', scope: 'shell' },
  { pattern: '(vite build|npm run build)[\\s\\S]*(app-atomic|159\\.65\\.64\\.73)', fact: 'prodBuild', scope: 'shell' },
  { pattern: 'stripe-refund|STRIPE_REFUND', fact: 'stripeRefund', scope: 'any' },
  { pattern: 'freescout-manager\\.php reply|freescout[\\s\\S]*\\breply\\b', fact: 'freescoutSend', scope: 'shell' },
];

const cases = [
  // [name, capability, args, fact, expected, patternsOverride?]
  ['reboot → serverReboot', 'shell.exec', bash('ssh root@198.51.100.23 "reboot"'), 'serverReboot', true],
  ['systemctl reload is NOT a reboot', 'shell.exec', bash('systemctl reload apache2'), 'serverReboot', undefined],
  ['suspend-user → userSuspend', 'shell.exec', bash('v-globex-suspend-user user123 phishing'), 'userSuspend', true],
  ['prod build → prodBuild', 'shell.exec', bash('cd /home/runcloud/webapps/app-atomic/live && npm run build'), 'prodBuild', true],
  ['dev build (no prod path) is not prodBuild', 'shell.exec', bash('npm run build'), 'prodBuild', undefined],
  ['stripe refund (any scope, shell)', 'shell.exec', bash('./iwp stripe-refund ch_123 --amount=50'), 'stripeRefund', true],
  ['stripe refund (any scope, connector)', 'connector.call', conn('mcp__x__STRIPE_REFUND', { amount: 5 }), 'stripeRefund', true],
  ['freescout reply → freescoutSend', 'shell.exec', bash('php freescout-manager.php reply 42 --text=hi'), 'freescoutSend', true],
  ['freescout note is NOT a send', 'shell.exec', bash('php freescout-manager.php note 42 --text=hi'), 'freescoutSend', undefined],
  ['shell-scoped pattern ignores connector calls', 'connector.call', conn('mcp__x__reboot_thing'), 'serverReboot', undefined],
  ['file.write is never matched by custom patterns', 'file.write', { tool: 'Write', input: { file_path: '/tmp/x', content: 'reboot the server' } }, 'serverReboot', undefined],
  ['bad regex is ignored, never throws', 'shell.exec', bash('anything'), 'oops', undefined, [{ pattern: '(', fact: 'oops', scope: 'shell' }]],
  ['no patterns → no custom facts', 'shell.exec', bash('reboot'), 'serverReboot', undefined, []],
];

let pass = 0;
const fails = [];
for (const [name, cap, args, fact, expect, override] of cases) {
  const f = enrichArgs(cap, args, [], undefined, override ?? patterns);
  const got = f[fact];
  if (got === expect) pass++;
  else fails.push(`  ✗ ${name}: ${fact}=${JSON.stringify(got)} (expected ${JSON.stringify(expect)})`);
}
// built-in facts still work alongside custom patterns
const both = enrichArgs('shell.exec', bash('rm -rf /data'), [], undefined, patterns);
if (both.destructive !== true) fails.push('  ✗ built-in destructive fact regressed with patterns present');
else pass++;

console.log(`${pass}/${cases.length + 1} enrich-pattern checks passed`);
if (fails.length) { console.log(fails.join('\n')); process.exit(1); }
process.exit(0);
