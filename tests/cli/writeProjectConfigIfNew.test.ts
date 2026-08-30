import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	CONFIG_SCHEMA_REF,
	writeProjectConfigIfNew,
} from '../../src/config/project-init';
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

	// 1. .opencode/opencode-swarm.json created in cwd
	test('1. creates .opencode/opencode-swarm.json in cwd', () => {
		writeProjectConfigIfNew(tmpDir);

		const configPath = path.join(tmpDir, '.opencode', 'opencode-swarm.json');
		expect(fs.existsSync(configPath)).toBe(true);
	});

	// 2. File is valid JSON containing only the $schema reference (issue #1663)
	test('2. file is valid JSON containing only the $schema reference', () => {
		writeProjectConfigIfNew(tmpDir);

		const configPath = path.join(tmpDir, '.opencode', 'opencode-swarm.json');
		const content = fs.readFileSync(configPath, 'utf-8');
		const parsed = JSON.parse(content) as Record<string, unknown>;
		expect(Object.keys(parsed)).toEqual(['$schema']);
		expect(parsed.$schema).toBe(CONFIG_SCHEMA_REF);
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

	// 4. Epic #1752 PR2: advisory now routes through advisoryWarn (buffered for
	// /swarm diagnose) regardless of quiet. console.warn is never called.
	test('4. quiet=true routes advisory to buffer, never raw stderr', () => {
		let warned = false;
		console.warn = (..._args: unknown[]) => {
			warned = true;
		};

		writeProjectConfigIfNew(tmpDir, true);

		expect(warned).toBe(false);
		expect(
			getDeferredWarnings().some((m) => m.includes('opencode-swarm.json')),
		).toBe(true);
	});

	// 5. Epic #1752 PR2: even with quiet=false the advisory routes through
	// advisoryWarn (never raw stderr).
	test('5. quiet=false routes advisory to buffer, never raw stderr', () => {
		let warned = false;
		console.warn = (..._args: unknown[]) => {
			warned = true;
		};

		writeProjectConfigIfNew(tmpDir, false);

		expect(warned).toBe(false);
		expect(
			getDeferredWarnings().some((m) => m.includes('opencode-swarm.json')),
		).toBe(true);
	});
});
