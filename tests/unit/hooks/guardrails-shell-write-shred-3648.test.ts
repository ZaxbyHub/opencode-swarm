/**
 * #3648 item 4 (D4 / frozen check C06): `shred` is an overwrite write-verb —
 * every operand is an in-place overwrite target judged by the write-scope
 * gate, per the DOCUMENTED GNU shred grammar: `-n N` / `-s N` consume a
 * detached value, `--remove=wipesync` is a glued OPTIONAL value while a
 * DETACHED word after `--remove` stays an OPERAND (both it and the following
 * path are overwrite targets), `--` ends options, and there is NO
 * numeric-name exclusion — a file literally named `1` is a real operand.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { resetSwarmState } from '../../../src/state';
import { gate } from './_shell-write-3616-fixtures';

const T = 60_000;
const AUTHORITY_DENY = /AUTHORITY_ROOT_ESCAPE/;

afterEach(() => {
	resetSwarmState();
});

describe('#3648 D4: shred operands are overwrite write targets', () => {
	test(
		'shred ../x is denied',
		async () => {
			const r = await gate('shred ../x');
			expect(r.verdict).toBe('BLOCKED');
			expect(r.message).toMatch(AUTHORITY_DENY);
		},
		T,
	);

	test(
		'shred src/a stays admitted (in-scope control)',
		async () => {
			const r = await gate('shred src/a');
			expect(r.verdict).toBe('ADMITTED');
		},
		T,
	);

	test(
		'shred -s 1024 ../x is denied (detached size consumed)',
		async () => {
			const r = await gate('shred -s 1024 ../x');
			expect(r.verdict).toBe('BLOCKED');
			expect(r.message).toMatch(AUTHORITY_DENY);
		},
		T,
	);

	test(
		'shred -n3 -u ../x is denied',
		async () => {
			const r = await gate('shred -n3 -u ../x');
			expect(r.verdict).toBe('BLOCKED');
		},
		T,
	);

	test(
		'shred --remove=wipesync ../x is denied (glued optional value)',
		async () => {
			const r = await gate('shred --remove=wipesync ../x');
			expect(r.verdict).toBe('BLOCKED');
			expect(r.message).toMatch(AUTHORITY_DENY);
		},
		T,
	);

	test(
		'shred --remove wipesync ../x is denied (detached word stays an operand)',
		async () => {
			// `--remove` takes only a GLUED `=how` value; the detached
			// `wipesync` word is an OPERAND alongside `../x` — the denial
			// names it as a judged target, not a consumed option value.
			const r = await gate('shred --remove wipesync ../x');
			expect(r.verdict).toBe('BLOCKED');
			expect(r.message).toMatch(/wipesync/);
		},
		T,
	);

	test(
		'shred -- 1 is denied (numeric filename after -- is a real operand)',
		async () => {
			const r = await gate('shred -- 1');
			expect(r.verdict).toBe('BLOCKED');
		},
		T,
	);

	test(
		'shred src/1 stays admitted (in-scope numeric filename control)',
		async () => {
			const r = await gate('shred src/1');
			expect(r.verdict).toBe('ADMITTED');
		},
		T,
	);
	test(
		'4.5 review: a consumed value option does not end option parsing',
		async () => {
			const a = await gate('shred -s 1024 -z src/a');
			expect(a.verdict).toBe('ADMITTED');
			const b = await gate('shred -s 1024 -z ../x');
			expect(b.verdict).toBe('BLOCKED');
		},
		T,
	);
});
