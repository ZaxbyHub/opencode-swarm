/**
 * #3648 item 1 (D1 / frozen check C02): awk-family inline program text is
 * judged as an interpreter-eval capability write — `awk 'BEGIN{print >
 * "../secret"}'`, `system()` bodies, the gawk/mawk alias map and the gawk
 * `-e` inline spelling all reach the python3 -c / perl -e parity arm, `-f
 * progfile` is the script-file carve-out, an unknown option denies on
 * uncertainty, and the eval-at-workspace-root over-deny is the DISCLOSED
 * python-parity bound (an inline eval at a cwd outside the declared scope
 * `src/` is denied even when its body has no visible write).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { resetSwarmState } from '../../../src/state';
import { gate } from './_shell-write-3616-fixtures';

const T = 60_000;
const EVAL_DENY = /dynamic path target|SCOPE_VIOLATION|evaluates inline code/;

afterEach(() => {
	resetSwarmState();
});

describe('#3648 D1: awk inline programs are judged as interpreter evals', () => {
	test(
		'awk print redirection to an escaping target is denied',
		async () => {
			const r = await gate('awk \'BEGIN{print > "../secret"}\'');
			expect(r.verdict).toBe('BLOCKED');
			expect(r.message).toMatch(EVAL_DENY);
		},
		T,
	);

	test(
		'awk system() body with rm -rf is denied under blockDestructive',
		async () => {
			const r = await gate('awk \'BEGIN{system("rm -rf ../x")}\'', {
				blockDestructive: true,
			});
			expect(r.verdict).toBe('BLOCKED');
		},
		T,
	);

	test(
		'gawk alias spelling is denied (alias map)',
		async () => {
			const r = await gate('gawk \'BEGIN{print > "../secret"}\'');
			expect(r.verdict).toBe('BLOCKED');
		},
		T,
	);

	test(
		'mawk alias spelling is denied (alias map)',
		async () => {
			const r = await gate('mawk \'BEGIN{print > "../secret"}\'');
			expect(r.verdict).toBe('BLOCKED');
		},
		T,
	);

	test(
		'awk -e inline program is denied (gawk -e spelling)',
		async () => {
			const r = await gate('awk -e \'BEGIN{print > "../secret"}\'');
			expect(r.verdict).toBe('BLOCKED');
		},
		T,
	);

	test(
		'awk -f progfile stays admitted (script-file carve-out)',
		async () => {
			// No prep needed: `-f` names a script FILE, not inline code — no
			// write target is judged, so plain operand strings suffice.
			const r = await gate('awk -f progfile.awk data.txt');
			expect(r.verdict).toBe('ADMITTED');
		},
		T,
	);

	test(
		'awk with an unknown option denies on uncertainty (eval risk)',
		async () => {
			const r = await gate("awk --weird 'BEGIN{x}'");
			expect(r.verdict).toBe('BLOCKED');
		},
		T,
	);
});

describe('#3648 D1 disclosed over-deny bound: python-parity contract', () => {
	test(
		'awk eval at the workspace root with scope src/ is denied (parity with python3 -c)',
		async () => {
			// DISCLOSED over-deny pin: an inline eval with no visible write is
			// judged at its cwd against the declared scope — the workspace root
			// is outside `src/`, exactly like `python3 -c 'print(1)'`.
			const r = await gate("awk '{print}' file");
			expect(r.verdict).toBe('BLOCKED');
			expect(r.message).toMatch(EVAL_DENY);
		},
		T,
	);

	test(
		'python3 -c parity leg: eval at the workspace root is denied',
		async () => {
			const r = await gate("python3 -c 'print(1)'");
			expect(r.verdict).toBe('BLOCKED');
			expect(r.message).toMatch(EVAL_DENY);
		},
		T,
	);

	test(
		'cd src && awk eval at an in-scope cwd is admitted',
		async () => {
			const r = await gate("cd src && awk '{print}' f");
			expect(r.verdict).toBe('ADMITTED');
		},
		T,
	);
	test(
		'4.5 review: glued -ffile does not hang and --include programs still deny',
		async () => {
			const a = await gate('awk -ffile.awk data');
			expect(a.verdict).toBe('ADMITTED');
			const b = await gate(
				'awk --include foo.awk \'BEGIN{print > "../secret"}\'',
			);
			expect(b.verdict).toBe('BLOCKED');
			const c = await gate('awk -v x=1 -f prog.awk data');
			expect(c.verdict).toBe('ADMITTED');
		},
		T,
	);
	test(
		'4.5 r2: -i <lib> (non-inplace) keeps the program classification live',
		async () => {
			const a = await gate('awk -i foo.awk \'BEGIN{print > "../secret"}\'');
			expect(a.verdict).toBe('BLOCKED');
			const b = await gate('awk -ifile.awk \'BEGIN{print > "../secret"}\'');
			expect(b.verdict).toBe('BLOCKED');
			const c = await gate("awk -i inplace '{print}' src/a");
			expect(c.verdict).toBe('ADMITTED');
		},
		T,
	);
});
