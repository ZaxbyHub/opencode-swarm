import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	appendDecision,
	appendTaskHistory,
	computeContentHash,
	createEmptyContextMap,
	loadContextMap,
	markStaleEntries,
	saveContextMap,
} from '../../../src/context-map/persistence';
import type {
	ContextMap,
	DecisionEntry,
	FileContextEntry,
	TaskContextSummary,
} from '../../../src/types/context-map';

// ---------------------------------------------------------------------------
// Temp directory helpers
// ---------------------------------------------------------------------------

let tempDir: string;
let origInternals: typeof _internals;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-map-test-'));
	// Snapshot _internals so each test can mutate and restore
	origInternals = { ..._internals };
});

afterEach(() => {
	// Restore original _internals
	Object.assign(_internals, origInternals);
	// Clean up temp directory
	fs.rmSync(tempDir, { force: true, recursive: true });
});

// ---------------------------------------------------------------------------
// computeContentHash
// ---------------------------------------------------------------------------

describe('computeContentHash', () => {
	test('returns consistent SHA-256 hex string for same input', () => {
		const hash1 = computeContentHash('hello world');
		const hash2 = computeContentHash('hello world');
		expect(hash1).toBe(hash2);
		expect(hash1).toMatch(/^[a-f0-9]{64}$/);
	});

	test('returns different hash for different input', () => {
		const hash1 = computeContentHash('hello');
		const hash2 = computeContentHash('world');
		expect(hash1).not.toBe(hash2);
	});

	test('returns 64-character lowercase hex', () => {
		const hash = computeContentHash('test content');
		expect(hash).toHaveLength(64);
		expect(hash).toBe(hash.toLowerCase());
		expect(/^[a-f0-9]+$/.test(hash)).toBe(true);
	});

	test('handles empty string', () => {
		const hash = computeContentHash('');
		expect(hash).toHaveLength(64);
	});
});

// ---------------------------------------------------------------------------
// createEmptyContextMap
// ---------------------------------------------------------------------------

describe('createEmptyContextMap', () => {
	test('produces valid empty map with schema_version=1', () => {
		const map = createEmptyContextMap();
		expect(map.schema_version).toBe(1);
	});

	test('has empty files, task_history, decisions arrays', () => {
		const map = createEmptyContextMap();
		expect(map.files).toEqual({});
		expect(map.task_history).toEqual({});
		expect(map.decisions).toEqual([]);
	});

	test('has non-empty generated_at ISO string', () => {
		const map = createEmptyContextMap();
		expect(map.generated_at).toBeTruthy();
		expect(() => new Date(map.generated_at)).not.toThrow();
	});

	test('has empty repo_fingerprint', () => {
		const map = createEmptyContextMap();
		expect(map.repo_fingerprint).toBe('');
	});
});

// ---------------------------------------------------------------------------
// saveContextMap + loadContextMap round-trip
// ---------------------------------------------------------------------------

describe('saveContextMap and loadContextMap', () => {
	test('saveContextMap writes .swarm/context-map.json', () => {
		const map = createEmptyContextMap();
		saveContextMap(map, tempDir);
		const filePath = path.join(tempDir, '.swarm', 'context-map.json');
		expect(fs.existsSync(filePath)).toBe(true);
	});

	test('loadContextMap returns null for missing file', () => {
		const result = loadContextMap(tempDir);
		expect(result).toBeNull();
	});

	test('loadContextMap returns null for corrupt JSON', () => {
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		fs.writeFileSync(
			path.join(swarmDir, 'context-map.json'),
			'not valid json{',
		);
		const result = loadContextMap(tempDir);
		expect(result).toBeNull();
	});

	test('loadContextMap returns null for wrong schema_version', () => {
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		fs.writeFileSync(
			path.join(swarmDir, 'context-map.json'),
			JSON.stringify({
				schema_version: 99,
				files: {},
				task_history: {},
				decisions: [],
			}),
		);
		const result = loadContextMap(tempDir);
		expect(result).toBeNull();
	});

	test('saveContextMap + loadContextMap round-trip preserves data', () => {
		const original: ContextMap = {
			schema_version: 1,
			generated_at: new Date().toISOString(),
			repo_fingerprint: 'abc123',
			files: {},
			task_history: {},
			decisions: [],
		};
		saveContextMap(original, tempDir);
		const loaded = loadContextMap(tempDir);
		expect(loaded).not.toBeNull();
		expect(loaded!.schema_version).toBe(1);
		expect(loaded!.repo_fingerprint).toBe('abc123');
	});

	test('saveContextMap updates generated_at timestamp', () => {
		const original = createEmptyContextMap();
		original.generated_at = '2020-01-01T00:00:00.000Z';
		saveContextMap(original, tempDir);
		const loaded = loadContextMap(tempDir);
		expect(loaded!.generated_at).not.toBe('2020-01-01T00:00:00.000Z');
	});
});

// ---------------------------------------------------------------------------
// markStaleEntries
// ---------------------------------------------------------------------------

describe('markStaleEntries', () => {
	test('detects changed files (different hash)', () => {
		// Create a real file
		const testFile = path.join(tempDir, 'test.ts');
		fs.writeFileSync(testFile, 'original content', 'utf-8');

		const contentHash = computeContentHash('original content');
		const map: ContextMap = {
			schema_version: 1,
			generated_at: new Date().toISOString(),
			repo_fingerprint: '',
			files: {
				'test.ts': {
					path: 'test.ts',
					content_hash: contentHash,
					mtime_ms: 0,
					language: 'typescript',
					purpose: 'test',
					summary: 'test',
				} as FileContextEntry,
			},
			task_history: {},
			decisions: [],
		};

		// Mutate the file
		fs.writeFileSync(testFile, 'modified content', 'utf-8');

		const stale = markStaleEntries(map, tempDir);
		expect(stale).toHaveLength(1);
		expect(stale[0].path).toBe('test.ts');
	});

	test('markStaleEntries skips unchanged files (same hash)', () => {
		const testFile = path.join(tempDir, 'test.ts');
		const content = 'same content';
		fs.writeFileSync(testFile, content, 'utf-8');

		const contentHash = computeContentHash(content);
		const stat = fs.statSync(testFile);

		const map: ContextMap = {
			schema_version: 1,
			generated_at: new Date().toISOString(),
			repo_fingerprint: '',
			files: {
				'test.ts': {
					path: 'test.ts',
					content_hash: contentHash,
					mtime_ms: stat.mtimeMs,
					language: 'typescript',
					purpose: 'test',
					summary: 'test',
				} as FileContextEntry,
			},
			task_history: {},
			decisions: [],
		};

		const stale = markStaleEntries(map, tempDir);
		expect(stale).toHaveLength(0);
	});

	test('markStaleEntries detects deleted files', () => {
		const map: ContextMap = {
			schema_version: 1,
			generated_at: new Date().toISOString(),
			repo_fingerprint: '',
			files: {
				'ghost.ts': {
					path: 'ghost.ts',
					content_hash: 'abc123',
					mtime_ms: 0,
					language: 'typescript',
					purpose: 'test',
					summary: 'test',
				} as FileContextEntry,
			},
			task_history: {},
			decisions: [],
		};

		const stale = markStaleEntries(map, tempDir);
		expect(stale).toHaveLength(1);
		expect(stale[0].path).toBe('ghost.ts');
	});
});

// ---------------------------------------------------------------------------
// appendTaskHistory
// ---------------------------------------------------------------------------

describe('appendTaskHistory', () => {
	test('adds task entry immutably', () => {
		const original = createEmptyContextMap();
		const summary: TaskContextSummary = {
			task_id: '1.1',
			goal: 'Implement feature X',
			files_touched: ['src/x.ts'],
			final_status: 'approved',
		};

		const updated = appendTaskHistory(original, summary);

		// Original unchanged
		expect(original.task_history).toEqual({});
		// Updated has new entry
		expect(updated.task_history['1.1']).toEqual(summary);
	});

	test('overwrites existing task entry', () => {
		const original: ContextMap = {
			...createEmptyContextMap(),
			task_history: {
				'1.1': {
					task_id: '1.1',
					goal: 'old',
					files_touched: [],
					final_status: 'pending',
				},
			},
		};

		const summary: TaskContextSummary = {
			task_id: '1.1',
			goal: 'new goal',
			files_touched: ['src/x.ts'],
			final_status: 'approved',
		};

		const updated = appendTaskHistory(original, summary);
		expect(updated.task_history['1.1'].goal).toBe('new goal');
		expect(updated.task_history['1.1'].final_status).toBe('approved');
	});
});

// ---------------------------------------------------------------------------
// appendDecision
// ---------------------------------------------------------------------------

describe('appendDecision', () => {
	test('appends decision immutably', () => {
		const original = createEmptyContextMap();
		const decision: DecisionEntry = {
			id: 'D1',
			decision: 'Use SHA-256 for content hashing',
			rationale: 'Industry standard',
			timestamp: new Date().toISOString(),
		};

		const updated = appendDecision(original, decision);

		// Original unchanged
		expect(original.decisions).toEqual([]);
		// Updated has new decision
		expect(updated.decisions).toHaveLength(1);
		expect(updated.decisions[0]).toEqual(decision);
	});

	test('appends multiple decisions in order', () => {
		let map = createEmptyContextMap();
		for (let i = 1; i <= 3; i++) {
			const decision: DecisionEntry = {
				id: `D${i}`,
				decision: `Decision ${i}`,
				rationale: '...',
				timestamp: new Date().toISOString(),
			};
			map = appendDecision(map, decision);
		}

		expect(map.decisions).toHaveLength(3);
		expect(map.decisions.map((d) => d.id)).toEqual(['D1', 'D2', 'D3']);
	});
});

// ---------------------------------------------------------------------------
// _internals DI seam
// ---------------------------------------------------------------------------

describe('_internals DI seam', () => {
	test('mock readFileSync override is used by loadContextMap', () => {
		// Must mock existsSync too, otherwise loadContextMap returns null before reading
		_internals.existsSync = mock(() => true) as typeof _internals.existsSync;
		// Override readFileSync to return valid JSON
		_internals.readFileSync = mock((filePath: string) => {
			if (filePath.endsWith('context-map.json')) {
				return JSON.stringify({
					schema_version: 1,
					generated_at: new Date().toISOString(),
					repo_fingerprint: 'test',
					files: {},
					task_history: {},
					decisions: [],
				});
			}
			throw new Error('unexpected path');
		}) as typeof _internals.readFileSync;

		const result = loadContextMap(tempDir);
		expect(result).not.toBeNull();
		expect(result!.repo_fingerprint).toBe('test');
	});

	test('mock existsSync override is used by loadContextMap', () => {
		// Make it appear file doesn't exist
		_internals.existsSync = mock(() => false) as typeof _internals.existsSync;

		const result = loadContextMap(tempDir);
		expect(result).toBeNull();
	});

	test('mock writeFileSync override is used by saveContextMap', () => {
		// Also mock renameSync to avoid real filesystem operations
		_internals.renameSync = mock(() => {}) as typeof _internals.renameSync;
		let writtenContent = '';
		_internals.writeFileSync = mock((path: string, content: string) => {
			writtenContent = content;
		}) as typeof _internals.writeFileSync;

		const map = createEmptyContextMap();
		saveContextMap(map, tempDir);

		expect(writtenContent).toContain('schema_version');
	});

	test('mock createHash override is used by computeContentHash', () => {
		// Override createHash to return a known hash
		let capturedAlgorithm = '';
		const mockHash = {
			update: (data: string, _encoding: BufferEncoding) => mockHash,
			digest: (_encoding: BufferEncoding) => 'a'.repeat(64),
		};
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		_internals.createHash = mock((algorithm: string) => {
			capturedAlgorithm = algorithm;
			return mockHash as any;
		}) as typeof _internals.createHash;

		const hash = computeContentHash('test');
		expect(capturedAlgorithm).toBe('sha256');
		expect(hash).toBe('a'.repeat(64));
	});
});
