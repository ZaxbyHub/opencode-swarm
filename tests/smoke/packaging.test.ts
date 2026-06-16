import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '../../');
const MAIN_BUNDLE_MAX_BYTES = 5.5 * 1024 * 1024;

describe('packaging smoke tests', () => {
	test('dist/index.js exists', () => {
		expect(existsSync(path.join(ROOT, 'dist/index.js'))).toBe(true);
	});

	test('dist/index.d.ts exists', () => {
		expect(existsSync(path.join(ROOT, 'dist/index.d.ts'))).toBe(true);
	});

	test('dist/cli/index.js exists', () => {
		expect(existsSync(path.join(ROOT, 'dist/cli/index.js'))).toBe(true);
	});

	test('dist/index.js is importable and exports a v1 plugin object', async () => {
		const mod = await import(path.join(ROOT, 'dist/index.js'));
		expect(typeof mod.default).toBe('object');
		expect(mod.default).toHaveProperty('id');
		expect(mod.default).toHaveProperty('server');
	});

	test('v1 plugin object has correct id and server properties', async () => {
		const mod = await import(path.join(ROOT, 'dist/index.js'));
		expect(mod.default.id).toBe('opencode-swarm');
		expect(typeof mod.default.server).toBe('function');
	});

	test('server function returns plugin object with config hook', async () => {
		const mod = await import(path.join(ROOT, 'dist/index.js'));
		const plugin = await mod.default.server({ directory: ROOT });
		expect(plugin.config).toBeDefined();
		expect(typeof plugin.config).toBe('function');
	});

	test('dist/index.js file size is reasonable (< 5.5MB)', () => {
		const stats = Bun.file(path.join(ROOT, 'dist/index.js'));
		// Raised from 5MiB by #1302 Wave 2's eval-gated skill machinery and
		// #1263 config-doctor validation expansion: 62+ switch cases, Levenshtein
		// suggestion, atomic writes, symlink rejection; keep the cap narrow so
		// future bundle growth remains visible in smoke CI.
		expect(stats.size).toBeLessThan(MAIN_BUNDLE_MAX_BYTES);
		// But should be at least 10KB (non-empty)
		expect(stats.size).toBeGreaterThan(10 * 1024);
	});

	test('dist/cli/index.js file size is reasonable (< 2.4MB)', () => {
		const stats = Bun.file(path.join(ROOT, 'dist/cli/index.js'));
		// CLI bundle should be under 2.4MB (raised from 2.2MB due to #1234
		// auto-triage commands + success-motif learning machinery plus
		// first-class full-auto toggle — status subcommand, mode parsing)
		expect(stats.size).toBeLessThan(2.4 * 1024 * 1024);
		// But should be at least 1KB (non-empty)
		expect(stats.size).toBeGreaterThan(1 * 1024);
	});

	test('package.json has no postinstall script', async () => {
		const pkg = await import(path.join(ROOT, 'package.json'), {
			with: { type: 'json' },
		});
		expect(pkg.default?.scripts?.postinstall).toBeUndefined();
	});

	test('dist/lang/grammars/ directory exists with WASM files', () => {
		const grammarsDir = path.join(ROOT, 'dist/lang/grammars');
		expect(existsSync(grammarsDir)).toBe(true);
		// Should contain at least one .wasm file
		const { readdirSync } = require('node:fs');
		const wasmFiles = readdirSync(grammarsDir).filter((f: string) =>
			f.endsWith('.wasm'),
		);
		expect(wasmFiles.length).toBeGreaterThan(0);
	});
});
