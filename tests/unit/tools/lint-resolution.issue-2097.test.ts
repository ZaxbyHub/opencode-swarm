import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	detectAdditionalLinter,
	runAdditionalLint,
	runLint,
} from '../../../src/tools/lint';
import type { ExternalToolRunOptions } from '../../../src/utils/external-tool-runner';

function makeTempDir(prefix: string): string {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeFile(filePath: string, contents = ''): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, contents, 'utf8');
}

function writeWindowsCmdShim(shimPath: string, relativeTarget: string): void {
	writeFile(
		shimPath,
		[
			'@ECHO off',
			'SETLOCAL',
			'SET dp0=%~dp0',
			'endLocal & "%_prog%" "%dp0%' + relativeTarget + '" %*',
			'',
		].join('\r\n'),
	);
}

function writeWindowsPowerShellShim(
	shimPath: string,
	relativeTarget: string,
): void {
	writeFile(
		shimPath,
		`& "$basedir/${relativeTarget.replaceAll('\\', '/')}" $args\r\n`,
	);
}

describe('lint resolution lane — issue #2097', () => {
	const originalInternals = {
		arch: _internals.arch,
		detectResolvedLinter: _internals.detectResolvedLinter,
		existsSync: _internals.existsSync,
		isCommandAvailable: _internals.isCommandAvailable,
		pathEnv: _internals.pathEnv,
		platform: _internals.platform,
		runExternalTool: _internals.runExternalTool,
	};

	let tempRoot: string;
	let runnerCalls: ExternalToolRunOptions[];

	beforeEach(() => {
		tempRoot = makeTempDir('lint-resolution-');
		runnerCalls = [];
		_internals.platform = () => 'win32';
		_internals.arch = () => 'x64';
		_internals.pathEnv = () => '';
		_internals.runExternalTool = mock(
			async (options: ExternalToolRunOptions) => {
				runnerCalls.push(options);
				return {
					status: 'completed',
					exitCode: 0,
					stdout: '',
					stderr: '',
					stdoutTruncated: false,
					stderrTruncated: false,
				};
			},
		);
	});

	afterEach(() => {
		_internals.arch = originalInternals.arch;
		_internals.detectResolvedLinter = originalInternals.detectResolvedLinter;
		_internals.existsSync = originalInternals.existsSync;
		_internals.isCommandAvailable = originalInternals.isCommandAvailable;
		_internals.pathEnv = originalInternals.pathEnv;
		_internals.platform = originalInternals.platform;
		_internals.runExternalTool = originalInternals.runExternalTool;
		try {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		} catch {
			// best effort
		}
	});

	it('prefers the local Biome native executable before shims or PATH', async () => {
		const nativeExe = path.join(
			tempRoot,
			'node_modules',
			'@biomejs',
			'cli-win32-x64',
			'biome.exe',
		);
		const shimPath = path.join(tempRoot, 'node_modules', '.bin', 'biome.cmd');
		writeFile(nativeExe);
		writeWindowsCmdShim(shimPath, '\\..\\@biomejs\\biome\\bin\\biome');

		const resolved = await _internals.resolveLinterCommand('biome', tempRoot);

		expect(resolved).not.toBeNull();
		expect(resolved?.source).toBe('local-native');
		expect(resolved?.executable).toBe(nativeExe);
		expect(resolved?.argsPrefix).toEqual([]);
	});

	it('resolves a local npm-style eslint shim to the canonical package bin and executes through node', async () => {
		const eslintBin = path.join(
			tempRoot,
			'node_modules',
			'eslint',
			'bin',
			'eslint.js',
		);
		writeFile(
			path.join(tempRoot, 'node_modules', 'eslint', 'package.json'),
			JSON.stringify({ bin: { eslint: 'bin/eslint.js' } }),
		);
		writeFile(eslintBin, 'console.log("eslint");');
		writeWindowsCmdShim(
			path.join(tempRoot, 'node_modules', '.bin', 'eslint.cmd'),
			'\\..\\eslint\\bin\\eslint.js',
		);

		const resolved = await _internals.resolveLinterCommand('eslint', tempRoot);
		expect(resolved).not.toBeNull();
		expect(resolved?.source).toBe('local-shim');
		expect(resolved?.executable).toBe(process.execPath);
		expect(resolved?.argsPrefix).toEqual([fs.realpathSync(eslintBin)]);

		const result = await _internals.runResolvedLint(resolved!, 'fix', tempRoot);
		expect(result.success).toBe(true);
		expect(result.command).toEqual([
			path.join(tempRoot, 'node_modules', '.bin', 'eslint'),
			'.',
			'--fix',
		]);
		expect(runnerCalls).toHaveLength(1);
		expect(runnerCalls[0]).toMatchObject({
			executable: process.execPath,
			args: [fs.realpathSync(eslintBin), '.', '--fix'],
			cwd: tempRoot,
		});
	});

	it('uses a safe package bin when the local package has no shim', async () => {
		const eslintBin = path.join(
			tempRoot,
			'node_modules',
			'eslint',
			'bin',
			'eslint.js',
		);
		writeFile(
			path.join(tempRoot, 'node_modules', 'eslint', 'package.json'),
			JSON.stringify({ bin: { eslint: 'bin/eslint.js' } }),
		);
		writeFile(eslintBin, 'console.log("eslint");');

		const resolved = await _internals.resolveLinterCommand('eslint', tempRoot);

		expect(resolved).not.toBeNull();
		expect(resolved?.source).toBe('safe-package-bin');
		expect(resolved?.executable).toBe(process.execPath);
		expect(resolved?.argsPrefix).toEqual([fs.realpathSync(eslintBin)]);
	});

	it('parses a pnpm-style PATH shim without ever executing the .cmd file', async () => {
		const pathBinDir = path.join(tempRoot, 'tools');
		const pnpmTarget = path.join(
			tempRoot,
			'node_modules',
			'.pnpm',
			'@biomejs+biome@1.9.4',
			'node_modules',
			'@biomejs',
			'biome',
			'bin',
			'biome',
		);
		writeFile(pnpmTarget, 'console.log("biome");');
		writeWindowsCmdShim(
			path.join(pathBinDir, 'biome.cmd'),
			'\\..\\node_modules\\.pnpm\\@biomejs+biome@1.9.4\\node_modules\\@biomejs\\biome\\bin\\biome',
		);
		_internals.pathEnv = () => pathBinDir;

		const resolved = await _internals.resolveLinterCommand('biome', tempRoot);

		expect(resolved).not.toBeNull();
		expect(resolved?.source).toBe('path-shim');
		expect(resolved?.executable).toBe(process.execPath);
		expect(resolved?.argsPrefix).toEqual([fs.realpathSync(pnpmTarget)]);
		expect(resolved?.executable.endsWith('.cmd')).toBe(false);
	});

	it('parses a Yarn-style PowerShell shim to its package entry without executing the shim', async () => {
		const pathBinDir = path.join(tempRoot, 'tools');
		const yarnTarget = path.join(
			tempRoot,
			'node_modules',
			'.yarn',
			'eslint',
			'node_modules',
			'eslint',
			'bin',
			'eslint.js',
		);
		writeFile(yarnTarget, 'console.log("eslint");');
		writeWindowsPowerShellShim(
			path.join(pathBinDir, 'eslint.ps1'),
			'../node_modules/.yarn/eslint/node_modules/eslint/bin/eslint.js',
		);
		_internals.pathEnv = () => pathBinDir;

		const resolved = await _internals.resolveLinterCommand('eslint', tempRoot);

		expect(resolved).not.toBeNull();
		expect(resolved?.source).toBe('path-shim');
		expect(resolved?.executable).toBe(process.execPath);
		expect(resolved?.argsPrefix).toEqual([fs.realpathSync(yarnTarget)]);
		expect(resolved?.executable.endsWith('.ps1')).toBe(false);
	});

	it('uses a PATH native executable only after local sources are absent', async () => {
		const pathBinDir = path.join(tempRoot, 'native-bin');
		const nativeExe = path.join(pathBinDir, 'biome.exe');
		writeFile(nativeExe);
		_internals.pathEnv = () => pathBinDir;

		const resolved = await _internals.resolveLinterCommand('biome', tempRoot);

		expect(resolved).not.toBeNull();
		expect(resolved?.source).toBe('path-native');
		expect(resolved?.executable).toBe(nativeExe);
		expect(resolved?.argsPrefix).toEqual([]);
	});

	it('treats a package manifest with a missing bin target as unavailable', async () => {
		writeFile(
			path.join(tempRoot, 'node_modules', 'eslint', 'package.json'),
			JSON.stringify({ bin: { eslint: 'bin/missing.js' } }),
		);
		writeWindowsCmdShim(
			path.join(tempRoot, 'node_modules', '.bin', 'eslint.cmd'),
			'\\..\\eslint\\bin\\missing.js',
		);

		await expect(
			_internals.resolveLinterCommand('eslint', tempRoot),
		).resolves.toBeNull();
	});

	it('never executes an unresolved raw package-manager shim', async () => {
		writeFile(path.join(tempRoot, 'node_modules', '.bin', 'eslint.cmd'));
		writeFile(path.join(tempRoot, 'node_modules', '.bin', 'eslint.ps1'));

		const result = await runLint('eslint', 'check', tempRoot);

		expect(result).toMatchObject({
			success: false,
			linter: 'eslint',
			error: 'No safely resolved eslint executable found',
		});
		expect(runnerCalls).toHaveLength(0);
	});

	it('rejects a Windows Composer batch-only proxy without reaching the runner', async () => {
		const pathBinDir = path.join(tempRoot, 'tools');
		writeFile(path.join(tempRoot, 'phpstan.neon'));
		writeFile(path.join(tempRoot, 'vendor', 'bin', 'phpstan.bat'));
		writeFile(path.join(pathBinDir, 'php.cmd'));
		_internals.pathEnv = () => pathBinDir;

		expect(detectAdditionalLinter(tempRoot)).toBeNull();
		const result = await runAdditionalLint('phpstan', 'check', tempRoot);

		expect(result.success).toBe(false);
		expect(runnerCalls).toHaveLength(0);
	});

	it('runs a Windows Composer PHP proxy through native php, never its batch shim', async () => {
		const pathBinDir = path.join(tempRoot, 'tools');
		const phpExecutable = path.join(pathBinDir, 'php.exe');
		writeFile(path.join(tempRoot, 'phpstan.neon'));
		writeFile(path.join(tempRoot, 'vendor', 'bin', 'phpstan'), '<?php');
		writeFile(path.join(tempRoot, 'vendor', 'bin', 'phpstan.bat'));
		writeFile(phpExecutable);
		_internals.pathEnv = () => pathBinDir;

		expect(detectAdditionalLinter(tempRoot)).toBe('phpstan');
		const result = await runAdditionalLint('phpstan', 'check', tempRoot);

		expect(result.success).toBe(true);
		expect(runnerCalls).toHaveLength(1);
		expect(runnerCalls[0]).toMatchObject({
			executable: phpExecutable,
			args: [path.join('vendor', 'bin', 'phpstan'), 'analyse'],
			cwd: tempRoot,
		});
	});

	it('rejects batch-only PATH linters whose unsafe extension is hidden by a bare name', async () => {
		const pathBinDir = path.join(tempRoot, 'tools');
		writeFile(path.join(pathBinDir, 'ruff.cmd'));
		writeFile(path.join(pathBinDir, 'gradle.bat'));
		writeFile(
			path.join(tempRoot, 'build.gradle'),
			'plugins { id("checkstyle") }',
		);
		_internals.pathEnv = () => pathBinDir;

		const ruff = await runAdditionalLint('ruff', 'check', tempRoot);
		const checkstyle = await runAdditionalLint('checkstyle', 'check', tempRoot);

		expect(ruff.success).toBe(false);
		expect(checkstyle.success).toBe(false);
		expect(runnerCalls).toHaveLength(0);
	});

	it('passes the exact native Windows PATH executable to the shared runner', async () => {
		const pathBinDir = path.join(tempRoot, 'tools');
		const ruffExecutable = path.join(pathBinDir, 'ruff.exe');
		writeFile(ruffExecutable);
		_internals.pathEnv = () => pathBinDir;

		const result = await runAdditionalLint('ruff', 'check', tempRoot);

		expect(result.success).toBe(true);
		expect(runnerCalls[0]).toMatchObject({
			executable: ruffExecutable,
			args: ['check', '.'],
		});
	});

	it('keeps metacharacter-heavy workspace paths opaque in both detection and execution', async () => {
		const specialProjectDir = path.join(
			tempRoot,
			"odd & (100%) 'quotes' 日本語",
		);
		const nativeExe = path.join(
			specialProjectDir,
			'node_modules',
			'@biomejs',
			'cli-win32-x64',
			'biome.exe',
		);
		writeFile(nativeExe);

		const resolved = await _internals.detectResolvedLinter(specialProjectDir);
		expect(resolved).not.toBeNull();
		expect(runnerCalls).toHaveLength(1);
		expect(runnerCalls[0]?.cwd).toBe(specialProjectDir);
		expect(runnerCalls[0]?.args).toEqual(['--version']);

		runnerCalls = [];
		const result = await _internals.runResolvedLint(
			resolved!,
			'check',
			specialProjectDir,
		);
		expect(result.success).toBe(true);
		expect(runnerCalls).toHaveLength(1);
		expect(runnerCalls[0]?.cwd).toBe(specialProjectDir);
		expect(runnerCalls[0]?.args).toEqual(['check', '.']);
	});

	it('routes additional linters through the shared runner instead of direct spawn calls', async () => {
		const pathBinDir = path.join(tempRoot, 'tools');
		const ruffExecutable = path.join(pathBinDir, 'ruff.exe');
		writeFile(ruffExecutable);
		_internals.pathEnv = () => pathBinDir;
		const result = await runAdditionalLint('ruff', 'check', tempRoot);

		expect(result.success).toBe(true);
		expect(runnerCalls).toHaveLength(1);
		expect(runnerCalls[0]).toMatchObject({
			executable: ruffExecutable,
			args: ['check', '.'],
			cwd: tempRoot,
		});
	});
});
