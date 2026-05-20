import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Trigger backend registration before importing dispatch.
import '../../../src/lang/backends';
import {
	clearDispatchCache,
	_internals as dispatchInternals,
	pickBackend,
} from '../../../src/lang/dispatch';

describe('pickBackend — language detection + caching', () => {
	let tempDir: string;

	beforeEach(() => {
		// mkdtempSync + realpathSync — the latter is required on macOS where
		// /var → /private/var symlinks otherwise break path comparisons in
		// downstream tools (Invariant 7 — writing-tests skill).
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-test-')),
		);
		clearDispatchCache();
	});

	afterEach(() => {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
		clearDispatchCache();
	});

	test('returns null when no manifest is present', async () => {
		const backend = await pickBackend(tempDir);
		expect(backend).toBeNull();
	});

	test('returns the typescript backend for a directory containing package.json', async () => {
		fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name":"x"}');
		const backend = await pickBackend(tempDir);
		expect(backend).not.toBeNull();
		expect(backend!.id).toBe('typescript');
	});

	test('returns a default-backend (rust) for Cargo.toml', async () => {
		fs.writeFileSync(path.join(tempDir, 'Cargo.toml'), '[package]\nname="x"\n');
		const backend = await pickBackend(tempDir);
		expect(backend).not.toBeNull();
		expect(backend!.id).toBe('rust');
		// Rust gets the default backend (no override registered in Phase 2).
		// Verify default behavior is wired: extractImports returns [].
		expect(backend!.extractImports!('foo.rs', 'use std::io;')).toEqual([]);
	});

	test('typescript wins the tier-1 tie against python (deterministic by registration order)', async () => {
		// detectProjectLanguages returns profiles tier-sorted (lowest first).
		// Both typescript and python are tier 1; on a tie, V8/Bun's stable
		// sort preserves the registration order in `profiles.ts`. typescript
		// registers first, so it wins. Asserting strict equality locks this
		// — if a future PR re-orders profile registration, this test fails
		// loudly and the contributor must either update this assertion or
		// add a stable secondary sort key in detector.ts.
		fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name":"x"}');
		fs.writeFileSync(path.join(tempDir, 'pyproject.toml'), '[tool.poetry]\n');
		const backend = await pickBackend(tempDir);
		expect(backend).not.toBeNull();
		expect(backend!.id).toBe('typescript');
	});

	test('walks up to find the manifest root', async () => {
		const subdir = path.join(tempDir, 'src', 'utils');
		fs.mkdirSync(subdir, { recursive: true });
		fs.writeFileSync(path.join(tempDir, 'Cargo.toml'), '[package]\nname="x"\n');
		const backend = await pickBackend(subdir);
		expect(backend).not.toBeNull();
		expect(backend!.id).toBe('rust');
	});

	test('caches results and reuses them on identical manifest hash', async () => {
		fs.writeFileSync(path.join(tempDir, 'Cargo.toml'), '[package]\n');
		let detectCalls = 0;
		const realDetect = dispatchInternals.detectProjectLanguages;
		dispatchInternals.detectProjectLanguages = async (dir) => {
			detectCalls++;
			return realDetect(dir);
		};
		try {
			await pickBackend(tempDir);
			await pickBackend(tempDir);
			await pickBackend(tempDir);
			expect(detectCalls).toBe(1); // second + third calls hit cache
		} finally {
			dispatchInternals.detectProjectLanguages = realDetect;
		}
	});

	test('invalidates cache when manifest content changes', async () => {
		const manifestPath = path.join(tempDir, 'Cargo.toml');
		fs.writeFileSync(manifestPath, '[package]\nname="x"\n');
		await pickBackend(tempDir);

		// Wait long enough for mtime granularity (HFS+ on older macOS rounds
		// to seconds; ext4 to microseconds; bun's fs.statSync uses mtimeMs).
		await new Promise((r) => setTimeout(r, 50));
		fs.writeFileSync(manifestPath, '[package]\nname="x-updated"\n');

		let detectCalls = 0;
		const realDetect = dispatchInternals.detectProjectLanguages;
		dispatchInternals.detectProjectLanguages = async (dir) => {
			detectCalls++;
			return realDetect(dir);
		};
		try {
			await pickBackend(tempDir);
			expect(detectCalls).toBe(1); // cache miss because hash changed
		} finally {
			dispatchInternals.detectProjectLanguages = realDetect;
		}
	});

	test('cache LRU evicts oldest entry when capacity exceeded', async () => {
		const realCapacity = dispatchInternals.cacheCapacity;
		dispatchInternals.cacheCapacity = 3;
		try {
			const dirs: string[] = [];
			for (let i = 0; i < 4; i++) {
				const d = fs.realpathSync(
					fs.mkdtempSync(path.join(os.tmpdir(), `dispatch-lru-${i}-`)),
				);
				fs.writeFileSync(
					path.join(d, 'Cargo.toml'),
					`[package]\nname="x${i}"\n`,
				);
				dirs.push(d);
				await pickBackend(d);
			}
			// After 4 inserts with capacity 3, the first dir should be evicted.
			let detectCalls = 0;
			const realDetect = dispatchInternals.detectProjectLanguages;
			dispatchInternals.detectProjectLanguages = async (dir) => {
				detectCalls++;
				return realDetect(dir);
			};
			try {
				await pickBackend(dirs[0]); // evicted — re-detect
				expect(detectCalls).toBe(1);
				await pickBackend(dirs[3]); // still cached
				expect(detectCalls).toBe(1);
			} finally {
				dispatchInternals.detectProjectLanguages = realDetect;
			}

			for (const d of dirs) {
				try {
					fs.rmSync(d, { recursive: true, force: true });
				} catch {
					// best-effort
				}
			}
		} finally {
			dispatchInternals.cacheCapacity = realCapacity;
		}
	});
});
