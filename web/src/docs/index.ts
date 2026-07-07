// The Docs section ships WITH the software (same for every tenant, versioned with the code) —
// deliberately not the KB plane, which is the tenant's own living wiki. Markdown is bundled at
// build time via Vite ?raw imports; adding a page = add the .md file + one entry here.
import whatIsAgentOs from './what-is-agent-os.md?raw'
import gettingStarted from './getting-started.md?raw'
import coreConcepts from './core-concepts.md?raw'
import workingWithAgents from './working-with-agents.md?raw'
import automations from './automations.md?raw'
import governance from './governance.md?raw'
import sharedPlanes from './shared-planes.md?raw'

export type DocPage = { slug: string; title: string; body: string }

export const docPages: DocPage[] = [
  { slug: 'what-is-agent-os', title: 'What is Agent OS?', body: whatIsAgentOs },
  { slug: 'getting-started', title: 'Getting started', body: gettingStarted },
  { slug: 'core-concepts', title: 'Core concepts', body: coreConcepts },
  { slug: 'working-with-agents', title: 'Working with agents', body: workingWithAgents },
  { slug: 'automations', title: 'Automations', body: automations },
  { slug: 'governance', title: 'Governance & approvals', body: governance },
  { slug: 'shared-planes', title: 'Memory, Knowledge & Tasks', body: sharedPlanes },
]
