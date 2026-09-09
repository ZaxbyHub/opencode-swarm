/**
 * `swarm ci` command-handler tests (issue #2497; plan D3/R1/R4).
 *
 * Pins: registry presence + toolPolicy 'none' (runnable without a TTY and
 * NOT agent-callable as a chat tool), argument validation (typed
 * diagnostics for --timeout-ms abuse and unknown flags; the runtime is
 * never entered on invalid input), the outcome→exit-code mapping, and the
 * signal-cancellation seam (SIGINT/SIGTERM → abort; exit 2).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	createSignalCancellation,
	handleCiCommand,
} from '../../../src/commands/ci.js';
import {
	COMMAND_REGISTRY,
	type CommandContext,
	isCommandFailure,
} from '../../../src/commands/registry.js';
import { buildSatisfiedFixture, makeFixtureDir } from '../ci/_fixtures.js';

function ctx(directory: string, args: string[] = []): CommandContext {
	return {
		directory,
		args,
		sessionID: '',
		agents: {},
		source: 'cli',
	};
}

describe('swarm ci registry entry', () => {
	test("COMMAND_REGISTRY registers 'ci' with toolPolicy 'none'", () => {
		const entry = COMMAND_REGISTRY['ci' as keyof typeof COMMAND_REGISTRY] as
			| { toolPolicy?: string; handler?: unknown; description?: string }
			| undefined;
		expect(entry).toBeDefined();
		expect(entry?.handler).toBeTypeOf('function');
		// 'none': not agent-callable (no chat-tool bypass surface), not
		// human-only/restricted (CI runners have no TTY).
		expect(entry?.toolPolicy).toBe('none');
		expect(entry?.description).toContain('Advisory headless CI');
	});
});

describe('swarm ci argument validation', () => {
	test('missing --timeout-ms value throws a typed error', async () => {
		const dir = makeFixtureDir('swarm-ci-cmd-novalue-');
		await expect(handleCiCommand(ctx(dir, ['--timeout-ms']))).rejects.toThrow(
			/--timeout-ms/,
		);
	});

	test('non-numeric --timeout-ms value throws', async () => {
		const dir = makeFixtureDir('swarm-ci-cmd-nan-');
		await expect(
			handleCiCommand(ctx(dir, ['--timeout-ms', 'banana'])),
		).rejects.toThrow(/--timeout-ms/);
	});

	test('negative --timeout-ms value throws', async () => {
		const dir = makeFixtureDir('swarm-ci-cmd-neg-');
		await expect(
			handleCiCommand(ctx(dir, ['--timeout-ms', '-5'])),
		).rejects.toThrow(/--timeout-ms/);
	});

	test('zero --timeout-ms value throws', async () => {
		const dir = makeFixtureDir('swarm-ci-cmd-zero-');
		await expect(
			handleCiCommand(ctx(dir, ['--timeout-ms', '0'])),
		).rejects.toThrow(/--timeout-ms/);
	});

	test('all invalid --timeout-ms forms share one validation diagnostic (PR-TIMEOUT-MSG)', async () => {
		const dir = makeFixtureDir('swarm-ci-cmd-timeout-message-');
		const invalidArgs = [
			['--timeout-ms'],
			['--timeout-ms', '--json'],
			['--timeout-ms', 'banana'],
			['--timeout-ms', '0'],
			['--timeout-ms', '-5'],
			['--timeout-ms', 'Infinity'],
			['--timeout-ms', String(300_001)],
		];
		const messages: string[] = [];
		for (const args of invalidArgs) {
			try {
				await handleCiCommand(ctx(dir, args));
				messages.push('command unexpectedly succeeded');
			} catch (error) {
				messages.push(error instanceof Error ? error.message : String(error));
			}
		}

		const expected =
			'Invalid --timeout-ms value: expected a positive finite number from 1 through 300000 milliseconds.';
		// The missing-value branch and Number() validation branch must expose the
		// same stable diagnostic, rather than subtly different caller guidance.
		expect(messages).toEqual(invalidArgs.map(() => expected));
	});

	test('unknown flag throws before the runtime is entered', async () => {
		const dir = makeFixtureDir('swarm-ci-cmd-unknown-');
		await expect(handleCiCommand(ctx(dir, ['--turbo']))).rejects.toThrow(
			/Unknown flag/,
		);
	});
});

describe('swarm ci outcome mapping', () => {
	test('satisfied fixture: exit-0 path returns the full report string', async () => {
		const dir = await buildSatisfiedFixture();
		const result = await handleCiCommand(ctx(dir));
		expect(typeof result).toBe('string');
		const text = result as string;
		expect(text).toContain('[SWARM_CI_JSON]');
		expect(text).toContain('[/SWARM_CI_JSON]');
		expect(text).toContain('## Swarm CI Advisory Report');
	}, 15000);

	test('gate violation: structured failure with exit code 1', async () => {
		const dir = makeFixtureDir('swarm-ci-cmd-violation-');
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		// No plan.json → plan_missing is a violation (exit 1), and the
		// diagnostic mentions the plan.
		const result = await handleCiCommand(ctx(dir));
		expect(isCommandFailure(result)).toBe(true);
		if (isCommandFailure(result)) {
			expect(result.exitCode).toBe(1);
			expect(result.text).toContain('plan');
		}
	}, 15000);

	test('--json emits the machine block only (no Markdown headings)', async () => {
		const dir = await buildSatisfiedFixture();
		const result = await handleCiCommand(ctx(dir, ['--json']));
		expect(typeof result).toBe('string');
		const text = result as string;
		expect(text.startsWith('[SWARM_CI_JSON]')).toBe(true);
		expect(text).not.toContain('## Swarm CI Advisory Report');
	}, 15000);
});

describe('signal cancellation seam', () => {
	test('handler aborts the controller exactly once and notifies', () => {
		const controller = new AbortController();
		let notified = 0;
		const seam = createSignalCancellation(controller, () => {
			notified++;
		});
		seam.install();
		try {
			expect(process.listenerCount('SIGINT')).toBeGreaterThan(0);
			seam.handler();
			seam.handler();
			expect(controller.signal.aborted).toBe(true);
			expect(notified).toBe(1);
		} finally {
			seam.dispose();
		}
	});

	test('install/dispose manages listeners idempotently', () => {
		const controller = new AbortController();
		const seam = createSignalCancellation(controller);
		const before = process.listenerCount('SIGINT');
		seam.install();
		seam.install(); // second install is a no-op
		expect(process.listenerCount('SIGINT')).toBe(before + 1);
		seam.dispose();
		expect(process.listenerCount('SIGINT')).toBe(before);
		seam.dispose(); // second dispose is a no-op
		expect(process.listenerCount('SIGINT')).toBe(before);
	});
});

describe('swarm ci diagnostic branch (exit 2/3)', () => {
	const realRuntime = _internals.runAdvisoryCiRuntime;

	afterEach(() => {
		_internals.runAdvisoryCiRuntime = realRuntime;
	});

	function stubOutcome(
		outcome: 'cancelled' | 'deadline' | 'error',
		detail: string,
	) {
		_internals.runAdvisoryCiRuntime = async () => ({
			outcome,
			journal: [
				{ seq: 1, type: 'run_started', detail: 'evaluating' },
				{ seq: 2, type: `run_${outcome}` },
			],
			journalTruncated: 0,
			cleanupRan: true,
			detail,
		});
	}

	function parseDiagnosticBlock(text: string): Record<string, unknown> {
		const start = text.indexOf('[SWARM_CI_JSON]');
		const end = text.indexOf('[/SWARM_CI_JSON]');
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		return JSON.parse(
			text.slice(start + '[SWARM_CI_JSON]'.length, end),
		) as Record<string, unknown>;
	}

	test('deadline path (exit 3) emits the full version-1 report shape', async () => {
		stubOutcome('deadline', 'advisory CI run deadline exceeded');
		const dir = makeFixtureDir('swarm-ci-cmd-deadline-');
		const result = await handleCiCommand(ctx(dir));
		expect(isCommandFailure(result)).toBe(true);
		if (!isCommandFailure(result)) return;
		expect(result.exitCode).toBe(3);
		// Human diagnostic + journal tail around the machine block.
		expect(result.text).toContain('swarm ci deadline:');
		expect(result.text).toContain('journal tail: run_started');
		const parsed = parseDiagnosticBlock(result.text);
		expect(parsed.version).toBe(1);
		expect(parsed.verdict).toBe('fail');
		expect(parsed.exit_reason).toBe('deadline');
		// One schema for every exit code: the fields the reduced diagnostic
		// used to drop are present (neutral values) on this branch too.
		for (const key of [
			'gates',
			'tasks',
			'plan',
			'environment',
			'gate_profile',
			'effective_gates',
			'not_evaluated',
			'not_evaluable',
			'counts',
		]) {
			expect(parsed).toHaveProperty(key);
		}
		expect(parsed.counts).toEqual({
			pass: 0,
			fail: 0,
			no_data: 0,
			corrupt: 0,
			error: 0,
		});
	}, 15000);

	test('cancelled path with --json emits the machine block only (exit 2)', async () => {
		stubOutcome('cancelled', 'advisory CI run cancelled');
		const dir = makeFixtureDir('swarm-ci-cmd-cancel-');
		const result = await handleCiCommand(ctx(dir, ['--json']));
		expect(isCommandFailure(result)).toBe(true);
		if (!isCommandFailure(result)) return;
		expect(result.exitCode).toBe(2);
		// --json means the machine block only, on every exit path.
		expect(result.text.startsWith('[SWARM_CI_JSON]')).toBe(true);
		expect(result.text).not.toContain('journal tail');
		const parsed = parseDiagnosticBlock(result.text);
		expect(parsed.exit_reason).toBe('cancelled');
	}, 15000);

	test('diagnostics redact an alternate-separator directory form (PR-REDACTION)', async () => {
		const dir = makeFixtureDir('swarm-ci-cmd-redaction-');
		const alternateDirectory = dir.replaceAll(
			path.sep,
			path.sep === '/' ? '\\' : '/',
		);
		_internals.runAdvisoryCiRuntime = async () => ({
			outcome: 'deadline' as const,
			journal: [{ seq: 1, type: 'run_started', detail: alternateDirectory }],
			journalTruncated: 0,
			cleanupRan: true,
			detail: `deadline while evaluating ${alternateDirectory}`,
		});

		const result = await handleCiCommand(ctx(dir));
		expect(isCommandFailure(result)).toBe(true);
		if (!isCommandFailure(result)) return;
		expect(result.text).not.toContain(alternateDirectory);
		expect(result.text).toContain('[evaluated-directory]');
	});
});
