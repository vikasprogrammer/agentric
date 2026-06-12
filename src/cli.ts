/**
 * agent-os CLI. The `bin/agent-os` shim calls into here.
 *
 *   agent-os init [dir]            scaffold a data home (the user-owned half of an instance)
 *   agent-os serve [--port=3010]   start the web console + API (default command)
 *   agent-os demo                  run the scripted governance demo in the terminal
 *   agent-os help                  show this help
 */
import { startServer } from './server';
import { init } from './init';

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case 'init':
      init(rest);
      break;
    case undefined:
    case 'serve': {
      const portArg = rest.find((a) => a.startsWith('--port='));
      const port = portArg ? Number(portArg.split('=')[1]) : undefined;
      startServer(port);
      break;
    }
    case 'demo':
      await import('./demo');
      break;
    case 'help':
    case '--help':
    case '-h':
    default:
      usage();
      if (cmd && !['help', '--help', '-h'].includes(cmd)) process.exitCode = 1;
  }
}

function usage(): void {
  console.log(`agent-os <command>

  init [dir]            scaffold a data home (default ./data) — your agents + policy + runtime
  serve [--port=3010]   start the web console + API (default)
  demo                  run the scripted governance demo in the terminal
  help                  show this help

  PORT env var also sets the serve port; TTYD_PORT defaults to PORT+1.
  AGENT_OS_HOME sets the data home (default ./data) — point distinct homes + PORTs at
  separate instances to run several on one machine.`);
}

void main();
