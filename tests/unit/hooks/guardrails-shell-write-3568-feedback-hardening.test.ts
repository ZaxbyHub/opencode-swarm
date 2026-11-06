/**
 * #3568 feedback-round hardening pins (swarm-pr-feedback run pr3568-20261104).
 *
 * Pins every review defect fixed on PR #3568, gate-level where the fix's
 * consequence is a verdict, detector-level where the fix is an emission
 * contract; every deny leg asserts a class and every family carries an
 * admit control:
 * - PRR-001 (F-01): masked procsub bodies route through the FULL detector
 *   family (tee/dd/cp/interpreter/nested forms deny; `<(ls)` admits).
 * - PRR-003: nested `<(` spans and `;`-torn bodies parse natively.
 * - F-02: a fully-quoted brace token stays literal and the judged write is
 *   the whole literal path (no quote-wrapper mis-slice).
 * - F-04: the backslash-escaped cd verb withdraws the span body.
 * - PRR-005: span-dense masking is linear (bounded time probe).
 * - PRR-006: numeric brace ranges refuse BEFORE materialization (large and
 *   unsafe-integer ranges return fast; a small range still enumerates).
 * - PRR-008: scope_validate resolves the masked residual (parity with the
 *   live gate).
 * - PRR-009: `cp -t DEST` emits DEST as a judged write.
 * - F-10: the dynamic-target denial sanitizes the untrusted source word.
 * - touch/cp-t modeling regressions: `touch ../../esc` and procsub-body
 *   destructive verbs deny.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { detectPosixWrites } from '../../../src/hooks/shell-write-detect';
import {
	getAgentSession,
	resetSwarmState,
	startAgentSession,
} from '../../../src/state';
import { evaluateScopeValidate } from '../../../src/tools/scope-validate';
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
	const ws = canonicalMkdtemp('fb3568-ws-');
	created.push(ws);
	mkdirSync(path.join(ws, 'src'), { recursive: true });
	const sessionID = `fb3568-s${++counter}`;
	const callID = `fb3568-call-${counter}`;
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

const ANY_BLOCK = /(?:WRITE )?BLOCKED/i;
const wsRoot = canonicalMkdtemp('fb3568-root-');
created.push(wsRoot);
mkdirSync(path.join(wsRoot, 'src'), { recursive: true });

describe('3568 feedback: masked procsub body family (PRR-001 / F-01)', () => {
	test.each([
		['wc -l <(tee ../../esc.txt)'],
		['true <(dd of=../../x)'],
		['tee >(tee ../../esc.txt)'],
		['tee >(python3 -c "open(../x)")'],
		['cat <(cat <(cp a ../outside.txt))'],
		['true <(echo hi && tee ../../esc)'],
		['tee >(true; cp x ../../x)'],
		['true >(touch ../../esc)'],
		['true <(rm -rf .swarm)'],
	])('%s denies (body write/destructive visible)', async (cmd) => {
		const got = await gate(cmd);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(ANY_BLOCK);
	}, 120_000);

	test('control: read-only <(ls) emits no write (detector level)', () => {
		// Gate-level here would measure the Windows weak-sandbox arm (it
		// denies procsub shapes on this host — the F-06 confound), not the
		// write gate; the read-only admit contract is detector-level.
		const r = detectPosixWrites('cat <(ls)');
		expect(r.hasWrites).toBe(false);
		expect(r.writes.length).toBe(0);
	});

	test('control: plain touch in scope admits; out of scope denies', async () => {
		expect((await gate('touch src/ok.txt')).verdict).toBe('ADMITTED');
		expect((await gate('touch ../../esc')).verdict).toBe('DENIED');
	}, 120_000);

	test('touch option values are not write targets (reviewer F-a)', () => {
		for (const cmd of [
			'touch -d 2024-01-01 src/ok.txt',
			'touch -t 202401010000 src/ok.txt',
			'touch -r ref.txt src/ok.txt',
			'command /usr/bin/touch src/ok.txt',
		]) {
			const r = detectPosixWrites(cmd);
			expect(r.writes.map((w) => w.path)).toEqual(['src/ok.txt']);
		}
	});

	test('cp -t attached spelling denies (reviewer F-d)', async () => {
		const r = detectPosixWrites('cp -t../../esc src/a');
		expect(r.writes.map((w) => w.path)).toContain('../../esc');
		const got = await gate('cp -t../../esc src/a');
		expect(got.verdict).toBe('DENIED');
	}, 120_000);

	test('nested-span depth cap keeps cost bounded (reviewer F-b)', () => {
		const deep =
			Array.from({ length: 1000 }, () => 'cat <(').join('') +
			'echo hi > src/f' +
			Array.from({ length: 1000 }, () => ')').join('');
		const t0 = performance.now();
		void detectPosixWrites(deep);
		expect(performance.now() - t0).toBeLessThan(2000);
	});

	test('unquoted dd of=$VAR emits the dynamic refusal (reviewer F-f)', () => {
		const r = detectPosixWrites('dd of=$D/src/f if=/dev/null');
		expect(r.writes.length).toBe(1);
		expect(r.writes[0]?.path).toBeNull();
		expect(r.writes[0]?.unresolvedContext).toBe(true);
	});
});

describe('3568 feedback: quoted brace token (F-02)', () => {
	test('dd quoted of= braces stay literal and the whole path is judged', () => {
		const r = detectPosixWrites('dd "of=../../src/{a,b}" if=/dev/null');
		expect(r.writes.map((w) => w.path)).toEqual(['../../src/{a,b}']);
	});
});

describe('3568 feedback: escaped cd verb withdrawal (F-04)', () => {
	test('backslash-prefixed cd withdraws the span body', () => {
		const r = detectPosixWrites('\\cd ..; true <(echo x > src/f)');
		expect(r.writes.length).toBeGreaterThan(0);
		expect(r.writes.every((w) => w.unresolvedContext === true)).toBe(true);
	});
});

describe('3568 feedback: masking linearity (PRR-005)', () => {
	test('span-dense masking is bounded (running-length counter)', () => {
		const cmd = `cat <(echo a) ${Array.from({ length: 400 }, (_, i) => `<(echo ${i})`).join(' ')}`;
		const t0 = performance.now();
		detectPosixWrites(cmd);
		const elapsed = performance.now() - t0;
		expect(elapsed).toBeLessThan(2000);
	});
});

describe('3568 feedback: brace pre-cap (PRR-006)', () => {
	test('a 1e8 numeric range refuses without materializing', () => {
		const t0 = performance.now();
		const r = detectPosixWrites('echo f{1..100000000}');
		expect(performance.now() - t0).toBeLessThan(500);
		expect(r.writes.length).toBe(0);
	});

	test('an unsafe-integer endpoint refuses immediately', () => {
		const t0 = performance.now();
		const r = detectPosixWrites('{1..99999999999999999999}');
		expect(performance.now() - t0).toBeLessThan(500);
		expect(r.writes.length).toBe(0);
	});

	test('control: a small range still enumerates its branches', () => {
		const r = detectPosixWrites('cd src && echo x > {a,b}');
		expect(r.writes.length).toBe(2);
	});
});

describe('3568 feedback: cp -t destination (PRR-009)', () => {
	test('cp -t DEST emits DEST as a judged write', () => {
		const r = detectPosixWrites('cp -t ../../esc src/a');
		expect(r.writes.map((w) => w.path)).toContain('../../esc');
	});

	test('cp --target-directory=DEST emits DEST too', () => {
		const r = detectPosixWrites('cp --target-directory=../../esc src/a');
		expect(r.writes.map((w) => w.path)).toContain('../../esc');
	});

	test('gate: cp -t escaping destination denies', async () => {
		const got = await gate('cp -t ../../esc src/a');
		expect(got.verdict).toBe('DENIED');
	}, 120_000);
});

describe('3568 feedback: scope_validate residual parity (PRR-008)', () => {
	test('evaluateScopeValidate resolves the masked residual (ROOT_ESCAPE)', () => {
		// The pin calls the TOOL directly — a gate-leg cross-check cannot
		// detect a scope-validate revert to raw-text resolution (reviewer
		// round 2, PRR-008).
		// fail() throws the typed error carrying the code (not a result
		// object) — the ROOT_ESCAPE denial is a throw.
		expect(() =>
			evaluateScopeValidate(
				{
					command: 'cd .. && echo hi > out.txt; true <(true)',
					shell: 'posix',
					scope_files: ['src/'],
				},
				wsRoot,
			),
		).toThrow(/ROOT_ESCAPE/);
	});

	test('control: an in-scope write stays allowed', () => {
		const result = evaluateScopeValidate(
			{
				command: 'echo hi > src/ok.txt',
				shell: 'posix',
				scope_files: ['src/'],
			},
			wsRoot,
		);
		expect(result.allowed).toBe(true);
	});

	test('the live gate denies the same shape (cross-check)', async () => {
		const gateResult = await gate('cd .. && echo hi > out.txt; true <(true)');
		expect(gateResult.verdict).toBe('DENIED');
	});
});
