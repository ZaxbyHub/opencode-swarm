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

describe('#3616 login-tail long options and compound payloads (review r16)', () => {
	// F1: long arg-taking sudo options with a SEPARATE argument
	// (--user root) are skipped by the interactive-tail slicer, so the
	// withdrawal inner words start at the command word, not the option
	// argument. F2: ANY shell -c payload under a login tail is treated as
	// write-bearing (compound payloads hide the write behind a non-write
	// first token; over-deny, safe direction) — and the destructive arm
	// now consumes the withdrawal rewrite via the uncertain-context push.
	for (const command of [
		`sh -c "sudo -i --user root sh -c 'tee src/ok'"`,
		`sh -c "sudo -i --group root sh -c 'tee src/ok'"`,
		`sh -c "sudo -i --prompt P sh -c 'tee src/ok'"`,
		`sh -c "sudo -i -u root sh -c 'tee src/ok'"`,
		`sh -c "sudo -i --user=root sh -c 'tee src/ok'"`,
		`sh -c "sudo -i sh -c 'cd src && tee ok'"`,
		`sh -c "sudo -i sh -c 'env tee src/ok'"`,
		`sh -c "sudo -i sh -c 'true && tee src/ok'"`,
		`sh -c "sudo -i bash -c 'cd src && tee ok'"`,
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
	test(
		'sh -c "sudo -i sh -c \'cd src && rm -rf x\'" is denied (destructive verb relocated to the sentinel)',
		async () => {
			const r = await gate(`sh -c "sudo -i sh -c 'cd src && rm -rf x'"`);
			expect(r.verdict).toBe('BLOCKED');
			expect(r.message).toMatch(/Recursive delete target|dynamic path target/);
			// Sharper oracle (review r17 nit): the relocation target IS the
			// escaping sentinel path, proving the push (not some other arm)
			// produced the deny.
			expect(r.message).toContain('__swarm_unresolved_chdir');
		},
		T,
	);
	// No-write shell payload control: the unconditional payload flag forces
	// the withdrawal REWRITE, but the deny still requires a detected write —
	// `echo hi` writes nothing, so it stays admitted (correct, not an
	// over-deny; the over-deny bound only compounds with a write-bearing
	// payload, as the tests above pin).
	test(
		'control: sh -c "sudo -i sh -c \'echo hi\'" stays admitted',
		async () => {
			expect((await gate(`sh -c "sudo -i sh -c 'echo hi'"`)).verdict).toBe(
				'ADMITTED',
			);
		},
		T,
	);
	// Plain (non-shell) no-write tails stay admitted.
	test(
		'control: sudo -i make build stays admitted',
		async () => {
			expect((await gate('sudo -i make build')).verdict).toBe('ADMITTED');
		},
		T,
	);
});

describe('#3616 login-tail shared-grammar completion (reviews r17-r18)', () => {
	// The r16 fixes stopped one spelling short of the detector's own option
	// grammar. r17 closes the gap by consuming the SHARED primitives
	// (longFlagTakesArg + the sudo tables, walkShellCommandFlags) and scopes
	// the destructive-arm push per top-level segment.
	test(
		'sibling after a withdrawn wrapper keeps its parent-cwd verdict: env -C $DIR true; rm -rf dist admits',
		async () => {
			expect((await gate('env -C $DIR true; rm -rf dist')).verdict).toBe(
				'ADMITTED',
			);
		},
		T,
	);
	test(
		'sibling after a withdrawn wrapper keeps its parent-cwd verdict: sudo -D "$D" true; rm -rf node_modules admits',
		async () => {
			expect(
				(await gate('sudo -D "$D" true; rm -rf node_modules')).verdict,
			).toBe('ADMITTED');
		},
		T,
	);
	test(
		'GNU long abbreviation skips its argument: sh -c "sudo -i --use root sh -c \'tee src/ok\'" denies',
		async () => {
			const r = await gate(`sh -c "sudo -i --use root sh -c 'tee src/ok'"`);
			expect(r.verdict).toBe('BLOCKED');
			expect(r.message).toMatch(DYNAMIC_DENY);
		},
		T,
	);
	test(
		'short cluster skips its argument: sh -c "sudo -i -Eu root sh -c \'tee src/ok\'" denies',
		async () => {
			const r = await gate(`sh -c "sudo -i -Eu root sh -c 'tee src/ok'"`);
			expect(r.verdict).toBe('BLOCKED');
			expect(r.message).toMatch(DYNAMIC_DENY);
		},
		T,
	);
	test(
		'clustered shell flags select the payload: sh -c "sudo -i sh -ec \'cd src && tee ok\'" denies',
		async () => {
			const r = await gate(`sh -c "sudo -i sh -ec 'cd src && tee ok'"`);
			expect(r.verdict).toBe('BLOCKED');
			expect(r.message).toMatch(DYNAMIC_DENY);
		},
		T,
	);
	test(
		'ordered shell flags select the payload: sh -c "sudo -i sh -e -c \'cd src && tee ok\'" denies',
		async () => {
			const r = await gate(`sh -c "sudo -i sh -e -c 'cd src && tee ok'"`);
			expect(r.verdict).toBe('BLOCKED');
			expect(r.message).toMatch(DYNAMIC_DENY);
		},
		T,
	);
	test(
		'a raw command merely CONTAINING the sentinel literal never triggers the push',
		async () => {
			expect((await gate(`echo '$__swarm_unresolved_chdir'`)).verdict).toBe(
				'ADMITTED',
			);
		},
		T,
	);
	// Review r18: the slicer must RESUME the option walk across VAR=value
	// words exactly like walkSudoOptions (parse_args.c:284) — stopping at the
	// assignment serialized the option word into command position and hid
	// the write. The glued-abbreviation leg pins longFlagTakesArg composing
	// the GNU prefix rule with `=`.
	test(
		'assignment before an option keeps the command word: sh -c "sudo -i FOO=bar --user root sh -c \'tee src/ok\'" denies',
		async () => {
			const r = await gate(
				`sh -c "sudo -i FOO=bar --user root sh -c 'tee src/ok'"`,
			);
			expect(r.verdict).toBe('BLOCKED');
			expect(r.message).toMatch(DYNAMIC_DENY);
		},
		T,
	);
	test(
		'assignment before an option relocates the destructive verb: sh -c "sudo -i FOO=bar --user root sh -c \'cd src && rm -rf x\'" denies',
		async () => {
			const r = await gate(
				`sh -c "sudo -i FOO=bar --user root sh -c 'cd src && rm -rf x'"`,
			);
			expect(r.verdict).toBe('BLOCKED');
			expect(r.message).toContain('__swarm_unresolved_chdir');
		},
		T,
	);
	test(
		'assignment-first spelling denies: sh -c "sudo FOO=bar -i --user root sh -c \'tee src/ok\'"',
		async () => {
			const r = await gate(
				`sh -c "sudo FOO=bar -i --user root sh -c 'tee src/ok'"`,
			);
			expect(r.verdict).toBe('BLOCKED');
			expect(r.message).toMatch(DYNAMIC_DENY);
		},
		T,
	);
	test(
		'control: benign assignment with a no-write payload stays admitted: sh -c "sudo -i FOO=bar sh -c \'echo hi\'"',
		async () => {
			expect(
				(await gate(`sh -c "sudo -i FOO=bar sh -c 'echo hi'"`)).verdict,
			).toBe('ADMITTED');
		},
		T,
	);
	test(
		'glued GNU abbreviation takes its value in-token: sh -c "sudo -i --u=root sh -c \'tee src/ok\'" denies',
		async () => {
			const r = await gate(`sh -c "sudo -i --u=root sh -c 'tee src/ok'"`);
			expect(r.verdict).toBe('BLOCKED');
			expect(r.message).toMatch(DYNAMIC_DENY);
		},
		T,
	);
});
