/**
 * #3591 (collated trace 3586-3588-3591-shell-gate-walk-fixpoint, Fix 6):
 * - 6a: a dedicated POSIX rm arm emits EVERY literal non-option operand of
 *   a NON-destructive rm (flagless, -i/-v/-I/-d) as a scope-checked write
 *   target — the AC10 policy decision is SCOPE CONTAINMENT modeled on
 *   unlink/rmdir. Recursive/forced shapes emit nothing there (the
 *   destructive arm owns them and runs first).
 * - 6b: GNU getopt permutation — the shared two-pass parse
 *   (parseRmOptionTokens) reads flags at ANY position before `--`, so
 *   `rm foo -rf ../../outside` is recursive (fail-closed).
 * - 6c: dcEvaluateRecursiveDeleteTargets runs the pre-allowlist checks over
 *   EVERY target first, so the denial NAMES the escaping target.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	dcEvaluateRecursiveDeleteTargets,
	dcExtractRecursiveRmTargets,
} from '../../../src/hooks/guardrails/destructive-command';
import {
	detectPosixWrites,
	parseRmOptionTokens,
} from '../../../src/hooks/shell-write-detect';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

const created: string[] = [];
let counter = 0;
afterAll(() => {
	for (const dir of created.splice(0)) removeTreeWithRetry(dir);
});

function config(): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		profiles: undefined,
	};
}

interface Verdict {
	verdict: 'ADMITTED' | 'DENIED';
	message: string;
}

async function gate(command: string): Promise<Verdict> {
	const ws = canonicalMkdtemp('rm3591-');
	created.push(ws);
	mkdirSync(path.join(ws, 'src'), { recursive: true });
	const sessionID = `rm3591-s${++counter}`;
	const callID = `rm3591-call-${counter}`;
	startAgentSession(sessionID, 'coder');
	installActiveScopeBinding({
		directory: ws,
		childSessionId: sessionID,
		taskId: '1.1',
		files: ['src/'],
		dispatchCallId: callID,
	});
	const hooks = createGuardrailsHooks(ws, undefined, config());
	try {
		await hooks.toolBefore(
			{ tool: 'bash', sessionID, callID },
			{ args: { command } },
		);
		return { verdict: 'ADMITTED', message: '' };
	} catch (error) {
		return {
			verdict: 'DENIED',
			message: (error as Error).message.split('\n')[0] ?? '',
		};
	} finally {
		resetSwarmState();
	}
}

function rmWritePaths(command: string): Array<string | null> {
	return detectPosixWrites(command)
		.writes.filter((w) => w.category === 'builtin_write')
		.map((w) => w.path);
}

describe('#3591 Fix 6 shared two-pass parse (parseRmOptionTokens)', () => {
	test('leading flags: destructive, operands extracted', () => {
		const p = parseRmOptionTokens(['-rf', 'foo', 'bar']);
		expect(p.destructive).toBe(true);
		expect(p.targetIndices).toEqual([1, 2]);
	});

	test('GNU permutation: a late flag is still read and consumed', () => {
		const p = parseRmOptionTokens(['foo', '-rf', '../../outside']);
		expect(p.destructive).toBe(true);
		expect(p.targetIndices).toEqual([0, 2]);
	});

	test('non-destructive flags anywhere: not destructive, consumed', () => {
		const p = parseRmOptionTokens(['a', '-v', '-i', 'b']);
		expect(p.destructive).toBe(false);
		expect(p.targetIndices).toEqual([0, 3]);
	});

	test('exact long options --recursive / --force are destructive', () => {
		expect(parseRmOptionTokens(['x', '--recursive']).destructive).toBe(true);
		expect(parseRmOptionTokens(['--force', 'x']).destructive).toBe(true);
		expect(parseRmOptionTokens(['--verbose', 'x']).destructive).toBe(false);
	});

	test('`--` ends options: later dash words are targets, not flags', () => {
		const p = parseRmOptionTokens(['--', '-rf', 'x']);
		expect(p.destructive).toBe(false);
		expect(p.targetIndices).toEqual([1, 2]);
	});

	test('a bare `-` is an operand, never an option', () => {
		const p = parseRmOptionTokens(['-', 'x']);
		expect(p.destructive).toBe(false);
		expect(p.targetIndices).toEqual([0, 1]);
	});
});

describe('#3591 Fix 6b extractor (dcExtractRecursiveRmTargets)', () => {
	test('late-flag permutation extracts BOTH targets', () => {
		expect(dcExtractRecursiveRmTargets('rm foo -rf ../../outside')).toEqual([
			'foo',
			'../../outside',
		]);
	});

	test('leading-flag control extracts the same set', () => {
		expect(dcExtractRecursiveRmTargets('rm -rf foo ../../outside')).toEqual([
			'foo',
			'../../outside',
		]);
	});

	test('flagless literal stays null (brace-3569 pin preserved)', () => {
		expect(dcExtractRecursiveRmTargets('rm ../esc')).toBeNull();
	});

	test('verbose-only stays null (nested-artifacts-2096 pin preserved)', () => {
		expect(dcExtractRecursiveRmTargets('rm -v x')).toBeNull();
	});

	test('the late flag is consumed, never extracted as a target', () => {
		const targets = dcExtractRecursiveRmTargets('rm a -f b') ?? [];
		expect(targets).toEqual(['a', 'b']);
	});
});

describe('#3591 Fix 6c two-phase evaluation (dcEvaluateRecursiveDeleteTargets)', () => {
	const cwd = canonicalMkdtemp('rm3591-eval-');
	created.push(cwd);

	test('escape after a non-allowlisted target: denial names the escape', () => {
		const d = dcEvaluateRecursiveDeleteTargets({
			targets: ['foo', '../../outside'],
			cwd,
		});
		expect(d.allowed).toBe(false);
		if (!d.allowed) {
			expect(d.code).toBe('DESTRUCTIVE_TARGET_INVALID');
			expect(d.reason).toContain('../../outside');
		}
	});

	test('protected component after a non-allowlisted target names .git', () => {
		const d = dcEvaluateRecursiveDeleteTargets({
			targets: ['foo', '.git'],
			cwd,
		});
		expect(d.allowed).toBe(false);
		if (!d.allowed) {
			expect(d.code).toBe('DESTRUCTIVE_TARGET_PROTECTED');
			expect(d.reason).toContain('.git');
		}
	});

	test('per-target pre-allowlist order preserved: traversal before protected', () => {
		const d = dcEvaluateRecursiveDeleteTargets({
			targets: ['../.swarm'],
			cwd,
		});
		expect(d.allowed).toBe(false);
		if (!d.allowed) expect(d.code).toBe('DESTRUCTIVE_TARGET_INVALID');
	});

	test('phase 2 still rejects a non-allowlisted in-workspace target', () => {
		const d = dcEvaluateRecursiveDeleteTargets({ targets: ['foo'], cwd });
		expect(d.allowed).toBe(false);
		if (!d.allowed) expect(d.code).toBe('DESTRUCTIVE_TARGET_NOT_SAFE_ARTIFACT');
	});

	test('bare allowlisted artifacts stay allowed', () => {
		const d = dcEvaluateRecursiveDeleteTargets({
			targets: ['node_modules', 'dist'],
			cwd,
		});
		expect(d.allowed).toBe(true);
	});
});

describe('#3591 Fix 6a detector rm arm', () => {
	test('every literal operand of a flagless rm is emitted', () => {
		expect(rmWritePaths('rm a src/b ../c')).toEqual(['a', 'src/b', '../c']);
	});

	test('non-destructive flags still emit every operand', () => {
		expect(rmWritePaths('rm -v a -i b')).toEqual(['a', 'b']);
	});

	test('recursive/forced shapes emit nothing here (destructive arm owns them)', () => {
		expect(rmWritePaths('rm -rf a b')).toEqual([]);
		expect(rmWritePaths('rm a -f b')).toEqual([]);
		expect(rmWritePaths('rm --recursive a')).toEqual([]);
	});

	test('`--` makes a dash-word an operand', () => {
		expect(rmWritePaths('rm -- -v')).toEqual(['-v']);
	});

	test('brace operands expand per branch', () => {
		expect(rmWritePaths('rm src/{a,b}')).toEqual(['src/a', 'src/b']);
	});

	test('wrapper-consumed window: sudo rm emits the operand only', () => {
		expect(rmWritePaths('sudo rm ../esc')).toEqual(['../esc']);
	});
});

describe('#3591 Fix 6 gate verdicts (coder, scope src/)', () => {
	test.each([
		'rm ../esc',
		'rm ../../outside',
		'rm src/ok ../esc',
		'rm -v ../esc',
		'rm -i ../esc',
	])('%s → DENY (out-of-scope operand)', async (command) => {
		const got = await gate(command);
		expect(got.verdict).toBe('DENIED');
	}, 30_000);

	test.each([
		'rm src/temp.ts',
		'rm -i src/temp.ts',
		'rm src/a src/b',
	])('%s → ADMIT (in-scope operands)', async (command) => {
		const got = await gate(command);
		expect(got.verdict).toBe('ADMITTED');
	}, 30_000);

	test.each([
		'rm foo -rf ../../outside',
		'rm -rf foo ../../outside',
	])('%s → DENY naming ../../outside', async (command) => {
		const got = await gate(command);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toContain('../../outside');
	}, 30_000);

	test('rmdir brace escape still denies (AC12 preserved)', async () => {
		const got = await gate('rmdir src/{a,../esc}');
		expect(got.verdict).toBe('DENIED');
	}, 30_000);
});
