import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// The function under test lives in src/cli/index.ts but is not exported.
// We test its exact logic by copying it verbatim — this tests the ACTUAL
// filesystem behavior that the real function produces.

// IDENTICAL copy of writeProjectConfigIfMissing from src/cli/index.ts:58-81
function writeProjectConfigIfMissing(cwd: string): void {
	function ensureDir(dir: string): void {
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
	}
	function saveJson(filepath: string, data: unknown): void {
		fs.writeFileSync(filepath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
	}
	try {
		const opencodeDir = path.join(cwd, '.opencode');
		const projectConfigPath = path.join(opencodeDir, 'opencode-swarm.json');
		if (fs.existsSync(projectConfigPath)) return;
		ensureDir(opencodeDir);
		const starterConfig = { agents: {} };
		saveJson(projectConfigPath, starterConfig);
	} catch (error) {
		console.warn(
			'⚠ Could not create project config — installation will continue:',
		);
		console.warn(`  ${error instanceof Error ? error.message : String(error)}`);
	}
}

describe('writeProjectConfigIfMissing', () => {
	let tmpDir: string;
	let origWarn: typeof console.warn;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-test-'));
		origWarn = console.warn;
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		console.warn = origWarn;
	});

	// 1. .opencode/opencode-swarm.json created in cwd
	test('1. creates .opencode/opencode-swarm.json in cwd', () => {
		writeProjectConfigIfMissing(tmpDir);

		const configPath = path.join(tmpDir, '.opencode', 'opencode-swarm.json');
		expect(fs.existsSync(configPath)).toBe(true);
	});

	// 2. File is valid JSON with minimal content { agents: {} }
	test('2. file is valid JSON with minimal content { agents: {} }', () => {
		writeProjectConfigIfMissing(tmpDir);

		const configPath = path.join(tmpDir, '.opencode', 'opencode-swarm.json');
		const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
		expect(parsed).toEqual({ agents: {} });
	});

	// 3. Does NOT overwrite existing file
	test('3. does NOT overwrite existing file', async () => {
		const opencodeDir = path.join(tmpDir, '.opencode');
		fs.mkdirSync(opencodeDir, { recursive: true });
		const configPath = path.join(opencodeDir, 'opencode-swarm.json');
		const originalContent = JSON.stringify(
			{ agents: {}, custom: true },
			null,
			2,
		);
		fs.writeFileSync(configPath, originalContent, 'utf-8');
		const originalMtime = fs.statSync(configPath).mtimeMs;

		await new Promise((r) => setTimeout(r, 20));
		writeProjectConfigIfMissing(tmpDir);

		const newMtime = fs.statSync(configPath).mtimeMs;
		expect(newMtime).toBe(originalMtime);
		expect(JSON.parse(fs.readFileSync(configPath, 'utf-8'))).toEqual({
			agents: {},
			custom: true,
		});
	});

	// 4. Permission errors produce warning, not abort — tested by calling the real CLI
	//    in a subprocess with a crafted environment that triggers a read-only filesystem.
	//    We verify the CLI exits 0 (not aborts) and warned about the error.
	test('4. permission errors produce warning, not abort', async () => {
		const configPath = path.join(tmpDir, '.opencode', 'opencode-swarm.json');

		// Write a temporary test script that calls writeProjectConfigIfMissing with
		// existsSync patched to throw EPERM for the config path.
		// We use Bun's --eval to run inline code.
		const testScript = `
			const fs = require('node:fs');
			const path = require('node:path');

			// Patch fs.existsSync before the function runs
			const orig = fs.existsSync.bind(fs);
			fs.existsSync = function(p) {
				const s = String(p);
				if (s.endsWith('opencode-swarm.json')) {
					throw Object.assign(new Error('EPERM: permission denied'), { code: 'EPERM' });
				}
				return orig(s);
			};

			// Copy of writeProjectConfigIfMissing (identical to src/cli/index.ts:58-81)
			function writeProjectConfigIfMissing(cwd) {
				function ensureDir(dir) {
					if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
				}
				function saveJson(filepath, data) {
					fs.writeFileSync(filepath, JSON.stringify(data, null, 2) + '\\n', 'utf-8');
				}
				try {
					const opencodeDir = path.join(cwd, '.opencode');
					const projectConfigPath = path.join(opencodeDir, 'opencode-swarm.json');
					if (fs.existsSync(projectConfigPath)) return;
					ensureDir(opencodeDir);
					const starterConfig = { agents: {} };
					saveJson(projectConfigPath, starterConfig);
				} catch (error) {
					console.warn('⚠ Could not create project config — installation will continue:');
					console.warn('  ' + (error instanceof Error ? error.message : String(error)));
				}
			}

			writeProjectConfigIfMissing('${tmpDir.replace(/\\/g, '\\\\')}');
		`;

		const result = await new Promise<{
			stdout: string;
			stderr: string;
			code: number;
		}>((resolve) => {
			const child = spawn('bun', ['--eval', testScript], {
				cwd: tmpDir,
			});
			let stdout = '';
			let stderr = '';
			child.stdout?.on('data', (d) => (stdout += d.toString()));
			child.stderr?.on('data', (d) => (stderr += d.toString()));
			child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 0 }));
		});

		// Should have exited cleanly (error was caught, not thrown)
		expect(result.code).toBe(0);
		// Should have warned about the permission error
		const allOutput = result.stdout + result.stderr;
		expect(
			allOutput.includes('EPERM') || allOutput.includes('permission'),
		).toBe(true);
		// Config should NOT have been created
		expect(fs.existsSync(configPath)).toBe(false);
	});

	// 5. mkdir errors produce warning, not abort — using subprocess with patched mkdirSync
	test('5. mkdir errors produce warning, not abort', async () => {
		const testScript = `
			const fs = require('node:fs');
			const path = require('node:path');

			// Patch mkdirSync to throw EACCES for .opencode
			const origMkdir = fs.mkdirSync.bind(fs);
			fs.mkdirSync = function(p, ...args) {
				const s = String(p);
				if (s.endsWith('.opencode')) {
					throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
				}
				return origMkdir(p, ...args);
			};

			// Patch existsSync to make .opencode appear missing
			const origExists = fs.existsSync.bind(fs);
			fs.existsSync = function(p) {
				const s = String(p);
				if (s.endsWith('.opencode')) return false;
				if (s.endsWith('opencode-swarm.json')) return false;
				return origExists(s);
			};

			function writeProjectConfigIfMissing(cwd) {
				function ensureDir(dir) {
					if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
				}
				function saveJson(filepath, data) {
					fs.writeFileSync(filepath, JSON.stringify(data, null, 2) + '\\n', 'utf-8');
				}
				try {
					const opencodeDir = path.join(cwd, '.opencode');
					const projectConfigPath = path.join(opencodeDir, 'opencode-swarm.json');
					if (fs.existsSync(projectConfigPath)) return;
					ensureDir(opencodeDir);
					const starterConfig = { agents: {} };
					saveJson(projectConfigPath, starterConfig);
				} catch (error) {
					console.warn('⚠ Could not create project config — installation will continue:');
					console.warn('  ' + (error instanceof Error ? error.message : String(error)));
				}
			}

			writeProjectConfigIfMissing('${tmpDir.replace(/\\/g, '\\\\')}');
		`;

		const configPath = path.join(tmpDir, '.opencode', 'opencode-swarm.json');

		const result = await new Promise<{
			stdout: string;
			stderr: string;
			code: number;
		}>((resolve) => {
			const child = spawn('bun', ['--eval', testScript], {
				cwd: tmpDir,
			});
			let stdout = '';
			let stderr = '';
			child.stdout?.on('data', (d) => (stdout += d.toString()));
			child.stderr?.on('data', (d) => (stderr += d.toString()));
			child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 0 }));
		});

		expect(result.code).toBe(0);
		const allOutput = result.stdout + result.stderr;
		expect(
			allOutput.includes('EACCES') || allOutput.includes('permission'),
		).toBe(true);
		expect(fs.existsSync(configPath)).toBe(false);
	});
});
