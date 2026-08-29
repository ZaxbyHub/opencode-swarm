import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeProjectConfigIfNew } from '../../src/config/project-init';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../src/services/warning-buffer';

describe('writeProjectConfigIfNew', () => {
	let tmpDir: string;
	let origWarn: typeof console.warn;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-test-'));
		origWarn = console.warn;
		// Epic #1752 PR2: advisoryWarn writes to the module-level deferred-warning
		// buffer. Clear it between tests (AGENTS.md Invariant 7).
		clearDeferredWarnings();
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		console.warn = origWarn;
		clearDeferredWarnings();
	});

	// 1. Project config is not auto-created
	test('1. does not create .opencode/opencode-swarm.json in cwd', () => {
		writeProjectConfigIfNew(tmpDir);

		const configPath = path.join(tmpDir, '.opencode', 'opencode-swarm.json');
		expect(fs.existsSync(configPath)).toBe(false);
	});

	// 2. .opencode directory is not auto-created
	test('2. does not create .opencode directory', () => {
		writeProjectConfigIfNew(tmpDir);
		expect(fs.existsSync(path.join(tmpDir, '.opencode'))).toBe(false);
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

	// 4. No warning is emitted when skipping auto-creation.
	test('4. quiet=true does not emit warning', () => {
		let warned = false;
		console.warn = (..._args: unknown[]) => {
			warned = true;
		};

		writeProjectConfigIfNew(tmpDir, true);

		expect(warned).toBe(false);
		expect(getDeferredWarnings()).toHaveLength(0);
	});

	test('5. quiet=false does not emit warning', () => {
		let warned = false;
		console.warn = (..._args: unknown[]) => {
			warned = true;
		};

		writeProjectConfigIfNew(tmpDir, false);

		expect(warned).toBe(false);
		expect(getDeferredWarnings()).toHaveLength(0);
	});
});
