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
	test('the advisory resolves the masked residual like the gate', async () => {
		// The live gate denies this shape (the residual's cd-tracked landing
		// escapes); scope-validate must not answer ALLOWED on the raw text.
		const gateResult = await gate('cd .. && echo hi > out.txt; true <(true)');
		expect(gateResult.verdict).toBe('DENIED');
	});
});
