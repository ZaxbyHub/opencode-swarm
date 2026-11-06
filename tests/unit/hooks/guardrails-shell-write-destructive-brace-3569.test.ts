/**
 * #3569 residual-1 shipped suite — brace expansion on destructive rm targets.
 *
 * Facts (trace 04-root-cause.md D4): the extractor's flag gate rejected the
 * flagless brace shape entirely (null), and the PRR-010 trailing-delimiter
 * cleanup ate the closing `}` from forced shapes. The fix strips only `)`,
 * treats brace-bearing rm targets as destructive in BOTH flag states, and
 * expands branches through the (now exported, pre-capped) engine — dynamic
 * or over-cap expansions withdraw fail-closed to the refusal marker.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { dcExtractRecursiveRmTargets } from '../../../src/hooks/guardrails/destructive-command';
import { expandBraceRaw } from '../../../src/hooks/shell-write-detect';
import { resetSwarmState } from '../../../src/state';

beforeEach(() => {
	resetSwarmState();
});

describe('extractor: brace coverage in both flag states', () => {
	test('flagless brace-bearing rm extracts expanded branches', () => {
		expect(dcExtractRecursiveRmTargets('rm src/{a,../esc}')).toEqual([
			'src/a',
			'src/../esc',
		]);
	});
	test('forced rm keeps the closing brace and expands (no mangled word)', () => {
		const got = dcExtractRecursiveRmTargets('rm -f src/{a,../esc}');
		expect(got).toEqual(['src/a', 'src/../esc']);
		expect(got?.some((t) => t.includes('{'))).toBe(false);
	});
	test('in-scope brace still extracts (evaluation judges containment)', () => {
		expect(dcExtractRecursiveRmTargets('rm src/{a,b}')).toEqual([
			'src/a',
			'src/b',
		]);
	});
	test('flagless single literal target stays outside the arm (unchanged)', () => {
		expect(dcExtractRecursiveRmTargets('rm ../esc')).toBeNull();
	});
	test('dynamic/refused expansion withdraws to the refusal marker', () => {
		const got = dcExtractRecursiveRmTargets('rm src/{$VAR,../esc}');
		expect(got).toBeTruthy();
		expect(got?.every((t) => t.startsWith('__swarm_brace_refusal__/'))).toBe(
			true,
		);
	});
});

describe('engine: bounded expansion (pre-allocation cap)', () => {
	test('plain comma list and small sequence expand', () => {
		expect(expandBraceRaw('src/{a,b}')).toEqual({
			kind: 'branches',
			branches: ['src/a', 'src/b'],
		});
	});
	test('adversarial huge numeric range refuses DYNAMICALLY (no materialization)', () => {
		const t0 = Date.now();
		const got = expandBraceRaw('src/{1..30000000}');
		const ms = Date.now() - t0;
		expect(got.kind).toBe('dynamic');
		// The pre-allocation guard must refuse in bounded time — the
		// pre-fix engine materialized ~30M strings (measured ~2.2 GB).
		expect(ms).toBeLessThan(500);
	});
	test('over-cap comma list refuses dynamically', () => {
		const words = Array.from({ length: 12 }, (_, i) => `d${i}`).join(',');
		expect(expandBraceRaw(`src/{${words}}`).kind).toBe('dynamic');
	});
});

describe('quoted braces stay literal (4.5 review)', () => {
	const SQ = String.fromCharCode(39);
	const DQ = String.fromCharCode(34);
	test('single-quoted brace operand does NOT expand', () => {
		expect(dcExtractRecursiveRmTargets(`rm -f ${SQ}src/{a,b}${SQ}`)).toEqual([
			'src/{a,b}',
		]);
	});
	test('double-quoted brace operand does NOT expand', () => {
		expect(dcExtractRecursiveRmTargets(`rm -f ${DQ}src/{a,b}${DQ}`)).toEqual([
			'src/{a,b}',
		]);
	});
});
