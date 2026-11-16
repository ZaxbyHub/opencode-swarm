/**
 * #3318 AC8 (DISCRIMINATING): under `OPENCODE_SWARM_DEBUG=1`, each v2 command
 * execution must log the RAW `invocation.prompt.text` and
 * `invocation.delivery` (before normalization); with the variable unset,
 * nothing is logged.
 *
 * Nothing logs the raw invocation at base (which is what makes the live
 * triage step "read the raw prompt.text" impossible today), so the debug half
 * is red at base; the unset half is green at both ends. `log()` in
 * src/utils/logger.ts writes through `console.log` when debug is on, so the
 * check spies `console.log` by plain reassignment (restored in finally) and
 * sets/restores `OPENCODE_SWARM_DEBUG` around each test.
 *
 * Fakes only (no mock.module); local fake-ctx helper following the pattern of
 * tests/unit/host/v2/command-dispatch-3169.test.ts (nothing imported from it);
 * canonicalMkdtemp project directory.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { registerV2AgentsAndCommands } from '../../../../src/host/v2/agents-commands';
import type { V1HooksSubset } from '../../../../src/host/v2/types';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../../helpers/tmpdir';

interface RegisteredCommand {
	name: string;
	description?: string;
	execute: (invocation: {
		sessionID: string;
		prompt: { text: string };
		delivery?: string;
	}) => Promise<void>;
}

const tempDirs: string[] = [];

function trackedMkdtemp(prefix: string): string {
	const dir = canonicalMkdtemp(prefix);
	tempDirs.push(dir);
	return dir;
}

/** Render captured console.log args into one comparable string. */
function renderArgs(args: unknown[]): string {
	return args
		.map((a) => {
			if (typeof a === 'string') return a;
			try {
				return JSON.stringify(a) ?? String(a);
			} catch {
				return String(a);
			}
		})
		.join(' ');
}

interface TraceHarness {
	commands: RegisteredCommand[];
	logCalls: unknown[][];
	restore: () => void;
}

/**
 * Register the swarm command against a fake v2 ctx and install a console.log
 * spy. restore() returns both the spy and the env var to their prior state.
 */
async function setupTraceHarness(): Promise<TraceHarness> {
	const commands: RegisteredCommand[] = [];
	await registerV2AgentsAndCommands(
		{
			agent: {
				transform: async () => ({ dispose: async () => {} }),
				reload: async () => {},
			},
			command: {
				transform: async (
					cb: (e: { add(d: RegisteredCommand): void }) => void,
				) => {
					cb({
						add(d) {
							commands.push(d);
						},
					});
					return { dispose: async () => {} };
				},
				reload: async () => {},
			},
			session: {
				hook: async () => ({ dispose: async () => {} }),
				prompt: async (_input: unknown) => {},
			},
		} as never,
		{
			config: async (cfg: Record<string, unknown>) => {
				cfg.command = {
					swarm: { template: '/swarm $ARGUMENTS', description: 'swarm' },
				};
			},
		} as V1HooksSubset,
		trackedMkdtemp('v2-3318-ac8-'),
		[],
	);

	const originalLog = console.log;
	const logCalls: unknown[][] = [];
	console.log = (...args: unknown[]) => {
		logCalls.push(args);
	};
	const savedDebug = process.env.OPENCODE_SWARM_DEBUG;
	return {
		commands,
		logCalls,
		restore: () => {
			console.log = originalLog;
			if (savedDebug === undefined) delete process.env.OPENCODE_SWARM_DEBUG;
			else process.env.OPENCODE_SWARM_DEBUG = savedDebug;
		},
	};
}

describe('#3318 AC8 — OPENCODE_SWARM_DEBUG=1 traces the raw invocation text and delivery', () => {
	const savedDebug = process.env.OPENCODE_SWARM_DEBUG;

	afterEach(async () => {
		if (savedDebug === undefined) delete process.env.OPENCODE_SWARM_DEBUG;
		else process.env.OPENCODE_SWARM_DEBUG = savedDebug;
		for (const dir of tempDirs.splice(0)) {
			await removeTreeWithRetry(dir);
		}
	});

	test('debug on: a console.log carries the raw prompt.text and delivery before normalization', async () => {
		process.env.OPENCODE_SWARM_DEBUG = '1';
		const harness = await setupTraceHarness();
		try {
			const swarm = harness.commands.find((c) => c.name === 'swarm');
			expect(swarm).toBeDefined();
			// The RAW (pre-normalization) text: the leading token must still be
			// visible in the trace even though dispatch strips it.
			await swarm?.execute({
				sessionID: 'ses-ac8',
				prompt: { text: '/swarm status' },
				delivery: 'queue',
			});
			const rendered = harness.logCalls.map(renderArgs);
			expect(
				rendered.some(
					(line) => line.includes('/swarm status') && line.includes('queue'),
				),
			).toBe(true);
		} finally {
			harness.restore();
		}
	}, 30000);

	test('debug on: a long raw text is traced bounded (its first 200 chars appear)', async () => {
		process.env.OPENCODE_SWARM_DEBUG = '1';
		const harness = await setupTraceHarness();
		try {
			const swarm = harness.commands.find((c) => c.name === 'swarm');
			const longText = `/swarm ${'a'.repeat(300)}`;
			await swarm?.execute({
				sessionID: 'ses-ac8-long',
				prompt: { text: longText },
				delivery: 'steer',
			});
			const prefix = longText.slice(0, 200);
			const rendered = harness.logCalls.map(renderArgs);
			expect(rendered.some((line) => line.includes(prefix))).toBe(true);
		} finally {
			harness.restore();
		}
	}, 30000);

	test('debug unset: nothing logs the raw invocation (green at both ends)', async () => {
		delete process.env.OPENCODE_SWARM_DEBUG;
		const harness = await setupTraceHarness();
		try {
			const swarm = harness.commands.find((c) => c.name === 'swarm');
			await swarm?.execute({
				sessionID: 'ses-ac8-off',
				prompt: { text: '/swarm status' },
				delivery: 'queue',
			});
			const rendered = harness.logCalls.map(renderArgs);
			expect(
				rendered.some(
					(line) => line.includes('/swarm status') || line.includes('queue'),
				),
			).toBe(false);
		} finally {
			harness.restore();
		}
	}, 30000);
});
