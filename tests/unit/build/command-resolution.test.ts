import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	resolveLocalCommand,
	resolveLocalNodeTool,
	tokenizeCommand,
} from '../../../src/build/command-resolution';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const GENERATED_COMMAND_SOURCES = [
	'src/lang/profiles.ts',
	'src/lang/default-backend.ts',
	'src/hooks/incremental-verify.ts',
	'src/tools/test-runner.ts',
];

describe('local-only command resolution (#2303)', () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0))
			fs.rmSync(dir, { recursive: true, force: true });
	});

	function fixture(platform: NodeJS.Platform, tool = 'tsc') {
		const dir = canonicalMkdtemp('resolver space 2303-');
		dirs.push(dir);
		const binDir = path.join(dir, 'node_modules', '.bin');
		fs.mkdirSync(binDir, { recursive: true });
		const executable = platform === 'win32' ? `${tool}.cmd` : tool;
		fs.writeFileSync(path.join(binDir, executable), '');
		return { dir, executable };
	}

	function fixtureWithExecutables(executables: string[]) {
		const dir = canonicalMkdtemp('resolver space 2303-');
		dirs.push(dir);
		const binDir = path.join(dir, 'node_modules', '.bin');
		fs.mkdirSync(binDir, { recursive: true });
		for (const executable of executables) {
			fs.writeFileSync(path.join(binDir, executable), '');
		}
		return { dir };
	}

	test('rejects implicit-download wrappers', () => {
		expect(resolveLocalCommand('npx tsc --noEmit', '.', () => true)).toBeNull();
	});

	test('emits a cwd-relative POSIX shell command and absolute argv', () => {
		const { dir } = fixture('linux');
		const result = resolveLocalCommand(
			'tsc --noEmit',
			dir,
			(binary) => binary === 'node',
			'linux',
		);
		expect(result).toEqual({
			argv: [path.join(dir, 'node_modules', '.bin', 'tsc'), '--noEmit'],
			shellCommand: './node_modules/.bin/tsc --noEmit',
		});
	});

	test('prefers the repository-local binary over a global installation', () => {
		const { dir } = fixture('linux');
		const result = resolveLocalCommand(
			'tsc --noEmit',
			dir,
			(binary) => binary === 'node' || binary === 'tsc',
			'linux',
		);

		expect(result?.argv[0]).toBe(path.join(dir, 'node_modules', '.bin', 'tsc'));
		expect(result?.shellCommand).toBe('./node_modules/.bin/tsc --noEmit');
	});

	test('emits the Windows cmd shim without embedding the absolute cwd', () => {
		const { dir } = fixture('win32');
		const result = resolveLocalCommand(
			'tsc --noEmit',
			dir,
			(binary) => binary === 'node',
			'win32',
		);
		expect(result?.shellCommand).toBe('node_modules\\.bin\\tsc.cmd --noEmit');
		expect(result?.shellCommand).not.toContain(dir);
	});

	test('FB-001 prefers a local Windows PowerShell shim over a PATH binary when no .cmd shim exists', () => {
		// Previous code only probed `<tool>.cmd`, so a repo-local `.ps1` shim was
		// ignored and the resolver fell through to the global PATH binary.
		const { dir } = fixtureWithExecutables(['tsc.ps1']);
		const result = resolveLocalCommand(
			'tsc --noEmit',
			dir,
			(binary) => binary === 'node' || binary === 'tsc',
			'win32',
		);

		expect(result).toEqual({
			argv: [path.join(dir, 'node_modules', '.bin', 'tsc.ps1'), '--noEmit'],
			shellCommand: 'node_modules\\.bin\\tsc.ps1 --noEmit',
		});
	});

	test('FB-001 returns null instead of preferring a global PATH binary over a local Windows shim', () => {
		// Previous code would skip the local shim when `.cmd` was absent and then
		// accept a global PATH binary, bypassing the repository-local version.
		const { dir } = fixtureWithExecutables(['tsc.ps1']);
		const result = resolveLocalCommand(
			'tsc --noEmit',
			dir,
			(binary) => binary === 'tsc',
			'win32',
		);

		expect(result).toBeNull();
	});

	test('FB-001 keeps scanning Windows local candidates when a .cmd shim needs node but a later .exe does not', () => {
		// Previous code treated the first local hit as authoritative, so a
		// non-runnable `.cmd` shim prevented a usable repo-local `.exe` from winning.
		const { dir } = fixtureWithExecutables(['tsc.cmd', 'tsc.exe']);
		const result = resolveLocalCommand(
			'tsc --noEmit',
			dir,
			(binary) => binary === 'tsc',
			'win32',
		);

		expect(result).toEqual({
			argv: [path.join(dir, 'node_modules', '.bin', 'tsc.exe'), '--noEmit'],
			shellCommand: 'node_modules\\.bin\\tsc.exe --noEmit',
		});
	});

	test('FB-001 resolves Windows local shims beyond .cmd for node tool execution', () => {
		// Previous code hard-coded `<tool>.cmd`, so `.exe`, `.bat`, `.ps1`, and
		// extensionless local shims were invisible to the test runner/backend path.
		const { dir } = fixtureWithExecutables([
			'vitest.exe',
			'jest.bat',
			'mocha.ps1',
			'eslint',
		]);

		const isAvailable = (binary: string) =>
			['node', 'vitest', 'jest', 'mocha', 'eslint'].includes(binary);

		expect(
			resolveLocalNodeTool('vitest', ['run'], dir, 'win32', isAvailable),
		).toEqual([path.join(dir, 'node_modules', '.bin', 'vitest.exe'), 'run']);
		expect(
			resolveLocalNodeTool('jest', ['--json'], dir, 'win32', isAvailable),
		).toEqual([path.join(dir, 'node_modules', '.bin', 'jest.bat'), '--json']);
		expect(
			resolveLocalNodeTool('mocha', [], dir, 'win32', isAvailable),
		).toEqual([path.join(dir, 'node_modules', '.bin', 'mocha.ps1')]);
		expect(
			resolveLocalNodeTool('eslint', ['.'], dir, 'win32', isAvailable),
		).toEqual([path.join(dir, 'node_modules', '.bin', 'eslint'), '.']);
	});

	test('FB-001 falls back to PATH for node tools only when the caller explicitly allows it', () => {
		// Previous code had no PATH fallback at all for the node-tool helper, so
		// default-backend/test-runner callers could not honor existing PATH tools.
		const dir = canonicalMkdtemp('resolver-2303-');
		dirs.push(dir);
		const isAvailable = (binary: string) => binary === 'vitest';

		expect(resolveLocalNodeTool('vitest', ['run'], dir, 'win32')).toBeNull();
		expect(
			resolveLocalNodeTool('vitest', ['run'], dir, 'win32', isAvailable),
		).toEqual(['vitest', 'run']);
	});

	test('FB-001 still prefers a repository-local executable over an allowed PATH fallback', () => {
		const { dir } = fixtureWithExecutables(['vitest.exe']);
		const isAvailable = (binary: string) => binary === 'vitest';

		expect(
			resolveLocalNodeTool('vitest', ['run'], dir, 'win32', isAvailable),
		).toEqual([path.join(dir, 'node_modules', '.bin', 'vitest.exe'), 'run']);
	});

	test('returns null when the local binary is absent', () => {
		const dir = canonicalMkdtemp('resolver-2303-');
		dirs.push(dir);
		expect(resolveLocalNodeTool('vitest', ['run'], dir)).toBeNull();
	});

	test('FB-009 preserves quoted argument groups when rewriting a local shell command', () => {
		// Previous code used whitespace splitting here, so `"path with spaces"`
		// was broken into multiple argv entries when a local shim was selected.
		const { dir } = fixture('linux');
		const result = resolveLocalCommand(
			'tsc --project "packages/app tsconfig.json" --pretty false',
			dir,
			(binary) => binary === 'node',
			'linux',
		);

		expect(result).toEqual({
			argv: [
				path.join(dir, 'node_modules', '.bin', 'tsc'),
				'--project',
				'packages/app tsconfig.json',
				'--pretty',
				'false',
			],
			shellCommand:
				'./node_modules/.bin/tsc --project "packages/app tsconfig.json" --pretty false',
		});
	});

	test('FB-009 keeps shellCommand text unchanged while tokenizing quoted PATH commands safely', () => {
		// Previous code also used whitespace splitting on the PATH fallback, so
		// quoted groups were lost even though the original shell text was preserved.
		const command = 'python -m pytest -k "fast | smoke suite"';
		const result = resolveLocalCommand(
			command,
			'.',
			(binary) => binary === 'python',
			'linux',
		);

		expect(result).toEqual({
			argv: ['python', '-m', 'pytest', '-k', 'fast | smoke suite'],
			shellCommand: command,
		});
	});

	test('FB-009 tokenizes quoted groups without interpreting shell metacharacters', () => {
		expect(
			tokenizeCommand(`vitest run --testNamePattern "fast | smoke"`),
		).toEqual(['vitest', 'run', '--testNamePattern', 'fast | smoke']);
	});

	test('production-generated verification commands contain no implicit-download wrappers', () => {
		const root = path.resolve(import.meta.dir, '../../..');
		const violations: string[] = [];
		for (const relative of GENERATED_COMMAND_SOURCES) {
			const source = fs.readFileSync(path.join(root, relative), 'utf8');
			if (/cmd:\s*['"](?:npx|bunx|pnpx)\b/.test(source))
				violations.push(relative);
			if (/\[\s*['"](?:npx|bunx|pnpx)['"]\s*,/.test(source))
				violations.push(relative);
		}
		expect(violations).toEqual([]);
	});
});
