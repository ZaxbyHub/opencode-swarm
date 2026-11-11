/**
 * #3616 launcher+shell and login-sudo composition family — the critic-round
 * legs split from guardrails-shell-write-launcher-3616.test.ts (FR-006 file
 * cap). Every gate leg drives the REAL gate through
 * `_shell-write-3616-fixtures.ts` (coder role, scope `src/`).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { resetSwarmState } from '../../../src/state';
import { gate } from './_shell-write-3616-fixtures';

const T = 60_000;
const DYNAMIC_DENY = /dynamic path target/;
const AUTHORITY_DENY = /AUTHORITY_ROOT_ESCAPE/;

afterEach(() => {
	resetSwarmState();
});

describe('#3616 launcher + shell composition keeps the inner chdir (critic r3 (a))', () => {
	// `time bash -c "sudo -D /etc tee x"` previously unwrapped to a
	// chdir-less text (the shell-payload recursion only fired when the
	// SEGMENT head was the shell; a launcher prefix hid it). The recursion
	// now peels the launcher grammar first, and the nested fallback routes
	// through the same helper.
	for (const [command, landing] of [
		[`time bash -c "sudo -D /etc tee src/ok"`, /etc[\\\\/]src[\\\\/]ok/],
		[`nice bash -c "sudo -D /etc tee src/ok"`, /etc[\\\\/]src[\\\\/]ok/],
		[`env -i bash -c "sudo -D /etc tee src/ok"`, /etc[\\\\/]src[\\\\/]ok/],
		[`time sh -c "env -C .. tee src/a"`, 'path=../src/a'],
		[`time bash -c "env -C .. tee src/a"`, 'path=../src/a'],
		// nested fallback: the dash rewrite's quoted-time inner text
		[`env - time sh -c "env -C .. tee src/a"`, 'path=../src/a'],
	] as Array<[string, string | RegExp]>) {
		test(
			`${command} is denied at the wrapped command's landing`,
			async () => {
				const r = await gate(command);
				expect(r.verdict).toBe('BLOCKED');
				expect(r.message).toMatch(AUTHORITY_DENY);
				if (typeof landing === 'string') {
					expect(r.message).toContain(landing);
				} else {
					expect(r.message).toMatch(landing);
				}
			},
			T,
		);
	}
	for (const command of [
		`time bash -c "tee src/ok"`,
		`time sh -c "echo hi"`,
		`env -i bash -c "echo x > src/ok.txt"`,
	]) {
		test(
			`control: ${command} is admitted`,
			async () => {
				expect((await gate(command)).verdict).toBe('ADMITTED');
			},
			T,
		);
	}
});

describe('#3616 shell-wrapped sudo -i withdraws (critic r4 (e))', () => {
	// A login sudo inside a shell payload previously spliced to
	// `( tee src/ok )` — the legacy unwrap stripped the sudo words, so the
	// login-landing withdrawal could never fire. matchSudoChdir now has a
	// login arm: a write-bearing tail with a RELATIVE operand returns the
	// uncertain (withdrawal) match at the shared funnel.
	for (const command of [
		`sh -c "sudo -i tee src/ok"`,
		`bash -c "sudo -i tee src/ok"`,
		`env -i sh -c "sudo -i tee src/ok"`,
		`time sh -c "sudo -i tee src/ok"`,
		`env - time sh -c "sudo -i tee src/ok"`,
	]) {
		test(
			`${command} is denied by withdrawal`,
			async () => {
				const r = await gate(command);
				expect(r.verdict).toBe('BLOCKED');
				expect(r.message).toMatch(DYNAMIC_DENY);
				// Not the pre-item-15 default label.
				expect(r.message).not.toMatch(/shell variable or command substitution/);
			},
			T,
		);
	}
	test(
		'control: sh -c "sudo -s tee src/ok" stays admitted',
		async () => {
			expect((await gate(`sh -c "sudo -s tee src/ok"`)).verdict).toBe(
				'ADMITTED',
			);
		},
		T,
	);
	test(
		'control: sh -c "sudo -i make build" stays admitted',
		async () => {
			expect((await gate(`sh -c "sudo -i make build"`)).verdict).toBe(
				'ADMITTED',
			);
		},
		T,
	);
	test(
		'control: sh -c "sudo -i tee /etc/x" denies by authority, not withdrawal',
		async () => {
			const r = await gate(`sh -c "sudo -i tee /etc/x"`);
			expect(r.verdict).toBe('BLOCKED');
			expect(r.message).toMatch(AUTHORITY_DENY);
			expect(r.message).not.toMatch(DYNAMIC_DENY);
		},
		T,
	);
});

describe('#3616 login-tail family completion (review r15 findings)', () => {
	// F1: the write-word set now matches the detector's (touch/unlink/
	// rmdir/ln added). F2: a non-login sudo prefix is peeled at the
	// shell-payload site. F3: -i before a shell word classifies
	// 'interactive' — the same withdrawal scan runs over the raw tail,
	// sliced from the command word. F4: absolute-only tails keep the
	// authority reason (only the write TARGET counts as an operand).
	for (const command of [
		`sh -c "sudo -i touch src/ok"`,
		`sh -c "sudo -i unlink src/ok"`,
		`sh -c "sudo -i rmdir src/d"`,
		`sh -c "sudo -i ln -s src/a src/b"`,
		`sudo sh -c "sudo -i tee src/ok"`,
		`nice sudo sh -c "sudo -i tee src/ok"`,
		`sh -c "sudo -i sh -c 'tee ../x'"`,
		`sh -c "sudo -i sh -c 'tee src/ok'"`,
	]) {
		test(
			`${command} is denied by withdrawal`,
			async () => {
				const r = await gate(command);
				expect(r.verdict).toBe('BLOCKED');
				expect(r.message).toMatch(DYNAMIC_DENY);
			},
			T,
		);
	}
	for (const command of [
		`sudo -i rm /etc/x`,
		`sudo -i cp /etc/a /etc/b`,
		`sudo -i mv /etc/a /etc/b`,
		`sudo -i install src/a /etc/b`,
		`sh -c "sudo -i rm /etc/x"`,
	]) {
		test(
			`${command} denies by authority (absolute-only tail)`,
			async () => {
				const r = await gate(command);
				expect(r.verdict).toBe('BLOCKED');
				expect(r.message).toMatch(AUTHORITY_DENY);
				expect(r.message).not.toMatch(DYNAMIC_DENY);
			},
			T,
		);
	}
});
