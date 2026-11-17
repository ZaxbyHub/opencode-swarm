/**
 * #3648 item 5 (D5 / frozen check C07): a leading paren/brace opener must not
 * let a login sudo escape the login-withdrawal arms — the wrapper strip
 * tolerates standalone AND glued delimiters at SEGMENT START only, so
 * `( sudo -i … )`, `((sudo …`, `( ( sudo …`, `{ sudo …; }`, `({ sudo …; })`
 * and `(sudo …` all reach the text-arm matchers. `>(cat)` / `2>(wc)` fd
 * redirect openers are explicitly untouched admission shapes.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { resetSwarmState } from '../../../src/state';
import { gate } from './_shell-write-3616-fixtures';

const T = 60_000;

/** The C07 RED-leg payload: a login sudo running a cd-carrying rm -rf. */
const LOGIN_RM = "sudo -i sh -c 'cd src && rm -rf x'";

afterEach(() => {
	resetSwarmState();
});

describe('#3648 D5: paren/brace-led login sudo reaches the text arms', () => {
	test(
		'( sudo -i sh -c rm ) is denied — the AC7 leg',
		async () => {
			const r = await gate(`( ${LOGIN_RM} )`, { blockDestructive: true });
			expect(r.verdict).toBe('BLOCKED');
		},
		T,
	);

	test(
		'bare paren-less twin stays denied',
		async () => {
			const r = await gate(LOGIN_RM, { blockDestructive: true });
			expect(r.verdict).toBe('BLOCKED');
		},
		T,
	);

	test(
		'glued doubled paren ((sudo … stays denied',
		async () => {
			const r = await gate(`((${LOGIN_RM} ))`, { blockDestructive: true });
			expect(r.verdict).toBe('BLOCKED');
		},
		T,
	);

	test(
		'spaced doubled paren ( ( sudo … ) ) stays denied',
		async () => {
			const r = await gate(`( ( ${LOGIN_RM} ) )`, { blockDestructive: true });
			expect(r.verdict).toBe('BLOCKED');
		},
		T,
	);

	test(
		'brace group { sudo …; } stays denied',
		async () => {
			const r = await gate(`{ ${LOGIN_RM}; }`, { blockDestructive: true });
			expect(r.verdict).toBe('BLOCKED');
		},
		T,
	);

	test(
		'glued brace group ({ sudo …; }) stays denied',
		async () => {
			const r = await gate(`({ ${LOGIN_RM}; })`, { blockDestructive: true });
			expect(r.verdict).toBe('BLOCKED');
		},
		T,
	);

	test(
		'glued paren (sudo -i rm -rf src/x) stays denied',
		async () => {
			const r = await gate('(sudo -i rm -rf src/x)', {
				blockDestructive: true,
			});
			expect(r.verdict).toBe('BLOCKED');
		},
		T,
	);
});

describe('#3648 D5 controls: fd-redirect openers stay untouched', () => {
	test(
		'>(cat) stays admitted',
		async () => {
			const r = await gate('>(cat)');
			expect(r.verdict).toBe('ADMITTED');
		},
		T,
	);

	test(
		'echo hi 2>(wc -l) stays admitted',
		async () => {
			const r = await gate('echo hi 2>(wc -l)');
			expect(r.verdict).toBe('ADMITTED');
		},
		T,
	);

	test(
		'( sudo -i make build ) is denied (paren unwrap keeps the interactive-shell denial)',
		async () => {
			// DISCLOSED over-deny bound: the bare `sudo -i make build` twin is
			// admitted by the AST launcher walk (3616 item 6), but inside a
			// paren the D5 text-arm peel routes the login form through the
			// interactive-shell withdrawal — the same accepted safe-direction
			// bound the frozen C11 check pins for `sudo -i sh -c 'echo hi'`.
			const r = await gate('( sudo -i make build )');
			expect(r.verdict).toBe('BLOCKED');
		},
		T,
	);
});
