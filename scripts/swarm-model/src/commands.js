#!/usr/bin/env node

import { readSwarmConfig } from './config.js';
import { resolve } from 'path';

const defaultSwarmConfig = resolve(process.env.HOME || process.env.USERPROFILE, '.config', 'opencode', 'opencode-swarm.json');

export function showList(configPath) {
  const config = readSwarmConfig(configPath);
  const agents = Object.entries(config.agents || {}).sort((a, b) => a[0].localeCompare(b[0]));

  console.log('');
  console.log('\x1b[36mSwarm Agent Model Config\x1b[0m');
  console.log('='.repeat(70));
  console.log(`\x1b[37m${'Agent'.padEnd(28)} ${'Model'.padEnd(35)} Temp\x1b[0m`);
  console.log('-'.repeat(70));

  for (const [name, agent] of agents) {
    const temp = agent.temperature ?? '';
    console.log(`${name.padEnd(28)} ${(agent.model || '').padEnd(35)} ${temp}`);
  }
  console.log('');
}

export function showHelp() {
  console.log('');
  console.log('\x1b[36mswarm-model - Swarm Agent Model Config Tool\x1b[0m');
  console.log('='.repeat(50));
  console.log('');
  console.log('Usage:');
  console.log('  node src/cli.js                  Interactive mode');
  console.log('  node src/cli.js list             List all agents');
  console.log('  node src/cli.js help             Show this help');
  console.log('');
  console.log('Params:');
  console.log('  --swarm-config <path>    Swarm config path');
  console.log('                           Default: ~/.config/opencode/opencode-swarm.json');
  console.log('  --opencode-config <path> OpenCode config path');
  console.log('                           Default: ~/.config/opencode/opencode.json');
  console.log('');
}
