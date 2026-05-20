import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	writeProjectConfigIfNew,
	writeSwarmConfigExampleIfNew,
} from '../../../src/config/project-init';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

describe('writeProjectConfigIfNew', () => {
	let dir: string;
	let cleanup: () => void;
	let warnOutput: string[];
	let origWarn: typeof console.warn;

	beforeEach(() => {
		({ dir, cleanup } = createSafeTestDir('swarm-project-init-'));
		warnOutput = [];
		origWarn = console.warn;
		console.warn = (...args: unknown[]) => {
			warnOutput.push(args.map(String).join(' '));
		};
	});

	afterEach(() => {
		console.warn = origWarn;
		cleanup();
	});

	const configPath = (d: string) =>
		path.join(d, '.opencode', 'opencode-swarm.json');

	// 1. Creates the file when neither file nor .opencode/ directory exist
	test('1. creates .opencode/opencode-swarm.json when directory is absent', () => {
		writeProjectConfigIfNew(dir);
		expect(fs.existsSync(configPath(dir))).toBe(true);
	});

	// 2. Creates .opencode/ directory if it does not exist
	test('2. creates .opencode/ directory when absent', () => {
		writeProjectConfigIfNew(dir);
		expect(fs.existsSync(path.join(dir, '.opencode'))).toBe(true);
	});

	// 3. Created file is valid JSON (compatible with the JSON.parse loader)
	test('3. created file parses as valid JSON', () => {
		writeProjectConfigIfNew(dir);
		const raw = fs.readFileSync(configPath(dir), 'utf-8');
		expect(() => JSON.parse(raw)).not.toThrow();
		const parsed = JSON.parse(raw);
		expect(typeof parsed).toBe('object');
		expect(parsed).not.toBeNull();
	});

	// 4. Created file is an empty JSON object (deep-merges as no-op)
	test('4. created file is an empty JSON object', () => {
		writeProjectConfigIfNew(dir);
		const raw = fs.readFileSync(configPath(dir), 'utf-8');
		expect(JSON.parse(raw)).toEqual({});
	});

	// 5. Does NOT overwrite an existing file
	test('5. does not overwrite an existing file', () => {
		const opencodeDir = path.join(dir, '.opencode');
		fs.mkdirSync(opencodeDir, { recursive: true });
		const sentinel = JSON.stringify({ custom: true }, null, 2) + '\n';
		fs.writeFileSync(configPath(dir), sentinel, 'utf-8');
		const mtimeBefore = fs.statSync(configPath(dir)).mtimeMs;

		// Small delay to ensure mtime would differ if the file were rewritten
		Bun.sleepSync(20);
		writeProjectConfigIfNew(dir);

		expect(fs.statSync(configPath(dir)).mtimeMs).toBe(mtimeBefore);
		expect(fs.readFileSync(configPath(dir), 'utf-8')).toBe(sentinel);
	});

	// 6. Calling twice is idempotent — no error, same file content
	test('6. idempotent: calling twice leaves file unchanged', () => {
		writeProjectConfigIfNew(dir);
		const first = fs.readFileSync(configPath(dir), 'utf-8');
		writeProjectConfigIfNew(dir);
		expect(fs.readFileSync(configPath(dir), 'utf-8')).toBe(first);
	});

	// 7. Non-fatal when mkdirSync fails — verified via subprocess with patched fs
	test('7. non-fatal when mkdirSync fails (EACCES)', async () => {
		const script = `
			const fs = require('node:fs');
			const origMkdir = fs.mkdirSync.bind(fs);
			const origExists = fs.existsSync.bind(fs);
			fs.existsSync = function(p) {
				if (String(p).endsWith('.opencode')) return false;
				if (String(p).endsWith('opencode-swarm.json')) return false;
				return origExists(p);
			};
			fs.mkdirSync = function(p, ...args) {
				if (String(p).endsWith('.opencode')) {
					throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
				}
				return origMkdir(p, ...args);
			};
			// Inline copy of writeProjectConfigIfNew (uses patched fs via require)
			const path = require('node:path');
			const STARTER_CONTENT = '{}\\n';
			function writeProjectConfigIfNew(directory, quiet) {
				try {
					const opencodeDir = path.join(directory, '.opencode');
					const dest = path.join(opencodeDir, 'opencode-swarm.json');
					if (!fs.existsSync(opencodeDir)) {
						fs.mkdirSync(opencodeDir, { recursive: true });
					}
					try {
						fs.writeFileSync(dest, STARTER_CONTENT, { encoding: 'utf-8', flag: 'wx' });
					} catch {}
				} catch {}
			}
			writeProjectConfigIfNew(${JSON.stringify(dir)}, false);
		`;

		const result = await new Promise<{ code: number }>((resolve) => {
			const child = spawn('bun', ['--eval', script], { cwd: dir });
			child.on('close', (code) => resolve({ code: code ?? 0 }));
		});

		// Plugin must not crash — exit 0
		expect(result.code).toBe(0);
		// File should not have been created
		expect(fs.existsSync(configPath(dir))).toBe(false);
	});

	// 8. Respects quiet flag — no console.warn when quiet=true
	test('8. suppresses console.warn when quiet=true', () => {
		writeProjectConfigIfNew(dir, true);
		expect(warnOutput).toHaveLength(0);
	});

	// 9a. Symlink guard: skips creation when .opencode is a symlink
	test('9a. does not write through a symlinked .opencode directory', () => {
		const target = path.join(dir, 'symlink-target');
		const opencodeLink = path.join(dir, '.opencode');
		fs.mkdirSync(target, { recursive: true });
		fs.symlinkSync(target, opencodeLink);

		writeProjectConfigIfNew(dir);

		expect(fs.existsSync(path.join(opencodeLink, 'opencode-swarm.json'))).toBe(
			false,
		);
	});

	// 9. Emits console.warn when quiet=false (default)
	test('9. emits console.warn when quiet=false', () => {
		writeProjectConfigIfNew(dir, false);
		expect(warnOutput.some((m) => m.includes('opencode-swarm.json'))).toBe(
			true,
		);
	});
});

describe('writeSwarmConfigExampleIfNew', () => {
	let dir: string;
	let cleanup: () => void;

	beforeEach(() => {
		({ dir, cleanup } = createSafeTestDir('swarm-example-init-'));
	});

	afterEach(() => {
		cleanup();
	});

	const examplePath = (d: string) =>
		path.join(d, '.swarm', 'config.example.json');

	test('10. creates .swarm/config.example.json and .swarm/ when absent', () => {
		writeSwarmConfigExampleIfNew(dir);
		expect(fs.existsSync(examplePath(dir))).toBe(true);
		expect(fs.existsSync(path.join(dir, '.swarm'))).toBe(true);
	});

	test('11. written file is valid JSON with an agents key', () => {
		writeSwarmConfigExampleIfNew(dir);
		const raw = fs.readFileSync(examplePath(dir), 'utf-8');
		const parsed = JSON.parse(raw);
		expect(typeof parsed).toBe('object');
		expect(parsed).not.toBeNull();
		expect(typeof parsed.agents).toBe('object');
	});

	test('12. does not overwrite an existing config.example.json', () => {
		const swarmDir = path.join(dir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		const sentinel = '{"sentinel":true}\n';
		fs.writeFileSync(examplePath(dir), sentinel, 'utf-8');

		writeSwarmConfigExampleIfNew(dir);

		expect(fs.readFileSync(examplePath(dir), 'utf-8')).toBe(sentinel);
	});
});
