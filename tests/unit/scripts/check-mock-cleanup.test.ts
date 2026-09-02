/**
 * Issue #2094 — regression coverage for the TypeScript-owned mock cleanup gate.
 *
 * Covers direct-import decision logic plus end-to-end execution in a temp git
 * repo, including repo-root resolution and shell-shim parity.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	assessMockFile,
	main as runDirectMain,
	toSpreadVar,
} from '../../../scripts/check-mock-cleanup';
import { bashCommand } from '../../helpers/bash';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const TS_GATE = path.resolve(process.cwd(), 'scripts', 'check-mock-cleanup.ts');
const SH_SHIM = path.resolve(process.cwd(), 'scripts', 'check-mock-cleanup.sh');
const tempRoots: string[] = [];
const MOCK_MODULE_PREFIX = ['mock', 'module'].join('.');

function makeMockModuleCall(target: string, body: string): string {
	return `${MOCK_MODULE_PREFIX}('${target}', ${body});`;
}

interface SpawnResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

function spawn(
	cmd: string[],
	repoDir: string,
	env?: Record<string, string>,
): SpawnResult {
	const proc = Bun.spawnSync({
		cmd,
		cwd: repoDir,
		env: { ...process.env, ...env },
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 30_000,
	});
	return {
		exitCode: proc.exitCode ?? 1,
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
	};
}

function runScript(repoDir: string): SpawnResult {
	return spawn([process.execPath, 'run', TS_GATE], repoDir);
}

function runShim(repoDir: string): SpawnResult {
	return spawn(bashCommand(SH_SHIM), repoDir);
}

function git(repoDir: string, ...args: string[]): void {
	const proc = Bun.spawnSync({
		cmd: ['git', ...args],
		cwd: repoDir,
		env: process.env,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 10_000,
	});
	if (proc.exitCode !== 0) {
		throw new Error(
			`git ${args.join(' ')} failed in ${repoDir}: ${proc.stderr.toString()}`,
		);
	}
}

function write(repoDir: string, relPath: string, content: string): void {
	const full = path.join(repoDir, relPath);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content, 'utf-8');
}

function commit(repoDir: string, message: string): void {
	git(repoDir, 'add', '-A');
	git(repoDir, 'commit', '-q', '-m', message);
}

function makeRepo(): string {
	const repoDir = canonicalMkdtemp('mock-cleanup-2094-');
	git(repoDir, 'init', '-q', '-b', 'main');
	git(repoDir, 'config', 'user.email', 'test@example.com');
	git(repoDir, 'config', 'user.name', 'Test');
	write(repoDir, 'README.md', 'base\n');
	commit(repoDir, 'init');
	git(repoDir, 'branch', 'origin/main');
	tempRoots.push(repoDir);
	return repoDir;
}

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}
});

describe('check-mock-cleanup — pure decision coverage', () => {
	test('toSpreadVar matches repo naming convention', () => {
		expect(toSpreadVar('fs')).toBe('realFs');
		expect(toSpreadVar('child_process')).toBe('realChildProcess');
		expect(toSpreadVar('fs/promises')).toBe('realFsPromises');
	});

	test('flags missing cleanup when no documented exception exists', () => {
		const result = assessMockFile(
			makeMockModuleCall('./dep', '() => ({})') + '\n',
		);
		expect(result.missingCleanup).toBe(true);
		expect(result.spreadViolations).toEqual([]);
	});

	test('treats file-scoped mockClear/mockReset as an allowed cleanup shape', () => {
		const result = assessMockFile(
			[
				makeMockModuleCall('./dep', '() => ({})'),
				'beforeEach(() => mockFn.mockClear());',
			].join('\n'),
		);
		expect(result.missingCleanup).toBe(false);
	});

	test('flags node: mocks without spread or async import fallback', () => {
		const result = assessMockFile(
			makeMockModuleCall('node:fs', '() => ({ readFileSync: mockFn })') + '\n',
		);
		expect(result.spreadViolations).toEqual([
			{ module: 'fs', line: 1, spreadVar: 'realFs' },
		]);
	});

	test('accepts async import spread pattern for node: mocks', () => {
		const result = assessMockFile(
			[
				`${MOCK_MODULE_PREFIX}('node:fs', async () => {`,
				"  const realFs = await import('node:fs');",
				'  return { ...realFs, readFileSync: mockFn };',
				'});',
			].join('\n'),
		);
		expect(result.spreadViolations).toEqual([]);
	});

	// Issue #2260 class: mock.module retroactively patches the original
	// module's export slots, so a factory that spreads a captured namespace
	// and delegates an overridden export back into that namespace is infinite
	// tail recursion — an unkillable hang, not a stack overflow.
	test('flags delegation back into the spread namespace (issue #2260 class)', () => {
		const result = assessMockFile(
			[
				"import * as realDiscovery from './discovery';",
				makeMockModuleCall(
					'./discovery',
					`() => ({
	...realDiscovery,
	isCommandAvailable: (cmd: string) => {
		if (cmd === 'composer') return mockIsCommandAvailable;
		return realDiscovery.isCommandAvailable(cmd);
	},
})`,
				),
			].join('\n'),
		);
		expect(result.delegationViolations).toEqual([
			{ line: 6, spreadVar: 'realDiscovery', property: 'isCommandAvailable' },
		]);
	});

	test('accepts a captured-function delegation taken before registration', () => {
		const result = assessMockFile(
			[
				"import * as realExtractors from './extractors.js';",
				'const realExtractPlanCursor = realExtractors.extractPlanCursor;',
				makeMockModuleCall(
					'./extractors.js',
					`() => ({
	...realExtractors,
	extractPlanCursor: (planContent: string) => {
		return realExtractPlanCursor(planContent);
	},
})`,
				),
			].join('\n'),
		);
		expect(result.delegationViolations).toEqual([]);
	});

	test('array spreads of non-namespace identifiers are not delegation', () => {
		const result = assessMockFile(
			[
				"import { mock } from 'bun:test';",
				makeMockModuleCall(
					'./dep',
					`() => ({
	cmd: [...parts],
	join: 'literal',
})`,
				),
				'const joined = parts.join(",");',
			].join('\n'),
		);
		expect(result.delegationViolations).toEqual([]);
	});

	test('block comments mentioning the delegation shape are not flagged', () => {
		const result = assessMockFile(
			[
				"import * as realDiscovery from './discovery';",
				makeMockModuleCall(
					'./discovery',
					`() => ({
	...realDiscovery,
	isCommandAvailable: (cmd: string) => capturedReal(cmd),
})`,
				),
				'/* historical note: this factory used to call',
				' * realDiscovery.isCommandAvailable(cmd) before the #2260 fix',
				' */',
			].join('\n'),
		);
		expect(result.delegationViolations).toEqual([]);
	});

	test('namespace re-alias delegation is a documented accepted false negative', () => {
		// Known limitation (review F-004/PRR-009): the gate's namespace set
		// only covers `import * as X`, `await import()`, and `require()` — a
		// re-aliased binding (`const alias = realDiscovery`) delegating
		// through the alias is NOT flagged. Pinned here so the limitation is
		// a documented decision, not an accident.
		const result = assessMockFile(
			[
				"import * as realDiscovery from './discovery';",
				'const alias = realDiscovery;',
				makeMockModuleCall(
					'./discovery',
					`() => ({
	...realDiscovery,
	isCommandAvailable: (cmd: string) => alias.isCommandAvailable(cmd),
})`,
				),
			].join('\n'),
		);
		expect(result.delegationViolations).toEqual([]);
	});

	test('comment lines mentioning the delegation shape are not flagged', () => {
		const result = assessMockFile(
			[
				"import * as realDiscovery from './discovery';",
				makeMockModuleCall(
					'./discovery',
					`() => ({
	...realDiscovery,
	isCommandAvailable: (cmd: string) => capturedReal(cmd),
})`,
				),
				'// fixed: used to call realDiscovery.isCommandAvailable(cmd) here',
			].join('\n'),
		);
		expect(result.delegationViolations).toEqual([]);
	});
});

describe('check-mock-cleanup — end to end', () => {
	test('new mock.module cleanup violation is blocking', () => {
		const repo = makeRepo();
		write(
			repo,
			'tests/fixture.test.ts',
			[
				"import { mock } from 'bun:test';",
				makeMockModuleCall('./dep', '() => ({})'),
			].join('\n'),
		);
		commit(repo, 'add violating test');

		const result = runScript(repo);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain('no afterEach(mock.restore()) cleanup');
	});

	test('pre-existing violation outside the diff is non-blocking', () => {
		const repo = makeRepo();
		write(
			repo,
			'tests/preexisting.test.ts',
			[
				"import { mock } from 'bun:test';",
				makeMockModuleCall('./dep', '() => ({})'),
			].join('\n'),
		);
		commit(repo, 'seed violating test');
		git(repo, 'branch', '-f', 'origin/main');

		write(repo, 'src/keep.ts', 'export const keep = 1;\n');
		commit(repo, 'touch unrelated file');

		const result = runScript(repo);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('pre-existing violation(s) found');
		expect(result.stdout).not.toContain('NEW violation');
	});

	test('new node builtin mock without spread is blocking', () => {
		const repo = makeRepo();
		write(
			repo,
			'tests/node-mock.test.ts',
			[
				"import { afterEach, mock } from 'bun:test';",
				makeMockModuleCall('node:fs', '() => ({ readFileSync: mockFn })'),
				'afterEach(() => mock.restore());',
			].join('\n'),
		);
		commit(repo, 'add node mock violation');

		const result = runScript(repo);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain('without spreading real exports');
		expect(result.stdout).toContain('...realFs');
	});

	test('new delegation back into the spread namespace is blocking (issue #2260)', () => {
		const repo = makeRepo();
		write(
			repo,
			'tests/delegation-mock.test.ts',
			[
				"import { afterEach, mock } from 'bun:test';",
				"import * as realDiscovery from '../src/discovery';",
				makeMockModuleCall(
					'../src/discovery',
					`() => ({
	...realDiscovery,
	isCommandAvailable: (cmd: string) => {
		if (cmd === 'composer') return true;
		return realDiscovery.isCommandAvailable(cmd);
	},
})`,
				),
				'afterEach(() => mock.restore());',
			].join('\n'),
		);
		commit(repo, 'add delegation violation');

		const result = runScript(repo);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain(
			"delegates 'realDiscovery.isCommandAvailable(...)'",
		);
		expect(result.stdout).toContain('infinite tail recursion');
	});

	test('repo-root resolution makes subdirectory runs match root runs', () => {
		const repo = makeRepo();
		write(
			repo,
			'tests/fixture.test.ts',
			[
				"import { mock } from 'bun:test';",
				makeMockModuleCall('./dep', '() => ({})'),
			].join('\n'),
		);
		write(repo, 'src/nested/keep.ts', 'export const keep = 1;\n');
		commit(repo, 'add violation');

		const fromRoot = runScript(repo);
		const fromSubdir = runScript(path.join(repo, 'src', 'nested'));
		expect(fromSubdir.exitCode).toBe(fromRoot.exitCode);
		expect(fromSubdir.stdout).toBe(fromRoot.stdout);
	});

	test('the shell shim is byte-equal with the TypeScript gate', () => {
		const repo = makeRepo();
		write(
			repo,
			'tests/fixture.test.ts',
			[
				"import { mock } from 'bun:test';",
				makeMockModuleCall('./dep', '() => ({})'),
			].join('\n'),
		);
		commit(repo, 'add violation');

		const direct = runScript(repo);
		const shim = runShim(repo);
		expect(shim.exitCode).toBe(direct.exitCode);
		expect(shim.stdout).toBe(direct.stdout);
	});

	test('the shim carries no cleanup or spread policy logic', () => {
		const shimSource = fs.readFileSync(SH_SHIM, 'utf-8');
		const body = shimSource
			.split('\n')
			.filter((line) => !line.trimStart().startsWith('#'))
			.join('\n');
		expect(body).not.toContain('mock.restore');
		expect(body).not.toContain('mockClear');
		expect(body).not.toContain('realFs');
		expect(body).toContain('check-mock-cleanup.ts');
	});

	test('direct-import main matches subprocess exit code for the same repo', async () => {
		const repo = makeRepo();
		write(
			repo,
			'tests/fixture.test.ts',
			[
				"import { mock } from 'bun:test';",
				makeMockModuleCall('./dep', '() => ({})'),
			].join('\n'),
		);
		commit(repo, 'add violation');

		expect(await runDirectMain(repo)).toBe(runScript(repo).exitCode);
	});
});
