import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeProjectConfigIfNew } from '../../src/config/project-init';

describe('writeProjectConfigIfNew', () => {
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
		writeProjectConfigIfNew(tmpDir);

		const configPath = path.join(tmpDir, '.opencode', 'opencode-swarm.json');
		expect(fs.existsSync(configPath)).toBe(true);
	});

	// 2. File is valid JSON with minimal content {}
	test('2. file is valid JSON with minimal content {}', () => {
		writeProjectConfigIfNew(tmpDir);

		const configPath = path.join(tmpDir, '.opencode', 'opencode-swarm.json');
		const content = fs.readFileSync(configPath, 'utf-8');
		const parsed = JSON.parse(content);
		expect(parsed).toEqual({});
	});

	// 3. Does NOT overwrite existing file
	test('3. does NOT overwrite existing file', async () => {
		const opencodeDir = path.join(tmpDir, '.opencode');
		fs.mkdirSync(opencodeDir, { recursive: true });
		const configPath = path.join(opencodeDir, 'opencode-swarm.json');
		const originalContent = JSON.stringify({ custom: true }, null, 2);
		fs.writeFileSync(configPath, originalContent, 'utf-8');
		const originalMtime = fs.statSync(configPath).mtimeMs;

		await new Promise((r) => setTimeout(r, 20));
		writeProjectConfigIfNew(tmpDir);

		const newMtime = fs.statSync(configPath).mtimeMs;
		expect(newMtime).toBe(originalMtime);
		expect(JSON.parse(fs.readFileSync(configPath, 'utf-8'))).toEqual({
			custom: true,
		});
	});

	// 4. Quiet mode suppresses success console.warn
	test('4. quiet mode suppresses success console.warn', () => {
		let warned = false;
		console.warn = (..._args: unknown[]) => {
			warned = true;
		};

		writeProjectConfigIfNew(tmpDir, true);

		expect(warned).toBe(false);
	});

	// 5. Non-quiet mode emits success console.warn
	test('5. non-quiet mode emits success console.warn', () => {
		let warned = false;
		console.warn = (..._args: unknown[]) => {
			warned = true;
		};

		writeProjectConfigIfNew(tmpDir, false);

		expect(warned).toBe(true);
	});
});
