/**
 * v2 deterministic command wiring (issue #3151, PR #3163 feedback FB-006).
 *
 * The v1 factory exposes hooks['command.execute.before'] =
 * safeHook(createSwarmCommandHandler(...)) — the deterministic /swarm
 * subcommand engine whose output.parts overrides the LLM response on v1.
 * V2CommandDefinition.execute returns Promise<void> (vendored type AND
 * @opencode/plugin 2.0.20 dist/promise/command.d.ts — verified), so the v2
 * adapter delivers non-empty parts through ctx.session.synthetic with
 * resume:false (text admitted without waking the model); empty parts (or a
 * missing synthetic surface) fall back to the ctx.session.prompt bridge.
 *
 * Legs:
 *   1. a command.execute.before that writes output.parts → delivered via
 *      synthetic with the v1-shaped input, prompt NEVER called;
 *   2. a no-op handler (empty parts, alias command key) → prompt fallback;
 *   3. parts present but the host has no synthetic surface → prompt
 *      degradation;
 *   4. a throwing handler degrades to prompt (safeHook already wraps the
 *      real handler; the adapter must still survive a raw throw).
 */

import { describe, expect, test } from 'bun:test';
import { registerV2AgentsAndCommands } from '../../../src/host/v2/agents-commands';
import type { V1HooksSubset } from '../../../src/host/v2/types';

function makeHooks(overrides: Partial<V1HooksSubset> = {}): V1HooksSubset {
	return {
		tool: {},
		agent: {},
		config: async () => {},
		dispose: async () => {},
		...overrides,
	} as V1HooksSubset;
}

interface AddedCommand {
	name: string;
	execute: (inv: {
		sessionID: string;
		prompt: { text: string };
	}) => Promise<void>;
}

interface CommandCapture {
	ctx: unknown;
	added: AddedCommand[];
	prompts: Array<{ sessionID: string; input: unknown }>;
	synthetics: Array<{
		sessionID: string;
		text: string;
		resume?: boolean;
	}>;
}

function commandCapture(withSynthetic: boolean): CommandCapture {
	const added: AddedCommand[] = [];
	const prompts: CommandCapture['prompts'] = [];
	const synthetics: CommandCapture['synthetics'] = [];
	const ctx = {
		agent: {
			transform: async () => ({ dispose: async () => {} }),
			reload: async () => {},
		},
		command: {
			transform: async (
				cb: (e: { add(d: AddedCommand): void }) => void,
			) => {
				cb({
					add(d: AddedCommand) {
						added.push(d);
					},
				});
				return { dispose: async () => {} };
			},
			reload: async () => {},
		},
		session: {
			hook: async () => ({ dispose: async () => {} }),
			prompt: async (sessionID: string, input: unknown) => {
				prompts.push({ sessionID, input });
			},
			...(withSynthetic
				? {
						synthetic: async (input: {
							sessionID: string;
							text: string;
							resume?: boolean;
						}) => {
							synthetics.push(input);
						},
					}
				: {}),
		},
	};
	return { ctx, added, prompts, synthetics };
}

/** The v1 swarm-command table shape the config hook produces. */
function swarmCommandConfig(
	key: string,
	template: string,
): NonNullable<V1HooksSubset['config']> {
	return async (cfg: Record<string, unknown>) => {
		cfg.command = { [key]: { template, description: 'd' } };
	};
}

describe('v2 deterministic commands (FB-006)', () => {
	test('handler-written output.parts are delivered via session.synthetic; prompt never fires', async () => {
		const capture = commandCapture(true);
		const seenInputs: Array<Record<string, unknown>> = [];
		const hooks = makeHooks({
			// The real handler's contract: act ONLY on command === 'swarm',
			// write output.parts (src/commands/index.ts).
			'command.execute.before': async (input, output) => {
				seenInputs.push(input as Record<string, unknown>);
				if ((input as { command: string }).command !== 'swarm') return;
				(output as { parts: unknown[] }).parts = [
					{ type: 'text', text: 'SWARM STATUS: phase 2 active' },
				];
			},
			config: swarmCommandConfig('swarm', '/swarm $ARGUMENTS'),
		});
		await registerV2AgentsAndCommands(
			capture.ctx as never,
			hooks,
			'.',
			[],
		);
		const cmd = capture.added.find((c) => c.name === 'swarm');
		expect(cmd).toBeDefined();
		await cmd?.execute({ sessionID: 's-det', prompt: { text: 'status' } });
		// v1-shaped input reached the handler (command key + expanded
		// $ARGUMENTS + session identity).
		expect(seenInputs).toEqual([
			{ command: 'swarm', sessionID: 's-det', arguments: 'status' },
		]);
		// Deterministic delivery: synthetic with resume:false, no LLM prompt.
		expect(capture.synthetics).toEqual([
			{ sessionID: 's-det', text: 'SWARM STATUS: phase 2 active', resume: false },
		]);
		expect(capture.prompts).toEqual([]);
	});

	test('a no-op handler (empty parts) keeps the prompt fallback', async () => {
		const capture = commandCapture(true);
		const hooks = makeHooks({
			'command.execute.before': async () => {},
			// Alias key: the v1 handler ignores command !== 'swarm' — the v2
			// adapter passes the key verbatim, preserving v1 LLM routing.
			config: swarmCommandConfig('swarm-status', '/swarm status $ARGUMENTS'),
		});
		await registerV2AgentsAndCommands(
			capture.ctx as never,
			hooks,
			'.',
			[],
		);
		const cmd = capture.added.find((c) => c.name === 'swarm-status');
		expect(cmd).toBeDefined();
		await cmd?.execute({ sessionID: 's-fb', prompt: { text: 'extra' } });
		expect(capture.prompts).toEqual([
			{ sessionID: 's-fb', input: { text: '/swarm status extra' } },
		]);
		expect(capture.synthetics).toEqual([]);
	});

	test('parts without a synthetic surface degrade to the prompt path', async () => {
		const capture = commandCapture(false);
		const hooks = makeHooks({
			'command.execute.before': async (input, output) => {
				if ((input as { command: string }).command !== 'swarm') return;
				(output as { parts: unknown[] }).parts = [
					{ type: 'text', text: 'SWARM STATUS' },
				];
			},
			config: swarmCommandConfig('swarm', '/swarm $ARGUMENTS'),
		});
		await registerV2AgentsAndCommands(
			capture.ctx as never,
			hooks,
			'.',
			[],
		);
		const cmd = capture.added.find((c) => c.name === 'swarm');
		await cmd?.execute({ sessionID: 's-nosyn', prompt: { text: 'status' } });
		expect(capture.synthetics).toEqual([]);
		expect(capture.prompts).toEqual([
			{ sessionID: 's-nosyn', input: { text: '/swarm status' } },
		]);
	});

	test('a throwing deterministic handler degrades to prompt without propagating', async () => {
		const capture = commandCapture(true);
		const hooks = makeHooks({
			'command.execute.before': async () => {
				throw new Error('deterministic handler exploded');
			},
			config: swarmCommandConfig('swarm', '/swarm $ARGUMENTS'),
		});
		await registerV2AgentsAndCommands(
			capture.ctx as never,
			hooks,
			'.',
			[],
		);
		const cmd = capture.added.find((c) => c.name === 'swarm');
		expect(cmd).toBeDefined();
		await cmd?.execute({ sessionID: 's-throw', prompt: { text: 'status' } });
		expect(capture.synthetics).toEqual([]);
		expect(capture.prompts).toEqual([
			{ sessionID: 's-throw', input: { text: '/swarm status' } },
		]);
	});
});
