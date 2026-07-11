import { describe, expect, it } from 'bun:test';
import { createArchitectAgent } from '../agents/architect.js';
import type { CommandEntry } from './registry.js';
import { COMMAND_REGISTRY, VALID_COMMANDS } from './registry.js';

describe('registry-documentation', () => {
	// Test 1: Every entry in COMMAND_REGISTRY has a non-empty description field
	it('every command entry has a non-empty description', () => {
		const missingDescriptions: string[] = [];
		const emptyDescriptions: string[] = [];

		for (const command of VALID_COMMANDS) {
			const entry = COMMAND_REGISTRY[command] as CommandEntry;
			if (!entry.description) {
				missingDescriptions.push(command);
			} else if (entry.description.trim() === '') {
				emptyDescriptions.push(command);
			}
		}

		expect(missingDescriptions, 'Commands missing description field').toEqual(
			[],
		);
		expect(emptyDescriptions, 'Commands with empty description').toEqual([]);
	});

	// Test 2: Side-effect commands have a non-empty details field
	it('side-effect commands have non-empty details field', () => {
		const sideEffectCommands = [
			'close',
			'reset',
			'reset-session',
			'checkpoint',
			'rollback',
			'archive',
			'promote',
			'write-retro',
			'turbo',
			'full-auto',
		] as const;

		const missingDetails: string[] = [];
		const emptyDetails: string[] = [];

		for (const cmd of sideEffectCommands) {
			const entry = COMMAND_REGISTRY[
				cmd as keyof typeof COMMAND_REGISTRY
			] as CommandEntry;
			if (!entry.details) {
				missingDetails.push(cmd);
			} else if (entry.details.trim() === '') {
				emptyDetails.push(cmd);
			}
		}

		expect(
			missingDetails,
			'Side-effect commands missing details field',
		).toEqual([]);
		expect(emptyDetails, 'Side-effect commands with empty details').toEqual([]);
	});

	// Test 3: Commands with args have a non-empty args field
	it('commands with args have non-empty args field', () => {
		const commandsWithArgs = [
			'reset',
			'checkpoint',
			'rollback',
			'archive',
			'simulate',
			'dark-matter',
			'benchmark',
			'promote',
			'write-retro',
			'turbo',
			'full-auto',
		] as const;

		const missingArgs: string[] = [];
		const emptyArgs: string[] = [];

		for (const cmd of commandsWithArgs) {
			const entry = COMMAND_REGISTRY[
				cmd as keyof typeof COMMAND_REGISTRY
			] as CommandEntry;
			if (!entry.args) {
				missingArgs.push(cmd);
			} else if (entry.args.trim() === '') {
				emptyArgs.push(cmd);
			}
		}

		expect(missingArgs, 'Commands with args missing args field').toEqual([]);
		expect(emptyArgs, 'Commands with args having empty args field').toEqual([]);
	});

	// Test 4: Generated prompt does NOT match the bare-name pattern
	it('generated prompt is not just comma-separated names ending with period', () => {
		const agent = createArchitectAgent('test-model');
		const prompt = agent.config.prompt!;

		// The bare-name pattern would be something like: "explorer, coder, reviewer, test_engineer."
		// This tests that the prompt is substantive, not just a list of agent names
		const bareNamePattern = /^\w+(, \w+)*\.$/;
		expect(prompt).not.toMatch(bareNamePattern);
	});

	// Test 5: Generated prompt contains at least 5 description strings from the registry
	it('generated prompt contains at least 5 registry descriptions', () => {
		const agent = createArchitectAgent('test-model');
		const prompt = agent.config.prompt!;

		// Well-known descriptions from the registry (verified against the current
		// COMMAND_REGISTRY entries these commands render with).
		const wellKnownDescriptions = [
			'Show current swarm state',
			'Show current plan (optionally filter by phase number)',
			'List registered agents',
			'Run health check on swarm state',
			'Toggle Turbo Mode strategy for the active session [on|off|lean|standard|epic|status]',
			'Toggle Full-Auto Mode for the active session [on [mode]|off|status]',
			'Restore swarm state or project files to a checkpoint',
			'Manage project checkpoints [save|restore|delete|list] <label>',
		];

		const foundDescriptions = wellKnownDescriptions.filter((desc) =>
			prompt.includes(desc),
		);

		expect(
			foundDescriptions.length,
			`Found ${foundDescriptions.length} of 5 required descriptions: ${foundDescriptions.join(', ')}`,
		).toBeGreaterThanOrEqual(5);
	});
});
