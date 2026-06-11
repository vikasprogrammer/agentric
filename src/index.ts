/**
 * Boot entrypoint — assemble an Agent OS from config + plugins and report readiness.
 * In a real deployment this is also where you'd start Triggers (cron/webhook) and the
 * Console HTTP server. Run `npm run demo` to exercise the governance pipeline.
 */
import { loadAgentOS } from './kernel';
import { exampleCapabilities } from './capabilities/examples';
import { greeterBehavior, refunderBehavior } from './runtime/mock-adapter';

function main(): void {
  const os = loadAgentOS();

  // Plugin code: register capability implementations + agent behaviors.
  os.registerCapabilities(exampleCapabilities);
  os.registerMockBehavior('example-greeter', greeterBehavior);
  os.registerMockBehavior('example-refunder', refunderBehavior);

  console.log(`Agent OS ready — tenant=${os.tenant}`);
  console.log(`  agents:       ${[...os.agents.keys()].join(', ') || '(none)'}`);
  console.log(`  capabilities: ${os.registry.list().map((c) => c.id).join(', ')}`);
  console.log(`  policy:       ${os.policy.id}`);
  console.log('\nNext: start triggers + console here, or run `npm run demo` to see the gateway work.');
}

main();
