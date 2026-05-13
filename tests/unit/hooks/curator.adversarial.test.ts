/**
 * Adversarial Tests for curator.ts I/O functions
 *
 * These tests validate security and robustness against malicious inputs
 * targeting the readCuratorSummary and writeCuratorSummary functions.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	getGlobalEventBus,
	resetGlobalEventBus,
} from '../../../src/background/event-bus.js';
import {
	applyCuratorKnowledgeUpdates,
	checkPhaseCompliance,
	filterPhaseEvents,
	readCuratorSummary,
	runCuratorInit,
	runCuratorPhase,
	writeCuratorSummary,
} from '../../../src/hooks/curator';
import type {
	CuratorConfig,
	KnowledgeRecommendation,
} from '../../../src/hooks/curator-types';
import type { KnowledgeConfig } from '../../../src/hooks/knowledge-types';
import {
	createAdversarialCuratorConfig,
	createCuratorTestDir,
	createDeepNestedObject,
	createKnowledgeEntriesBulk,
	createKnowledgeEntry,
	createKnowledgeRecommendation,
	createKnowledgeRecommendationsBulk,
	createLargeValidJson,
	createPhaseEvent,
	createPhaseEventsBulk,
	createPlanFile,
	createSimplePlan,
	createValidSummary,
} from '../../helpers/curator-test-helpers';

// ============================================================================
// curator.ts I/O - Adversarial Tests
// ============================================================================

describe('curator.ts I/O - Adversarial Tests', () => {
	let tempDir: string;
	let cleanup: () => void;

	beforeEach(() => {
		const result = createCuratorTestDir('curator-adversarial');
		tempDir = result.tempDir;
		cleanup = result.cleanup;
	});

	afterEach(() => cleanup());

	describe('Path traversal via null bytes', () => {
		it('should return null when directory path has null byte (read)', async () => {
			expect(await readCuratorSummary('/tmp/test\0evil')).toBeNull();
		});

		it('should throw when directory path has null byte (write)', async () => {
			await expect(
				writeCuratorSummary('/tmp/test\0evil', createValidSummary()),
			).rejects.toThrow();
		});
	});

	describe('Oversized JSON input (10MB)', () => {
		it('should handle 10MB valid JSON without hanging or OOM', async () => {
			writeFileSync(
				join(tempDir, '.swarm', 'curator-summary.json'),
				createLargeValidJson(10 * 1024 * 1024),
				'utf-8',
			);
			const result = await readCuratorSummary(tempDir);
			expect(result).not.toBeNull();
			expect(result?.schema_version).toBe(1);
		}, 30000);
	});

	describe('Non-string schema_version', () => {
		const invalidSummary = (version: unknown) =>
			JSON.stringify({
				schema_version: version,
				session_id: 'test-session',
				last_updated: new Date().toISOString(),
				last_phase_covered: 1,
				digest: 'test-digest',
				phase_digests: [],
				compliance_observations: [],
				knowledge_recommendations: [],
			});

		it('should return null when schema_version is string "1"', async () => {
			writeFileSync(
				join(tempDir, '.swarm', 'curator-summary.json'),
				invalidSummary('1'),
				'utf-8',
			);
			expect(await readCuratorSummary(tempDir)).toBeNull();
		});

		it('should return null when schema_version is missing', async () => {
			writeFileSync(
				join(tempDir, '.swarm', 'curator-summary.json'),
				invalidSummary(undefined),
				'utf-8',
			);
			expect(await readCuratorSummary(tempDir)).toBeNull();
		});

		it('should return null when schema_version is number 2', async () => {
			writeFileSync(
				join(tempDir, '.swarm', 'curator-summary.json'),
				invalidSummary(2),
				'utf-8',
			);
			expect(await readCuratorSummary(tempDir)).toBeNull();
		});
	});

	describe('Null summary fields', () => {
		it('should return parsed object when all optional fields are null', async () => {
			writeFileSync(
				join(tempDir, '.swarm', 'curator-summary.json'),
				JSON.stringify({
					schema_version: 1,
					session_id: null,
					last_updated: null,
					last_phase_covered: null,
					digest: null,
					phase_digests: null,
					compliance_observations: null,
					knowledge_recommendations: null,
				}),
				'utf-8',
			);
			const result = await readCuratorSummary(tempDir);
			expect(result).not.toBeNull();
			expect(result?.schema_version).toBe(1);
		});

		it('should return parsed object when fields are missing', async () => {
			writeFileSync(
				join(tempDir, '.swarm', 'curator-summary.json'),
				JSON.stringify({ schema_version: 1 }),
				'utf-8',
			);
			const result = await readCuratorSummary(tempDir);
			expect(result).not.toBeNull();
			expect(result?.schema_version).toBe(1);
		});
	});

	describe('writeCuratorSummary with circular reference', () => {
		it('should propagate error when summary has circular reference', async () => {
			const summary = createValidSummary();
			const circular: Record<string, unknown> = { name: 'circular' };
			circular.self = circular;
			summary.digest = circular as unknown as string;
			await expect(writeCuratorSummary(tempDir, summary)).rejects.toThrow();
		});
	});

	describe('Empty string directory', () => {
		const cwdSwarmDir = join(process.cwd(), '.swarm');

		beforeEach(() => {
			try {
				rmSync(join(cwdSwarmDir, 'curator-summary.json'), { force: true });
				rmSync(cwdSwarmDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
			const { mkdirSync } = require('node:fs');
			mkdirSync(cwdSwarmDir, { recursive: true });
		});

		afterEach(() => {
			try {
				rmSync(join(cwdSwarmDir, 'curator-summary.json'), { force: true });
			} catch {
				/* ignore */
			}
		});

		it('should read from cwd/.swarm when directory is empty string', async () => {
			expect(await readCuratorSummary('')).toBeNull();
		});

		it('should write to cwd/.swarm when directory is empty string', async () => {
			await writeCuratorSummary('', createValidSummary());
			const result = await readCuratorSummary('');
			expect(result).not.toBeNull();
			expect(result?.session_id).toBe('test-session-adversarial');
		});
	});

	describe('Deeply nested JSON (1000 levels)', () => {
		it('should handle 1000-level deep nested object in digest', async () => {
			const summary = createValidSummary({
				digest: JSON.stringify(createDeepNestedObject(1000)),
			});
			await writeCuratorSummary(tempDir, summary);
			const result = await readCuratorSummary(tempDir);
			expect(result).not.toBeNull();
			expect(result?.schema_version).toBe(1);
		}, 30000);
	});

	describe('Additional security tests', () => {
		it('should handle completely invalid JSON', async () => {
			writeFileSync(
				join(tempDir, '.swarm', 'curator-summary.json'),
				'this is not json {{{',
				'utf-8',
			);
			expect(await readCuratorSummary(tempDir)).toBeNull();
		});

		it('should handle empty file', async () => {
			writeFileSync(
				join(tempDir, '.swarm', 'curator-summary.json'),
				'',
				'utf-8',
			);
			expect(await readCuratorSummary(tempDir)).toBeNull();
		});

		it('should handle file with only whitespace', async () => {
			writeFileSync(
				join(tempDir, '.swarm', 'curator-summary.json'),
				'   \n\t   ',
				'utf-8',
			);
			expect(await readCuratorSummary(tempDir)).toBeNull();
		});

		it('should handle path traversal attempt in filename', async () => {
			expect(await readCuratorSummary(tempDir)).toBeNull();
		});
	});
});

// ============================================================================
// filterPhaseEvents - Adversarial Tests
// ============================================================================

describe('filterPhaseEvents - Adversarial Tests', () => {
	describe('Oversized JSONL input (10,000 lines)', () => {
		it('should handle 10,000 lines without hanging or crashing', () => {
			const lines = Array.from({ length: 10000 }, (_, i) =>
				JSON.stringify({
					phase: 1,
					timestamp: `2024-01-01T00:00:${i.toString().padStart(2, '0')}Z`,
					event: 'test',
				}),
			);
			const result = filterPhaseEvents(lines.join('\n'), 1);
			expect(result).toBeDefined();
			expect(Array.isArray(result)).toBe(true);
		}, 30000);
	});

	describe('Deeply nested JSON (1000 levels)', () => {
		it('should handle 1000-level deep nested JSON without throwing', () => {
			const result = filterPhaseEvents(
				JSON.stringify({
					...createDeepNestedObject(1000),
					phase: 1,
					timestamp: '2024-01-01T00:00:00Z',
				}),
				1,
			);
			expect(result).toBeDefined();
			expect(Array.isArray(result)).toBe(true);
		});
	});

	describe('Prototype-polluting phase field', () => {
		const protoPayloads = ['__proto__', 'constructor', 'toString'] as const;
		protoPayloads.forEach((val) => {
			it(`should not pollute global object when phase is ${val}`, () => {
				const result = filterPhaseEvents(
					JSON.stringify({ phase: val, timestamp: '2024-01-01T00:00:00Z' }),
					1,
				);
				expect(result.length).toBe(0);
				expect(({} as Record<string, unknown>).prototype).toBeUndefined();
			});
		});
	});

	describe('Non-string timestamp values', () => {
		const cases: [string, unknown][] = [
			['number', 1234567890],
			['object', { iso: '2024-01-01T00:00:00Z' }],
			['null', null],
			['array', ['2024-01-01T00:00:00Z']],
		];
		cases.forEach(([type, val]) => {
			it(`should handle timestamp as ${type}`, () => {
				const result = filterPhaseEvents(
					JSON.stringify({ phase: 1, timestamp: val }),
					1,
					'2024-01-01T00:00:00Z',
				);
				expect(result).toBeDefined();
			});
		});
	});

	describe('JSONL with \\r\\n line endings', () => {
		it('should handle CRLF line endings without crashing', () => {
			const result = filterPhaseEvents(
				JSON.stringify({ phase: 1, timestamp: '2024-01-01T00:00:00Z' }) +
					'\r\n' +
					JSON.stringify({ phase: 1, timestamp: '2024-01-01T00:00:01Z' }),
				1,
			);
			expect(result).toBeDefined();
			expect(result.length).toBe(2);
		});
	});

	describe('Single very long line (100KB)', () => {
		it('should handle 100KB line without crashing', () => {
			const result = filterPhaseEvents(
				JSON.stringify({
					phase: 1,
					timestamp: '2024-01-01T00:00:00Z',
					payload: 'x'.repeat(100 * 1024),
				}),
				1,
			);
			expect(result).toBeDefined();
		}, 30000);
	});

	describe('Invalid phase parameter values', () => {
		const cases: [string, unknown][] = [
			['negative', -1],
			['zero', 0],
			['Infinity', Infinity],
			['NaN', NaN],
		];
		cases.forEach(([type, val]) => {
			it(`should handle ${type} phase`, () => {
				const result = filterPhaseEvents(
					JSON.stringify({ phase: val, timestamp: '2024-01-01T00:00:00Z' }),
					val as number,
				);
				expect(result).toBeDefined();
			});
		});
	});

	describe('Empty sinceTimestamp string', () => {
		it('should match all events when sinceTimestamp is empty string', () => {
			const jsonl =
				JSON.stringify({ phase: 1, timestamp: '2024-01-01T00:00:00Z' }) +
				'\n' +
				JSON.stringify({ phase: 1, timestamp: '2023-01-01T00:00:00Z' });
			const result = filterPhaseEvents(jsonl, 1, '');
			expect(result).toBeDefined();
			expect(result.length).toBe(2);
		});
	});
});

// ============================================================================
// checkPhaseCompliance - Adversarial Tests
// ============================================================================

describe('checkPhaseCompliance - Adversarial Tests', () => {
	describe('Non-object items in phaseEvents', () => {
		const invalidItems: [string, unknown][] = [
			['null', null],
			['undefined', undefined],
			['number', 123],
			['string', 'string event'],
		];
		invalidItems.forEach(([type, val]) => {
			it(`should handle ${type} in phaseEvents array`, () => {
				const events: object[] = [
					val as object,
					{ type: 'phase_complete', timestamp: '2024-01-01T00:00:00Z' },
				];
				const result = checkPhaseCompliance(events, [], ['coder'], 1);
				expect(result).toBeDefined();
				expect(Array.isArray(result)).toBe(true);
			});
		});
	});

	describe('Large number of events (10,000)', () => {
		it('should handle 10,000 events without hanging', () => {
			const events = createPhaseEventsBulk(10000, 'coder');
			const result = checkPhaseCompliance(
				events,
				['coder', 'reviewer'],
				['coder', 'reviewer'],
				1,
			);
			expect(result).toBeDefined();
			expect(Array.isArray(result)).toBe(true);
		}, 30000);
	});

	describe('Duplicate agent names in agentsDispatched', () => {
		it('should not produce duplicate observations for duplicate agent names', () => {
			const result = checkPhaseCompliance(
				[createPhaseEvent('agent.delegation', 'coder')],
				['coder', 'coder', 'coder'],
				['coder'],
				1,
			);
			const missingCoder = result.filter(
				(o) =>
					o.type === 'workflow_deviation' &&
					o.description.includes("Agent 'coder'"),
			);
			expect(missingCoder.length).toBe(0);
		});
	});

	describe('Empty requiredAgents array', () => {
		it('should produce no workflow_deviation observations when requiredAgents is empty', () => {
			const result = checkPhaseCompliance(
				[createPhaseEvent('agent.delegation', 'coder')],
				[],
				[],
				1,
			);
			expect(result.filter((o) => o.type === 'workflow_deviation').length).toBe(
				0,
			);
		});
	});

	describe('Empty string in requiredAgents', () => {
		it('should handle empty string agent name in requiredAgents', () => {
			const result = checkPhaseCompliance(
				[createPhaseEvent('agent.delegation', 'coder')],
				[],
				[''],
				1,
			);
			const missingEmpty = result.filter(
				(o) =>
					o.type === 'workflow_deviation' && o.description.includes("Agent ''"),
			);
			expect(missingEmpty.length).toBe(1);
		});
	});

	describe('Very long agent name (10,000 characters)', () => {
		it('should handle 10,000 character agent name without throwing', () => {
			const longName = 'a'.repeat(10000);
			const result = checkPhaseCompliance(
				[createPhaseEvent('agent.delegation', longName)],
				[longName],
				[longName],
				1,
			);
			expect(result).toBeDefined();
			expect(Array.isArray(result)).toBe(true);
		}, 30000);
	});

	describe('Agent field as object', () => {
		it('should handle agent as object without throwing', () => {
			const result = checkPhaseCompliance(
				[
					createPhaseEvent('agent.delegation', {
						name: 'coder',
					} as unknown as string),
				],
				[],
				['coder'],
				1,
			);
			expect(result).toBeDefined();
		});

		it('should handle nested object agent without throwing', () => {
			const result = checkPhaseCompliance(
				[
					createPhaseEvent('agent.delegation', {
						nested: { deep: 'coder' },
					} as unknown as string),
				],
				[],
				['coder'],
				1,
			);
			expect(result).toBeDefined();
		});
	});

	describe('Event type as non-string values', () => {
		const typeCases: [string, unknown][] = [
			['null', null],
			['undefined', undefined],
			['number', 123],
		];
		typeCases.forEach(([type, val]) => {
			it(`should handle type as ${type}`, () => {
				const events = [
					{ type: val, agent: 'coder', timestamp: '2024-01-01T00:00:00Z' },
				];
				const result = checkPhaseCompliance(
					events as object[],
					[],
					['coder'],
					1,
				);
				expect(result).toBeDefined();
			});
		});
	});

	describe('Coder delegation at last index', () => {
		it('should emit missing_reviewer when coder is at last index with no reviewer after', () => {
			const result = checkPhaseCompliance(
				[createPhaseEvent('agent.delegation', 'coder')],
				['coder'],
				[],
				1,
			);
			expect(result.filter((o) => o.type === 'missing_reviewer').length).toBe(
				1,
			);
		});
	});

	describe('All coders have subsequent reviewers', () => {
		it('should not emit missing_reviewer when all coders have reviewers after', () => {
			const result = checkPhaseCompliance(
				[
					createPhaseEvent('agent.delegation', 'coder'),
					createPhaseEvent('agent.delegation', 'reviewer'),
				],
				['coder', 'reviewer'],
				[],
				1,
			);
			expect(result.filter((o) => o.type === 'missing_reviewer').length).toBe(
				0,
			);
		});
	});

	describe('phase_complete followed by retro', () => {
		it('should not emit missing_retro when retro exists after phase_complete', () => {
			const result = checkPhaseCompliance(
				[
					{ type: 'phase_complete', timestamp: '2024-01-01T00:00:00Z' },
					{ type: 'retrospective.written', timestamp: '2024-01-01T00:00:01Z' },
				],
				[],
				[],
				1,
			);
			expect(result.filter((o) => o.type === 'missing_retro').length).toBe(0);
		});
	});

	describe('Deeply recursive event object', () => {
		it('should handle deeply recursive event without throwing', () => {
			const result = checkPhaseCompliance(
				[createDeepNestedObject(1000)],
				[],
				[],
				1,
			);
			expect(result).toBeDefined();
			expect(Array.isArray(result)).toBe(true);
		});
	});
});

// ============================================================================
// runCuratorInit - Adversarial Tests
// ============================================================================

describe('runCuratorInit - Adversarial Tests', () => {
	let tempDir: string;
	let cleanup: () => void;
	const defaultConfig = createAdversarialCuratorConfig();

	beforeEach(() => {
		const result = createCuratorTestDir('curator-init-adversarial');
		tempDir = result.tempDir;
		cleanup = result.cleanup;
		resetGlobalEventBus();
	});

	afterEach(() => {
		resetGlobalEventBus();
		cleanup();
	});

	describe('Corrupt curator-summary.json (invalid JSON)', () => {
		it('should return safe default when curator-summary.json has invalid JSON', async () => {
			writeFileSync(
				join(tempDir, '.swarm', 'curator-summary.json'),
				'{{{ invalid json',
				'utf-8',
			);
			const result = await runCuratorInit(tempDir, defaultConfig);
			expect(result).toBeDefined();
			expect(result.briefing).toContain('First Session');
			expect(result.knowledge_entries_reviewed).toBe(0);
		});
	});

	describe('curator-summary.json with schema_version !== 1', () => {
		it('should return first-session briefing when schema_version is 2', async () => {
			writeFileSync(
				join(tempDir, '.swarm', 'curator-summary.json'),
				JSON.stringify({
					schema_version: 2,
					session_id: 'test-session',
					last_updated: new Date().toISOString(),
					last_phase_covered: 1,
					digest: 'test-digest',
					phase_digests: [],
					compliance_observations: [],
					knowledge_recommendations: [],
				}),
				'utf-8',
			);
			const result = await runCuratorInit(tempDir, defaultConfig);
			expect(result).toBeDefined();
			expect(result.briefing).toContain('First Session');
			expect(result.prior_phases_covered).toBe(0);
		});
	});

	describe('knowledge.jsonl with 10,000 entries', () => {
		it('should handle 10,000 knowledge entries without hanging or OOM', async () => {
			const entries = createKnowledgeEntriesBulk(10000, 'entry');
			writeFileSync(
				join(tempDir, '.swarm', 'knowledge.jsonl'),
				entries.map((e) => JSON.stringify(e)).join('\n'),
				'utf-8',
			);
			const result = await runCuratorInit(tempDir, defaultConfig);
			expect(result).toBeDefined();
			expect(result.knowledge_entries_reviewed).toBe(10000);
			const highConfCount = (result.briefing.match(/- Lesson/g) || []).length;
			expect(highConfCount).toBeLessThanOrEqual(10);
		}, 60000);
	});

	describe('knowledge.jsonl with all high-confidence entries', () => {
		it('should include max 10 entries in briefing when all have confidence 1.0', async () => {
			const entries = Array.from({ length: 20 }, (_, i) =>
				createKnowledgeEntry(`entry-${i}`, {
					lesson: `High confidence lesson ${i}`,
					confidence: 1.0,
					status: 'established',
				}),
			);
			writeFileSync(
				join(tempDir, '.swarm', 'knowledge.jsonl'),
				entries.map((e) => JSON.stringify(e)).join('\n'),
				'utf-8',
			);
			const result = await runCuratorInit(tempDir, defaultConfig);
			expect(result).toBeDefined();
			const matches = result.briefing.match(/- High confidence lesson/g);
			expect(matches?.length).toBeLessThanOrEqual(10);
		});
	});

	describe('Knowledge entry with lesson as object', () => {
		it('should JSON.stringify lesson object without throwing', async () => {
			writeFileSync(
				join(tempDir, '.swarm', 'knowledge.jsonl'),
				JSON.stringify(
					createKnowledgeEntry('entry-obj', {
						lesson: { nested: { value: 'test' }, array: [1, 2, 3] },
						confidence: 0.9,
						status: 'established',
					}),
				),
				'utf-8',
			);
			const result = await runCuratorInit(tempDir, defaultConfig);
			expect(result).toBeDefined();
			expect(result.briefing).toContain('High-Confidence Knowledge');
			expect(result.briefing).toContain('nested');
		});
	});

	describe('Knowledge entry with tags as null', () => {
		it('should skip contradiction check when tags is null without throwing', async () => {
			writeFileSync(
				join(tempDir, '.swarm', 'knowledge.jsonl'),
				JSON.stringify(
					createKnowledgeEntry('entry-null-tags', {
						lesson: 'Lesson with null tags',
						tags: null as unknown as string[],
						confidence: 0.9,
						status: 'established',
					}),
				),
				'utf-8',
			);
			const result = await runCuratorInit(tempDir, defaultConfig);
			expect(result).toBeDefined();
			expect(result.contradictions).toEqual([]);
		});
	});

	describe('Context.md truncation (100KB)', () => {
		it('should truncate 100KB context.md to max_summary_tokens * 2 chars', async () => {
			writeFileSync(
				join(tempDir, '.swarm', 'context.md'),
				'x'.repeat(100 * 1024),
				'utf-8',
			);
			const result = await runCuratorInit(tempDir, defaultConfig);
			expect(result).toBeDefined();
			expect(result.briefing).toContain('Context Summary');
			const match = result.briefing.match(/## Context Summary\n([\s\S]*?)$/m);
			expect(match![1].length).toBeLessThanOrEqual(2000);
		});
	});

	describe('min_knowledge_confidence: NaN', () => {
		it('should not throw when min_knowledge_confidence is NaN', async () => {
			writeFileSync(
				join(tempDir, '.swarm', 'knowledge.jsonl'),
				JSON.stringify(
					createKnowledgeEntry('entry-nan', {
						lesson: 'Lesson with NaN threshold',
						confidence: 0.9,
						status: 'established',
					}),
				),
				'utf-8',
			);
			const result = await runCuratorInit(tempDir, {
				...defaultConfig,
				min_knowledge_confidence: NaN,
			});
			expect(result).toBeDefined();
			expect(result.briefing).not.toContain('High-Confidence Knowledge');
		});
	});

	describe('Directory does not exist', () => {
		it('should return safe default when directory does not exist', async () => {
			const result = await runCuratorInit(
				join(tmpdir(), `non-existent-${Date.now()}`),
				defaultConfig,
			);
			expect(result).toBeDefined();
			expect(result.briefing).toContain('First Session');
			expect(result.knowledge_entries_reviewed).toBe(0);
		});
	});

	describe('suppress_warnings: false with many compliance observations', () => {
		it('should include all compliance observations when suppress_warnings is false', async () => {
			const observations = Array.from({ length: 50 }, (_, i) => ({
				phase: 1,
				timestamp: new Date().toISOString(),
				type: 'workflow_deviation' as const,
				severity: 'warning' as const,
				description: `Compliance observation ${i}`,
			}));
			writeFileSync(
				join(tempDir, '.swarm', 'curator-summary.json'),
				JSON.stringify({
					schema_version: 1,
					session_id: 'test-session',
					last_updated: new Date().toISOString(),
					last_phase_covered: 1,
					digest: 'test-digest',
					phase_digests: [],
					compliance_observations: observations,
					knowledge_recommendations: [],
				}),
				'utf-8',
			);
			const result = await runCuratorInit(tempDir, {
				...defaultConfig,
				suppress_warnings: false,
			});
			expect(result).toBeDefined();
			expect(result.briefing).toContain('Compliance Observations');
			for (let i = 0; i < 50; i++)
				expect(result.briefing).toContain(`Compliance observation ${i}`);
		});
	});
});

// ============================================================================
// runCuratorPhase - Adversarial Tests
// ============================================================================

describe('runCuratorPhase - Adversarial Tests', () => {
	let tempDir: string;
	let cleanup: () => void;
	const defaultConfig = createAdversarialCuratorConfig();

	beforeEach(() => {
		const result = createCuratorTestDir('curator-phase-adversarial');
		tempDir = result.tempDir;
		cleanup = result.cleanup;
		resetGlobalEventBus();
	});

	afterEach(() => {
		resetGlobalEventBus();
		cleanup();
	});

	describe('Corrupt events.jsonl (invalid lines mixed with valid)', () => {
		it('should process valid lines and skip corrupt ones', async () => {
			writeFileSync(
				join(tempDir, '.swarm', 'events.jsonl'),
				[
					'{"phase": 1, "timestamp": "2024-01-01T00:00:00Z", "type": "phase_complete"}',
					'{{{ invalid json',
					'{"phase": 1, "timestamp": "2024-01-01T00:00:01Z", "type": "phase_complete"}',
					'not json at all',
					'{"phase": 1, "timestamp": "2024-01-01T00:00:02Z", "type": "phase_complete"}',
				].join('\n'),
				'utf-8',
			);
			createSimplePlan(tempDir, 1, 3, 3);
			const result = await runCuratorPhase(
				tempDir,
				1,
				['reviewer', 'test_engineer'],
				defaultConfig,
				{},
			);
			expect(result).toBeDefined();
			expect(result.digest.tasks_completed).toBe(3);
			expect(result.summary_updated).toBe(true);
		});
	});

	describe('events.jsonl with 10,000 events in phase', () => {
		it('should handle 10,000 events without hanging', async () => {
			const events = Array.from({ length: 10000 }, (_, i) =>
				JSON.stringify({
					phase: 1,
					timestamp: `2024-01-01T00:00:${i.toString().padStart(2, '0')}Z`,
					type: 'phase_complete',
				}),
			);
			writeFileSync(
				join(tempDir, '.swarm', 'events.jsonl'),
				events.join('\n'),
				'utf-8',
			);
			createSimplePlan(tempDir, 1, 1, 1);
			const result = await runCuratorPhase(
				tempDir,
				1,
				['reviewer', 'test_engineer'],
				defaultConfig,
				{},
			);
			expect(result).toBeDefined();
			expect(result.digest.tasks_completed).toBe(1);
		}, 60000);
	});

	describe('agentsDispatched with 1,000 entries', () => {
		it('should deduplicate 1,000 agents without hanging', async () => {
			const agents = Array.from({ length: 1000 }, (_, i) =>
				i % 2 === 0 ? 'coder' : 'reviewer',
			);
			const result = await runCuratorPhase(
				tempDir,
				1,
				agents,
				defaultConfig,
				{},
			);
			expect(result).toBeDefined();
			expect(result.digest.agents_used).toContain('coder');
			expect(result.digest.agents_used).toContain('reviewer');
			expect(result.digest.agents_used.length).toBeLessThanOrEqual(2);
		});
	});

	describe('Write failure - parent directory is a file', () => {
		it('should emit curator.error and return summary_updated: false', async () => {
			rmSync(join(tempDir, '.swarm'), { recursive: true, force: true });
			writeFileSync(
				join(tempDir, '.swarm'),
				'this is a file not a directory',
				'utf-8',
			);
			let errorEmitted = false;
			const unsubscribe = getGlobalEventBus().subscribe('curator.error', () => {
				errorEmitted = true;
			});
			const result = await runCuratorPhase(
				tempDir,
				1,
				['reviewer', 'test_engineer'],
				defaultConfig,
				{},
			);
			expect(result).toBeDefined();
			expect(result.summary_updated).toBe(false);
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(errorEmitted).toBe(true);
			unsubscribe();
		});
	});

	describe('phase = 0 (edge case)', () => {
		it('should process phase 0 without throwing', async () => {
			const result = await runCuratorPhase(
				tempDir,
				0,
				['reviewer', 'test_engineer'],
				defaultConfig,
				{},
			);
			expect(result).toBeDefined();
			expect(result.phase).toBe(0);
			expect(result.summary_updated).toBe(true);
		});
	});

	describe('phase = -1 (negative)', () => {
		it('should process negative phase without throwing', async () => {
			const result = await runCuratorPhase(
				tempDir,
				-1,
				['reviewer', 'test_engineer'],
				defaultConfig,
				{},
			);
			expect(result).toBeDefined();
			expect(result.phase).toBe(-1);
			expect(result.summary_updated).toBe(true);
		});
	});

	describe('phase = Infinity', () => {
		it('should process Infinity phase without throwing', async () => {
			const result = await runCuratorPhase(
				tempDir,
				Infinity,
				['reviewer', 'test_engineer'],
				defaultConfig,
				{},
			);
			expect(result).toBeDefined();
			expect(result.phase).toBe(Infinity);
			expect(result.summary_updated).toBe(true);
		});
	});

	describe('context.md with Windows line endings in Decisions section', () => {
		it('should extract key decisions with CRLF line endings', async () => {
			writeFileSync(
				join(tempDir, '.swarm', 'context.md'),
				'## Project Overview\r\nTest project\r\n\r\n## Decisions\r\n- Decision 1\r\n- Decision 2\r\n- Decision 3\r\n\r\n## Notes\r\nSome notes',
				'utf-8',
			);
			const result = await runCuratorPhase(
				tempDir,
				1,
				['reviewer', 'test_engineer'],
				defaultConfig,
				{},
			);
			expect(result).toBeDefined();
			expect(result.digest.key_decisions).toContain('Decision 1');
			expect(result.digest.key_decisions).toContain('Decision 2');
			expect(result.digest.key_decisions).toContain('Decision 3');
		});
	});

	describe('context.md with NO Decisions section', () => {
		it('should return empty keyDecisions when no Decisions section', async () => {
			writeFileSync(
				join(tempDir, '.swarm', 'context.md'),
				'## Project Overview\r\nTest project\r\n\r\n## Notes\r\nSome notes',
				'utf-8',
			);
			const result = await runCuratorPhase(
				tempDir,
				1,
				['reviewer', 'test_engineer'],
				defaultConfig,
				{},
			);
			expect(result).toBeDefined();
			expect(result.digest.key_decisions).toEqual([]);
		});
	});

	describe('agentsDispatched = [] (empty)', () => {
		it('should return compliance observations for missing required agents', async () => {
			const result = await runCuratorPhase(tempDir, 1, [], defaultConfig, {});
			expect(result).toBeDefined();
			const missingAgents = result.compliance.filter(
				(o) => o.type === 'workflow_deviation',
			);
			expect(missingAgents.length).toBeGreaterThan(0);
			expect(
				missingAgents.some((o) => o.description.includes('reviewer')),
			).toBe(true);
			expect(
				missingAgents.some((o) => o.description.includes('test_engineer')),
			).toBe(true);
		});
	});
});

// ============================================================================
// applyCuratorKnowledgeUpdates - Adversarial Tests
// ============================================================================

describe('applyCuratorKnowledgeUpdates - Adversarial Tests', () => {
	let tempDir: string;
	let cleanup: () => void;

	beforeEach(() => {
		const result = createCuratorTestDir('curator-knowledge-updates');
		tempDir = result.tempDir;
		cleanup = result.cleanup;
		resetGlobalEventBus();
	});

	afterEach(() => {
		resetGlobalEventBus();
		cleanup();
	});

	describe('Path traversal in directory', () => {
		it('should handle path traversal attempt in directory without crashing', async () => {
			const result = await applyCuratorKnowledgeUpdates(
				'../../../etc/passwd',
				[createKnowledgeRecommendation('promote', 'test-entry')],
				{} as KnowledgeConfig,
			);
			expect(result).toBeDefined();
			expect(typeof result.applied).toBe('number');
			expect(typeof result.skipped).toBe('number');
		});

		it('should handle null byte in directory path', async () => {
			const result = await applyCuratorKnowledgeUpdates(
				'/tmp/test\0evil',
				[createKnowledgeRecommendation('promote', 'test-entry')],
				{} as KnowledgeConfig,
			);
			expect(result).toBeDefined();
		});
	});

	describe('entry_id containing path separators', () => {
		it('should not match entry_id with path separators', async () => {
			writeFileSync(
				join(tempDir, '.swarm', 'knowledge.jsonl'),
				JSON.stringify(
					createKnowledgeEntry('legitimate-entry', {
						lesson: 'Legitimate lesson',
						status: 'established',
						confidence: 0.8,
					}),
				) + '\n',
				'utf-8',
			);
			const result = await applyCuratorKnowledgeUpdates(
				tempDir,
				[
					createKnowledgeRecommendation('promote', '../evil', {
						lesson: 'Evil lesson',
						reason: 'Malicious reason',
					}),
				],
				{} as KnowledgeConfig,
			);
			expect(result.skipped).toBe(1);
			expect(result.applied).toBe(0);
			const { readFileSync } = require('node:fs');
			const content = readFileSync(
				join(tempDir, '.swarm', 'knowledge.jsonl'),
				'utf-8',
			);
			const parsed = content
				.trim()
				.split('\n')
				.filter(Boolean)
				.map((l: string) => JSON.parse(l));
			expect(parsed[0].status).toBe('established');
			expect(parsed[0].confidence).toBe(0.8);
		});

		it('should handle entry_id with null byte', async () => {
			writeFileSync(
				join(tempDir, '.swarm', 'knowledge.jsonl'),
				JSON.stringify(
					createKnowledgeEntry('normal-entry', {
						lesson: 'Normal lesson',
						status: 'established',
						confidence: 0.8,
					}),
				) + '\n',
				'utf-8',
			);
			const result = await applyCuratorKnowledgeUpdates(
				tempDir,
				[createKnowledgeRecommendation('promote', 'entry\0evil')],
				{} as KnowledgeConfig,
			);
			expect(result.skipped).toBe(1);
		});
	});

	describe('Oversized reason field (10,000 characters)', () => {
		it('should handle 10,000 character reason without crashing', async () => {
			writeFileSync(
				join(tempDir, '.swarm', 'knowledge.jsonl'),
				JSON.stringify(
					createKnowledgeEntry('test-entry', {
						lesson: 'Test lesson',
						status: 'established',
						confidence: 0.8,
					}),
				) + '\n',
				'utf-8',
			);
			const result = await applyCuratorKnowledgeUpdates(
				tempDir,
				[
					createKnowledgeRecommendation('flag_contradiction', 'test-entry', {
						reason: 'x'.repeat(10000),
					}),
				],
				{} as KnowledgeConfig,
			);
			expect(result.applied).toBe(1);
			expect(result.skipped).toBe(0);
			const { readFileSync } = require('node:fs');
			const content = readFileSync(
				join(tempDir, '.swarm', 'knowledge.jsonl'),
				'utf-8',
			);
			const parsed = content
				.trim()
				.split('\n')
				.filter(Boolean)
				.map((l: string) => JSON.parse(l));
			const tag = parsed[0].tags.find((t: string) =>
				t.startsWith('contradiction:'),
			);
			expect(tag).toBeDefined();
			expect(tag.length).toBeLessThanOrEqual(64);
		}, 30000);
	});

	describe('Empty string entry_id', () => {
		it('should skip recommendations with empty string entry_id', async () => {
			writeFileSync(
				join(tempDir, '.swarm', 'knowledge.jsonl'),
				JSON.stringify(
					createKnowledgeEntry('real-entry', {
						lesson: 'Real lesson',
						status: 'established',
						confidence: 0.8,
					}),
				) + '\n',
				'utf-8',
			);
			const result = await applyCuratorKnowledgeUpdates(
				tempDir,
				[createKnowledgeRecommendation('promote', '')],
				{} as KnowledgeConfig,
			);
			expect(result.skipped).toBe(1);
			expect(result.applied).toBe(0);
		});
	});

	describe('Large recommendations array (10,000 entries)', () => {
		it('should handle 10,000 recommendations without crashing', async () => {
			const entries = createKnowledgeEntriesBulk(100, 'entry');
			writeFileSync(
				join(tempDir, '.swarm', 'knowledge.jsonl'),
				entries.map((e) => JSON.stringify(e)).join('\n'),
				'utf-8',
			);
			const recommendations = createKnowledgeRecommendationsBulk(
				10000,
				['promote', 'archive', 'flag_contradiction'],
				'entry',
			);
			const result = await applyCuratorKnowledgeUpdates(
				tempDir,
				recommendations,
				{} as KnowledgeConfig,
			);
			expect(result).toBeDefined();
			expect(typeof result.applied).toBe('number');
			expect(typeof result.skipped).toBe('number');
			expect(result.applied).toBeLessThanOrEqual(100);
		}, 60000);
	});

	describe('Unknown action value', () => {
		it('should skip recommendations with unknown action value', async () => {
			writeFileSync(
				join(tempDir, '.swarm', 'knowledge.jsonl'),
				JSON.stringify(
					createKnowledgeEntry('test-entry', {
						lesson: 'Test lesson',
						status: 'established',
						confidence: 0.8,
					}),
				) + '\n',
				'utf-8',
			);
			const result = await applyCuratorKnowledgeUpdates(
				tempDir,
				[createKnowledgeRecommendation('delete' as 'promote', 'test-entry')],
				{} as KnowledgeConfig,
			);
			expect(result.skipped).toBe(1);
			expect(result.applied).toBe(0);
			const { readFileSync } = require('node:fs');
			const content = readFileSync(
				join(tempDir, '.swarm', 'knowledge.jsonl'),
				'utf-8',
			);
			const parsed = JSON.parse(content.trim());
			expect(parsed.status).toBe('established');
			expect(parsed.confidence).toBe(0.8);
		});

		it('should handle unknown action "update" gracefully', async () => {
			writeFileSync(
				join(tempDir, '.swarm', 'knowledge.jsonl'),
				JSON.stringify(
					createKnowledgeEntry('test-entry-2', {
						lesson: 'Test lesson 2',
						status: 'established',
						confidence: 0.8,
					}),
				) + '\n',
				'utf-8',
			);
			const result = await applyCuratorKnowledgeUpdates(
				tempDir,
				[createKnowledgeRecommendation('update' as 'promote', 'test-entry-2')],
				{} as KnowledgeConfig,
			);
			expect(result).toBeDefined();
			expect(result.skipped).toBe(1);
		});
	});

	describe('Invalid confidence values (NaN, Infinity, -Infinity)', () => {
		const confidenceCases: [string, number][] = [
			['NaN', NaN],
			['Infinity', Infinity],
			['-Infinity', -Infinity],
		];
		confidenceCases.forEach(([type, val]) => {
			it(`should handle entry with ${type} confidence without crashing`, async () => {
				writeFileSync(
					join(tempDir, '.swarm', 'knowledge.jsonl'),
					JSON.stringify(
						createKnowledgeEntry(`${type}-confidence`, {
							lesson: 'Test lesson',
							status: 'established',
							confidence: val,
						}),
					) + '\n',
					'utf-8',
				);
				const result = await applyCuratorKnowledgeUpdates(
					tempDir,
					[createKnowledgeRecommendation('promote', `${type}-confidence`)],
					{} as KnowledgeConfig,
				);
				expect(result).toBeDefined();
				expect(result.applied).toBe(1);
			});
		});
	});

	describe('tags = null (not undefined)', () => {
		it('should handle entry with null tags without crashing', async () => {
			writeFileSync(
				join(tempDir, '.swarm', 'knowledge.jsonl'),
				JSON.stringify(
					createKnowledgeEntry('null-tags', {
						lesson: 'Test lesson',
						status: 'established',
						confidence: 0.8,
						tags: null as unknown as string[],
					}),
				) + '\n',
				'utf-8',
			);
			const result = await applyCuratorKnowledgeUpdates(
				tempDir,
				[createKnowledgeRecommendation('flag_contradiction', 'null-tags')],
				{} as KnowledgeConfig,
			);
			expect(result).toBeDefined();
			expect(result.applied).toBe(1);
			const { readFileSync } = require('node:fs');
			const content = readFileSync(
				join(tempDir, '.swarm', 'knowledge.jsonl'),
				'utf-8',
			);
			const parsed = JSON.parse(content.trim());
			expect(parsed.tags).toBeDefined();
			expect(parsed.tags.length).toBe(1);
			expect(parsed.tags[0]).toContain('contradiction:');
		});
	});

	describe('Concurrent modification scenario', () => {
		it('should handle concurrent reads/writes without crashing', async () => {
			const entries = createKnowledgeEntriesBulk(10, 'entry');
			writeFileSync(
				join(tempDir, '.swarm', 'knowledge.jsonl'),
				entries.map((e) => JSON.stringify(e)).join('\n'),
				'utf-8',
			);
			let totalApplied = 0,
				totalSkipped = 0;
			for (let i = 0; i < 5; i++) {
				const result = await applyCuratorKnowledgeUpdates(
					tempDir,
					[createKnowledgeRecommendation('promote', 'entry-0')],
					{} as KnowledgeConfig,
				);
				totalApplied += result.applied;
				totalSkipped += result.skipped;
			}
			expect(totalApplied + totalSkipped).toBeGreaterThan(0);
		});

		it('should handle concurrent writes with different entries without crashing', async () => {
			const entries = createKnowledgeEntriesBulk(10, 'entry');
			writeFileSync(
				join(tempDir, '.swarm', 'knowledge.jsonl'),
				entries.map((e) => JSON.stringify(e)).join('\n'),
				'utf-8',
			);
			let totalApplied = 0,
				totalSkipped = 0;
			for (let i = 0; i < 10; i++) {
				const result = await applyCuratorKnowledgeUpdates(
					tempDir,
					[createKnowledgeRecommendation('promote', `entry-${i}`)],
					{} as KnowledgeConfig,
				);
				totalApplied += result.applied;
				totalSkipped += result.skipped;
			}
			expect(totalApplied).toBe(10);
			expect(totalSkipped).toBe(0);
		});
	});

	describe('Knowledge file does not exist', () => {
		it('should return applied=0 skipped=N when knowledge.jsonl does not exist', async () => {
			const knowledgePath = join(tempDir, '.swarm', 'knowledge.jsonl');
			if (existsSync(knowledgePath)) rmSync(knowledgePath);
			const result = await applyCuratorKnowledgeUpdates(
				tempDir,
				[
					createKnowledgeRecommendation('promote', 'non-existent-entry'),
					createKnowledgeRecommendation('archive', 'another-missing'),
				],
				{} as KnowledgeConfig,
			);
			expect(result.applied).toBe(0);
			expect(result.skipped).toBe(2);
		});

		it('should handle empty recommendations with no knowledge file', async () => {
			const knowledgePath = join(tempDir, '.swarm', 'knowledge.jsonl');
			if (existsSync(knowledgePath)) rmSync(knowledgePath);
			const result = await applyCuratorKnowledgeUpdates(
				tempDir,
				[],
				{} as KnowledgeConfig,
			);
			expect(result.applied).toBe(0);
			expect(result.skipped).toBe(0);
		});

		it('should handle directory that does not exist at all', async () => {
			const result = await applyCuratorKnowledgeUpdates(
				join(tmpdir(), `non-existent-${Date.now()}`),
				[createKnowledgeRecommendation('promote', 'test-entry')],
				{} as KnowledgeConfig,
			);
			expect(result.applied).toBe(0);
			expect(result.skipped).toBe(1);
		});
	});

	// ==================================================================
	// Adversarial: rewrite action boundary tests (v6.50)
	// ==================================================================

	describe('Adversarial: rewrite action', () => {
		let rewriteDir: string;
		let rewriteCleanup: () => void;
		const rewriteKnowledgeConfig: KnowledgeConfig = {
			enabled: true,
			swarm_max_entries: 100,
			hive_max_entries: 200,
			auto_promote_days: 90,
			max_inject_count: 5,
			dedup_threshold: 0.6,
			scope_filter: ['global'],
			hive_enabled: true,
			rejected_max_entries: 20,
			validation_enabled: true,
			evergreen_confidence: 0.9,
			evergreen_utility: 0.8,
			low_utility_threshold: 0.3,
			min_retrievals_for_utility: 3,
			schema_version: 1,
			same_project_weight: 1.0,
			cross_project_weight: 0.5,
			min_encounter_score: 0.1,
			initial_encounter_score: 1.0,
			encounter_increment: 0.1,
			max_encounter_score: 10.0,
		};

		beforeEach(() => {
			const result = createCuratorTestDir('curator-rewrite-adv');
			rewriteDir = result.tempDir;
			rewriteCleanup = result.cleanup;
		});

		afterEach(() => rewriteCleanup());

		it('rewrite with lesson.length = 281 is rejected', async () => {
			writeFileSync(
				join(rewriteDir, '.swarm', 'knowledge.jsonl'),
				JSON.stringify(
					createKnowledgeEntry('RW-ADV-1', {
						lesson: 'Original lesson text that should not change',
						status: 'established',
						hive_eligible: false,
					}),
				),
				'utf-8',
			);
			const result = await applyCuratorKnowledgeUpdates(
				rewriteDir,
				[
					createKnowledgeRecommendation('rewrite', 'RW-ADV-1', {
						lesson: 'A'.repeat(281),
						reason: 'Too long',
					}),
				],
				rewriteKnowledgeConfig,
			);
			expect(result.applied).toBe(0);
		});

		it('rewrite with lesson.length = 280 is accepted', async () => {
			writeFileSync(
				join(rewriteDir, '.swarm', 'knowledge.jsonl'),
				JSON.stringify(
					createKnowledgeEntry('RW-ADV-2', {
						lesson: 'Original lesson text for testing boundary',
						status: 'established',
						hive_eligible: false,
					}),
				),
				'utf-8',
			);
			const result = await applyCuratorKnowledgeUpdates(
				rewriteDir,
				[
					createKnowledgeRecommendation('rewrite', 'RW-ADV-2', {
						lesson: 'A'.repeat(280),
						reason: 'Boundary',
					}),
				],
				rewriteKnowledgeConfig,
			);
			expect(result.applied).toBe(1);
		});
	});

	// ==================================================================
	// Adversarial: knowledgeConfig null/undefined guard (v6.60)
	// ==================================================================

	describe('Adversarial: knowledgeConfig null/undefined guard with non-empty recommendations', () => {
		let guardDir: string;
		let guardCleanup: () => void;

		beforeEach(() => {
			const result = createCuratorTestDir('curator-guard-adv');
			guardDir = result.tempDir;
			guardCleanup = result.cleanup;
			writeFileSync(
				join(guardDir, '.swarm', 'knowledge.jsonl'),
				JSON.stringify(
					createKnowledgeEntry('existing-entry', {
						lesson: 'Existing lesson',
						status: 'established',
					}),
				),
				'utf-8',
			);
		});

		afterEach(() => guardCleanup());

		it('returns { applied: 0, skipped: 0 } when knowledgeConfig is null WITH non-empty recommendations', async () => {
			const result = await applyCuratorKnowledgeUpdates(
				guardDir,
				[createKnowledgeRecommendation('promote', 'existing-entry')],
				null as unknown as KnowledgeConfig,
			);
			expect(result).toEqual({ applied: 0, skipped: 0 });
			const { readFileSync } = require('node:fs');
			const content = readFileSync(
				join(guardDir, '.swarm', 'knowledge.jsonl'),
				'utf-8',
			);
			const parsed = JSON.parse(content.trim());
			expect(parsed.status).toBe('established');
			expect(parsed.hive_eligible).toBeUndefined();
		});

		it('returns { applied: 0, skipped: 0 } when knowledgeConfig is undefined WITH non-empty recommendations', async () => {
			const result = await applyCuratorKnowledgeUpdates(
				guardDir,
				[createKnowledgeRecommendation('promote', 'existing-entry')],
				undefined as unknown as KnowledgeConfig,
			);
			expect(result).toEqual({ applied: 0, skipped: 0 });
			const { readFileSync } = require('node:fs');
			const content = readFileSync(
				join(guardDir, '.swarm', 'knowledge.jsonl'),
				'utf-8',
			);
			const parsed = JSON.parse(content.trim());
			expect(parsed.status).toBe('established');
			expect(parsed.hive_eligible).toBeUndefined();
		});

		const falsyCases: [string, unknown][] = [
			['0 (zero)', 0],
			['empty string', ''],
			['false', false],
		];
		falsyCases.forEach(([type, val]) => {
			it(`does NOT guard against knowledgeConfig = ${type} (falsy but not null)`, async () => {
				const result = await applyCuratorKnowledgeUpdates(
					guardDir,
					[createKnowledgeRecommendation('promote', 'existing-entry')],
					val as unknown as KnowledgeConfig,
				);
				expect(
					result.applied !== 0 || result.skipped !== 0 || result.applied === 0,
				).toBe(true);
			});
		});

		it('handles recommendations = null gracefully', async () => {
			const result = await applyCuratorKnowledgeUpdates(
				guardDir,
				null as unknown as KnowledgeRecommendation[],
				{},
			);
			expect(result).toBeDefined();
			expect(typeof result.applied).toBe('number');
			expect(typeof result.skipped).toBe('number');
		});

		it('handles recommendations = undefined gracefully', async () => {
			const result = await applyCuratorKnowledgeUpdates(
				guardDir,
				undefined as unknown as KnowledgeRecommendation[],
				{},
			);
			expect(result).toBeDefined();
			expect(typeof result.applied).toBe('number');
			expect(typeof result.skipped).toBe('number');
		});

		it('handles recommendations array with null item gracefully', async () => {
			const result = await applyCuratorKnowledgeUpdates(
				guardDir,
				[
					createKnowledgeRecommendation('promote', 'existing-entry'),
					null as unknown as KnowledgeRecommendation,
				],
				{} as KnowledgeConfig,
			);
			expect(result).toMatchObject({
				applied: expect.any(Number),
				skipped: expect.any(Number),
			});
		});

		it('handles recommendations array with undefined item gracefully', async () => {
			const result = await applyCuratorKnowledgeUpdates(
				guardDir,
				[createKnowledgeRecommendation('promote', 'existing-entry'), undefined],
				{} as KnowledgeConfig,
			);
			expect(result).toMatchObject({
				applied: expect.any(Number),
				skipped: expect.any(Number),
			});
		});
	});
});
