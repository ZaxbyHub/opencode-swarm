/**
 * #3648 item 3 (D3 / frozen check C04): `sudoedit` is recognized as an edit
 * form over its OWN documented getopt (NOT ordinary sudo's): value-taking
 * options (-u USER, -g GROUP, -T TIMEOUT, -h HOST, …) consume their argument
 * detached or glued BEFORE edit operands are identified, `-h HOST` withdraws
 * every operand (the remote landing is unmodeled — an in-scope-looking
 * operand still withdraws), an unknown option fails closed, and `--` ends
 * the option scan with the following word judged as the operand. Operands
 * land on the INVOKING cwd (the `sudo -e` model, sudo 1.9.15p5).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { resetSwarmState } from '../../../src/state';
import { gate } from './_shell-write-3616-fixtures';

const T = 60_000;
const AUTHORITY_DENY = /AUTHORITY_ROOT_ESCAPE/;

afterEach(() => {
	resetSwarmState();
});

describe('#3648 D3: sudoedit edit operands are judged per its own getopt', () => {
	test(
		'sudoedit ../secret.txt is denied (bare edit form)',
		async () => {
			const r = await gate('sudoedit ../secret.txt');
			expect(r.verdict).toBe('BLOCKED');
			expect(r.message).toMatch(AUTHORITY_DENY);
		},
		T,
	);

	test(
		'sudoedit -u root ../secret.txt is denied (-u consumes root)',
		async () => {
			const r = await gate('sudoedit -u root ../secret.txt');
			expect(r.verdict).toBe('BLOCKED');
		},
		T,
	);

	test(
		'sudoedit -h host ../secret is denied (remote host withdrawal)',
		async () => {
			const r = await gate('sudoedit -h host ../secret');
			expect(r.verdict).toBe('BLOCKED');
		},
		T,
	);

	test(
		'sudoedit -h host src/a is denied (in-scope-looking operand, remote landing withdraws)',
		async () => {
			const r = await gate('sudoedit -h host src/a');
			expect(r.verdict).toBe('BLOCKED');
		},
		T,
	);

	test(
		'sudoedit -T 10 src/a stays admitted (-T consumes 10; in-scope operand)',
		async () => {
			const r = await gate('sudoedit -T 10 src/a');
			expect(r.verdict).toBe('ADMITTED');
		},
		T,
	);

	test(
		'sudoedit -T 5 ../secret is denied (-T consumes 5; operand escapes)',
		async () => {
			const r = await gate('sudoedit -T 5 ../secret');
			expect(r.verdict).toBe('BLOCKED');
		},
		T,
	);

	test(
		'sudoedit -g wheel src/a stays admitted (-g consumes wheel; in-scope)',
		async () => {
			const r = await gate('sudoedit -g wheel src/a');
			expect(r.verdict).toBe('ADMITTED');
		},
		T,
	);

	test(
		'sudoedit -E src/a fails closed (invalid option)',
		async () => {
			const r = await gate('sudoedit -E src/a');
			expect(r.verdict).toBe('BLOCKED');
			expect(r.message).toMatch(/unrecognized option/);
		},
		T,
	);

	test(
		'sudoedit -- src/a stays admitted (sentinel then in-scope operand)',
		async () => {
			const r = await gate('sudoedit -- src/a');
			expect(r.verdict).toBe('ADMITTED');
		},
		T,
	);

	// FB-006 (#3689 review round): the PR summary claims `-R DIR`/`--chroot`
	// withdrawal but the suite pinned zero -R legs — neutralizing the
	// glued/detached -R mapping flipped these shapes to ADMITTED with the
	// suite green. The chroot re-bases operand resolution (sudo 1.9
	// synopsis), so EVERY edit operand withdraws while the chroot context is
	// live, in-scope-looking ones included; the no-option control stays
	// admitted so a wholesale -R breakage cannot hide.
	test(
		'sudoedit -R /outside src/a is denied (detached -R; operand under unresolvable chroot)',
		async () => {
			const r = await gate('sudoedit -R /outside src/a');
			expect(r.verdict).toBe('BLOCKED');
		},
		T,
	);

	test(
		'sudoedit -R/outside src/a is denied (glued -R)',
		async () => {
			const r = await gate('sudoedit -R/outside src/a');
			expect(r.verdict).toBe('BLOCKED');
		},
		T,
	);

	test(
		'sudoedit --chroot /outside src/a is denied (detached long form)',
		async () => {
			const r = await gate('sudoedit --chroot /outside src/a');
			expect(r.verdict).toBe('BLOCKED');
		},
		T,
	);

	test(
		'sudoedit --chroot=/outside src/a is denied (glued long form)',
		async () => {
			const r = await gate('sudoedit --chroot=/outside src/a');
			expect(r.verdict).toBe('BLOCKED');
		},
		T,
	);

	test(
		'sudoedit -R src-dir src/a is denied (workspace-relative chroot still re-bases resolution)',
		async () => {
			const r = await gate('sudoedit -R src-dir src/a');
			expect(r.verdict).toBe('BLOCKED');
		},
		T,
	);

	test(
		'sudoedit src/a stays admitted (no chroot option — control)',
		async () => {
			const r = await gate('sudoedit src/a');
			expect(r.verdict).toBe('ADMITTED');
		},
		T,
	);
});
