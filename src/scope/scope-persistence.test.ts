/**
 * Tests for scope-persistence (#519 v6.71.1).
 *
 * Covers:
 *   - Atomic write + read round-trip
 *   - Schema-version fail-closed on unknown version
 *   - TTL expiry returns null
 *   - lstat symlink guard
 *   - Plan.json fallback (files_touched) for active task
 *   - Resolve chain order: memory → disk → plan.json → pending-map
 *   - Invalid taskId rejection
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	clearAllScopes,
	clearScopeForTask,
	readPlanScope,
	readScopeFromDisk,
	resolveScopeWithFallbacks,
	writeScopeToDisk,
} from './scope-persistence';

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-persist-'));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('writeScopeToDisk / readScopeFromDisk', () => {
	test('round-trips a declared scope through disk', async () => {
		await writeScopeToDisk(tmpDir, '1.1', ['src/a.ts', 'src/b.ts']);
		const read = readScopeFromDisk(tmpDir, '1.1');
		expect(read).toEqual(['src/a.ts', 'src/b.ts']);
	});

	test('returns null when scope file does not exist', () => {
		expect(readScopeFromDisk(tmpDir, '9.9')).toBeNull();
	});

	test('writes to .swarm/scopes/scope-{taskId}.json', async () => {
		await writeScopeToDisk(tmpDir, '2.3', ['a.ts']);
		const expected = path.join(tmpDir, '.swarm', 'scopes', 'scope-2.3.json');
		expect(fs.existsSync(expected)).toBe(true);
	});

	test('persists schema version, declaredAt, expiresAt in payload', async () => {
		await writeScopeToDisk(tmpDir, '1.1', ['a.ts']);
		const raw = fs.readFileSync(
			path.join(tmpDir, '.swarm', 'scopes', 'scope-1.1.json'),
			'utf-8',
		);
		const parsed = JSON.parse(raw);
		expect(parsed.version).toBe(1);
		expect(typeof parsed.declaredAt).toBe('number');
		expect(typeof parsed.expiresAt).toBe('number');
		expect(parsed.expiresAt).toBeGreaterThan(parsed.declaredAt);
	});

	test('fails closed on unknown schema version', async () => {
		const scopesDir = path.join(tmpDir, '.swarm', 'scopes');
		fs.mkdirSync(scopesDir, { recursive: true });
		fs.writeFileSync(
			path.join(scopesDir, 'scope-1.1.json'),
			JSON.stringify({
				version: 99,
				taskId: '1.1',
				files: ['a.ts'],
				declaredAt: Date.now(),
				expiresAt: Date.now() + 1000,
			}),
		);
		expect(readScopeFromDisk(tmpDir, '1.1')).toBeNull();
	});

	test('returns null when TTL has expired', async () => {
		const scopesDir = path.join(tmpDir, '.swarm', 'scopes');
		fs.mkdirSync(scopesDir, { recursive: true });
		fs.writeFileSync(
			path.join(scopesDir, 'scope-1.1.json'),
			JSON.stringify({
				version: 1,
				taskId: '1.1',
				declaredAt: Date.now() - 1_000_000,
				expiresAt: Date.now() - 1_000,
				files: ['a.ts'],
			}),
		);
		expect(readScopeFromDisk(tmpDir, '1.1')).toBeNull();
	});

	test('returns null on malformed JSON', async () => {
		const scopesDir = path.join(tmpDir, '.swarm', 'scopes');
		fs.mkdirSync(scopesDir, { recursive: true });
		fs.writeFileSync(path.join(scopesDir, 'scope-1.1.json'), '{not json');
		expect(readScopeFromDisk(tmpDir, '1.1')).toBeNull();
	});

	test('returns null when files array is empty', async () => {
		const scopesDir = path.join(tmpDir, '.swarm', 'scopes');
		fs.mkdirSync(scopesDir, { recursive: true });
		fs.writeFileSync(
			path.join(scopesDir, 'scope-1.1.json'),
			JSON.stringify({
				version: 1,
				taskId: '1.1',
				declaredAt: Date.now(),
				expiresAt: Date.now() + 1000,
				files: [],
			}),
		);
		expect(readScopeFromDisk(tmpDir, '1.1')).toBeNull();
	});

	test('rejects symlinked scope file (lstat guard)', async () => {
		const scopesDir = path.join(tmpDir, '.swarm', 'scopes');
		fs.mkdirSync(scopesDir, { recursive: true });
		const realTarget = path.join(tmpDir, 'hostile.json');
		fs.writeFileSync(
			realTarget,
			JSON.stringify({
				version: 1,
				taskId: '1.1',
				declaredAt: Date.now(),
				expiresAt: Date.now() + 1000,
				files: ['/etc/passwd'],
			}),
		);
		try {
			fs.symlinkSync(realTarget, path.join(scopesDir, 'scope-1.1.json'));
		} catch {
			// Windows may refuse symlink creation without privilege; skip the assertion.
			return;
		}
		if (process.platform === 'win32') {
			// O_NOFOLLOW is a no-op on Windows (documented residual risk in scope-persistence.ts).
			return;
		}
		expect(readScopeFromDisk(tmpDir, '1.1')).toBeNull();
	});

	test('rejects invalid taskId for write and read', async () => {
		await writeScopeToDisk(tmpDir, '../escape', ['a.ts']);
		expect(readScopeFromDisk(tmpDir, '../escape')).toBeNull();
		expect(
			fs.existsSync(
				path.join(tmpDir, '.swarm', 'scopes', 'scope-../escape.json'),
			),
		).toBe(false);
	});

	test('rejects taskId with path separator', async () => {
		await writeScopeToDisk(tmpDir, 'a/b', ['x.ts']);
		expect(readScopeFromDisk(tmpDir, 'a/b')).toBeNull();
	});

	test('overwrites existing scope on re-declaration', async () => {
		await writeScopeToDisk(tmpDir, '1.1', ['src/a.ts']);
		await writeScopeToDisk(tmpDir, '1.1', ['src/a.ts', 'src/b.ts']);
		expect(readScopeFromDisk(tmpDir, '1.1')).toEqual(['src/a.ts', 'src/b.ts']);
	});

	test('concurrent writes for different taskIds do not interfere', async () => {
		await Promise.all([
			writeScopeToDisk(tmpDir, '1.1', ['a.ts']),
			writeScopeToDisk(tmpDir, '1.2', ['b.ts']),
			writeScopeToDisk(tmpDir, '2.1', ['c.ts']),
		]);
		expect(readScopeFromDisk(tmpDir, '1.1')).toEqual(['a.ts']);
		expect(readScopeFromDisk(tmpDir, '1.2')).toEqual(['b.ts']);
		expect(readScopeFromDisk(tmpDir, '2.1')).toEqual(['c.ts']);
	});
});

describe('readPlanScope (plan-as-scope fallback)', () => {
	function writePlan(
		dir: string,
		tasks: Array<{ id: string; files_touched?: string[] | string }>,
	): void {
		const planDir = path.join(dir, '.swarm');
		fs.mkdirSync(planDir, { recursive: true });
		fs.writeFileSync(
			path.join(planDir, 'plan.json'),
			JSON.stringify({
				phases: [{ id: 1, name: 'Phase 1', status: 'in_progress', tasks }],
			}),
		);
	}

	test('reads files_touched array for active task', () => {
		writePlan(tmpDir, [{ id: '1.1', files_touched: ['src/a.ts', 'src/b.ts'] }]);
		expect(readPlanScope(tmpDir, '1.1')).toEqual(['src/a.ts', 'src/b.ts']);
	});

	test('accepts single-string files_touched and wraps it', () => {
		writePlan(tmpDir, [{ id: '1.1', files_touched: 'src/only.ts' }]);
		expect(readPlanScope(tmpDir, '1.1')).toEqual(['src/only.ts']);
	});

	test('returns null when task has no files_touched', () => {
		writePlan(tmpDir, [{ id: '1.1' }]);
		expect(readPlanScope(tmpDir, '1.1')).toBeNull();
	});

	test('returns null when task id not found', () => {
		writePlan(tmpDir, [{ id: '1.1', files_touched: ['a.ts'] }]);
		expect(readPlanScope(tmpDir, '9.9')).toBeNull();
	});

	test('returns null when plan.json is missing', () => {
		expect(readPlanScope(tmpDir, '1.1')).toBeNull();
	});

	test('returns null when plan.json is malformed', () => {
		const planDir = path.join(tmpDir, '.swarm');
		fs.mkdirSync(planDir, { recursive: true });
		fs.writeFileSync(path.join(planDir, 'plan.json'), '{invalid json');
		expect(readPlanScope(tmpDir, '1.1')).toBeNull();
	});

	test('rejects invalid taskId before touching disk', () => {
		expect(readPlanScope(tmpDir, '../escape')).toBeNull();
	});
});

describe('resolveScopeWithFallbacks', () => {
	test('returns in-memory scope when present (fast path, does not touch disk)', () => {
		const result = resolveScopeWithFallbacks({
			directory: tmpDir,
			taskId: '1.1',
			inMemoryScope: ['mem.ts'],
			pendingMapScope: null,
		});
		expect(result).toEqual(['mem.ts']);
	});

	test('falls back to disk when in-memory is null', async () => {
		await writeScopeToDisk(tmpDir, '1.1', ['disk.ts']);
		const result = resolveScopeWithFallbacks({
			directory: tmpDir,
			taskId: '1.1',
			inMemoryScope: null,
			pendingMapScope: null,
		});
		expect(result).toEqual(['disk.ts']);
	});

	test('falls back to plan.json when in-memory + disk are null', () => {
		const planDir = path.join(tmpDir, '.swarm');
		fs.mkdirSync(planDir, { recursive: true });
		fs.writeFileSync(
			path.join(planDir, 'plan.json'),
			JSON.stringify({
				phases: [{ tasks: [{ id: '1.1', files_touched: ['plan.ts'] }] }],
			}),
		);
		const result = resolveScopeWithFallbacks({
			directory: tmpDir,
			taskId: '1.1',
			inMemoryScope: null,
			pendingMapScope: null,
		});
		expect(result).toEqual(['plan.ts']);
	});

	test('falls back to pending-map when all higher layers are null', () => {
		const result = resolveScopeWithFallbacks({
			directory: tmpDir,
			taskId: '1.1',
			inMemoryScope: null,
			pendingMapScope: ['pending.ts'],
		});
		expect(result).toEqual(['pending.ts']);
	});

	test('returns null when every layer is empty', () => {
		const result = resolveScopeWithFallbacks({
			directory: tmpDir,
			taskId: '1.1',
			inMemoryScope: null,
			pendingMapScope: null,
		});
		expect(result).toBeNull();
	});

	test('empty in-memory array falls through to disk layer', async () => {
		await writeScopeToDisk(tmpDir, '1.1', ['disk.ts']);
		const result = resolveScopeWithFallbacks({
			directory: tmpDir,
			taskId: '1.1',
			inMemoryScope: [],
			pendingMapScope: null,
		});
		expect(result).toEqual(['disk.ts']);
	});

	test('missing taskId skips disk + plan layers and uses pending-map', () => {
		const result = resolveScopeWithFallbacks({
			directory: tmpDir,
			taskId: null,
			inMemoryScope: null,
			pendingMapScope: ['pending.ts'],
		});
		expect(result).toEqual(['pending.ts']);
	});
});

describe('clearScopeForTask / clearAllScopes', () => {
	test('clearScopeForTask removes a single scope file', async () => {
		await writeScopeToDisk(tmpDir, '1.1', ['a.ts']);
		await writeScopeToDisk(tmpDir, '1.2', ['b.ts']);
		clearScopeForTask(tmpDir, '1.1');
		expect(readScopeFromDisk(tmpDir, '1.1')).toBeNull();
		expect(readScopeFromDisk(tmpDir, '1.2')).toEqual(['b.ts']);
	});

	test('clearScopeForTask is idempotent on missing file', () => {
		expect(() => clearScopeForTask(tmpDir, '9.9')).not.toThrow();
	});

	test('clearAllScopes removes the scopes directory', async () => {
		await writeScopeToDisk(tmpDir, '1.1', ['a.ts']);
		await writeScopeToDisk(tmpDir, '2.1', ['b.ts']);
		clearAllScopes(tmpDir);
		expect(fs.existsSync(path.join(tmpDir, '.swarm', 'scopes'))).toBe(false);
	});

	test('clearAllScopes is idempotent when no scopes exist', () => {
		expect(() => clearAllScopes(tmpDir)).not.toThrow();
	});

	test('clearScopeForTask rejects invalid taskId silently', async () => {
		await writeScopeToDisk(tmpDir, '1.1', ['a.ts']);
		clearScopeForTask(tmpDir, '../escape');
		expect(readScopeFromDisk(tmpDir, '1.1')).toEqual(['a.ts']);
	});
});

describe('prompt hardening regression (#519)', () => {
	test('coder prompt forbids bash write bypasses', async () => {
		const coderModule = await import('../agents/coder');
		const agent = coderModule.createCoderAgent('test-model');
		const prompt = agent.config.prompt ?? '';
		// The rule is rule-based, not enumerated — but the enumeration covers the
		// common categories so the coder model has worked examples to pattern-match.
		expect(prompt).toContain('WRITE BLOCKED PROTOCOL');
		expect(prompt).toMatch(/sed -i/);
		expect(prompt).toMatch(/here-docs/);
		expect(prompt).toMatch(/tee/);
		expect(prompt).toMatch(/python -c/);
		expect(prompt).toMatch(/bash -c/);
		// Rule-based framing — must assert that the enumeration is not exhaustive.
		expect(prompt).toMatch(/rule-based/);
		expect(prompt).toMatch(/illustrative/);
	});

	test('architect prompt requires declare_scope and bans bash workarounds', async () => {
		const architectModule = await import('../agents/architect');
		const agent = architectModule.createArchitectAgent('test-model');
		const prompt = agent.config.prompt ?? '';
		expect(prompt).toContain('declare_scope');
		expect(prompt).toContain('SCOPE DISCIPLINE');
		expect(prompt).toMatch(/WRITE BLOCKED/);
		expect(prompt).toMatch(/bash workaround/i);
		expect(prompt).toMatch(/file-move.*shell.*b(ypass|an)/i);
	});
});

describe('hardening (#519 adversarial-review follow-up)', () => {
	test('rejects reads when parent .swarm/scopes is a symlink outside workspace', async () => {
		if (process.platform === 'win32') return; // symlink tests fragile on Windows
		const external = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-attacker-'));
		try {
			// Attacker stages a legit-looking scope file in an external directory.
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
			// Then symlinks .swarm/scopes into the external directory.
			fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
			fs.symlinkSync(external, path.join(tmpDir, '.swarm', 'scopes'));

			expect(readScopeFromDisk(tmpDir, '1.1')).toBeNull();
		} finally {
			fs.rmSync(external, { recursive: true, force: true });
		}
	});

	test('rejects files when stored taskId disagrees with filename', async () => {
		const scopesDir = path.join(tmpDir, '.swarm', 'scopes');
		fs.mkdirSync(scopesDir, { recursive: true });
		fs.writeFileSync(
			path.join(scopesDir, 'scope-1.1.json'),
			JSON.stringify({
				version: 1,
				taskId: '9.9-ATTACKER',
				declaredAt: Date.now(),
				expiresAt: Date.now() + 60_000,
				files: ['pwned.ts'],
			}),
		);
		expect(readScopeFromDisk(tmpDir, '1.1')).toBeNull();
	});

	test('rejects future declaredAt (clock-skew / attacker-crafted)', async () => {
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

	test('rejects scope files whose files array exceeds DoS cap on read', async () => {
		const scopesDir = path.join(tmpDir, '.swarm', 'scopes');
		fs.mkdirSync(scopesDir, { recursive: true });
		const big = Array.from({ length: 10_001 }, (_v, i) => `f${i}.ts`);
		fs.writeFileSync(
			path.join(scopesDir, 'scope-1.1.json'),
			JSON.stringify({
				version: 1,
				taskId: '1.1',
				declaredAt: Date.now(),
				expiresAt: Date.now() + 60_000,
				files: big,
			}),
		);
		expect(readScopeFromDisk(tmpDir, '1.1')).toBeNull();
	});

	test('silently refuses to persist oversize file arrays', async () => {
		const big = Array.from({ length: 10_001 }, (_v, i) => `f${i}.ts`);
		await writeScopeToDisk(tmpDir, '1.1', big);
		expect(readScopeFromDisk(tmpDir, '1.1')).toBeNull();
	});

	test('rejects Windows reserved taskIds', async () => {
		// Can't actually open `scope-CON.json` on Windows — instead verify the
		// guard refuses to persist / read such ids on any platform.
		await writeScopeToDisk(tmpDir, 'CON', ['a.ts']);
		expect(readScopeFromDisk(tmpDir, 'CON')).toBeNull();
		await writeScopeToDisk(tmpDir, 'NUL', ['a.ts']);
		expect(readScopeFromDisk(tmpDir, 'NUL')).toBeNull();
		await writeScopeToDisk(tmpDir, 'LPT1', ['a.ts']);
		expect(readScopeFromDisk(tmpDir, 'LPT1')).toBeNull();
		await writeScopeToDisk(tmpDir, 'con.', ['a.ts']);
		expect(readScopeFromDisk(tmpDir, 'con.')).toBeNull();
	});

	test('readPlanScope rejects oversize plan.json', () => {
		const swarmDir = path.join(tmpDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		const planPath = path.join(swarmDir, 'plan.json');
		// Write a plan that exceeds the 10 MiB cap (with valid JSON wrapping).
		const padding = 'x'.repeat(11 * 1024 * 1024);
		fs.writeFileSync(
			planPath,
			JSON.stringify({
				phases: [
					{
						tasks: [{ id: '1.1', files_touched: ['a.ts'], _pad: padding }],
					},
				],
			}),
		);
		expect(readPlanScope(tmpDir, '1.1')).toBeNull();
	});

	test('readPlanScope filters non-string entries from files_touched arrays', () => {
		const swarmDir = path.join(tmpDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		fs.writeFileSync(
			path.join(swarmDir, 'plan.json'),
			JSON.stringify({
				phases: [
					{
						tasks: [
							{
								id: '1.1',
								files_touched: ['a.ts', 123, { path: 'b.ts' }, 'c.ts'],
							},
						],
					},
				],
			}),
		);
		expect(readPlanScope(tmpDir, '1.1')).toEqual(['a.ts', 'c.ts']);
	});
});
