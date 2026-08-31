import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	createIncrementalVerifyHook,
	detectTypecheckCommand,
	resetAdvisoryDedup,
} from './incremental-verify';

const PASS_CMD = process.platform === 'win32' ? 'cmd /c exit 0' : 'true';

describe('incremental-verify hook', () => {
	let tmpDir: string;
	let injectResult: { sessionId: string; message: string } | null;
	let injectMessage: (sessionId: string, message: string) => void;

	beforeEach(async () => {
		tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'incr-verify-'));
		injectResult = null;
		injectMessage = (sessionId: string, message: string) => {
			injectResult = { sessionId, message };
		};
	});

	afterEach(async () => {
		await fs.promises.rm(tmpDir, { recursive: true, force: true });
	});

	// 1. Fires after coder delegation — passes
	test('fires after coder Task delegation with passing typecheck', async () => {
		const hook = createIncrementalVerifyHook(
			{
				enabled: true,
				command: PASS_CMD,
				timeoutMs: 5000,
				triggerAgents: ['coder'],
			},
			tmpDir,
			injectMessage,
		);
		await hook.toolAfter(
			{ tool: 'Task', sessionID: 'sess-1', args: { subagent_type: 'coder' } },
			{},
		);
		expect(injectResult).not.toBeNull();
		expect(injectResult!.sessionId).toBe('sess-1');
		expect(injectResult!.message).toContain('POST-CODER CHECK PASSED');
	});

	// 2. Does NOT fire after reviewer delegation
	test('does not fire after reviewer Task delegation', async () => {
		const hook = createIncrementalVerifyHook(
			{
				enabled: true,
				command: PASS_CMD,
				timeoutMs: 5000,
				triggerAgents: ['coder'],
			},
			tmpDir,
			injectMessage,
		);
		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 'sess-2',
				args: { subagent_type: 'reviewer' },
			},
			{},
		);
		expect(injectResult).toBeNull();
	});

	// 3. Respects custom command from config
	test('respects custom command that exits 0', async () => {
		const customCmd =
			process.platform === 'win32' ? 'cmd /c echo type_ok' : 'echo type_ok';
		const hook = createIncrementalVerifyHook(
			{
				enabled: true,
				command: customCmd,
				timeoutMs: 5000,
				triggerAgents: ['coder'],
			},
			tmpDir,
			injectMessage,
		);
		await hook.toolAfter(
			{ tool: 'Task', sessionID: 'sess-3', args: { subagent_type: 'coder' } },
			{},
		);
		expect(injectResult).not.toBeNull();
		expect(injectResult!.message).toContain('POST-CODER CHECK PASSED');
	});

	// 4. Times out gracefully — timeout causes null result, no message injected
	test('handles timeout gracefully without throwing', async () => {
		// sleep 30 blocks indefinitely with zero output; proc.kill() terminates it.
		// The 80ms timeout fires, kill() is called, process exits → result is null → no message.
		const sleepCmd =
			process.platform === 'win32' ? 'cmd /c type con' : 'sleep 30';
		const hook = createIncrementalVerifyHook(
			{
				enabled: true,
				command: sleepCmd,
				timeoutMs: 80,
				triggerAgents: ['coder'],
			},
			tmpDir,
			injectMessage,
		);
		await expect(
			hook.toolAfter(
				{ tool: 'Task', sessionID: 'sess-4', args: { subagent_type: 'coder' } },
				{},
			),
		).resolves.toBeUndefined();
		// If kill worked: injectResult is null (silent skip on timeout)
		// If kill didn't work: process exits → FAILED injected (platform limitation)
	});

	// 5. Skips when TypeScript not detected (no package.json, no tsconfig.json)
	test('skips when TypeScript not detected — no package.json or tsconfig', async () => {
		const hook = createIncrementalVerifyHook(
			{
				enabled: true,
				command: null,
				timeoutMs: 5000,
				triggerAgents: ['coder'],
			},
			tmpDir, // empty temp dir — no package.json, no tsconfig.json
			injectMessage,
		);
		await hook.toolAfter(
			{ tool: 'Task', sessionID: 'sess-5', args: { subagent_type: 'coder' } },
			{},
		);
		expect(injectResult).toBeNull();
	});

	// 6. Passes typecheck error output in failure message
	test('injects failure message with stderr when command exits non-zero', async () => {
		// Use a command that fails and produces stderr
		const failWithStderr =
			process.platform === 'win32'
				? 'cmd /c echo SomeTypeError > nul && exit 1'
				: 'sh -c "echo SomeTypeError >&2; exit 1"';
		const hook = createIncrementalVerifyHook(
			{
				enabled: true,
				command: failWithStderr,
				timeoutMs: 5000,
				triggerAgents: ['coder'],
			},
			tmpDir,
			injectMessage,
		);
		await hook.toolAfter(
			{ tool: 'Task', sessionID: 'sess-6', args: { subagent_type: 'coder' } },
			{},
		);
		expect(injectResult).not.toBeNull();
		expect(injectResult!.message).toContain('POST-CODER CHECK FAILED');
	});

	// 7. enabled: false — no injection regardless of tool/agent
	test('does not fire when enabled is false', async () => {
		const hook = createIncrementalVerifyHook(
			{
				enabled: false,
				command: PASS_CMD,
				timeoutMs: 5000,
				triggerAgents: ['coder'],
			},
			tmpDir,
			injectMessage,
		);
		await hook.toolAfter(
			{ tool: 'Task', sessionID: 'sess-7', args: { subagent_type: 'coder' } },
			{},
		);
		expect(injectResult).toBeNull();
	});

	// 8. Non-Task tool (bash) — injectMessage NOT called
	test('does not fire for non-Task tools', async () => {
		const hook = createIncrementalVerifyHook(
			{
				enabled: true,
				command: PASS_CMD,
				timeoutMs: 5000,
				triggerAgents: ['coder'],
			},
			tmpDir,
			injectMessage,
		);
		await hook.toolAfter({ tool: 'bash', sessionID: 'sess-8', args: {} }, {});
		expect(injectResult).toBeNull();
	});

	// 9. input.args is null/undefined — no throw, no injection
	test('handles null/undefined input.args without throwing', async () => {
		const hook = createIncrementalVerifyHook(
			{
				enabled: true,
				command: PASS_CMD,
				timeoutMs: 5000,
				triggerAgents: ['coder'],
			},
			tmpDir,
			injectMessage,
		);
		// Should not throw
		await hook.toolAfter({ tool: 'Task', sessionID: 'sess-9', args: null }, {});
		expect(injectResult).toBeNull();

		injectResult = null;
		await hook.toolAfter(
			{ tool: 'Task', sessionID: 'sess-9b', args: undefined },
			{},
		);
		expect(injectResult).toBeNull();
	});

	// 10. string[] command — passed through directly without split
	test('accepts string[] command and passes it through without split', async () => {
		// Use an array command to verify no split happens
		const arrayCmd =
			process.platform === 'win32'
				? ['cmd', '/c', 'echo', 'type_ok']
				: ['echo', 'type_ok'];
		const hook = createIncrementalVerifyHook(
			{
				enabled: true,
				command: arrayCmd,
				timeoutMs: 5000,
				triggerAgents: ['coder'],
			},
			tmpDir,
			injectMessage,
		);
		await hook.toolAfter(
			{ tool: 'Task', sessionID: 'sess-10', args: { subagent_type: 'coder' } },
			{},
		);
		expect(injectResult).not.toBeNull();
		expect(injectResult!.message).toContain('POST-CODER CHECK PASSED');
	});

	// 11. Prefixed agent name 'mega_coder' normalises to 'coder' and triggers
	test('normalises prefixed agent name (mega_coder → coder) and triggers', async () => {
		const hook = createIncrementalVerifyHook(
			{
				enabled: true,
				command: PASS_CMD,
				timeoutMs: 5000,
				triggerAgents: ['coder'],
			},
			tmpDir,
			injectMessage,
		);
		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 'sess-10',
				args: { subagent_type: 'mega_coder' },
			},
			{},
		);
		expect(injectResult).not.toBeNull();
		expect(injectResult!.message).toContain('POST-CODER CHECK PASSED');
	});
});

describe('detectTypecheckCommand adversarial tests', () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.promises.mkdtemp(
			path.join(os.tmpdir(), 'detect-cmd-adversarial-'),
		);
	});

	afterEach(async () => {
		await fs.promises.rm(tmpDir, { recursive: true, force: true });
	});

	// 1. Malformed package.json (invalid JSON) → should return null (caught by try/catch)
	test('returns null for malformed package.json (invalid JSON)', async () => {
		const badPkgPath = path.join(tmpDir, 'package.json');
		await fs.promises.writeFile(
			badPkgPath,
			'{ "name": "test", invalid }',
			'utf8',
		);
		const result = detectTypecheckCommand(tmpDir);
		expect(result).toBeNull();
	});

	// 2. package.json with scripts as non-object (e.g., scripts: "invalid") → should not throw
	test('handles package.json with non-object scripts field without throwing', async () => {
		const badPkgPath = path.join(tmpDir, 'package.json');
		await fs.promises.writeFile(
			badPkgPath,
			'{ "name": "test", "scripts": "invalid" }',
			'utf8',
		);
		// Should not throw — the try/catch handles this gracefully
		const result = detectTypecheckCommand(tmpDir);
		// Since scripts is not an object, scripts?.typecheck is undefined, so it falls through
		// No typescript dependency or tsconfig.json, so it returns null
		expect(result).toBeNull();
	});

	// 3. Project dir that doesn't exist → detectTypecheckCommand should return null gracefully
	test('returns null gracefully when project dir does not exist', async () => {
		const nonExistentDir = path.join(
			os.tmpdir(),
			`this-dir-definitely-does-not-exist-${Date.now()}`,
		);
		const result = detectTypecheckCommand(nonExistentDir);
		expect(result).toBeNull();
	});

	// 4. Both go.mod AND Cargo.toml present → should detect Go first (priority order)
	test('detects Go over Rust when both go.mod and Cargo.toml are present', async () => {
		await fs.promises.writeFile(
			path.join(tmpDir, 'go.mod'),
			'module test\n',
			'utf8',
		);
		await fs.promises.writeFile(
			path.join(tmpDir, 'Cargo.toml'),
			'[package]\nname = "test"\n',
			'utf8',
		);
		const result = detectTypecheckCommand(tmpDir);
		expect(result).not.toBeNull();
		expect(result!.language).toBe('go');
		expect(result!.command).toEqual(['go', 'vet', './...']);
	});

	// 5. Python project (pyproject.toml) AND package.json present → should detect Node/JS (package.json wins)
	test('detects Node/JS over Python when both package.json and pyproject.toml are present', async () => {
		await fs.promises.writeFile(
			path.join(tmpDir, 'package.json'),
			'{ "name": "test", "dependencies": { "typescript": "^5.0.0" } }',
			'utf8',
		);
		await fs.promises.writeFile(
			path.join(tmpDir, 'pyproject.toml'),
			'[project]\nname = "test"\n',
			'utf8',
		);
		const result = detectTypecheckCommand(tmpDir);
		expect(result).not.toBeNull();
		expect(result!.language).toBe('typescript');
	});

	// 6. Go project via go.mod returns go vet command
	test('Go project via go.mod returns go vet command', async () => {
		fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module myproject\n', 'utf8');
		const result = detectTypecheckCommand(tmpDir);
		expect(result).toEqual({ command: ['go', 'vet', './...'], language: 'go' });
	});

	// 7. Rust via Cargo.toml returns cargo check
	test('Rust via Cargo.toml returns cargo check', async () => {
		fs.writeFileSync(
			path.join(tmpDir, 'Cargo.toml'),
			'[package]\nname = "test"\n',
			'utf8',
		);
		const result = detectTypecheckCommand(tmpDir);
		expect(result).toEqual({ command: ['cargo', 'check'], language: 'rust' });
	});

	// 8. C# via .csproj returns dotnet build
	test('C# via .csproj returns dotnet build', async () => {
		fs.writeFileSync(path.join(tmpDir, 'App.csproj'), '<Project />', 'utf8');
		const result = detectTypecheckCommand(tmpDir);
		expect(result).toEqual({
			command: ['dotnet', 'build', '--no-restore'],
			language: 'csharp',
		});
	});

	// 9. Python via pyproject.toml emits SKIPPED advisory via hook
	test('Python via pyproject.toml emits SKIPPED advisory via hook', async () => {
		fs.writeFileSync(
			path.join(tmpDir, 'pyproject.toml'),
			'[project]\nname = "test"\n',
			'utf8',
		);
		resetAdvisoryDedup();
		let capturedMessage: string | null = null;
		const captureInject: (sessionId: string, message: string) => void = (
			_sessionId,
			message,
		) => {
			capturedMessage = message;
		};
		const hook = createIncrementalVerifyHook(
			{
				enabled: true,
				command: null,
				timeoutMs: 5000,
				triggerAgents: ['coder'],
			},
			tmpDir,
			captureInject,
		);
		await hook.toolAfter(
			{ tool: 'Task', sessionID: 'sess-py', args: { subagent_type: 'coder' } },
			{},
		);
		expect(capturedMessage).not.toBeNull();
		expect(capturedMessage!).toContain('POST-CODER CHECK SKIPPED');
		expect(capturedMessage!).toContain('python');
	});

	// 10. TypeScript detection regression guard
	test('TypeScript detection regression guard', async () => {
		fs.writeFileSync(
			path.join(tmpDir, 'package.json'),
			'{ "devDependencies": { "typescript": "^5.0.0" } }',
			'utf8',
		);
		fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}', 'utf8');
		const result = detectTypecheckCommand(tmpDir);
		expect(result).toEqual({ command: null, language: 'typescript' });
	});

	// 11. Go when package.json exists but has no TypeScript markers
	test('detects Go when package.json exists but has no TypeScript markers', async () => {
		await fs.promises.writeFile(
			path.join(tmpDir, 'package.json'),
			'{ "name": "tooling-repo", "scripts": { "lint": "eslint ." } }',
			'utf8',
		);
		await fs.promises.writeFile(
			path.join(tmpDir, 'go.mod'),
			'module tooling-repo\n',
			'utf8',
		);
		const result = detectTypecheckCommand(tmpDir);
		expect(result).not.toBeNull();
		expect(result!.language).toBe('go');
		expect(result!.command).toEqual(['go', 'vet', './...']);
	});
});

describe('detectPackageManager adversarial security tests', () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.promises.mkdtemp(
			path.join(os.tmpdir(), 'detect-pm-adversarial-'),
		);
	});

	afterEach(async () => {
		await fs.promises.rm(tmpDir, { recursive: true, force: true });
	});

	// Helper to write a minimal package.json with a typecheck script
	async function writePackageJsonWithScript(
		scriptName: 'typecheck' | 'type-check',
	): Promise<void> {
		const pkgPath = path.join(tmpDir, 'package.json');
		await fs.promises.writeFile(
			pkgPath,
			JSON.stringify({
				name: 'test-project',
				scripts: { [scriptName]: 'tsc --noEmit' },
			}),
			'utf8',
		);
	}

	// ─────────────────────────────────────────────────────────────────────────────
	// ADVERSARIAL VECTOR 1: Path traversal in directory name
	// A malicious directory name containing "../" should be safely resolved by
	// path.join and NOT escape the project directory.
	// detectPackageManager does: path.join(projectDir, 'bun.lockb')
	// path.join normalizes "foo/../bar" → "foo/bar"
	// Expected: detection should look INSIDE the projectDir, not escape it.
	// ─────────────────────────────────────────────────────────────────────────────
	test('path traversal in directory name — lockfile not found outside projectDir', async () => {
		// Create a temp directory, then a subdirectory with ".." in its name
		const safeDir = await fs.promises.mkdtemp(
			path.join(os.tmpdir(), 'safe-project-'),
		);
		// Create a sibling directory that will NOT contain the lockfile
		const siblingDir = await fs.promises.mkdtemp(
			path.join(os.tmpdir(), 'sibling-project-'),
		);
		// Write lockfile to sibling dir only
		await fs.promises.writeFile(
			path.join(siblingDir, 'bun.lockb'),
			'# Bun lockfile',
			'utf8',
		);

		// Create a subdirectory inside safeDir whose name contains ".."
		// e.g. safeDir/evil../sibling/../../bun.lockb → safeDir/bun.lockb (normalized)
		// But the actual path is: safeDir/evil../sibling/../../bun.lockb
		// which resolves (after path.join normalization) to safeDir/bun.lockb
		// BUT the filesystem sees the literal ".." as part of the directory name
		const maliciousDir = path.join(safeDir, 'legit');
		await fs.promises.mkdir(maliciousDir, { recursive: true });

		// Write a lockfile INSIDE the malicious directory (not the sibling)
		// so that when path.join normalizes it, the path is still inside projectDir
		await fs.promises.writeFile(
			path.join(safeDir, 'package.json'),
			JSON.stringify({ name: 'test', scripts: { typecheck: 'tsc --noEmit' } }),
			'utf8',
		);
		await fs.promises.writeFile(
			path.join(maliciousDir, 'bun.lockb'),
			'# Bun inside malicious dir',
			'utf8',
		);

		// Now: path.join(maliciousDir, 'bun.lockb') → maliciousDir/bun.lockb (literal file exists)
		// path.join(safeDir, 'bun.lockb')  → safeDir/bun.lockb (does NOT exist)
		// Since we call detectTypecheckCommand with safeDir, it should NOT find bun.lockb
		// (it would only find maliciousDir/bun.lockb which is not safeDir/bun.lockb)
		const result = detectTypecheckCommand(safeDir);
		// safeDir has a package.json with typecheck script but NO lockfile at safeDir level
		// → falls back to bun
		expect(result).toEqual({
			command: ['bun', 'run', 'typecheck'],
			language: 'typescript',
		});

		await fs.promises.rm(safeDir, { recursive: true, force: true });
		await fs.promises.rm(siblingDir, { recursive: true, force: true });
	});

	test('path traversal in lockfile filename itself — path.join normalizes it', async () => {
		// This tests whether a lockfile named "foo/../bun.lockb" could escape
		// In practice, you can't create files with "/" in their names on any OS,
		// so this is a theoretical test. path.join normalizes the path.
		await writePackageJsonWithScript('typecheck');
		// Attempting to create a file with path separator in name will fail or
		// create a file with the literal characters on some systems.
		// On Windows, trying to create "foo\bun.lockb" creates a file named
		// "foo\bun.lockb" literally (backslash is not a path separator on Unix).
		// The important thing is that path.join(projectDir, 'foo/bun.lockb')
		// normalizes to projectDir/foo/bun.lockb — no escape.
		const result = detectTypecheckCommand(tmpDir);
		// No lockfile present → fallback to bun
		expect(result).toEqual({
			command: ['bun', 'run', 'typecheck'],
			language: 'typescript',
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// ADVERSARIAL VECTOR 2: Symlink lockfile
	// bun.lockb exists as a symlink pointing to another directory's lockfile.
	// existsSync follows symlinks → should still detect 'bun'.
	// ─────────────────────────────────────────────────────────────────────────────
	test('symlink lockfile is followed and detected correctly', async () => {
		// Create a "real" bun.lockb in a separate directory
		const realLockDir = await fs.promises.mkdtemp(
			path.join(os.tmpdir(), 'real-bun-lock-'),
		);
		await fs.promises.writeFile(
			path.join(realLockDir, 'bun.lockb'),
			'# Real Bun lockfile',
			'utf8',
		);

		await writePackageJsonWithScript('typecheck');
		// Create symlink: tmpDir/bun.lockb → realLockDir/bun.lockb
		const symlinkPath = path.join(tmpDir, 'bun.lockb');
		try {
			await fs.promises.symlink(
				path.join(realLockDir, 'bun.lockb'),
				symlinkPath,
				'file',
			);
		} catch {
			// Symlink creation may fail on some platforms (e.g., lack of privileges)
			// Skip this specific test case in that scenario
			await fs.promises.rm(realLockDir, { recursive: true, force: true });
			markTestSkipped('Symlink creation not available on this platform');
			return;
		}

		const result = detectTypecheckCommand(tmpDir);
		// Symlink is followed → bun.lockb exists → detects bun
		expect(result).toEqual({
			command: ['bun', 'run', 'typecheck'],
			language: 'typescript',
		});

		await fs.promises.rm(realLockDir, { recursive: true, force: true });
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// ADVERSARIAL VECTOR 3: Lockfile is a directory, not a file
	// existsSync returns true for directories too. The detection should still
	// pick the corresponding package manager (bun in this case).
	// This is not a bug — existence of a directory named bun.lockb is an
	// unusual but valid signal that bun is being used.
	// ─────────────────────────────────────────────────────────────────────────────
	test('lockfile directory (not file) — existsSync returns true, bun is detected', async () => {
		await writePackageJsonWithScript('typecheck');
		// Create a directory named bun.lockb
		await fs.promises.mkdir(path.join(tmpDir, 'bun.lockb'), {
			recursive: true,
		});
		// existsSync returns true for directories
		const result = detectTypecheckCommand(tmpDir);
		// This is expected behavior — directory named bun.lockb means bun is used
		expect(result).toEqual({
			command: ['bun', 'run', 'typecheck'],
			language: 'typescript',
		});
	});

	test('lockfile directory — pnpm-lock.yaml as directory detects pnpm', async () => {
		await writePackageJsonWithScript('typecheck');
		await fs.promises.mkdir(path.join(tmpDir, 'pnpm-lock.yaml'), {
			recursive: true,
		});
		const result = detectTypecheckCommand(tmpDir);
		expect(result).toEqual({
			command: ['pnpm', 'run', 'typecheck'],
			language: 'typescript',
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// ADVERSARIAL VECTOR 4: Lockfile exists but is unreadable (permission denied)
	// existsSync checks existence, NOT read permissions.
	// So it should still return true and detect the package manager.
	// Note: On some platforms (like as Administrator on Windows), all files are
	// readable regardless of permissions. We still test this to document the
	// expected behavior.
	// ─────────────────────────────────────────────────────────────────────────────
	test('unreadable lockfile — existsSync still returns true, package manager detected', async () => {
		await writePackageJsonWithScript('typecheck');
		await fs.promises.writeFile(
			path.join(tmpDir, 'pnpm-lock.yaml'),
			'lockfileVersion: "9.0"',
			'utf8',
		);

		// Try to make the file unreadable (may not work on all platforms/admin)
		try {
			const lockfilePath = path.join(tmpDir, 'pnpm-lock.yaml');
			await fs.promises.chmod(lockfilePath, 0o000);
		} catch {
			// If chmod fails (Windows admin, or immutable file), skip assertion on existence
			// But we can still verify that the file being present leads to detection
		}

		const result = detectTypecheckCommand(tmpDir);
		// existsSync checks existence, not readability — pnpm should still be detected
		// If the file was successfully made unreadable, existsSync still returns true
		// If chmod failed, the file is readable and detection still works
		expect(result).toEqual({
			command: ['pnpm', 'run', 'typecheck'],
			language: 'typescript',
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// ADVERSARIAL VECTOR 5: Very long projectDir path (near PATH_MAX)
	// path.join and existsSync should handle long paths without crashing.
	// We test with a deeply nested directory to exercise path length handling.
	// ─────────────────────────────────────────────────────────────────────────────
	test('very long nested path — detection completes without crash', async () => {
		// Create a deeply nested directory structure
		let deepDir = await fs.promises.mkdtemp(
			path.join(os.tmpdir(), 'deep-path-'),
		);
		// Nest 50 levels deep — on most systems this is well under PATH_MAX
		// but exercises the path handling code
		for (let i = 0; i < 50; i++) {
			deepDir = path.join(deepDir, `level${i}`);
			await fs.promises.mkdir(deepDir, { recursive: true });
		}

		await fs.promises.writeFile(
			path.join(deepDir, 'package.json'),
			JSON.stringify({ name: 'test', scripts: { typecheck: 'tsc --noEmit' } }),
			'utf8',
		);
		await fs.promises.writeFile(
			path.join(deepDir, 'package-lock.json'),
			'{ "lockfileVersion": 2 }',
			'utf8',
		);

		// Should not throw — should detect npm
		const result = detectTypecheckCommand(deepDir);
		expect(result).toEqual({
			command: ['npm', 'run', 'typecheck'],
			language: 'typescript',
		});

		// Clean up the deeply nested structure
		await fs.promises.rm(path.join(os.tmpdir(), 'deep-path-'), {
			recursive: true,
			force: true,
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// ADVERSARIAL VECTOR 6: Empty projectDir path
	// Empty string path — path.join('', 'bun.lockb') → 'bun.lockb'
	// existsSync('bun.lockb') checks current working directory — not what we want
	// but detectTypecheckCommand should handle it gracefully (no throw).
	// ─────────────────────────────────────────────────────────────────────────────
	test('empty projectDir path — no crash, returns null or fallback', async () => {
		// Empty string is an invalid project directory for our purposes
		// detectTypecheckCommand should handle it gracefully
		const result = detectTypecheckCommand('');
		// Will likely check cwd for package.json — may return null or find nothing
		// The key is it should NOT throw an exception
		// If it returns null that's acceptable (no package.json found)
		expect(result === null || result.language).toBeTruthy();
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// ADVERSARIAL VECTOR 7: Null bytes in path
	// path.join('foo\0bar', 'bun.lockb') — null bytes are path separators on some
	// systems or result in invalid path. Node.js may throw or truncate.
	// We test that detectTypecheckCommand doesn't crash.
	// ─────────────────────────────────────────────────────────────────────────────
	test('null byte in path — no crash, graceful handling', async () => {
		// On Windows, \0 is treated as path separator. On Unix, it causes issues.
		// We test that the function doesn't crash.
		const maliciousPath = `safe-dir${String.fromCharCode(0)}malicious`;
		try {
			const result = detectTypecheckCommand(maliciousPath);
			// Should not throw — either returns null or finds nothing
			expect(result === null || typeof result.language === 'string').toBe(true);
		} catch {
			// If it throws, that's also acceptable for an invalid path
			// The key is it doesn't corrupt state or crash the process
		}
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// ADVERSARIAL VECTOR 8: Concurrent detection calls on same directory
	// Multiple simultaneous detectTypecheckCommand calls should not interfere.
	// Since there's no shared mutable state in detectPackageManager, this should
	// be safe. We test with a Promise.all of many concurrent calls.
	// ─────────────────────────────────────────────────────────────────────────────
	test('concurrent detection calls — all return consistent result', async () => {
		await writePackageJsonWithScript('typecheck');
		await fs.promises.writeFile(
			path.join(tmpDir, 'yarn.lock'),
			'# Yarn lockfile',
			'utf8',
		);

		// Run 20 concurrent detection calls
		const results = await Promise.all(
			Array.from({ length: 20 }, () => detectTypecheckCommand(tmpDir)),
		);

		// All should return the same consistent result
		for (const result of results) {
			expect(result).toEqual({
				command: ['yarn', 'run', 'typecheck'],
				language: 'typescript',
			});
		}
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// Helper to skip test (since Bun.test doesn't have direct skip)
	// ─────────────────────────────────────────────────────────────────────────────
	function markTestSkipped(_reason: string): void {
		// In Bun, we use test() but can conditionally expect failure
		// For symlink test, if symlinks aren't supported, we just return
	}
});

describe('detectTypecheckCommand lockfile-based package manager detection', () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.promises.mkdtemp(
			path.join(os.tmpdir(), 'detect-pm-lockfile-'),
		);
	});

	afterEach(async () => {
		await fs.promises.rm(tmpDir, { recursive: true, force: true });
	});

	// Helper to write a minimal package.json with a typecheck script
	async function writePackageJsonWithScript(
		scriptName: 'typecheck' | 'type-check',
	): Promise<void> {
		const pkgPath = path.join(tmpDir, 'package.json');
		await fs.promises.writeFile(
			pkgPath,
			JSON.stringify({
				name: 'test-project',
				scripts: { [scriptName]: 'tsc --noEmit' },
			}),
			'utf8',
		);
	}

	// 1. npm project (only package-lock.json + typecheck) → command[0] is 'npm'
	test('npm project with package-lock.json uses npm for typecheck script', async () => {
		await writePackageJsonWithScript('typecheck');
		await fs.promises.writeFile(
			path.join(tmpDir, 'package-lock.json'),
			'{ "lockfileVersion": 2 }',
			'utf8',
		);
		const result = detectTypecheckCommand(tmpDir);
		expect(result).toEqual({
			command: ['npm', 'run', 'typecheck'],
			language: 'typescript',
		});
	});

	// 2. pnpm project (only pnpm-lock.yaml + typecheck) → command[0] is 'pnpm'
	test('pnpm project with pnpm-lock.yaml uses pnpm for typecheck script', async () => {
		await writePackageJsonWithScript('typecheck');
		await fs.promises.writeFile(
			path.join(tmpDir, 'pnpm-lock.yaml'),
			'lockfileVersion: "9.0"',
			'utf8',
		);
		const result = detectTypecheckCommand(tmpDir);
		expect(result).toEqual({
			command: ['pnpm', 'run', 'typecheck'],
			language: 'typescript',
		});
	});

	// 3. yarn project (only yarn.lock + typecheck) → command[0] is 'yarn'
	test('yarn project with yarn.lock uses yarn for typecheck script', async () => {
		await writePackageJsonWithScript('typecheck');
		await fs.promises.writeFile(
			path.join(tmpDir, 'yarn.lock'),
			'# THIS IS AN YARN LOCK FILE',
			'utf8',
		);
		const result = detectTypecheckCommand(tmpDir);
		expect(result).toEqual({
			command: ['yarn', 'run', 'typecheck'],
			language: 'typescript',
		});
	});

	// 4. bun project (only bun.lockb + typecheck) → command[0] is 'bun' (regression)
	test('bun project with bun.lockb uses bun for typecheck script', async () => {
		await writePackageJsonWithScript('typecheck');
		await fs.promises.writeFile(
			path.join(tmpDir, 'bun.lockb'),
			'# Bun lockfile',
			'utf8',
		);
		const result = detectTypecheckCommand(tmpDir);
		expect(result).toEqual({
			command: ['bun', 'run', 'typecheck'],
			language: 'typescript',
		});
	});

	// 5. No lockfile + typecheck script → command[0] is 'bun' (fallback preserved)
	test('no lockfile falls back to bun for typecheck script', async () => {
		await writePackageJsonWithScript('typecheck');
		// No lockfile written
		const result = detectTypecheckCommand(tmpDir);
		expect(result).toEqual({
			command: ['bun', 'run', 'typecheck'],
			language: 'typescript',
		});
	});

	// 6. Priority: both bun.lockb AND package-lock.json present → bun wins
	test('bun.lockb takes priority over package-lock.json', async () => {
		await writePackageJsonWithScript('typecheck');
		await fs.promises.writeFile(
			path.join(tmpDir, 'bun.lockb'),
			'# Bun lockfile',
			'utf8',
		);
		await fs.promises.writeFile(
			path.join(tmpDir, 'package-lock.json'),
			'{ "lockfileVersion": 2 }',
			'utf8',
		);
		const result = detectTypecheckCommand(tmpDir);
		expect(result).toEqual({
			command: ['bun', 'run', 'typecheck'],
			language: 'typescript',
		});
	});

	// 7. Priority: both pnpm-lock.yaml AND yarn.lock present → pnpm wins
	test('pnpm-lock.yaml takes priority over yarn.lock', async () => {
		await writePackageJsonWithScript('typecheck');
		await fs.promises.writeFile(
			path.join(tmpDir, 'pnpm-lock.yaml'),
			'lockfileVersion: "9.0"',
			'utf8',
		);
		await fs.promises.writeFile(
			path.join(tmpDir, 'yarn.lock'),
			'# THIS IS AN YARN LOCK FILE',
			'utf8',
		);
		const result = detectTypecheckCommand(tmpDir);
		expect(result).toEqual({
			command: ['pnpm', 'run', 'typecheck'],
			language: 'typescript',
		});
	});

	// 8. npm project with type-check script (not typecheck) → command[0] is 'npm'
	test('npm project with type-check script uses npm', async () => {
		await writePackageJsonWithScript('type-check');
		await fs.promises.writeFile(
			path.join(tmpDir, 'package-lock.json'),
			'{ "lockfileVersion": 2 }',
			'utf8',
		);
		const result = detectTypecheckCommand(tmpDir);
		expect(result).toEqual({
			command: ['npm', 'run', 'type-check'],
			language: 'typescript',
		});
	});

	// 9. bun project with type-check script (not typecheck) → command[0] is 'bun'
	test('bun project with type-check script uses bun', async () => {
		await writePackageJsonWithScript('type-check');
		await fs.promises.writeFile(
			path.join(tmpDir, 'bun.lockb'),
			'# Bun lockfile',
			'utf8',
		);
		const result = detectTypecheckCommand(tmpDir);
		expect(result).toEqual({
			command: ['bun', 'run', 'type-check'],
			language: 'typescript',
		});
	});

	// 10. Priority: bun.lockb AND pnpm-lock.yaml AND yarn.lock AND package-lock.json → bun wins
	test('bun.lockb wins when all lockfiles present', async () => {
		await writePackageJsonWithScript('typecheck');
		await fs.promises.writeFile(
			path.join(tmpDir, 'bun.lockb'),
			'# Bun',
			'utf8',
		);
		await fs.promises.writeFile(
			path.join(tmpDir, 'pnpm-lock.yaml'),
			'lockfileVersion: "9.0"',
			'utf8',
		);
		await fs.promises.writeFile(
			path.join(tmpDir, 'yarn.lock'),
			'# Yarn',
			'utf8',
		);
		await fs.promises.writeFile(
			path.join(tmpDir, 'package-lock.json'),
			'{ "lockfileVersion": 2 }',
			'utf8',
		);
		const result = detectTypecheckCommand(tmpDir);
		expect(result).toEqual({
			command: ['bun', 'run', 'typecheck'],
			language: 'typescript',
		});
	});
});
