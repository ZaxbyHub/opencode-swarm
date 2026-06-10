/**
 * Tests for capsule-persistence module
 *
 * Uses the _internals DI seam for filesystem mocking.
 * All filesystem operations are intercepted via the _internals object
 * to avoid mock.module cross-file leakage in Bun's shared test-runner process.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	deleteCapsule,
	listCapsules,
	loadCapsule,
	saveCapsule,
} from '../../../src/context-map/capsule-persistence';
import type {
	ContextCapsule,
	ReadPolicyEntry,
} from '../../../src/types/context-capsule';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeReadPolicy(
	entries: Array<{
		file_path: string;
		trust_summary?: boolean;
		read_original?: boolean;
	}>,
): ReadPolicyEntry[] {
	return entries.map((e) => ({
		file_path: e.file_path,
		trust_summary: e.trust_summary ?? false,
		read_original: e.read_original ?? false,
		reason: 'test',
	}));
}

function makeCapsule(overrides: Partial<ContextCapsule> = {}): ContextCapsule {
	return {
		task_id: '1.1',
		agent_role: 'coder',
		delegation_reason: 'new_task',
		generated_at: '2025-01-01T00:00:00.000Z',
		files_in_scope: ['src/foo.ts'],
		task_goal: 'Implement foo',
		relevant_facts: [],
		read_policy: makeReadPolicy([
			{ file_path: 'src/foo.ts', trust_summary: false, read_original: true },
		]),
		content: '# Foo\n\nImplement the foo feature.',
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Helpers — fresh mock factory
// ---------------------------------------------------------------------------

function createFreshMocks() {
	return {
		writeFileSync: mock(() => {}),
		readFileSync: mock(() => '{}'),
		existsSync: mock(() => false),
		mkdirSync: mock(() => {}),
		readdirSync: mock(() => []),
		unlinkSync: mock(() => {}),
		renameSync: mock(() => {}),
	};
}

// ---------------------------------------------------------------------------
// 1. saveCapsule tests
// ---------------------------------------------------------------------------

describe('saveCapsule', () => {
	let mocks: ReturnType<typeof createFreshMocks>;

	beforeEach(() => {
		mocks = createFreshMocks();
		_internals.writeFileSync = mocks.writeFileSync;
		_internals.readFileSync = mocks.readFileSync;
		_internals.existsSync = mocks.existsSync;
		_internals.mkdirSync = mocks.mkdirSync;
		_internals.readdirSync = mocks.readdirSync;
		_internals.unlinkSync = mocks.unlinkSync;
		_internals.renameSync = mocks.renameSync;
	});

	afterEach(() => {
		_internals.writeFileSync = realFs.writeFileSync;
		_internals.readFileSync = realFs.readFileSync;
		_internals.existsSync = realFs.existsSync;
		_internals.mkdirSync = realFs.mkdirSync;
		_internals.readdirSync = realFs.readdirSync;
		_internals.unlinkSync = realFs.unlinkSync;
		_internals.renameSync = realFs.renameSync;
	});

	test('writes capsule JSON to .swarm/capsules/{task_id}.json', () => {
		const capsule = makeCapsule({ task_id: '1.2', content: 'hello world' });
		const directory = '/fake/project';

		const result = saveCapsule(capsule, directory);

		expect(result.success).toBe(true);
		expect(result.capsule_path).toBe(
			path.join('/fake/project', '.swarm', 'capsules', '1.2.json'),
		);

		// writeFileSync should have been called with the temp path
		expect(mocks.writeFileSync).toHaveBeenCalledTimes(1);
		const [writePath, jsonContent] = mocks.writeFileSync.mock.calls[0]!;
		expect(writePath).toMatch(/1\.2\.tmp$/);
		const parsed = JSON.parse(jsonContent as string);
		expect(parsed.task_id).toBe('1.2');
		expect(parsed.content).toBe('hello world');
	});

	test('returns metadata with success=true and correct capsule_path', () => {
		const capsule = makeCapsule({ task_id: '2.3' });
		const result = saveCapsule(capsule, '/fake');

		expect(result.success).toBe(true);
		expect(result.capsule_path).toBe(
			path.join('/fake', '.swarm', 'capsules', '2.3.json'),
		);
		expect(result.token_estimate).toBeGreaterThan(0);
	});

	test('returns metadata with recommended_reads and skipped_reads from read_policy', () => {
		const capsule = makeCapsule({
			task_id: '3.1',
			read_policy: makeReadPolicy([
				{ file_path: 'src/a.ts', read_original: true, trust_summary: false },
				{ file_path: 'src/b.ts', read_original: false, trust_summary: true },
				{ file_path: 'src/c.ts', read_original: true, trust_summary: false },
			]),
		});

		const result = saveCapsule(capsule, '/fake');

		expect(result.success).toBe(true);
		expect(result.recommended_reads).toEqual(['src/a.ts', 'src/c.ts']);
		expect(result.skipped_reads).toEqual(['src/b.ts']);
	});

	test('returns success=false on write error', () => {
		mocks.writeFileSync = mock(() => {
			throw new Error('disk full');
		});
		_internals.writeFileSync = mocks.writeFileSync;

		const capsule = makeCapsule({ task_id: '1.1' });
		const result = saveCapsule(capsule, '/fake');

		expect(result.success).toBe(false);
		expect(result.capsule_path).toBe('');
	});

	test('returns success=false for invalid taskId (path traversal: "../../etc/passwd")', () => {
		const capsule = makeCapsule({ task_id: '../../etc/passwd' });
		const result = saveCapsule(capsule, '/fake');

		expect(result.success).toBe(false);
		expect(result.capsule_path).toBe('');
	});

	test('returns success=false for invalid taskId (single number: "1")', () => {
		const capsule = makeCapsule({ task_id: '1' });
		const result = saveCapsule(capsule, '/fake');

		expect(result.success).toBe(false);
		expect(result.capsule_path).toBe('');
	});

	test('returns success=false for non-numeric taskId (like "a.b")', () => {
		const capsule = makeCapsule({ task_id: 'a.b' });
		const result = saveCapsule(capsule, '/fake');

		expect(result.success).toBe(false);
		expect(result.capsule_path).toBe('');
	});

	test('creates .swarm/capsules/ directory if needed', () => {
		const capsule = makeCapsule({ task_id: '5.1' });
		saveCapsule(capsule, '/fake');

		expect(mocks.mkdirSync).toHaveBeenCalledTimes(1);
		const [dirPath] = mocks.mkdirSync.mock.calls[0]!;
		expect(dirPath).toBe(path.join('/fake', '.swarm', 'capsules'));
	});

	test('performs atomic write via temp-then-rename', () => {
		const capsule = makeCapsule({ task_id: '6.1' });
		saveCapsule(capsule, '/fake');

		expect(mocks.renameSync).toHaveBeenCalledTimes(1);
		const [tmpPath, finalPath] = mocks.renameSync.mock.calls[0]!;
		expect(tmpPath).toMatch(/6\.1\.tmp$/);
		expect(finalPath).toMatch(/6\.1\.json$/);
	});
});

// ---------------------------------------------------------------------------
// 2. loadCapsule tests
// ---------------------------------------------------------------------------

describe('loadCapsule', () => {
	let mocks: ReturnType<typeof createFreshMocks>;

	beforeEach(() => {
		mocks = createFreshMocks();
		_internals.writeFileSync = mocks.writeFileSync;
		_internals.readFileSync = mocks.readFileSync;
		_internals.existsSync = mocks.existsSync;
		_internals.mkdirSync = mocks.mkdirSync;
		_internals.readdirSync = mocks.readdirSync;
		_internals.unlinkSync = mocks.unlinkSync;
		_internals.renameSync = mocks.renameSync;
	});

	afterEach(() => {
		_internals.writeFileSync = realFs.writeFileSync;
		_internals.readFileSync = realFs.readFileSync;
		_internals.existsSync = realFs.existsSync;
		_internals.mkdirSync = realFs.mkdirSync;
		_internals.readdirSync = realFs.readdirSync;
		_internals.unlinkSync = realFs.unlinkSync;
		_internals.renameSync = realFs.renameSync;
	});

	test('returns parsed ContextCapsule for existing valid file', () => {
		const capsule = makeCapsule({ task_id: '7.1' });
		const json = JSON.stringify(capsule);

		mocks.existsSync = mock(() => true);
		mocks.readFileSync = mock(() => json);
		_internals.existsSync = mocks.existsSync;
		_internals.readFileSync = mocks.readFileSync;

		const result = loadCapsule('7.1', '/fake');

		expect(result).not.toBeNull();
		expect(result!.task_id).toBe('7.1');
		expect(result!.content).toBe('# Foo\n\nImplement the foo feature.');
	});

	test('returns null for missing file', () => {
		mocks.existsSync = mock(() => false);
		_internals.existsSync = mocks.existsSync;

		const result = loadCapsule('1.1', '/fake');

		expect(result).toBeNull();
	});

	test('returns null for corrupt JSON', () => {
		mocks.existsSync = mock(() => true);
		mocks.readFileSync = mock(() => '{ not valid json');
		_internals.existsSync = mocks.existsSync;
		_internals.readFileSync = mocks.readFileSync;

		const result = loadCapsule('1.1', '/fake');

		expect(result).toBeNull();
	});

	test('returns null for invalid taskId (path traversal)', () => {
		const result = loadCapsule('../../etc/passwd', '/fake');

		expect(result).toBeNull();
	});

	test('returns null if parsed object lacks task_id string', () => {
		mocks.existsSync = mock(() => true);
		mocks.readFileSync = mock(() => JSON.stringify({ content: 'x' }));
		_internals.existsSync = mocks.existsSync;
		_internals.readFileSync = mocks.readFileSync;

		const result = loadCapsule('1.1', '/fake');

		expect(result).toBeNull();
	});

	test('returns null if parsed object lacks content string', () => {
		mocks.existsSync = mock(() => true);
		mocks.readFileSync = mock(() => JSON.stringify({ task_id: '1.1' }));
		_internals.existsSync = mocks.existsSync;
		_internals.readFileSync = mocks.readFileSync;

		const result = loadCapsule('1.1', '/fake');

		expect(result).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 3. deleteCapsule tests
// ---------------------------------------------------------------------------

describe('deleteCapsule', () => {
	let mocks: ReturnType<typeof createFreshMocks>;

	beforeEach(() => {
		mocks = createFreshMocks();
		_internals.writeFileSync = mocks.writeFileSync;
		_internals.readFileSync = mocks.readFileSync;
		_internals.existsSync = mocks.existsSync;
		_internals.mkdirSync = mocks.mkdirSync;
		_internals.readdirSync = mocks.readdirSync;
		_internals.unlinkSync = mocks.unlinkSync;
		_internals.renameSync = mocks.renameSync;
	});

	afterEach(() => {
		_internals.writeFileSync = realFs.writeFileSync;
		_internals.readFileSync = realFs.readFileSync;
		_internals.existsSync = realFs.existsSync;
		_internals.mkdirSync = realFs.mkdirSync;
		_internals.readdirSync = realFs.readdirSync;
		_internals.unlinkSync = realFs.unlinkSync;
		_internals.renameSync = realFs.renameSync;
	});

	test('returns true when file exists and is deleted', () => {
		mocks.existsSync = mock(() => true);
		_internals.existsSync = mocks.existsSync;

		const result = deleteCapsule('8.1', '/fake');

		expect(result).toBe(true);
		expect(mocks.unlinkSync).toHaveBeenCalledTimes(1);
		const [deletedPath] = mocks.unlinkSync.mock.calls[0]!;
		expect(deletedPath).toBe(
			path.join('/fake', '.swarm', 'capsules', '8.1.json'),
		);
	});

	test('returns false when file does not exist', () => {
		mocks.existsSync = mock(() => false);
		_internals.existsSync = mocks.existsSync;

		const result = deleteCapsule('9.1', '/fake');

		expect(result).toBe(false);
		expect(mocks.unlinkSync).not.toHaveBeenCalled();
	});

	test('returns false for invalid taskId', () => {
		const result = deleteCapsule('../../etc/passwd', '/fake');

		expect(result).toBe(false);
		expect(mocks.unlinkSync).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// 4. listCapsules tests
// ---------------------------------------------------------------------------

describe('listCapsules', () => {
	let mocks: ReturnType<typeof createFreshMocks>;

	beforeEach(() => {
		mocks = createFreshMocks();
		_internals.writeFileSync = mocks.writeFileSync;
		_internals.readFileSync = mocks.readFileSync;
		_internals.existsSync = mocks.existsSync;
		_internals.mkdirSync = mocks.mkdirSync;
		_internals.readdirSync = mocks.readdirSync;
		_internals.unlinkSync = mocks.unlinkSync;
		_internals.renameSync = mocks.renameSync;
	});

	afterEach(() => {
		_internals.writeFileSync = realFs.writeFileSync;
		_internals.readFileSync = realFs.readFileSync;
		_internals.existsSync = realFs.existsSync;
		_internals.mkdirSync = realFs.mkdirSync;
		_internals.readdirSync = realFs.readdirSync;
		_internals.unlinkSync = realFs.unlinkSync;
		_internals.renameSync = realFs.renameSync;
	});

	test('returns array of task IDs from .json files', () => {
		mocks.existsSync = mock(() => true);
		mocks.readdirSync = mock(() => ['1.1.json', '2.3.json', 'README.md']);
		_internals.existsSync = mocks.existsSync;
		_internals.readdirSync = mocks.readdirSync;

		const result = listCapsules('/fake');

		expect(result).toEqual(['1.1', '2.3']);
	});

	test('returns empty array when directory does not exist', () => {
		mocks.existsSync = mock(() => false);
		_internals.existsSync = mocks.existsSync;

		const result = listCapsules('/fake');

		expect(result).toEqual([]);
	});

	test('filters non-.json files', () => {
		mocks.existsSync = mock(() => true);
		mocks.readdirSync = mock(() => [
			'1.1.json',
			'temp.tmp',
			'.hidden',
			'data.json.bak',
		]);
		_internals.existsSync = mocks.existsSync;
		_internals.readdirSync = mocks.readdirSync;

		const result = listCapsules('/fake');

		expect(result).toEqual(['1.1']);
	});

	test('strips .json extension from filenames', () => {
		mocks.existsSync = mock(() => true);
		mocks.readdirSync = mock(() => ['10.20.30.json']);
		_internals.existsSync = mocks.existsSync;
		_internals.readdirSync = mocks.readdirSync;

		const result = listCapsules('/fake');

		expect(result).toEqual(['10.20.30']);
	});
});

// ---------------------------------------------------------------------------
// 5. _internals DI seam tests
// ---------------------------------------------------------------------------

describe('_internals DI seam', () => {
	test('all expected fs functions are present', () => {
		expect(typeof _internals.writeFileSync).toBe('function');
		expect(typeof _internals.readFileSync).toBe('function');
		expect(typeof _internals.existsSync).toBe('function');
		expect(typeof _internals.mkdirSync).toBe('function');
		expect(typeof _internals.readdirSync).toBe('function');
		expect(typeof _internals.unlinkSync).toBe('function');
		expect(typeof _internals.renameSync).toBe('function');
	});

	test('override verification: mock writeFileSync, verify it is called', () => {
		// This is verified implicitly by every saveCapsule test, but we
		// make it explicit here so the seam contract is self-documenting.
		const original = _internals.writeFileSync;
		const spy = mock(() => {});
		_internals.writeFileSync = spy;

		const capsule = makeCapsule({ task_id: '11.1' });
		saveCapsule(capsule, '/test');

		expect(spy).toHaveBeenCalledTimes(1);

		_internals.writeFileSync = original;
	});
});

// ---------------------------------------------------------------------------
// 6. Path traversal security tests
// ---------------------------------------------------------------------------

describe('path traversal security', () => {
	test('saveCapsule("../../etc/passwd") → success=false', () => {
		const capsule = makeCapsule({ task_id: '../../etc/passwd' });
		expect(saveCapsule(capsule, '/fake').success).toBe(false);
	});

	test('loadCapsule("../../etc/passwd") → null', () => {
		expect(loadCapsule('../../etc/passwd', '/fake')).toBeNull();
	});

	test('deleteCapsule("../../etc/passwd") → false', () => {
		expect(deleteCapsule('../../etc/passwd', '/fake')).toBe(false);
	});

	test('saveCapsule("1") → success=false (single number, no dot)', () => {
		const capsule = makeCapsule({ task_id: '1' });
		expect(saveCapsule(capsule, '/fake').success).toBe(false);
	});

	test('saveCapsule("a.b") → success=false (non-numeric)', () => {
		const capsule = makeCapsule({ task_id: 'a.b' });
		expect(saveCapsule(capsule, '/fake').success).toBe(false);
	});

	test('loadCapsule("1") → null', () => {
		expect(loadCapsule('1', '/fake')).toBeNull();
	});

	test('loadCapsule("a.b") → null', () => {
		expect(loadCapsule('a.b', '/fake')).toBeNull();
	});

	test('deleteCapsule("1") → false', () => {
		expect(deleteCapsule('1', '/fake')).toBe(false);
	});

	test('deleteCapsule("a.b") → false', () => {
		expect(deleteCapsule('a.b', '/fake')).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Integration-style tests with real filesystem (os.tmpdir)
// ---------------------------------------------------------------------------

describe('integration — real filesystem', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = path.join(os.tmpdir(), `capsule-persistence-test-${Date.now()}`);
	});

	afterEach(() => {
		// Restore real _internals
		_internals.writeFileSync = realFs.writeFileSync;
		_internals.readFileSync = realFs.readFileSync;
		_internals.existsSync = realFs.existsSync;
		_internals.mkdirSync = realFs.mkdirSync;
		_internals.readdirSync = realFs.readdirSync;
		_internals.unlinkSync = realFs.unlinkSync;
		_internals.renameSync = realFs.renameSync;

		// Clean up any created files
		try {
			const capsulesDir = path.join(tmpDir, '.swarm', 'capsules');
			const files = realFs.readdirSync(capsulesDir);
			for (const file of files) {
				realFs.unlinkSync(path.join(capsulesDir, file));
			}
			realFs.rmdirSync(capsulesDir);
		} catch {
			// ignore
		}
		try {
			realFs.rmdirSync(path.join(tmpDir, '.swarm'));
		} catch {
			// ignore
		}
	});

	test('saveCapsule and loadCapsule round-trip', () => {
		const capsule = makeCapsule({ task_id: '99.1' });
		const saveResult = saveCapsule(capsule, tmpDir);

		expect(saveResult.success).toBe(true);
		expect(saveResult.capsule_path).toContain('99.1.json');

		const loaded = loadCapsule('99.1', tmpDir);
		expect(loaded).not.toBeNull();
		expect(loaded!.task_id).toBe('99.1');
		expect(loaded!.content).toBe(capsule.content);
	});

	test('deleteCapsule removes file', () => {
		const capsule = makeCapsule({ task_id: '99.2' });
		saveCapsule(capsule, tmpDir);

		const deleted = deleteCapsule('99.2', tmpDir);
		expect(deleted).toBe(true);

		const loaded = loadCapsule('99.2', tmpDir);
		expect(loaded).toBeNull();
	});

	test('listCapsules returns saved task IDs', () => {
		saveCapsule(makeCapsule({ task_id: '99.3' }), tmpDir);
		saveCapsule(makeCapsule({ task_id: '99.4' }), tmpDir);

		const listed = listCapsules(tmpDir);
		expect(listed).toContain('99.3');
		expect(listed).toContain('99.4');
	});
});
