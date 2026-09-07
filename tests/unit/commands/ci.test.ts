/**
 * `swarm ci` command-handler tests (issue #2497; plan D3/R1/R4).
 *
 * Pins: registry presence + toolPolicy 'none' (runnable without a TTY and
 * NOT agent-callable as a chat tool), argument validation (typed
 * diagnostics for --timeout-ms abuse and unknown flags; the runtime is
 * never entered on invalid input), the outcome→exit-code mapping, and the
 * signal-cancellation seam (SIGINT/SIGTERM → abort; exit 2).
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
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
