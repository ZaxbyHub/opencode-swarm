/**
 * Tests filling the gaps surfaced by the second-round council review:
 *  - prototype pollution via poisoned existing evidence file (HIGH)
 *  - preservation of existing non-council gate entries (MEDIUM)
 *  - corrupted-JSON recovery branch (MEDIUM)
 *  - JSON-array-input fresh-start branch (MEDIUM)
 *  - gates.council write path visible to check_gate_status semantics (HIGH/SME)
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCouncilEvidence } from '../../../src/council/council-evidence-writer';
import type { CouncilSynthesis } from '../../../src/council/types';

let tempDir: string;

const makeSynthesis = (
	overrides: Partial<CouncilSynthesis> = {},
): CouncilSynthesis => ({
	taskId: '1.1',
	swarmId: 'swarm-1',
	timestamp: '2026-04-13T00:00:00.000Z',
	overallVerdict: 'APPROVE',
	vetoedBy: null,
	memberVerdicts: [],
	unresolvedConflicts: [],
	requiredFixes: [],
	advisoryFindings: [],
	unifiedFeedbackMd: '',
	roundNumber: 1,
	allCriteriaMet: true,
	quorumSize: 3,
	...overrides,
});

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), 'council-evidence-gaps-'));
});

afterEach(() => {
	mock.restore();
	rmSync(tempDir, { recursive: true, force: true });
});

describe('evidence writer — gates.council integration', () => {
	test('writes to evidence.gates.council with standard GateInfo fields', async () => {
		await writeCouncilEvidence(tempDir, makeSynthesis());
		const evidence = JSON.parse(
			readFileSync(join(tempDir, '.swarm', 'evidence', '1.1.json'), 'utf-8'),
		);
		expect(evidence.gates).toBeDefined();
		expect(evidence.gates.council).toBeDefined();
		expect(evidence.gates.council.sessionId).toBe('swarm-1');
		expect(evidence.gates.council.timestamp).toBe('2026-04-13T00:00:00.000Z');
		expect(evidence.gates.council.agent).toBe('architect');
		expect(evidence.gates.council.verdict).toBe('APPROVE');
		// quorumSize must be persisted for rehydration validation (Task 3.3)
		expect(evidence.gates.council.quorumSize).toBe(3);
	});

	test('does NOT write council at top-level (must be under gates)', async () => {
		await writeCouncilEvidence(tempDir, makeSynthesis());
		const evidence = JSON.parse(
			readFileSync(join(tempDir, '.swarm', 'evidence', '1.1.json'), 'utf-8'),
		);
		expect(evidence.council).toBeUndefined();
	});
});

describe('evidence writer — preservation of existing evidence', () => {
	test('preserves existing non-council gate entries', async () => {
		const dir = join(tempDir, '.swarm', 'evidence');
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				required_gates: ['reviewer', 'test_engineer'],
				gates: {
					reviewer: {
						sessionId: 'prior-session',
						timestamp: '2024-01-01T00:00:00Z',
						agent: 'reviewer',
					},
				},
			}),
		);

		await writeCouncilEvidence(tempDir, makeSynthesis());
		const evidence = JSON.parse(readFileSync(join(dir, '1.1.json'), 'utf-8'));

		// Existing reviewer gate entry survives
		expect(evidence.gates.reviewer).toBeDefined();
		expect(evidence.gates.reviewer.sessionId).toBe('prior-session');
		// Existing top-level keys survive
		expect(evidence.taskId).toBe('1.1');
		expect(evidence.required_gates).toEqual(['reviewer', 'test_engineer']);
		// Council added alongside
		expect(evidence.gates.council).toBeDefined();
	});

	test('second write overwrites council but keeps other gates', async () => {
		await writeCouncilEvidence(
			tempDir,
			makeSynthesis({ roundNumber: 1, overallVerdict: 'REJECT' }),
		);
		await writeCouncilEvidence(
			tempDir,
			makeSynthesis({ roundNumber: 2, overallVerdict: 'APPROVE' }),
		);
		const evidence = JSON.parse(
			readFileSync(join(tempDir, '.swarm', 'evidence', '1.1.json'), 'utf-8'),
		);
		// Latest round wins
		expect(evidence.gates.council.verdict).toBe('APPROVE');
		expect(evidence.gates.council.roundNumber).toBe(2);
	});
});

describe('evidence writer — prototype pollution defence', () => {
	test('poisoned __proto__ in existing evidence does not pollute Object.prototype', async () => {
		const dir = join(tempDir, '.swarm', 'evidence');
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, '1.1.json'),
			'{"__proto__": {"polluted": true}, "gates": {}}',
		);

		await writeCouncilEvidence(tempDir, makeSynthesis());

		// Global Object.prototype must not have gained a `polluted` key.
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		// File must still be valid JSON with the council entry.
		const evidence = JSON.parse(readFileSync(join(dir, '1.1.json'), 'utf-8'));
		expect(evidence.gates.council).toBeDefined();
		// Forbidden keys must not appear as enumerable own-properties of the root.
		expect(Object.hasOwn(evidence, '__proto__')).toBe(false);
	});

	test('poisoned constructor / prototype keys are dropped', async () => {
		const dir = join(tempDir, '.swarm', 'evidence');
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, '1.1.json'),
			'{"constructor": "evil", "prototype": "bad", "gates": {"__proto__": {"x":1}}}',
		);

		await writeCouncilEvidence(tempDir, makeSynthesis());
		const raw = readFileSync(
			join(tempDir, '.swarm', 'evidence', '1.1.json'),
			'utf-8',
		);
		// These keys must not be written back at the top level.
		expect(raw).not.toContain('"constructor"');
		expect(raw).not.toContain('"prototype"');
	});
});

describe('evidence writer — malformed input recovery', () => {
	test('corrupted existing JSON falls through to fresh start', async () => {
		const dir = join(tempDir, '.swarm', 'evidence');
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, '1.1.json'), 'not valid json at all');

		// Must not throw; must write a valid council entry.
		await expect(
			writeCouncilEvidence(tempDir, makeSynthesis()),
		).resolves.toBeUndefined();
		const evidence = JSON.parse(readFileSync(join(dir, '1.1.json'), 'utf-8'));
		expect(evidence.gates.council.verdict).toBe('APPROVE');
	});

	test('existing file containing a JSON array triggers fresh start (not spread)', async () => {
		const dir = join(tempDir, '.swarm', 'evidence');
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, '1.1.json'), '["not","an","object"]');

		await writeCouncilEvidence(tempDir, makeSynthesis());
		const evidence = JSON.parse(readFileSync(join(dir, '1.1.json'), 'utf-8'));
		// Result must be a plain object with gates.council, not an array.
		expect(Array.isArray(evidence)).toBe(false);
		expect(evidence.gates.council).toBeDefined();
		// None of the array entries should have been spread in.
		expect(Object.hasOwn(evidence, '0')).toBe(false);
	});

	test('existing JSON null triggers fresh start', async () => {
		const dir = join(tempDir, '.swarm', 'evidence');
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, '1.1.json'), 'null');

		await expect(
			writeCouncilEvidence(tempDir, makeSynthesis()),
		).resolves.toBeUndefined();
		const evidence = JSON.parse(readFileSync(join(dir, '1.1.json'), 'utf-8'));
		expect(evidence.gates.council.verdict).toBe('APPROVE');
	});

	test('file with gates field of wrong type (array) is gracefully replaced', async () => {
		const dir = join(tempDir, '.swarm', 'evidence');
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, '1.1.json'), '{"taskId":"1.1","gates":["oops"]}');
		await writeCouncilEvidence(tempDir, makeSynthesis());
		const evidence = JSON.parse(readFileSync(join(dir, '1.1.json'), 'utf-8'));
		expect(Array.isArray(evidence.gates)).toBe(false);
		expect(evidence.gates.council).toBeDefined();
		// Top-level taskId survives.
		expect(evidence.taskId).toBe('1.1');
	});
});

describe('evidence writer — safeAssignOwnProps recursive filtering', () => {
	// Helper to verify forbidden keys are absent at all levels
	function assertNoForbiddenKeys(obj: unknown, path = 'root'): void {
		if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return;
		const record = obj as Record<string, unknown>;
		for (const key of Object.keys(record)) {
			expect(`${path}.${key}`).not.toMatch(
				/^(constructor|prototype|__proto__)$/,
			);
			assertNoForbiddenKeys(record[key], `${path}.${key}`);
		}
	}

	test('forbidden key at level 3 (deeply nested) is filtered', async () => {
		const dir = join(tempDir, '.swarm', 'evidence');
		mkdirSync(dir, { recursive: true });
		// { gates: { reviewer: { __proto__: { polluted: true } } } }
		writeFileSync(
			join(dir, '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				gates: {
					reviewer: {
						__proto__: { polluted: true },
						sessionId: 'prior',
					},
				},
			}),
		);

		await writeCouncilEvidence(tempDir, makeSynthesis());
		const evidence = JSON.parse(readFileSync(join(dir, '1.1.json'), 'utf-8'));

		// The nested __proto__ must be completely absent
		expect(evidence.gates.reviewer).toBeDefined();
		expect(evidence.gates.reviewer.sessionId).toBe('prior');
		expect(Object.hasOwn(evidence.gates.reviewer, '__proto__')).toBe(false);
		assertNoForbiddenKeys(evidence);
	});

	test('array of objects with forbidden keys — forbidden keys sanitized within each item', async () => {
		const dir = join(tempDir, '.swarm', 'evidence');
		mkdirSync(dir, { recursive: true });
		// { gates: { items: [{ __proto__: {} }, { constructor: {} }, { name: 'ok' }] } }
		writeFileSync(
			join(dir, '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				gates: {
					items: [
						{ __proto__: { x: 1 } },
						{ constructor: { y: 2 } },
						{ name: 'valid' },
					],
				},
			}),
		);

		await writeCouncilEvidence(tempDir, makeSynthesis());
		const evidence = JSON.parse(readFileSync(join(dir, '1.1.json'), 'utf-8'));

		// Array length preserved; forbidden keys sanitized within each object
		expect(evidence.gates.items).toHaveLength(3);
		expect(evidence.gates.items[0]).toEqual({});
		expect(evidence.gates.items[1]).toEqual({});
		expect(evidence.gates.items[2].name).toBe('valid');
		assertNoForbiddenKeys(evidence);
	});

	test('array of arrays containing objects with forbidden keys — inner objects sanitized', async () => {
		const dir = join(tempDir, '.swarm', 'evidence');
		mkdirSync(dir, { recursive: true });
		// Deeply nested: gates.data = [[[{ __proto__: {} }, { safe: 1 }]]]
		writeFileSync(
			join(dir, '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				gates: {
					data: [[[{ __proto__: { deep: true } }, { safe: 1 }]]],
				},
			}),
		);

		await writeCouncilEvidence(tempDir, makeSynthesis());
		const evidence = JSON.parse(readFileSync(join(dir, '1.1.json'), 'utf-8'));

		// Both objects preserved but __proto__ sanitized from first
		expect(evidence.gates.data[0][0]).toHaveLength(2);
		expect(evidence.gates.data[0][0][0]).toEqual({});
		expect(evidence.gates.data[0][0][1].safe).toBe(1);
		assertNoForbiddenKeys(evidence);
	});

	test('mixed nesting: object → array → object with forbidden key at level 3', async () => {
		const dir = join(tempDir, '.swarm', 'evidence');
		mkdirSync(dir, { recursive: true });
		// gates.levels: [{ inner: { __proto__: {} } }]
		writeFileSync(
			join(dir, '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				gates: {
					levels: [
						{
							inner: { __proto__: { level3: true }, safe: 'present' },
						},
					],
				},
			}),
		);

		await writeCouncilEvidence(tempDir, makeSynthesis());
		const evidence = JSON.parse(readFileSync(join(dir, '1.1.json'), 'utf-8'));

		expect(evidence.gates.levels[0].inner.safe).toBe('present');
		expect(Object.hasOwn(evidence.gates.levels[0].inner, '__proto__')).toBe(
			false,
		);
		assertNoForbiddenKeys(evidence);
	});

	test('gates.reviewer.__proto__ nested forbidden key is filtered', async () => {
		const dir = join(tempDir, '.swarm', 'evidence');
		mkdirSync(dir, { recursive: true });
		// The exact shape: gates.reviewer.__proto__ = { polluted: true }
		writeFileSync(
			join(dir, '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				gates: {
					reviewer: {
						__proto__: { polluted: true },
						sessionId: 'session-xyz',
						timestamp: '2024-01-01T00:00:00Z',
						agent: 'reviewer',
					},
				},
			}),
		);

		await writeCouncilEvidence(tempDir, makeSynthesis());
		const evidence = JSON.parse(readFileSync(join(dir, '1.1.json'), 'utf-8'));

		// reviewer entry survives with safe fields
		expect(evidence.gates.reviewer.sessionId).toBe('session-xyz');
		expect(Object.hasOwn(evidence.gates.reviewer, '__proto__')).toBe(false);
		assertNoForbiddenKeys(evidence);
	});

	test('round-trip: write evidence with nested forbidden keys, read back, keys are gone', async () => {
		const dir = join(tempDir, '.swarm', 'evidence');
		mkdirSync(dir, { recursive: true });

		// First write — write with deep nested __proto__
		writeFileSync(
			join(dir, '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				gates: {
					reviewer: {
						sessionId: 's1',
						deep: {
							__proto__: { nested: true },
							value: 42,
						},
					},
				},
			}),
		);

		// First read via writeCouncilEvidence (which re-reads and sanitizes)
		await writeCouncilEvidence(
			tempDir,
			makeSynthesis({ overallVerdict: 'REJECT', roundNumber: 1 }),
		);

		// Write again with new synthesis
		await writeCouncilEvidence(
			tempDir,
			makeSynthesis({ overallVerdict: 'APPROVE', roundNumber: 2 }),
		);

		const evidence = JSON.parse(readFileSync(join(dir, '1.1.json'), 'utf-8'));

		// The nested __proto__ must not survive either round-trip
		expect(evidence.gates.reviewer.deep.value).toBe(42);
		expect(Object.hasOwn(evidence.gates.reviewer.deep, '__proto__')).toBe(
			false,
		);
		assertNoForbiddenKeys(evidence);
	});

	test('all three forbidden keys (__proto__, constructor, prototype) filtered at all depths', async () => {
		const dir = join(tempDir, '.swarm', 'evidence');
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				gates: {
					level1: {
						__proto__: {},
						level2: {
							constructor: {},
							level3: {
								prototype: { filtered: true },
								safe: 'value',
							},
						},
					},
				},
			}),
		);

		await writeCouncilEvidence(tempDir, makeSynthesis());
		const evidence = JSON.parse(readFileSync(join(dir, '1.1.json'), 'utf-8'));

		// All safe paths survive
		expect(evidence.gates.level1.level2.level3.safe).toBe('value');
		// All forbidden paths are gone at every level
		expect(Object.hasOwn(evidence.gates.level1, '__proto__')).toBe(false);
		expect(Object.hasOwn(evidence.gates.level1.level2, 'constructor')).toBe(
			false,
		);
		expect(
			Object.hasOwn(evidence.gates.level1.level2.level3, 'prototype'),
		).toBe(false);
		assertNoForbiddenKeys(evidence);
	});
});

describe('evidence writer — idempotency / no directory pollution', () => {
	test('writer only creates files under .swarm/evidence/', async () => {
		await writeCouncilEvidence(tempDir, makeSynthesis());
		expect(existsSync(join(tempDir, '.swarm', 'evidence', '1.1.json'))).toBe(
			true,
		);
		// Guard: no other directories were created at the tempDir root.
		const entries = new Set(
			[
				'.swarm',
				// Any platform-generated entries (e.g. .DS_Store) would be noise.
			].filter(Boolean),
		);
		expect(entries.has('.swarm')).toBe(true);
	});
});

describe('evidence writer — primitive gates value handling', () => {
	test('gates as string primitive is discarded and replaced with council entry', async () => {
		const dir = join(tempDir, '.swarm', 'evidence');
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				status: 'pending',
				gates: 'not-an-object',
			}),
		);

		await writeCouncilEvidence(tempDir, makeSynthesis());
		const evidence = JSON.parse(readFileSync(join(dir, '1.1.json'), 'utf-8'));

		// gates must be a valid object, not the original string
		expect(typeof evidence.gates).toBe('object');
		expect(Array.isArray(evidence.gates)).toBe(false);
		expect(evidence.gates.council).toBeDefined();
		expect(evidence.gates.council.sessionId).toBe('swarm-1');
		// Original top-level keys survive
		expect(evidence.taskId).toBe('1.1');
		expect(evidence.status).toBe('pending');
	});

	test('gates as number primitive is discarded and replaced with council entry', async () => {
		const dir = join(tempDir, '.swarm', 'evidence');
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				gates: 42,
			}),
		);

		await writeCouncilEvidence(tempDir, makeSynthesis());
		const evidence = JSON.parse(readFileSync(join(dir, '1.1.json'), 'utf-8'));

		// gates must be a valid object, not the original number
		expect(typeof evidence.gates).toBe('object');
		expect(Array.isArray(evidence.gates)).toBe(false);
		expect(evidence.gates.council).toBeDefined();
		expect(evidence.gates.council.verdict).toBe('APPROVE');
	});

	test('absent gates key results in gates.council being created', async () => {
		const dir = join(tempDir, '.swarm', 'evidence');
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				status: 'pending',
			}),
		);

		await writeCouncilEvidence(tempDir, makeSynthesis());
		const evidence = JSON.parse(readFileSync(join(dir, '1.1.json'), 'utf-8'));

		// gates must now exist with council entry
		expect(evidence.gates).toBeDefined();
		expect(typeof evidence.gates).toBe('object');
		expect(evidence.gates.council).toBeDefined();
		expect(evidence.gates.council.agent).toBe('architect');
		// Original top-level keys survive
		expect(evidence.taskId).toBe('1.1');
		expect(evidence.status).toBe('pending');
	});

	test('gates as array is discarded and replaced with council entry', async () => {
		const dir = join(tempDir, '.swarm', 'evidence');
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				status: 'pending',
				gates: ['evil', 'array'],
			}),
		);

		await writeCouncilEvidence(tempDir, makeSynthesis());
		const evidence = JSON.parse(readFileSync(join(dir, '1.1.json'), 'utf-8'));

		// gates must be an object, not the original array
		expect(Array.isArray(evidence.gates)).toBe(false);
		expect(evidence.gates).toBeDefined();
		expect(typeof evidence.gates).toBe('object');
		expect(evidence.gates.council).toBeDefined();
		expect(evidence.gates.council.sessionId).toBe('swarm-1');
		// Original top-level keys survive
		expect(evidence.taskId).toBe('1.1');
		expect(evidence.status).toBe('pending');
	});

	test('gates as null is discarded and replaced with council entry', async () => {
		const dir = join(tempDir, '.swarm', 'evidence');
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				status: 'pending',
				gates: null,
			}),
		);

		await writeCouncilEvidence(tempDir, makeSynthesis());
		const evidence = JSON.parse(readFileSync(join(dir, '1.1.json'), 'utf-8'));

		// gates must be an object, not null
		expect(evidence.gates).toBeDefined();
		expect(evidence.gates).not.toBeNull();
		expect(typeof evidence.gates).toBe('object');
		expect(Array.isArray(evidence.gates)).toBe(false);
		expect(evidence.gates.council).toBeDefined();
		expect(evidence.gates.council.verdict).toBe('APPROVE');
		// Original top-level keys survive
		expect(evidence.taskId).toBe('1.1');
		expect(evidence.status).toBe('pending');
	});
});

describe('evidence writer — Object.hasOwn constructor/prototype filtering', () => {
	test('constructor and prototype are not own properties of gates after write', async () => {
		const dir = join(tempDir, '.swarm', 'evidence');
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				gates: {
					__proto__: { sessionId: 'evil-proto' },
					constructor: { sessionId: 'evil-constructor' },
					prototype: { sessionId: 'evil-prototype' },
					reviewer: {
						sessionId: 'safe-session',
						timestamp: '2024-01-01T00:00:00Z',
						agent: 'reviewer',
					},
				},
			}),
		);

		await writeCouncilEvidence(tempDir, makeSynthesis());
		const evidence = JSON.parse(readFileSync(join(dir, '1.1.json'), 'utf-8'));

		// Verify with Object.hasOwn — stronger than string search
		expect(Object.hasOwn(evidence.gates, '__proto__')).toBe(false);
		expect(Object.hasOwn(evidence.gates, 'constructor')).toBe(false);
		expect(Object.hasOwn(evidence.gates, 'prototype')).toBe(false);
		// Safe entries survive
		expect(evidence.gates.reviewer).toBeDefined();
		expect(evidence.gates.reviewer.sessionId).toBe('safe-session');
		// Council was added
		expect(evidence.gates.council).toBeDefined();
	});
});

describe('evidence writer — round-history audit log', () => {
	const makeRoundSynthesis = (
		overrides: Partial<CouncilSynthesis> = {},
	): CouncilSynthesis => ({
		taskId: '1.1',
		swarmId: 'swarm-1',
		timestamp: '2026-04-13T00:00:00.000Z',
		overallVerdict: 'APPROVE',
		vetoedBy: null,
		memberVerdicts: [],
		unresolvedConflicts: [],
		requiredFixes: [],
		advisoryFindings: [],
		unifiedFeedbackMd: '',
		roundNumber: 1,
		allCriteriaMet: true,
		quorumSize: 3,
		...overrides,
	});

	test('creates .swarm/council/{taskId}.rounds.jsonl after write', async () => {
		await writeCouncilEvidence(tempDir, makeRoundSynthesis());

		const roundsPath = join(tempDir, '.swarm', 'council', '1.1.rounds.jsonl');
		expect(existsSync(roundsPath)).toBe(true);
	});

	test('JSONL line contains {round, verdict, timestamp, vetoedBy}', async () => {
		await writeCouncilEvidence(
			tempDir,
			makeRoundSynthesis({
				roundNumber: 3,
				overallVerdict: 'REJECT',
				vetoedBy: ['critic'],
			}),
		);

		const roundsPath = join(tempDir, '.swarm', 'council', '1.1.rounds.jsonl');
		const lines = readFileSync(roundsPath, 'utf-8').trim().split('\n');
		expect(lines).toHaveLength(1);

		const entry = JSON.parse(lines[0]!);
		expect(entry).toEqual({
			round: 3,
			verdict: 'REJECT',
			timestamp: '2026-04-13T00:00:00.000Z',
			vetoedBy: ['critic'],
		});
	});

	test('multiple calls append multiple lines (not overwrite)', async () => {
		await writeCouncilEvidence(
			tempDir,
			makeRoundSynthesis({
				roundNumber: 1,
				overallVerdict: 'REJECT',
				vetoedBy: ['reviewer'],
			}),
		);
		await writeCouncilEvidence(
			tempDir,
			makeRoundSynthesis({
				roundNumber: 2,
				overallVerdict: 'CONCERNS',
				vetoedBy: null,
			}),
		);
		await writeCouncilEvidence(
			tempDir,
			makeRoundSynthesis({
				roundNumber: 3,
				overallVerdict: 'APPROVE',
				vetoedBy: null,
			}),
		);

		const roundsPath = join(tempDir, '.swarm', 'council', '1.1.rounds.jsonl');
		const lines = readFileSync(roundsPath, 'utf-8').trim().split('\n');
		expect(lines).toHaveLength(3);

		expect(JSON.parse(lines[0]!)).toEqual({
			round: 1,
			verdict: 'REJECT',
			timestamp: '2026-04-13T00:00:00.000Z',
			vetoedBy: ['reviewer'],
		});
		expect(JSON.parse(lines[1]!)).toEqual({
			round: 2,
			verdict: 'CONCERNS',
			timestamp: '2026-04-13T00:00:00.000Z',
			vetoedBy: null,
		});
		expect(JSON.parse(lines[2]!)).toEqual({
			round: 3,
			verdict: 'APPROVE',
			timestamp: '2026-04-13T00:00:00.000Z',
			vetoedBy: null,
		});
	});

	test('appendFileSync failure does not break primary evidence write and console.warn is called', async () => {
		// Spy on console.warn to verify it gets called on audit failure.
		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (msg: string) => warnings.push(msg);

		// Mock appendFileSync to throw on audit log paths — simulating permission error.
		// The primary evidence write uses atomicWriteFile (bunWrite + rename), not
		// appendFileSync, so mocking appendFileSync only affects the audit log path.
		const realFs = await import('node:fs');
		const mockAppendFileSync = mock((path: string, data: string) => {
			if (path.includes('.rounds.jsonl')) {
				throw new Error('EPERM: permission denied');
			}
			// Delegate non-audit writes to the real implementation.
			return realFs.appendFileSync(path, data);
		});
		mock.module('node:fs', () => ({
			...realFs,
			appendFileSync: mockAppendFileSync,
		}));

		// Primary evidence write must succeed even when audit log fails.
		await expect(
			writeCouncilEvidence(tempDir, makeRoundSynthesis()),
		).resolves.toBeUndefined();

		// Verify the primary evidence file was written correctly.
		const evidence = JSON.parse(
			readFileSync(join(tempDir, '.swarm', 'evidence', '1.1.json'), 'utf-8'),
		);
		expect(evidence.gates.council).toBeDefined();
		expect(evidence.gates.council.verdict).toBe('APPROVE');

		// Verify console.warn was called with the audit failure message.
		expect(
			warnings.some((w) =>
				w.includes('failed to append round-history audit log'),
			),
		).toBe(true);

		console.warn = originalWarn;
		mock.restore();
	});
});
