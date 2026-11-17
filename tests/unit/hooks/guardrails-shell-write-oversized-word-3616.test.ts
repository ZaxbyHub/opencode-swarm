/**
 * #3616 item 11 — oversized-word sentinel. Tracked port of the frozen
 * acceptance check `checks-brace-budget-3616.ts`, re-cut per call site.
 *
 * A whitespace-delimited word longer than 4096 characters cannot be analyzed
 * in budget (PR #3615 measured ~1.5 s per walk on a 40k unclosed-brace
 * operand). `detectPosixWrites` short-circuits it through
 * `firstWordOverBudget` into an opaque eval-class write the gate blocks.
 *
 * Legs:
 * 1. Unit: `firstWordOverBudget` boundary (4096 not over, 4097 over), quoted
 *    and unquoted words, tab/newline delimiters, short commands.
 * 2. Per call site (`curl -o`, `sed -i`, `scp`, `for … in` list): the detector
 *    classifies the 40k operand as an oversized word in well under 200 ms
 *    (min of several runs — host noise only adds latency; generous CI-safe
 *    bound, never an absolute gate-latency ceiling), and the live gate
 *    BLOCKS it with the fail-closed parse reason.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
	detectPosixWrites,
	firstWordOverBudget,
} from '../../../src/hooks/shell-write-detect';
import { resetSwarmState } from '../../../src/state';
import { gate } from './_shell-write-3616-fixtures';

const T = 60_000;
const BUDGET = 4096;
const BIG = `b{${'x'.repeat(40_000)}`;
const RUNS = 5;

afterEach(() => {
	resetSwarmState();
});

describe('#3616 item 11: firstWordOverBudget', () => {
	test(
		'a word of exactly the budget is not over; one more char is',
		() => {
			expect(firstWordOverBudget('x'.repeat(BUDGET), BUDGET)).toBeNull();
			expect(
				firstWordOverBudget(`ls ${'x'.repeat(BUDGET)} y`, BUDGET),
			).toBeNull();
			const over = firstWordOverBudget(
				`ls ${'x'.repeat(BUDGET + 1)} y`,
				BUDGET,
			);
			expect(over?.length).toBe(BUDGET + 1);
		},
		T,
	);

	test(
		'quoted and unquoted oversized words are both detected',
		() => {
			const unquoted = firstWordOverBudget(`a ${'x'.repeat(5000)}`, BUDGET);
			expect(unquoted).toBe('x'.repeat(5000));
			const quoted = firstWordOverBudget(`a "${'x'.repeat(5000)}"`, BUDGET);
			expect(quoted).toBe(`"${'x'.repeat(5000)}"`);
		},
		T,
	);

	test(
		'tab and newline delimit words; short commands return null',
		() => {
			const word = firstWordOverBudget(`a\t${'y'.repeat(5000)}\nb`, BUDGET);
			expect(word).toBe('y'.repeat(5000));
			expect(firstWordOverBudget('curl -o b{x http://h/x', BUDGET)).toBeNull();
			expect(firstWordOverBudget('', BUDGET)).toBeNull();
		},
		T,
	);
});

function minDetectMs(command: string): number {
	detectPosixWrites(command); // warm-up (JIT + parser init)
	let best = Number.POSITIVE_INFINITY;
	for (let i = 0; i < RUNS; i += 1) {
		const t0 = performance.now();
		detectPosixWrites(command);
		best = Math.min(best, performance.now() - t0);
	}
	return best;
}

const CALL_SITES: Array<[string, string]> = [
	['curl -o', `curl -o ${BIG} http://127.0.0.1/x`],
	['sed -i (picker)', `sed -i s/a/b/ ${BIG}`],
	['scp', `scp h:f ${BIG}`],
	['for … in list', `for i in ${BIG}; do echo x > src/f; done`],
];

describe('#3616 item 11: oversized operand per call site', () => {
	for (const [site, command] of CALL_SITES) {
		test(
			`${site}: detector short-circuits the 40k operand`,
			() => {
				const analysis = detectPosixWrites(command);
				expect(analysis.parseError).toBe(true);
				expect(analysis.writes.map((w) => w.operator)).toEqual([
					'oversized word',
				]);
				// Bounded echo of the oversized word.
				expect(
					(analysis.writes[0]?.dynamicSourceWord ?? '').length,
				).toBeLessThanOrEqual(64);
				expect(minDetectMs(command)).toBeLessThan(200);
			},
			T,
		);

		test(
			`${site}: live gate blocks the 40k operand`,
			async () => {
				const r = await gate(command);
				expect(r.verdict).toBe('BLOCKED');
				// F-15 (PR #3651 review): the sentinel names its actual cause.
				expect(r.message).toMatch(/4096-character analysis budget/);
			},
			T,
		);
	}

	test(
		'control: the small unclosed-brace operand is still analyzed (not an oversized word)',
		async () => {
			const analysis = detectPosixWrites('curl -o b{x http://127.0.0.1/x');
			expect(analysis.writes.map((w) => w.operator)).not.toContain(
				'oversized word',
			);
			const r = await gate('curl -o b{x http://127.0.0.1/x');
			expect(r.verdict).toBe('BLOCKED');
			expect(r.message).toContain('SCOPE_VIOLATION');
		},
		T,
	);
});
