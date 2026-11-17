/**
 * #3616 deny rendering + #3606 ancestor arms — tracked port of the frozen
 * acceptance checks `checks-deny-sanitize-3616.ts`,
 * `checks-deny-reasons-3616.ts`, `checks-explain-scope-3616.ts`,
 * `checks-rm-flag-off-3616.ts`, `checks-ancestor-lstat-3606.ts` and
 * `checks-ancestor-redaction-3606.ts`.
 *
 * Legs:
 * 1. Sanitizer (items 13/14): raw ESC, over-length targets, the UNC site,
 *    bidi marks, and astral pairs straddling both 160-unit truncation cuts
 *    (152z: canonical maxLength-1 cut; 153z: plain slice(0, 160) cut).
 * 2. Deny-reason table (item 15): each dynamic-target origin renders its own
 *    fragment and none of the others'.
 * 3. Explain without --scope (item 2) renders block / scope_unevaluated, never
 *    an unqualified allow.
 * 4. block_destructive_commands:false (item 10): flagged rm operands are
 *    still judged by the scope/authority layer.
 * 5. #3606: both ancestor denial arms of checkWriteTargetForSymlink are
 *    home-redacted, carry the error CODE only, and are bounded at 320. The
 *    lstat-failure arm is driven through the `_internals.lstatSync` seam.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	checkWriteTargetForSymlink,
} from '../../../src/hooks/guardrails/file-authority';
import { handleGuardrailExplain } from '../../../src/services/guardrail-explain-service';
import { resetSwarmState } from '../../../src/state';
import {
	gate,
	hasUnpairedSurrogate,
	linkDir,
	makeWorkspace,
	teardown,
} from './_shell-write-3616-fixtures';

const T = 60_000;
const ESC = String.fromCharCode(27);
const UNEXPANDED = /unexpanded variable/;
const originalLstat = _internals.lstatSync;

afterEach(() => {
	_internals.lstatSync = originalLstat;
	resetSwarmState();
});

describe('#3616 items 13/14: destructive deny-message sanitization', () => {
	test(
		'raw ESC never reaches the unexpanded-variable deny message',
		async () => {
			const r = await gate(`rm -rf "$HOME/a${ESC}X"`);
			expect(r.verdict).toBe('BLOCKED');
			expect(r.message).toMatch(UNEXPANDED);
			expect(r.message.includes(ESC)).toBe(false);
		},
		T,
	);

	test(
		'an over-length target is echoed bounded, not verbatim',
		async () => {
			const long = `d${'y'.repeat(300)}`;
			const r = await gate(`rm -rf "$HOME/${long}"`);
			expect(r.verdict).toBe('BLOCKED');
			expect(r.message).toMatch(UNEXPANDED);
			expect(r.message.length).toBeLessThanOrEqual(900);
			expect(r.message.includes(long.slice(0, 200))).toBe(false);
		},
		T,
	);

	test(
		'the UNC deny site neutralizes ESC too',
		async () => {
			const r = await gate(`rm -rf "\\\\server\\a${ESC}b"`);
			expect(r.verdict).toBe('BLOCKED');
			expect(r.message).toMatch(/remote\/network/);
			expect(r.message.includes(ESC)).toBe(false);
		},
		T,
	);

	test(
		'bidi marks U+061C / U+200E / U+200F are neutralized',
		async () => {
			const marks = [0x061c, 0x200e, 0x200f].map((c) => String.fromCharCode(c));
			const r = await gate(
				`rm -rf "$HOME/h${marks[0]}o${marks[1]}m${marks[2]}e"`,
			);
			expect(r.verdict).toBe('BLOCKED');
			expect(r.message).toMatch(UNEXPANDED);
			for (const mark of marks) {
				expect(r.message.includes(mark)).toBe(false);
			}
		},
		T,
	);

	// field = `$HOME/` (6 units) + target, rendered under a 160 bound.
	// 152 z: the first astral high surrogate sits at unit 158, its low at 159
	// (the canonical maxLength-1 cut). 153 z: high at 159, low at 160 (the
	// plain slice(0, 160) cut).
	for (const zs of [152, 153]) {
		test(
			`no unpaired surrogate when an astral pair straddles the cut (${zs}z)`,
			async () => {
				const target = `${'z'.repeat(zs)}${String.fromCodePoint(0x1f600).repeat(40)}`;
				const r = await gate(`rm -rf "$HOME/${target}"`);
				expect(r.verdict).toBe('BLOCKED');
				expect(r.message).toMatch(UNEXPANDED);
				expect(r.message).toContain('z'.repeat(zs));
				expect(hasUnpairedSurrogate(r.message)).toBe(false);
			},
			T,
		);
	}
});

const ORIGIN_FRAGMENTS = {
	tilde: /tilde/i,
	'loop-landing': /loop landing/i,
	'directory-withdrawal': /directory context/i,
	'wrapper-chdir': /wrapper chdir/i,
	'unverifiable-path': /could not be verified on the filesystem/i,
	'dynamic-text': /variable or command substitution/i,
} as const;
type Origin = keyof typeof ORIGIN_FRAGMENTS;

function expectOrigin(message: string, expected: Origin): void {
	for (const origin of Object.keys(ORIGIN_FRAGMENTS) as Origin[]) {
		expect(`${origin}: ${ORIGIN_FRAGMENTS[origin].test(message)}`).toBe(
			`${origin}: ${origin === expected}`,
		);
	}
}

describe('#3616 item 15: class-accurate dynamic-target deny reasons', () => {
	const ROWS: Array<[Origin, string, ((ws: string) => void)?]> = [
		['tilde', 'rm ~/x'],
		['loop-landing', 'cd src && for i in 1 2; do echo x > f; cd ..; done'],
		['wrapper-chdir', 'sudo -D /nonexistent-xyz -e src/a'],
		['directory-withdrawal', 'popd; echo x > src/f'],
		['dynamic-text', 'rm $FOO'],
		[
			'unverifiable-path',
			'rm ca/../src/x.txt',
			(ws) => {
				linkDir(path.join(ws, 'cb'), path.join(ws, 'ca'));
				linkDir(path.join(ws, 'ca'), path.join(ws, 'cb'));
			},
		],
	];
	for (const [origin, command, prep] of ROWS) {
		test(
			`${origin}: own fragment present, every other origin absent`,
			async () => {
				const r = await gate(command, { prep });
				expect(r.verdict).toBe('BLOCKED');
				expect(r.message).toMatch(/dynamic path target/);
				expectOrigin(r.message, origin);
			},
			T,
		);
	}
});

describe('#3616 item 2: explain without --scope', () => {
	test(
		'renders block with scope_unevaluated, never an unqualified allow',
		async () => {
			const g = await gate('rmdir src/{a,../esc}');
			expect(g.verdict).toBe('BLOCKED');
			const ws = makeWorkspace();
			try {
				const out = await handleGuardrailExplain(ws, [
					'--agent',
					'coder',
					'rmdir',
					'src/{a,../esc}',
				]);
				expect(out).not.toMatch(/allow: no (destructive|scope)? ?rule matched/);
				expect(out).toMatch(/\| Decision \| block \|/);
				expect(out).toContain('scope_unevaluated');
			} finally {
				teardown(ws);
			}
		},
		T,
	);
});

describe('#3616 item 10: destructive arm disabled still judges rm operands', () => {
	const OFF = { blockDestructive: false } as const;
	for (const [label, command, fragment] of [
		['out-of-scope', 'rm -rf ../outside', 'path=../outside'],
		['quoted flag', 'rm "-rf" ../outside', 'path=../outside'],
		['.git', 'rm -rf .git', 'AUTHORITY_PROTECTED_PATH'],
		['filesystem root', 'rm -rf /', 'AUTHORITY_ROOT_ESCAPE'],
	] as const) {
		test(
			`${label}: denied by the scope/authority layer`,
			async () => {
				const r = await gate(command, OFF);
				expect(r.verdict).toBe('BLOCKED');
				expect(r.message).toContain(fragment);
				expect(r.message).toMatch(/not authorised/);
				expect(r.message).not.toMatch(/Recursive delete target|allowlisted/);
			},
			T,
		);
	}

	test(
		'cwd-discriminated landing: cd tests && rm -rf src/f is out of scope',
		async () => {
			const r = await gate('cd tests && rm -rf src/f', {
				...OFF,
				prep: (ws) => {
					mkdirSync(path.join(ws, 'tests', 'src'));
					writeFileSync(path.join(ws, 'tests', 'src', 'f'), 'f');
				},
			});
			expect(r.verdict).toBe('BLOCKED');
			expect(r.message).toContain('SCOPE_VIOLATION');
			expect(r.message).toMatch(/tests[\\/]src[\\/]f/);
		},
		T,
	);

	test(
		'control: in-scope rm -rf src/tmp stays admitted',
		async () => {
			const r = await gate('rm -rf src/tmp', OFF);
			expect(r.verdict).toBe('ADMITTED');
		},
		T,
	);
});

describe('#3606: file-authority ancestor denial arms', () => {
	// Synthetic PROFILE-SHAPED paths: the seam answers every lstat, so nothing
	// is touched on disk. redactPath folds lexical profile shapes
	// (/home/<name>, /Users/<name>, C:\Users\<name>), so the fixture uses one
	// on every platform instead of os.homedir() — a root-run runner's
	// /root is not a profile shape and would not (and should not) redact.
	const home =
		process.platform === 'win32'
			? 'C:\\Users\\sw3606user'
			: process.platform === 'darwin'
				? '/Users/sw3606user'
				: '/home/sw3606user';
	const syntheticCwd = path.join(home, 'sw3606-synthetic');
	const injectEacces = (): { calls: number } => {
		const counter = { calls: 0 };
		_internals.lstatSync = ((p: unknown) => {
			counter.calls += 1;
			throw Object.assign(
				new Error(
					`EACCES: permission denied, lstat '${String(p)}' ${home} ${'x'.repeat(400)}`,
				),
				{ code: 'EACCES' },
			);
		}) as typeof _internals.lstatSync;
		return counter;
	};

	test(
		'lstat-failure arm: home-redacted, error CODE only (no raw error text)',
		() => {
			const counter = injectEacces();
			const reason = checkWriteTargetForSymlink(
				path.join(syntheticCwd, 'sub', 'f.txt'),
				syntheticCwd,
			);
			expect(counter.calls).toBeGreaterThan(0);
			expect(reason).not.toBeNull();
			const msg = reason ?? '';
			expect(msg).toContain('lstat failed');
			expect(msg).toContain(': EACCES');
			expect(msg).toContain('sw3606-synthetic');
			expect(msg.includes(home)).toBe(false);
			expect(msg).not.toMatch(/x{6}/);
			expect(msg).not.toContain('permission denied');
			expect(msg.length).toBeLessThanOrEqual(320);
		},
		T,
	);

	test(
		'lstat-failure arm: an over-length ancestor keeps the whole message <= 320',
		() => {
			injectEacces();
			const reason = checkWriteTargetForSymlink(
				path.join(syntheticCwd, 'a'.repeat(150), 'b'.repeat(150), 'f.txt'),
				syntheticCwd,
			);
			expect(reason).not.toBeNull();
			const msg = reason ?? '';
			expect(msg).toContain('lstat failed');
			expect(msg.length).toBeLessThanOrEqual(320);
			expect(msg.includes(home)).toBe(false);
			expect(msg).not.toMatch(/x{6}/);
		},
		T,
	);

	test(
		'lstat seam ENOENT is skipped (not yet created), so no denial',
		() => {
			_internals.lstatSync = (() => {
				throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
			}) as typeof _internals.lstatSync;
			expect(
				checkWriteTargetForSymlink(
					path.join(syntheticCwd, 'a', 'f'),
					syntheticCwd,
				),
			).toBeNull();
		},
		T,
	);

	test(
		'symlink/junction arm: class text kept, home-redacted, bounded',
		() => {
			const ws = makeWorkspace((w) => {
				mkdirSync(path.join(w, 'realdir'));
				linkDir(path.join(w, 'realdir'), path.join(w, 'jlink'));
			});
			try {
				const reason = checkWriteTargetForSymlink(
					path.join(ws, 'jlink', 'f.txt'),
					ws,
				);
				expect(reason).not.toBeNull();
				const msg = reason ?? '';
				expect(msg).toContain('symlink/junction');
				expect(msg).toContain('jlink');
				expect(msg.length).toBeLessThanOrEqual(320);
				expect(msg.includes(os.homedir())).toBe(false);
			} finally {
				teardown(ws);
			}
		},
		T,
	);
});
