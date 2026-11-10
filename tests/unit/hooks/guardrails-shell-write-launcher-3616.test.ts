/**
 * #3616 launcher / ambient-state family (items 1, 5, 6, 7) — tracked port of
 * the frozen acceptance checks `checks-launcher-3616.ts` (groups ambient,
 * sudo-d, sudo-i, env-hop). Every leg drives the REAL gate
 * (`createGuardrailsHooks().toolBefore`, bash tool, coder role, declared
 * scope `src/`) through `_shell-write-3616-fixtures.ts`.
 *
 * Legs:
 * 1. Ambient keys: an in-command assignment naming BASH_ENV, ENV, or a
 *    BASH_FUNC_* key (bare prefix, `export`, `env`, `env -i`, after `&&`) is
 *    denied as a whole command; a benign `FOO=1` / `ENVX=1` prefix is not.
 *    A detector-level leg pins the classification (operator) directly so a
 *    disabled ambient scan fails even where a later layer would also deny.
 * 2. `sudo -D DIR` behind a launcher wrapper (`time`, `bash -c`) resolves the
 *    tail under DIR (here /etc — outside the workspace): denied by authority.
 * 3. `sudo -i` relative write tails are judged at the target user's home
 *    (unresolvable → dynamic withdrawal); `-s`, a no-write tail, and an
 *    absolute target (authority-class reason) are the controls.
 * 4. `env` interposed between launchers matches the env-free twin's verdict.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { detectPosixWrites } from '../../../src/hooks/shell-write-detect';
import { resetSwarmState } from '../../../src/state';
import { gate } from './_shell-write-3616-fixtures';

const T = 60_000;
const PARSE_DENY = /failed to parse command/;
const DYNAMIC_DENY = /dynamic path target/;
const AUTHORITY_DENY = /AUTHORITY_ROOT_ESCAPE/;

afterEach(() => {
	resetSwarmState();
});

const AMBIENT_DENIED: Array<[string, string]> = [
	['BASH_FUNC_* prefix', "BASH_FUNC_f%%='() { echo x > ../esc; }' bash -c 'f'"],
	[
		'export BASH_FUNC_*',
		"export BASH_FUNC_f%%='() { echo x > ../esc; }'; true",
	],
	['env BASH_ENV=', 'env BASH_ENV=env.sh tee src/ok.txt'],
	['env ENV=', 'env ENV=x tee src/ok.txt'],
	['env -i BASH_ENV=', 'env -i BASH_ENV=x tee src/ok.txt'],
	['ENV= after &&', 'true && ENV=x tee src/a'],
	[
		'direct BASH_ENV= prefix (preserved)',
		"BASH_ENV=env.sh sh -c 'echo x > src/a'",
	],
];

describe('#3616 item 1: ambient shell-state key assignments', () => {
	for (const [label, command] of AMBIENT_DENIED) {
		test(
			`gate denies ${label}`,
			async () => {
				const r = await gate(command);
				expect(r.verdict).toBe('BLOCKED');
				expect(r.message).toMatch(PARSE_DENY);
			},
			T,
		);

		test(
			`detector classifies ${label} as an ambient key assignment`,
			() => {
				const analysis = detectPosixWrites(command);
				expect(analysis.parseError).toBe(true);
				expect(analysis.writes.map((w) => w.operator)).toContain(
					'ambient shell-state key assignment',
				);
			},
			T,
		);
	}

	for (const command of ['FOO=1 tee src/ok.txt', 'ENVX=1 tee src/ok.txt']) {
		test(
			`benign assignment stays admitted: ${command}`,
			async () => {
				const analysis = detectPosixWrites(command);
				expect(analysis.writes.map((w) => w.operator)).not.toContain(
					'ambient shell-state key assignment',
				);
				const r = await gate(command);
				expect(r.verdict).toBe('ADMITTED');
			},
			T,
		);
	}
});

describe('#3616 item 5: sudo -D behind launcher wrappers', () => {
	for (const command of [
		'time sudo -D /etc tee src/ok.txt',
		'bash -c "sudo -D /etc tee src/ok"',
		'sudo -D /etc tee src/ok.txt',
	]) {
		test(
			`denied at the -D landing: ${command}`,
			async () => {
				const r = await gate(command);
				expect(r.verdict).toBe('BLOCKED');
				expect(r.message).toMatch(AUTHORITY_DENY);
				// The landing is under /etc, never the workspace-relative src/.
				expect(r.message).toMatch(/etc[\\/]src[\\/]ok/);
			},
			T,
		);
	}
});

describe('#3616 item 6: sudo -i relative write tails', () => {
	test(
		'sudo -i relative tee is withdrawn (target home unresolvable)',
		async () => {
			const r = await gate('sudo -i tee src/ok.txt');
			expect(r.verdict).toBe('BLOCKED');
			expect(r.message).toMatch(DYNAMIC_DENY);
			expect(r.message).toContain('"src/ok.txt"');
		},
		T,
	);

	test(
		'control: sudo -s keeps cwd and stays admitted',
		async () => {
			const r = await gate('sudo -s tee src/ok.txt');
			expect(r.verdict).toBe('ADMITTED');
		},
		T,
	);

	test(
		'control: sudo -i with no write tail stays admitted',
		async () => {
			const r = await gate('sudo -i make build');
			expect(r.verdict).toBe('ADMITTED');
		},
		T,
	);

	test(
		'control: sudo -i absolute target is denied by authority, not withdrawal',
		async () => {
			const r = await gate('sudo -i tee /etc/x');
			expect(r.verdict).toBe('BLOCKED');
			expect(r.message).toMatch(AUTHORITY_DENY);
			expect(r.message).not.toMatch(DYNAMIC_DENY);
		},
		T,
	);
});

describe('#3616 item 7: env interposed between launchers', () => {
	const PAIRS: Array<[string, string, 'ADMITTED' | 'BLOCKED']> = [
		['nice env time -o ../x true', 'nice time -o ../x true', 'BLOCKED'],
		['nice env sudo -i tee src/ok.txt', 'sudo -i tee src/ok.txt', 'BLOCKED'],
		['sudo env sudo -i tee src/ok.txt', 'sudo -i tee src/ok.txt', 'BLOCKED'],
		['sudo env -- sudo -i tee src/ok.txt', 'sudo -i tee src/ok.txt', 'BLOCKED'],
		[
			'nice sudo env -i sudo -s tee src/ok.txt',
			'sudo -s tee src/ok.txt',
			'ADMITTED',
		],
	];
	for (const [wrapped, twin, expected] of PAIRS) {
		test(
			`${wrapped} matches its env-free twin (${expected})`,
			async () => {
				const w = await gate(wrapped);
				const t = await gate(twin);
				expect(w.verdict).toBe(expected);
				expect(t.verdict).toBe(expected);
				if (expected === 'BLOCKED') {
					// Same deny class as the twin (authority vs withdrawal).
					expect(DYNAMIC_DENY.test(w.message)).toBe(
						DYNAMIC_DENY.test(t.message),
					);
					expect(AUTHORITY_DENY.test(w.message)).toBe(
						AUTHORITY_DENY.test(t.message),
					);
				}
			},
			T,
		);
	}
});

describe('#3616 env split-string family: every spelling reaches the payload walk', () => {
	// GNU env splits the -S/--split-string payload into argv in place of the
	// option for EVERY spelling (final-critic round 2, F1). A `-C ..` payload
	// moves the wrapped write to the workspace parent, so each spelling must
	// deny; a payload with no chdir is judged like the canonical `-S` form.
	const PAYLOAD_CHDIR = `-C .. sh -c 'echo x > src/a'`;
	const DENIED: string[] = [
		`env "--split-string=${PAYLOAD_CHDIR}"`,
		`env "--split=${PAYLOAD_CHDIR}"`,
		`env --spl "${PAYLOAD_CHDIR}"`,
		`env "-S${PAYLOAD_CHDIR}"`,
		`env "-iS${PAYLOAD_CHDIR}"`,
		`env -S "${PAYLOAD_CHDIR}"`,
		`env -S'tee ../outside.txt'`,
		`env --split='tee ../outside.txt'`,
		`env -C .. -S'tee src/a'`,
		// Words AFTER the split option: the split is an argv splice, so an
		// empty / option-only payload leaves the following words as the
		// command, and a payload command takes them as its arguments
		// (implementation-review round 6).
		`env --split-string= sh -c "echo x > ../x.txt"`,
		`env --split= sh -c "echo x > ../x.txt"`,
		`env --split '' sh -c "echo x > ../x.txt"`,
		`env -S '' sh -c "echo x > ../x.txt"`,
		`env --split='FOO=1' sh -c "echo x > ../x.txt"`,
		`env --split='-i' sh -c "echo x > ../x.txt"`,
		`env -S sh -c "echo x > ../x.txt"`,
		`env --split=sh -c "echo x > ../x.txt"`,
		`env -S tee ../outside.txt`,
		// A lone `-` payload is env's obsolete -i alias: an option, not the
		// command — the post words run as the command (review round 7).
		`env -S '-' /bin/bash -c "echo x > ../x.txt"`,
		`env --split='-' /bin/bash -c "echo x > ../x.txt"`,
		`env -S '-' /bin/sh -c "tee ../x.txt"`,
		`env -S '-u FOO -' sh -c "echo x > ../x.txt"`,
		`env -S '' - sh -c "echo x > ../x.txt"`,
		`env -C .. - /bin/sh -c "echo x > src/a"`,
	];
	for (const command of DENIED) {
		test(
			`${command} is denied`,
			async () => {
				const r = await gate(command);
				expect(r.verdict).toBe('BLOCKED');
				expect(r.message).toMatch(AUTHORITY_DENY);
			},
			T,
		);
	}
	for (const command of [
		`env -S '-S tee src/ok.txt'`,
		// A payload env would expand, or a literal redirect-operator word,
		// followed by more words cannot be spliced faithfully.
		`env -S '$SHELL' -c "echo x > ../x.txt"`,
		`env -S 'echo >' ../o`,
	]) {
		test(
			`${command} fails closed`,
			async () => {
				const r = await gate(command);
				expect(r.verdict).toBe('BLOCKED');
				expect(r.message).toMatch(PARSE_DENY);
			},
			T,
		);
	}
	for (const command of [
		`env -S 'tee src/ok.txt'`,
		`env "--split=-C src tee ok.txt"`,
		`env -C src -S 'tee ok.txt'`,
		// env -S passes `>` through as a literal argv word (no redirect).
		`env -S'echo x > ../o'`,
		`env --split= sh -c "echo x > src/ok.txt"`,
		`env -S '' sh -c "echo x > src/ok.txt"`,
		`env -S sh -c "echo x > src/ok.txt"`,
		`env -S '-' /bin/bash -c "echo x > src/ok.txt"`,
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
