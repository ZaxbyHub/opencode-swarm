#!/usr/bin/env node

import { showList, showHelp } from './commands.js';
import { runInteractive } from './interactive.js';
import { resolve } from 'path';
import { DEFAULT_SWARM_CONFIG, DEFAULT_OPENCODE_CONFIG } from './paths.js';

function parseArgs() {
  const args = process.argv.slice(2);
  let command = '';
  let swarmConfig = DEFAULT_SWARM_CONFIG;
  let openCodeConfig = DEFAULT_OPENCODE_CONFIG;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--swarm-config' || args[i] === '--opencode-config') {
      const flag = args[i];
      const value = args[i + 1];
      // Treat a following flag (or no token) as a missing value rather than
      // silently consuming `--other-flag` as this flag's path.
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${flag}`);
      }
      i++;
      if (flag === '--swarm-config') {
        swarmConfig = resolve(value);
      } else {
        openCodeConfig = resolve(value);
      }
    } else {
      command = args[i];
    }
  }

  return { command, swarmConfig, openCodeConfig };
}

async function main() {
  const { command, swarmConfig, openCodeConfig } = parseArgs();

  if (command === 'list') {
    showList(swarmConfig);
  } else if (command === 'help' || command === '--help' || command === '-h' || command === '/?') {
    showHelp();
  } else {
    await runInteractive(swarmConfig, openCodeConfig);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
