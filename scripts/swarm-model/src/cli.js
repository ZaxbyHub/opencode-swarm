#!/usr/bin/env node

import { showList, showHelp } from './commands.js';
import { runInteractive } from './interactive.js';
import { resolve } from 'path';

const defaultSwarmConfig = resolve(process.env.HOME || process.env.USERPROFILE, '.config', 'opencode', 'opencode-swarm.json');
const defaultOpenCodeConfig = resolve(process.env.HOME || process.env.USERPROFILE, '.config', 'opencode', 'opencode.json');

function parseArgs() {
  const args = process.argv.slice(2);
  let command = '';
  let swarmConfig = defaultSwarmConfig;
  let openCodeConfig = defaultOpenCodeConfig;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--swarm-config' && args[i + 1]) {
      swarmConfig = resolve(args[++i]);
    } else if (args[i] === '--opencode-config' && args[i + 1]) {
      openCodeConfig = resolve(args[++i]);
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
