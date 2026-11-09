/**
 * #3569 residual-3 shipped suite — full-body process-substitution semantics.
 *
 * Every masked `>(…)` / `<(…)` span body routes WHOLE through the mainline
 * detection (all write families; recursion capped; parse/depth refusal
 * propagates even with zero writes), and the destructive pipelines (gate +
 * explain) push span-body segments. Write-free bodies that parse stay
 * admitted; span accounting is linear.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	detectPosixWrites,
	procSubSpanBodies,
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
		block_destructive_commands: true,
	};
}

async function gate(command: string): Promise<'ADMITTED' | string> {
	const ws = canonicalMkdtemp('ps3569-ws-');
	created.push(ws);
	mkdirSync(path.join(ws, 'src'), { recursive: true });
	const sessionID = `ps3569-s${++counter}`;
	const callID = `ps3569-call-${counter}`;
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
		return 'ADMITTED';
	} catch (error) {
		return (error as Error).message.split('\n')[0] ?? 'DENIED';
	} finally {
		resetSwarmState();
	}
}

beforeEach(() => {
	resetSwarmState();
});

describe('span bodies: write families all reach detection', () => {
	test.each([
		'tee >(gunzip -d ../esc.gz)',
		'tee >(tar -xf a.tgz -C ../esc)',
		'tee >(curl -o ../esc https://x)',
		'tee >(rsync a ../esc)',
		'tee >(sed -i s/a/b/ ../esc)',
		'tee >(tee ../esc)',
		'tee >(dd of=../esc)',
	])('%s DENIES', async (cmd) => {
		expect(await gate(cmd)).not.toBe('ADMITTED');
	});
	test('<(…) bodies execute too: escaping write DENIES', async () => {
		expect(await gate('diff <(tee ../../esc) <(cat b)')).not.toBe('ADMITTED');
	});
	test('destructive verb in a body DENIES (both operators)', async () => {
		expect(await gate('tee >(rm -rf ../esc)')).not.toBe('ADMITTED');
		expect(await gate('cmp <(rm -rf ../esc) b')).not.toBe('ADMITTED');
	});
	test('compound body DENIES on the escaping arm', async () => {
		expect(await gate('tee >(echo ok; gunzip -d ../esc.gz)')).not.toBe(
			'ADMITTED',
		);
	});
	test('write-free body that parses stays ADMITTED', async () => {
		expect(await gate('tee >(cat a | wc -l)')).toBe('ADMITTED');
	});
});

describe('detector-level shapes', () => {
	test('span bodies carry write targets for the unscanned families', () => {
		const writes = detectPosixWrites('true >(gunzip -d ../esc.gz)').writes;
		expect(writes.some((w) => w.operator.startsWith('gunzip'))).toBe(true);
	});
	test('procSubSpanBodies returns both operators', () => {
		expect(procSubSpanBodies('tee >(a) <(b)')).toEqual(['a', 'b']);
	});
});

describe('boundedness', () => {
	test('deeply nested procsub refuses (cap), not silent', () => {
		// Balanced nesting: each level wraps the previous in >(...)
		let cmd = 'gunzip -d ../esc.gz';
		for (let i = 0; i < 10; i++) cmd = `diff >(cat ${cmd}) b`;
		const writes = detectPosixWrites(cmd).writes;
		expect(
			writes.some((w) => w.unresolvedContext === true || w.path === null),
		).toBe(true);
	});
	test('two-span cd context: a post-cd span does not lose its context (4.5 Critical 1)', async () => {
		// The second span's recorded offset must account for the first
		// span's placeholder; before the fix the outer-prefix cd-context
		// read the wrong residual slice and this ADMITTED.
		expect(await gate('true >(cat); cd /;tee >(tee src/f)')).not.toBe(
			'ADMITTED',
		);
	});
	test('span-dense masking scales LINEARLY (doubling ratio, PR3590 critic)', () => {
		// Scaling-ratio bound measured at the MASKING ENTRY POINT
		// (procSubSpanBodies -> maskProcSubSpans) — timing the full detector
		// is dominated by the linear per-span body analysis and cannot
		// discriminate (delta re-gate: mutant total ratio ~2.0). Isolated,
		// the masking walk is linear when fixed (~2x on doubling) and
		// quadratic under the pre-fix per-span join (~3.6-4.7x); the 3x
		// ceiling separates the curves host-independently.
		const run = (spans: number): number => {
			const dense = `true ${'>(gunzip -d ../esc.gz) '.repeat(spans)}`;
			const t0 = performance.now();
			procSubSpanBodies(dense);
			return performance.now() - t0;
		};
		let ratioSum = 0;
		const RUNS = 3;
		for (let r = 0; r < RUNS; r++) {
			const tHalf = run(6000);
			const tFull = run(12000);
			ratioSum += tFull / Math.max(tHalf, 0.001);
		}
		expect(ratioSum / RUNS).toBeLessThan(3);
	}, 30000);
});
