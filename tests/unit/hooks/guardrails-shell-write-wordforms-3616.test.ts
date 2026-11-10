/**
 * #3616 word / directory-form family (items 3, 4, 8, 9, 16) — tracked port of
 * the frozen acceptance checks `checks-option-abbrev-3616.ts` and
 * `checks-wordforms-3616.ts`, plus new link-resolution legs (two-hop chain,
 * link cycle, POSIX real-symlink twin). Every gate leg drives the REAL gate
 * through `_shell-write-3616-fixtures.ts` (coder role, scope `src/`).
 *
 * Legs:
 * 1. GNU rm long-option abbreviations (`--r/--re/--rec/--recurs`,
 *    `--f/--fo/--forc`) gate exactly like the full spelling; the ambiguous
 *    `--v` prefix and `--verbose` stay non-recursive (admitted controls);
 *    scope_validate and explain agree on the abbreviated form.
 * 2. Word-position `$(...)` writes (for-list, suffix, assignment prefix, case
 *    subject, nested) are evaluated, at the CURRENT walk cwd.
 * 3. `pushd .` pushes a duplicate entry exactly as bash.
 * 4. A `..` after a directory link resolves through the REAL link target
 *    (single link, intermediate link, two-hop chain); a link cycle fails
 *    closed with the filesystem-verification reason; in-scope controls admit.
 * 5. #3616 item 16 is NOT delivered (owner decision): the shipped
 *    post-loop-exempt over-deny is pinned (all BLOCKED).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, symlinkSync } from 'node:fs';
import * as path from 'node:path';
import { handleGuardrailExplain } from '../../../src/services/guardrail-explain-service';
import { resetSwarmState } from '../../../src/state';
import { evaluateScopeValidate } from '../../../src/tools/scope-validate';
import {
	gate,
	linkDir,
	makeWorkspace,
	outsideRoot,
	teardown,
} from './_shell-write-3616-fixtures';

const T = 60_000;
const RECURSIVE_DENY = /Recursive delete target "src" is not an allowlisted/;
const AUTHORITY_DENY = /AUTHORITY_ROOT_ESCAPE/;
const UNVERIFIABLE = 'could not be verified on the filesystem';

afterEach(() => {
	resetSwarmState();
});

describe('#3616 item 3: GNU rm long-option abbreviations', () => {
	for (const spelling of [
		'--r',
		'--re',
		'--rec',
		'--recurs',
		'--recursive',
		'--f',
		'--fo',
		'--forc',
		'--force',
	]) {
		test(
			`rm ${spelling} src denies like the full spelling`,
			async () => {
				const r = await gate(`rm ${spelling} src`);
				expect(r.verdict).toBe('BLOCKED');
				expect(r.message).toMatch(RECURSIVE_DENY);
			},
			T,
		);
	}

	test(
		'control: ambiguous --v prefix is not treated as recursive',
		async () => {
			const r = await gate('rm --v src');
			expect(r.verdict).toBe('ADMITTED');
		},
		T,
	);

	for (const command of ['rm --verbose src/x.txt', 'rm src/x.txt']) {
		test(
			`control: non-recursive in-scope delete admitted: ${command}`,
			async () => {
				const r = await gate(command);
				expect(r.verdict).toBe('ADMITTED');
			},
			T,
		);
	}

	test(
		'scope_validate fails DESTRUCTIVE_COMMAND for abbreviated and full spellings',
		() => {
			const ws = makeWorkspace();
			try {
				for (const command of [
					'rm --r src',
					'rm --rec src',
					'rm --recursive src',
				]) {
					let code = 'ALLOWED';
					try {
						evaluateScopeValidate(
							{ command, shell: 'posix', scope_files: ['src/'] },
							ws,
						);
					} catch (err) {
						code = (err as { code?: string }).code ?? 'NO_CODE';
					}
					expect(`${command}: ${code}`).toBe(`${command}: DESTRUCTIVE_COMMAND`);
				}
			} finally {
				teardown(ws);
			}
		},
		T,
	);

	test(
		'explain renders block for rm --rec src',
		async () => {
			const ws = makeWorkspace();
			try {
				const out = await handleGuardrailExplain(ws, [
					'--agent',
					'coder',
					'--scope',
					'src/',
					'rm',
					'--rec',
					'src',
				]);
				expect(out).toMatch(/\| Decision \| block \|/);
				expect(out).toContain('DESTRUCTIVE_TARGET_NOT_SAFE_ARTIFACT');
			} finally {
				teardown(ws);
			}
		},
		T,
	);
});

describe('#3616 item 4: word-position $(...) writes', () => {
	for (const [label, command] of [
		['for-list', 'for i in $(echo x > ../esc); do :; done'],
		['suffix word', 'echo $(echo x > ../esc)'],
		['assignment prefix', 'X=$(echo x > ../esc) true'],
		['case subject', 'case $(echo x > ../esc) in *) esac'],
	] as const) {
		test(
			`${label}: inner escape write denied at its real landing`,
			async () => {
				const r = await gate(command);
				expect(r.verdict).toBe('BLOCKED');
				expect(r.message).toMatch(AUTHORITY_DENY);
				expect(r.message).toContain('path=../esc');
			},
			T,
		);
	}

	test(
		'nested $(...) escape write is denied',
		async () => {
			const r = await gate('echo $(echo $(echo x > ../esc))');
			expect(r.verdict).toBe('BLOCKED');
			// Nested bodies past the parse fail closed (or resolve to ../esc).
			expect(r.message).toMatch(
				/failed to parse command|AUTHORITY_ROOT_ESCAPE/,
			);
		},
		T,
	);

	test(
		'inner write resolves at the current walk cwd (tests/src/f is out of scope)',
		async () => {
			const r = await gate('cd tests && echo $(echo x > src/f)', {
				prep: (ws) => mkdirSync(path.join(ws, 'tests', 'src')),
			});
			expect(r.verdict).toBe('BLOCKED');
			expect(r.message).toContain('SCOPE_VIOLATION');
			expect(r.message).toMatch(/tests[\\/]src[\\/]f/);
		},
		T,
	);

	test(
		'control: in-scope $(...) write stays admitted',
		async () => {
			const r = await gate('echo $(echo x > src/f)');
			expect(r.verdict).toBe('ADMITTED');
		},
		T,
	);
});

describe('#3616 item 8: pushd . duplicates the stack entry', () => {
	test(
		'pushd src && pushd . && popd keeps cwd at src (admitted)',
		async () => {
			const r = await gate('pushd src && pushd . && popd && echo x > f');
			expect(r.verdict).toBe('ADMITTED');
		},
		T,
	);

	test(
		'pushd ../tests && pushd . && popd denies with a scope-class reason',
		async () => {
			const r = await gate('pushd ../tests && pushd . && popd && echo x > f');
			expect(r.verdict).toBe('BLOCKED');
			expect(r.message).toContain('SCOPE_VIOLATION');
			expect(r.message).not.toMatch(/dynamic path target/);
		},
		T,
	);
});

/** `<ws>/link` -> `<outside>` with `<outside>/src` and `<outside>/sub`. */
const singleLink = (ws: string): void => {
	const outside = outsideRoot(ws);
	mkdirSync(path.join(outside, 'src'), { recursive: true });
	mkdirSync(path.join(outside, 'sub'), { recursive: true });
	linkDir(outside, path.join(ws, 'link'));
};

/** `<ws>/jlink1` -> `<ws>/jlink2` -> `<outside>/deep`. */
const twoHopChain = (ws: string): void => {
	const outside = outsideRoot(ws);
	mkdirSync(path.join(outside, 'deep'), { recursive: true });
	linkDir(path.join(outside, 'deep'), path.join(ws, 'jlink2'));
	linkDir(path.join(ws, 'jlink2'), path.join(ws, 'jlink1'));
};

/** `<ws>/ca` -> `<ws>/cb` -> `<ws>/ca`. */
const linkCycle = (ws: string): void => {
	linkDir(path.join(ws, 'cb'), path.join(ws, 'ca'));
	linkDir(path.join(ws, 'ca'), path.join(ws, 'cb'));
};

describe('#3616 item 9: .. after a directory link resolves through the link', () => {
	for (const [route, command, landing] of [
		['rm', 'rm link/../src/x.txt', 'path=../src/x.txt'],
		['redirect', 'echo x > link/../src/f', 'path=../src/f'],
		['cp destination', 'cp src/x.txt link/../src/f', 'path=../src/f'],
	] as const) {
		test(
			`${route}: link/.. lands beside the outside tree (denied)`,
			async () => {
				const r = await gate(command, { prep: singleLink });
				expect(r.verdict).toBe('BLOCKED');
				expect(r.message).toMatch(AUTHORITY_DENY);
				expect(r.message).toContain(landing);
			},
			T,
		);
	}

	test(
		'intermediate link: link/sub/../src/f is denied at the outside landing',
		async () => {
			const r = await gate('echo x > link/sub/../src/f', { prep: singleLink });
			expect(r.verdict).toBe('BLOCKED');
			expect(r.message).toContain(`${path.basename(r.ws)}-outside`);
		},
		T,
	);

	for (const command of [
		'rm jlink1/../src/x.txt',
		'echo x > jlink1/../src/f',
	]) {
		test(
			`two-hop chain: ${command} names the real landing under <outside>`,
			async () => {
				const r = await gate(command, { prep: twoHopChain });
				expect(r.verdict).toBe('BLOCKED');
				expect(r.message).toMatch(AUTHORITY_DENY);
				expect(r.message).toContain(`${path.basename(r.ws)}-outside`);
			},
			T,
		);
	}

	for (const command of ['rm ca/../src/x.txt', 'echo x > ca/../src/f']) {
		test(
			`link cycle fails closed: ${command}`,
			async () => {
				const r = await gate(command, { prep: linkCycle });
				expect(r.verdict).toBe('BLOCKED');
				expect(r.message).toContain(UNVERIFIABLE);
				expect(r.message).not.toMatch(/shell variable or command substitution/);
			},
			T,
		);
	}

	test(
		'control: in-scope link target stays admitted',
		async () => {
			const r = await gate('echo x > inlink/../src/f', {
				prep: (ws) => linkDir(path.join(ws, 'src'), path.join(ws, 'inlink')),
			});
			expect(r.verdict).toBe('ADMITTED');
		},
		T,
	);

	test(
		'control: plain src/../src/f is judged lexically (admitted)',
		async () => {
			const r = await gate('echo x > src/../src/f', { prep: twoHopChain });
			expect(r.verdict).toBe('ADMITTED');
		},
		T,
	);

	test.skipIf(process.platform === 'win32')(
		'POSIX real symlink twin: rm slink/../src/x.txt denied',
		async () => {
			const r = await gate('rm slink/../src/x.txt', {
				prep: (ws) => {
					const outside = outsideRoot(ws);
					mkdirSync(path.join(outside, 'src'), { recursive: true });
					symlinkSync(outside, path.join(ws, 'slink'));
				},
			});
			expect(r.verdict).toBe('BLOCKED');
			expect(r.message).toMatch(AUTHORITY_DENY);
			expect(r.message).toContain('path=../src/x.txt');
		},
		T,
	);

	test.skipIf(process.platform === 'win32')(
		'POSIX RELATIVE-target symlink: rm rlink/../src/x.txt resolves against the link directory',
		async () => {
			// rlink -> ../<ws>-outside/deep (a relative target): the walk must
			// re-walk the target's own components from the LINK's directory,
			// so `..` lands in <ws>-outside, not back inside the workspace.
			const r = await gate('rm rlink/../src/x.txt', {
				prep: (ws) => {
					const outside = outsideRoot(ws);
					mkdirSync(path.join(outside, 'deep'), { recursive: true });
					mkdirSync(path.join(outside, 'src'), { recursive: true });
					symlinkSync(
						path.join('..', path.basename(outside), 'deep'),
						path.join(ws, 'rlink'),
					);
				},
			});
			expect(r.verdict).toBe('BLOCKED');
			expect(r.message).toMatch(AUTHORITY_DENY);
			expect(r.message).toContain('-outside');
		},
		T,
	);
});

describe('#3616 item 16 (not delivered): shipped post-exempt over-deny pinned', () => {
	for (const [label, command] of [
		[
			'post-exempt sibling',
			'cd src && for i in x; do echo x > f; cd ..; done && echo y > src/g',
		],
		[
			'non-exempt dynamic twin',
			'cd src && for i in $(echo x); do echo x > f; cd ..; done && echo y > src/g',
		],
		[
			'break before cd',
			'cd src && for i in x; do break; cd ..; done && echo y > src/g',
		],
		[
			'shadowed builtin',
			'echo() { break; }; cd src && for i in x; do echo; cd ..; done && printf y > src/g',
		],
		[
			'function-indirect break',
			'brk() { break; }; cd src && for i in x; do cd ..; brk; done && echo y > src/g',
		],
	] as const) {
		test(
			`${label} stays denied`,
			async () => {
				const r = await gate(command);
				expect(r.verdict).toBe('BLOCKED');
				expect(r.message).toMatch(/directory context|loop landing/);
			},
			T,
		);
	}
});
