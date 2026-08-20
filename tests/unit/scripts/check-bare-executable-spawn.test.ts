/**
 * Issue #2236 (F8b) — tests for scripts/check-bare-executable-spawn.ts.
 *
 * Tier 0 (fixture-string) tests drive `scanSourceForBareSpawn` directly, so
 * these are deterministic regardless of the sibling lanes' refactor
 * progress — they never read `src/`. Filesystem-backed tests (allowlist,
 * `.test.ts` skip, `_internals` wiring, `main()` exit codes) use a fixture
 * tree under a canonical temp directory, never the live repo tree.
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	collectBareSpawnErrors,
	FLAGGED_EXECUTABLES,
	main,
	RESOLVER_ALLOWLIST,
	SPAWN_FAMILY,
	scanSourceForBareSpawn,
} from '../../../scripts/check-bare-executable-spawn';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

describe('check-bare-executable-spawn — constants', () => {
	test('SPAWN_FAMILY matches the critic-approved callee set', () => {
		expect([...SPAWN_FAMILY].sort()).toEqual(
			[
				'spawnSync',
				'spawn',
				'execFile',
				'execFileSync',
				'exec',
				'bunSpawn',
				'runExternalTool',
			].sort(),
		);
	});

	test('FLAGGED_EXECUTABLES matches the critic-approved binary set', () => {
		expect([...FLAGGED_EXECUTABLES].sort()).toEqual(
			['git', 'gh', 'sandbox-exec', 'bwrap'].sort(),
		);
	});

	test('RESOLVER_ALLOWLIST names exactly the sibling-lane resolver module', () => {
		expect(RESOLVER_ALLOWLIST).toEqual(['src/utils/git-executable.ts']);
	});
});

describe('scanSourceForBareSpawn — form 1: first positional argument', () => {
	test('spawnSync("git", args, opts) is flagged', () => {
		const v = scanSourceForBareSpawn(
			'x.ts',
			"spawnSync('git', ['status'], {});",
		);
		expect(v).toHaveLength(1);
		expect(v[0]).toMatchObject({ form: 'first-arg', executable: 'git' });
	});

	test('a property-access callee (e.g. _internals.spawnSync) is still matched by its final name', () => {
		const v = scanSourceForBareSpawn(
			'x.ts',
			"const r = _internals.spawnSync('gh', args, {});",
		);
		expect(v).toHaveLength(1);
		expect(v[0]?.executable).toBe('gh');
	});

	test('child_process.execFileSync("git", ...) is flagged', () => {
		const v = scanSourceForBareSpawn(
			'x.ts',
			"child_process.execFileSync('git', args);",
		);
		expect(v).toHaveLength(1);
	});

	test('a non-listed binary (e.g. "ls") is NOT flagged', () => {
		const v = scanSourceForBareSpawn('x.ts', "spawnSync('ls', ['-la'], {});");
		expect(v).toHaveLength(0);
	});

	test('a callee not in SPAWN_FAMILY with a bare-git first arg is NOT flagged by form 1/2', () => {
		const v = scanSourceForBareSpawn('x.ts', "notASpawnFn('git', ['x']);");
		expect(v).toHaveLength(0);
	});

	test('a variable (not a string literal) first arg is NOT flagged', () => {
		const v = scanSourceForBareSpawn('x.ts', 'spawnSync(cmd, args, {});');
		expect(v).toHaveLength(0);
	});
});

describe('scanSourceForBareSpawn — form 2: first element of a first-argument array literal', () => {
	test('bunSpawn(["git", ...args], opts) is flagged', () => {
		const v = scanSourceForBareSpawn(
			'x.ts',
			"bunSpawn(['git', '-C', dir, ...args], options);",
		);
		expect(v).toHaveLength(1);
		expect(v[0]).toMatchObject({
			form: 'array-first-element',
			executable: 'git',
		});
	});

	test('the SECOND element being a flagged binary does not trigger form 2', () => {
		const v = scanSourceForBareSpawn(
			'x.ts',
			"bunSpawn(['echo', 'git'], options);",
		);
		expect(v).toHaveLength(0);
	});

	test('an array literal whose first element is not a listed binary is NOT flagged', () => {
		const v = scanSourceForBareSpawn('x.ts', "bunSpawn(['ls', '-la'], {});");
		expect(v).toHaveLength(0);
	});
});

describe('scanSourceForBareSpawn — form 3: "executable:" property (callee-independent)', () => {
	test('runExternalTool({ executable: "git", ... }) is flagged', () => {
		const v = scanSourceForBareSpawn(
			'x.ts',
			"await runExternalTool({ executable: 'git', args, cwd });",
		);
		expect(v).toHaveLength(1);
		expect(v[0]).toMatchObject({
			form: 'executable-property',
			executable: 'git',
		});
	});

	/**
	 * The deviation documented at the top of the script: `src/mutation/
	 * engine.ts:304`/`:387` call a local `runner` variable, not a literal
	 * `runExternalTool`/spawn-family name. Form 3 must catch this — it is one
	 * of the plan's six mandatory sites.
	 */
	test('a NON-spawn-family callee (e.g. a local "runner" variable) is still flagged via the executable: property', () => {
		const v = scanSourceForBareSpawn(
			'x.ts',
			"const r = await runner({ executable: 'git', args: ['apply', patchFile], cwd });",
		);
		expect(v).toHaveLength(1);
		expect(v[0]).toMatchObject({
			form: 'executable-property',
			executable: 'git',
		});
	});

	test('executable: "gh" is flagged', () => {
		const v = scanSourceForBareSpawn(
			'x.ts',
			"await runExternalTool({ executable: 'gh', args });",
		);
		expect(v).toHaveLength(1);
	});

	test('executable: "bun" (not in the flagged set) is NOT flagged', () => {
		const v = scanSourceForBareSpawn(
			'x.ts',
			"await runExternalTool({ executable: 'bun', args });",
		);
		expect(v).toHaveLength(0);
	});

	test('a non-literal executable (variable) is NOT flagged', () => {
		const v = scanSourceForBareSpawn(
			'x.ts',
			'await runExternalTool({ executable, args });',
		);
		expect(v).toHaveLength(0);
	});

	test('executable used as a variable name, not a property, is NOT flagged', () => {
		const v = scanSourceForBareSpawn(
			'x.ts',
			"const executable = 'git'; doSomethingElse(executable);",
		);
		expect(v).toHaveLength(0);
	});
});

describe('scanSourceForBareSpawn — MUST NOT FLAG: sameStringArray structural exclusion', () => {
	test("sameStringArray(check.command, ['git', 'diff', '--check']) is not a spawn and is not flagged", () => {
		// Fixture text mirroring src/hooks/pr-workflow-gate.ts:3358 exactly.
		// Deliberately a FIXTURE STRING, not a live-tree read: sibling lanes are
		// actively editing src/, so pinning this assertion to a live line number
		// would rot mid-refactor.
		const v = scanSourceForBareSpawn(
			'x.ts',
			"sameStringArray(check.command, ['git', 'diff', '--check']);",
		);
		expect(v).toHaveLength(0);
	});
});

describe('scanSourceForBareSpawn — multi-line call expressions', () => {
	test('a multi-line spawnSync call is flagged with the correct line number', () => {
		const source = [
			'const result = _internals.spawnSync(',
			"\t'git',",
			'\thardenedArgs,',
			'\t{',
			'\t\tcwd: directory,',
			'\t},',
			');',
		].join('\n');
		const v = scanSourceForBareSpawn('x.ts', source);
		expect(v).toHaveLength(1);
		expect(v[0]).toMatchObject({
			form: 'first-arg',
			executable: 'git',
			line: 2,
		});
	});

	test('a multi-line runner({ executable: ... }) call is flagged with the correct line number', () => {
		const source = [
			'const applyResult = await runner({',
			"\texecutable: 'git',",
			"\targs: ['apply', '--', patchFile],",
			'\tcwd: workingDir,',
			'\ttimeoutMs: GIT_APPLY_TIMEOUT_MS,',
			'});',
		].join('\n');
		const v = scanSourceForBareSpawn('x.ts', source);
		expect(v).toHaveLength(1);
		expect(v[0]).toMatchObject({
			form: 'executable-property',
			executable: 'git',
			line: 2,
		});
	});

	test('a multi-line bunSpawn array-literal call is flagged', () => {
		const source = [
			'proc = _internals.bunSpawn(',
			'\t[',
			"\t\t'git',",
			"\t\t'-C',",
			'\t\tdirectory,',
			'\t\t...args,',
			'\t],',
			'\toptions,',
			');',
		].join('\n');
		const v = scanSourceForBareSpawn('x.ts', source);
		expect(v).toHaveLength(1);
		expect(v[0]?.form).toBe('array-first-element');
	});

	test('a type-position lookalike ("spawnSync: (args...) => ...") is NOT a call and is not flagged', () => {
		const source = [
			'interface Seam {',
			'\tspawnSync: (',
			"\t\tcmd: 'git',",
			'\t\targs: string[],',
			'\t\topts: object,',
			'\t) => Result;',
			'}',
		].join('\n');
		const v = scanSourceForBareSpawn('x.ts', source);
		expect(v).toHaveLength(0);
	});
});

function writeFixtureTree(root: string, files: Record<string, string>): void {
	for (const [rel, content] of Object.entries(files)) {
		const abs = path.join(root, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, content);
	}
}

describe('collectBareSpawnErrors — filesystem-backed', () => {
	test('.test.ts files are skipped entirely', () => {
		const tmpDir = canonicalMkdtemp('bare-spawn-testskip-');
		try {
			writeFixtureTree(tmpDir, {
				'src/foo.test.ts': "spawnSync('git', [], {});",
			});
			const result = collectBareSpawnErrors(tmpDir);
			expect(result.errors).toHaveLength(0);
			expect(result.scannedFiles).toBe(0);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test('the resolver allowlist module is skipped; a sibling file with the same pattern is flagged', () => {
		const tmpDir = canonicalMkdtemp('bare-spawn-allowlist-');
		try {
			writeFixtureTree(tmpDir, {
				[RESOLVER_ALLOWLIST[0] as string]: "spawnSync('git', [], {});",
				'src/other.ts': "spawnSync('git', [], {});",
			});
			const result = collectBareSpawnErrors(tmpDir);
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]).toContain('src/other.ts');
			expect(result.skippedAllowlisted).toBe(1);
			// scannedFiles counts non-allowlisted, non-test files only.
			expect(result.scannedFiles).toBe(1);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test('a clean tree produces zero errors', () => {
		const tmpDir = canonicalMkdtemp('bare-spawn-clean-');
		try {
			writeFixtureTree(tmpDir, {
				'src/clean.ts': "spawnSync('ls', [], {});",
			});
			const result = collectBareSpawnErrors(tmpDir);
			expect(result.errors).toHaveLength(0);
			expect(result.scannedFiles).toBe(1);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test('_internals.scanSourceForBareSpawn is invoked once per scanned (non-test, non-allowlisted) file — FB-011-style loop-wiring proof', () => {
		const tmpDir = canonicalMkdtemp('bare-spawn-seam-');
		const original = _internals.scanSourceForBareSpawn;
		const calls: string[] = [];
		try {
			writeFixtureTree(tmpDir, {
				'src/a.ts': "spawnSync('ls', [], {});",
				'src/b.ts': "spawnSync('ls', [], {});",
				'src/b.test.ts': "spawnSync('git', [], {});",
				[RESOLVER_ALLOWLIST[0] as string]: "spawnSync('git', [], {});",
			});
			_internals.scanSourceForBareSpawn = (relPath, source) => {
				calls.push(relPath);
				return original(relPath, source);
			};
			const result = collectBareSpawnErrors(tmpDir);
			expect(calls.sort()).toEqual(['src/a.ts', 'src/b.ts']);
			expect(result.errors).toHaveLength(0);
		} finally {
			_internals.scanSourceForBareSpawn = original;
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

describe('main() — CLI wiring and exit codes', () => {
	test('a violating tree: main() returns 1 and logs the violation', () => {
		const tmpDir = canonicalMkdtemp('bare-spawn-main-fail-');
		const logged: string[] = [];
		const realError = console.error;
		const realLog = console.log;
		console.error = (line: string) => {
			logged.push(line);
		};
		console.log = (line: string) => {
			logged.push(line);
		};
		try {
			writeFixtureTree(tmpDir, {
				'src/bad.ts': "await runExternalTool({ executable: 'git', args });",
			});
			const exitCode = main(tmpDir);
			expect(exitCode).toBe(1);
			expect(logged.join('\n')).toInclude('src/bad.ts');
			expect(logged.join('\n')).toInclude('Bare-executable-spawn check FAILED');
		} finally {
			console.error = realError;
			console.log = realLog;
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test('a clean tree: main() returns 0', () => {
		const tmpDir = canonicalMkdtemp('bare-spawn-main-pass-');
		const realLog = console.log;
		console.log = () => {};
		try {
			writeFixtureTree(tmpDir, { 'src/ok.ts': "spawnSync('ls', [], {});" });
			expect(main(tmpDir)).toBe(0);
		} finally {
			console.log = realLog;
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
