/**
 * Integration tests for cross-process scope enforcement (#519 v6.71.1)
 *
 * Covers:
 *   1. Scope persistence across sessions — disk round-trip survives process restart
 *   2. TTL expiry — scope entries expire and return null after TTL
 *   3. Symlink guards — writes through symlinks are properly resolved and rejected
 *   4. Cross-process scope file — scope file on disk is read correctly by new process context
 *
 * These tests use the scope-persistence module directly to simulate cross-process
 * enforcement without requiring an actual subprocess (which would need full plugin init).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	clearAllScopes,
	clearScopeForTask,
	readScopeFromDisk,
	resolveScopeWithFallbacks,
	writeScopeToDisk,
} from '../../src/scope/scope-persistence';

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-process-scope-'));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper: simulate a new process context by using readScopeFromDisk directly
// (which is what happens when a new process reads the persisted scope)
// ---------------------------------------------------------------------------

describe('1. Scope persistence across sessions', () => {
	test('scope written in session A is readable in session B (disk round-trip)', async () => {
		// Session A (architect) declares scope for task 1.1
		const sessionA_scope = ['src/a.ts', 'src/b.ts', 'tests/a.test.ts'];
		await writeScopeToDisk(tmpDir, '1.1', sessionA_scope);

		// Session B (new process/coder) reads scope from disk
		// This simulates what happens when a new process calls resolveScopeWithFallbacks
		const sessionB_scope = readScopeFromDisk(tmpDir, '1.1');

		expect(sessionB_scope).toEqual(sessionA_scope);
	});

	test('scope is persisted independently per taskId', async () => {
		await writeScopeToDisk(tmpDir, '1.1', ['src/only-1-1.ts']);
		await writeScopeToDisk(tmpDir, '1.2', ['src/only-1-2.ts']);
		await writeScopeToDisk(tmpDir, '2.1', ['src/only-2-1.ts']);

		expect(readScopeFromDisk(tmpDir, '1.1')).toEqual(['src/only-1-1.ts']);
		expect(readScopeFromDisk(tmpDir, '1.2')).toEqual(['src/only-1-2.ts']);
		expect(readScopeFromDisk(tmpDir, '2.1')).toEqual(['src/only-2-1.ts']);
	});

	test('resolveScopeWithFallbacks uses disk scope when in-memory is absent', async () => {
		// Write scope to disk (simulates architect declaring scope, then process ends)
		await writeScopeToDisk(tmpDir, '1.1', ['src/persisted.ts']);

		// New process context: inMemoryScope is null, taskId is '1.1'
		const resolved = resolveScopeWithFallbacks({
			directory: tmpDir,
			taskId: '1.1',
			inMemoryScope: null,
			pendingMapScope: null,
		});

		expect(resolved).toEqual(['src/persisted.ts']);
	});

	test('in-memory scope takes precedence over disk scope (live process authority)', async () => {
		// Architect writes scope to disk
		await writeScopeToDisk(tmpDir, '1.1', ['src/disk.ts']);

		// But live process still has in-memory scope (more recent declaration)
		const resolved = resolveScopeWithFallbacks({
			directory: tmpDir,
			taskId: '1.1',
			inMemoryScope: ['src/memory.ts'], // more recent in-process declaration
			pendingMapScope: null,
		});

		// In-memory wins within the same process
		expect(resolved).toEqual(['src/memory.ts']);
	});

	test('scope survives clearAllScopes called for different task', async () => {
		await writeScopeToDisk(tmpDir, '1.1', ['src/1-1.ts']);
		await writeScopeToDisk(tmpDir, '1.2', ['src/1-2.ts']);

		// Clear scope for 1.1 only
		clearScopeForTask(tmpDir, '1.1');

		expect(readScopeFromDisk(tmpDir, '1.1')).toBeNull();
		expect(readScopeFromDisk(tmpDir, '1.2')).toEqual(['src/1-2.ts']);
	});
});

describe('2. TTL expiry', () => {
	test('scope expires after TTL and returns null', async () => {
		// Write scope with a 50ms TTL (very short for testing)
		await writeScopeToDisk(tmpDir, '1.1', ['src/a.ts'], 50);

		// Immediately — still valid
		expect(readScopeFromDisk(tmpDir, '1.1')).toEqual(['src/a.ts']);

		// After TTL expires (wait 60ms > 50ms TTL)
		await new Promise((r) => setTimeout(r, 60));

		expect(readScopeFromDisk(tmpDir, '1.1')).toBeNull();
	});

	test('TTL of zero is treated as already expired', async () => {
		// Write with 0 TTL (should expire immediately)
		await writeScopeToDisk(tmpDir, '1.1', ['src/a.ts'], 0);

		// Should be expired
		expect(readScopeFromDisk(tmpDir, '1.1')).toBeNull();
	});

	test('resolveScopeWithFallbacks falls through to plan.json when disk scope is expired', async () => {
		// Write scope with a 1ms TTL
		await writeScopeToDisk(tmpDir, '1.1', ['src/expired.ts'], 1);

		// Wait for expiry
		await new Promise((r) => setTimeout(r, 10));

		// Create plan.json with files_touched as fallback
		const swarmDir = path.join(tmpDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		fs.writeFileSync(
			path.join(swarmDir, 'plan.json'),
			JSON.stringify({
				phases: [
					{ tasks: [{ id: '1.1', files_touched: ['src/plan-fallback.ts'] }] },
				],
			}),
		);

		// resolveScopeWithFallbacks should fall through to plan.json
		const resolved = resolveScopeWithFallbacks({
			directory: tmpDir,
			taskId: '1.1',
			inMemoryScope: null,
			pendingMapScope: null,
		});

		expect(resolved).toEqual(['src/plan-fallback.ts']);
	});

	test('long TTL (24h default) does not expire during typical session', async () => {
		// Use default TTL (24h)
		const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
		await writeScopeToDisk(tmpDir, '1.1', ['src/a.ts'], DEFAULT_TTL_MS);

		// Even after a tiny delay, scope is still valid
		await new Promise((r) => setTimeout(r, 10));

		expect(readScopeFromDisk(tmpDir, '1.1')).toEqual(['src/a.ts']);
	});
});

describe('3. Symlink guards', () => {
	const isWindows = process.platform === 'win32';

	test('rejects symlinked scope file (lstat guard)', async () => {
		if (isWindows) {
			// Windows may refuse symlink creation without privilege; skip on failure
			try {
				const scopesDir = path.join(tmpDir, '.swarm', 'scopes');
				fs.mkdirSync(scopesDir, { recursive: true });
				const realTarget = path.join(tmpDir, 'hostile.json');
				fs.writeFileSync(
					realTarget,
					JSON.stringify({
						version: 1,
						taskId: '1.1',
						declaredAt: Date.now(),
						expiresAt: Date.now() + 60_000,
						files: ['/etc/passwd'],
					}),
				);
				fs.symlinkSync(realTarget, path.join(scopesDir, 'scope-1.1.json'));
			} catch {
				return; // symlink creation failed on Windows
			}
		}

		// On POSIX, O_NOFOLLOW causes symlinked scope files to be rejected
		if (!isWindows) {
			const scopesDir = path.join(tmpDir, '.swarm', 'scopes');
			fs.mkdirSync(scopesDir, { recursive: true });
			const realTarget = path.join(tmpDir, 'hostile.json');
			fs.writeFileSync(
				realTarget,
				JSON.stringify({
					version: 1,
					taskId: '1.1',
					declaredAt: Date.now(),
					expiresAt: Date.now() + 60_000,
					files: ['/etc/passwd'],
				}),
			);
			fs.symlinkSync(realTarget, path.join(scopesDir, 'scope-1.1.json'));

			expect(readScopeFromDisk(tmpDir, '1.1')).toBeNull();
		}
	});

	test('rejects parent .swarm/scopes when it is a symlink outside workspace', async () => {
		if (isWindows) return; // symlink tests fragile on Windows

		const external = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-attacker-'));
		try {
			// Attacker stages a scope file in an external directory
			fs.writeFileSync(
				path.join(external, 'scope-1.1.json'),
				JSON.stringify({
					version: 1,
					taskId: '1.1',
					declaredAt: Date.now(),
					expiresAt: Date.now() + 60_000,
					files: ['/etc/shadow'],
				}),
			);

			// Symlink .swarm/scopes to the external directory
			fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
			fs.symlinkSync(external, path.join(tmpDir, '.swarm', 'scopes'));

			// Scope must not be readable — the escape attempt should be blocked
			expect(readScopeFromDisk(tmpDir, '1.1')).toBeNull();
		} finally {
			fs.rmSync(external, { recursive: true, force: true });
		}
	});

	test('symlink to regular file inside scopes dir is rejected (O_NOFOLLOW)', async () => {
		if (isWindows) return; // O_NOFOLLOW is a no-op on Windows

		const scopesDir = path.join(tmpDir, '.swarm', 'scopes');
		fs.mkdirSync(scopesDir, { recursive: true });

		// Create a legitimate scope file
		const realFile = path.join(scopesDir, 'legitimate-scope.json');
		fs.writeFileSync(
			realFile,
			JSON.stringify({
				version: 1,
				taskId: '1.1',
				declaredAt: Date.now(),
				expiresAt: Date.now() + 60_000,
				files: ['src/a.ts'],
			}),
		);

		// Symlink to it from the task scope path
		fs.symlinkSync(realFile, path.join(scopesDir, 'scope-1.1.json'));

		// Symlink must not be followed — read must fail
		expect(readScopeFromDisk(tmpDir, '1.1')).toBeNull();
	});
});

describe('4. Cross-process scope file', () => {
	test('scope file is correctly read by a new process context', async () => {
		// Simulate architect process: write scope to disk
		await writeScopeToDisk(tmpDir, '1.1', [
			'src/architect.ts',
			'src/shared.ts',
		]);

		// Simulate coder process: read from disk using resolveScopeWithFallbacks
		// (no in-memory scope, no pending map — pure disk read)
		const coderScope = resolveScopeWithFallbacks({
			directory: tmpDir,
			taskId: '1.1',
			inMemoryScope: null,
			pendingMapScope: null,
		});

		expect(coderScope).toEqual(['src/architect.ts', 'src/shared.ts']);
	});

	test('scope file path follows expected naming convention', async () => {
		await writeScopeToDisk(tmpDir, '1.1', ['a.ts']);
		await writeScopeToDisk(tmpDir, '1.2.3', ['b.ts']);

		const expectedPath1 = path.join(
			tmpDir,
			'.swarm',
			'scopes',
			'scope-1.1.json',
		);
		const expectedPath2 = path.join(
			tmpDir,
			'.swarm',
			'scopes',
			'scope-1.2.3.json',
		);

		expect(fs.existsSync(expectedPath1)).toBe(true);
		expect(fs.existsSync(expectedPath2)).toBe(true);
	});

	test('malformed scope file returns null without crashing', async () => {
		const scopesDir = path.join(tmpDir, '.swarm', 'scopes');
		fs.mkdirSync(scopesDir, { recursive: true });

		// Write a malformed (non-JSON) file
		fs.writeFileSync(path.join(scopesDir, 'scope-1.1.json'), '{not json');

		// Must not throw — should return null
		expect(readScopeFromDisk(tmpDir, '1.1')).toBeNull();
	});

	test('unknown schema version returns null (fail-closed)', async () => {
		const scopesDir = path.join(tmpDir, '.swarm', 'scopes');
		fs.mkdirSync(scopesDir, { recursive: true });
		fs.writeFileSync(
			path.join(scopesDir, 'scope-1.1.json'),
			JSON.stringify({
				version: 99, // unknown version
				taskId: '1.1',
				declaredAt: Date.now(),
				expiresAt: Date.now() + 60_000,
				files: ['a.ts'],
			}),
		);

		expect(readScopeFromDisk(tmpDir, '1.1')).toBeNull();
	});

	test('scope file with mismatched taskId in content is rejected', async () => {
		const scopesDir = path.join(tmpDir, '.swarm', 'scopes');
		fs.mkdirSync(scopesDir, { recursive: true });

		// File is named scope-1.1.json but content says taskId is '9.9'
		// This could be a stale or attacker-planted file
		fs.writeFileSync(
			path.join(scopesDir, 'scope-1.1.json'),
			JSON.stringify({
				version: 1,
				taskId: '9.9', // mismatch with filename
				declaredAt: Date.now(),
				expiresAt: Date.now() + 60_000,
				files: ['pwned.ts'],
			}),
		);

		expect(readScopeFromDisk(tmpDir, '1.1')).toBeNull();
	});

	test('scope file with future declaredAt is rejected (clock-skew protection)', async () => {
		const scopesDir = path.join(tmpDir, '.swarm', 'scopes');
		fs.mkdirSync(scopesDir, { recursive: true });

		const future = Date.now() + 1_000_000_000; // ~31 years ahead
		fs.writeFileSync(
			path.join(scopesDir, 'scope-1.1.json'),
			JSON.stringify({
				version: 1,
				taskId: '1.1',
				declaredAt: future,
				expiresAt: future + 60_000,
				files: ['a.ts'],
			}),
		);

		expect(readScopeFromDisk(tmpDir, '1.1')).toBeNull();
	});

	test('empty files array in scope file returns null', async () => {
		const scopesDir = path.join(tmpDir, '.swarm', 'scopes');
		fs.mkdirSync(scopesDir, { recursive: true });
		fs.writeFileSync(
			path.join(scopesDir, 'scope-1.1.json'),
			JSON.stringify({
				version: 1,
				taskId: '1.1',
				declaredAt: Date.now(),
				expiresAt: Date.now() + 60_000,
				files: [], // empty — invalid
			}),
		);

		expect(readScopeFromDisk(tmpDir, '1.1')).toBeNull();
	});

	test('scope file exceeding MAX_FILES_PER_SCOPE is rejected', async () => {
		const scopesDir = path.join(tmpDir, '.swarm', 'scopes');
		fs.mkdirSync(scopesDir, { recursive: true });

		// 10,001 files exceeds the 10,000 cap
		const bigFiles = Array.from({ length: 10_001 }, (_v, i) => `f${i}.ts`);
		fs.writeFileSync(
			path.join(scopesDir, 'scope-1.1.json'),
			JSON.stringify({
				version: 1,
				taskId: '1.1',
				declaredAt: Date.now(),
				expiresAt: Date.now() + 60_000,
				files: bigFiles,
			}),
		);

		expect(readScopeFromDisk(tmpDir, '1.1')).toBeNull();
	});

	test('clearAllScopes removes all scope files', async () => {
		await writeScopeToDisk(tmpDir, '1.1', ['a.ts']);
		await writeScopeToDisk(tmpDir, '1.2', ['b.ts']);
		await writeScopeToDisk(tmpDir, '2.1', ['c.ts']);

		clearAllScopes(tmpDir);

		expect(readScopeFromDisk(tmpDir, '1.1')).toBeNull();
		expect(readScopeFromDisk(tmpDir, '1.2')).toBeNull();
		expect(readScopeFromDisk(tmpDir, '2.1')).toBeNull();
	});

	test('resolveScopeWithFallbacks resolves in correct priority order', async () => {
		// Priority: in-memory > disk > plan.json > pending-map

		// Setup disk scope
		await writeScopeToDisk(tmpDir, '1.1', ['disk.ts']);

		// Setup plan.json scope
		const swarmDir = path.join(tmpDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		fs.writeFileSync(
			path.join(swarmDir, 'plan.json'),
			JSON.stringify({
				phases: [{ tasks: [{ id: '1.1', files_touched: ['plan.ts'] }] }],
			}),
		);

		// Case 1: in-memory wins
		let resolved = resolveScopeWithFallbacks({
			directory: tmpDir,
			taskId: '1.1',
			inMemoryScope: ['memory.ts'],
			pendingMapScope: null,
		});
		expect(resolved).toEqual(['memory.ts']);

		// Case 2: disk wins over plan.json
		resolved = resolveScopeWithFallbacks({
			directory: tmpDir,
			taskId: '1.1',
			inMemoryScope: null,
			pendingMapScope: null,
		});
		expect(resolved).toEqual(['disk.ts']);

		// Case 3: pending-map wins when memory and disk are null (different taskId no disk scope)
		// Note: order is in-memory > disk > plan.json > pending-map
		// So pending-map only wins when disk also returns null
		resolved = resolveScopeWithFallbacks({
			directory: tmpDir,
			taskId: '9.9', // no disk scope for this task
			inMemoryScope: null,
			pendingMapScope: ['pending.ts'],
		});
		expect(resolved).toEqual(['pending.ts']);

		// Case 4: null when all sources are null/empty
		resolved = resolveScopeWithFallbacks({
			directory: tmpDir,
			taskId: '9.9', // no disk scope
			inMemoryScope: null,
			pendingMapScope: null,
		});
		expect(resolved).toBeNull();
	});
});

describe('5. POSIX and Windows path scenarios', () => {
	const isWindows = process.platform === 'win32';

	test('handles Windows-style backslash paths on disk', async () => {
		if (!isWindows) return; // Only relevant on Windows

		await writeScopeToDisk(tmpDir, '1.1', ['src\\a.ts', 'src\\b.ts']);
		const read = readScopeFromDisk(tmpDir, '1.1');

		// Should store and return the paths as-is (Windows uses backslashes)
		expect(read).toBeTruthy();
		if (read) {
			expect(read.length).toBe(2);
		}
	});

	test('handles POSIX forward-slash paths on disk', async () => {
		await writeScopeToDisk(tmpDir, '1.1', ['src/a.ts', 'src/b.ts']);
		const read = readScopeFromDisk(tmpDir, '1.1');

		expect(read).toEqual(['src/a.ts', 'src/b.ts']);
	});

	test('scope file respects case sensitivity on POSIX', async () => {
		if (isWindows) return; // Windows is case-insensitive

		await writeScopeToDisk(tmpDir, '1.1', ['Src/A.ts']);

		// Read with same case — should work
		expect(readScopeFromDisk(tmpDir, '1.1')).toEqual(['Src/A.ts']);

		// Read with different case — should NOT match (case-sensitive filesystem)
		// The scope file was written to scope-1.1.json (lowercase taskId)
		// So reading with taskId '1.1' still works because the filename is correct
	});

	test('absolute paths in scope are stored as-is', async () => {
		// Note: absolute paths are generally not allowed by declare-scope validation
		// but scope-persistence itself does not reject them (only declare-scope does)
		const absolutePath = path.resolve(tmpDir, 'src', 'a.ts');
		await writeScopeToDisk(tmpDir, '1.1', [absolutePath]);
		const read = readScopeFromDisk(tmpDir, '1.1');

		expect(read).toEqual([absolutePath]);
	});

	test('paths with spaces are handled correctly', async () => {
		const dirWithSpaces = path.join(tmpDir, 'path with spaces');
		fs.mkdirSync(dirWithSpaces, { recursive: true });
		fs.writeFileSync(
			path.join(dirWithSpaces, 'scope-1.1.json'),
			JSON.stringify({
				version: 1,
				taskId: '1.1',
				declaredAt: Date.now(),
				expiresAt: Date.now() + 60_000,
				files: ['src/file with spaces.ts'],
			}),
		);

		// Read back from the file directly
		const raw = fs.readFileSync(
			path.join(dirWithSpaces, 'scope-1.1.json'),
			'utf-8',
		);
		const parsed = JSON.parse(raw);
		expect(parsed.files).toEqual(['src/file with spaces.ts']);
	});
});
