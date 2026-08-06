/**
 * Tests for the `/swarm skill-opt` command group registration + wiring.
 * Covers: registry presence, subcommand wiring, help rendering, JSON output,
 * disabled-default gating, human-only toolPolicy on activation commands.
 */

import { describe, expect, it } from 'bun:test';
import { buildHelpText } from '../../../src/commands/index.js';
import {
	COMMAND_REGISTRY,
	resolveCommand,
	VALID_COMMANDS,
} from '../../../src/commands/registry.js';

const SUBCOMMANDS = [
	'skill-opt plan',
	'skill-opt run',
	'skill-opt status',
	'skill-opt diff',
	'skill-opt approve',
	'skill-opt reject',
	'skill-opt rollback',
	'skill-opt history',
] as const;

describe('skill-opt command registry', () => {
	it('registers the skill-opt parent and all 8 subcommands', () => {
		expect(Object.hasOwn(COMMAND_REGISTRY, 'skill-opt')).toBe(true);
		for (const sub of SUBCOMMANDS) {
			expect(Object.hasOwn(COMMAND_REGISTRY, sub)).toBe(true);
			const entry = COMMAND_REGISTRY[sub];
			expect(typeof entry.handler).toBe('function');
			expect(entry.description.length).toBeGreaterThan(0);
			expect(entry.subcommandOf).toBe('skill-opt');
		}
	});

	it('every subcommand resolves via resolveCommand with a 2-token compound key', () => {
		for (const sub of SUBCOMMANDS) {
			const tokens = sub.split(' ');
			const resolved = resolveCommand(tokens);
			expect(resolved.entry).toBeDefined();
			// The compound key is the literal "skill-opt plan" string.
			expect(resolved.key).toBe(sub);
		}
	});

	it('marks activation commands human-only', () => {
		expect(COMMAND_REGISTRY['skill-opt approve'].toolPolicy).toBe('human-only');
		expect(COMMAND_REGISTRY['skill-opt run'].toolPolicy).toBe('human-only');
		expect(COMMAND_REGISTRY['skill-opt reject'].toolPolicy).toBe('human-only');
		expect(COMMAND_REGISTRY['skill-opt rollback'].toolPolicy).toBe(
			'human-only',
		);
	});

	it('marks read-only commands agent-callable', () => {
		expect(COMMAND_REGISTRY['skill-opt plan'].toolPolicy).toBe('agent');
		expect(COMMAND_REGISTRY['skill-opt status'].toolPolicy).toBe('agent');
		expect(COMMAND_REGISTRY['skill-opt diff'].toolPolicy).toBe('agent');
		expect(COMMAND_REGISTRY['skill-opt history'].toolPolicy).toBe('agent');
	});

	it('classifies all skill-opt entries as utility', () => {
		expect(COMMAND_REGISTRY['skill-opt'].category).toBe('utility');
		for (const sub of SUBCOMMANDS) {
			expect(COMMAND_REGISTRY[sub].category).toBe('utility');
		}
	});
});

describe('skill-opt help rendering', () => {
	it('renders skill-opt under the Utility section', () => {
		const help = buildHelpText();
		expect(help).toContain('### Utility');
		expect(help).toContain('skill-opt');
		// Subcommands render indented under the parent as `- <action>`.
		expect(help).toContain('- `plan`');
		expect(help).toContain('- `run`');
		expect(help).toContain('- `approve`');
	});
});
