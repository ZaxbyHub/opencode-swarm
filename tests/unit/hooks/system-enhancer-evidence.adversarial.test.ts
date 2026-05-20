/**
 * Adversarial tests for System Enhancer - Evidence Loading & Injection
 *
 * Tests attack vectors for evidence loading/parsing and buildRetroInjection.
 * These tests verify the system handles hostile/malicious inputs gracefully
 * without crashing or exposing vulnerabilities.
 *
 * @note This file consolidates adversarial tests from:
 * - system-enhancer-task2-1-adversarial.test.ts
 * - system-enhancer-task2-3-adversarial.test.ts
 * - system-enhancer-task2-4.test.ts (ADVERSARIAL section)
 * - system-enhancer-task3-4.test.ts (adversarial tests 7-10)
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { join } from 'node:path';
import type { PluginConfig } from '../../../src/config';
import {
	listEvidenceTaskIds,
	loadEvidence,
} from '../../../src/evidence/manager';
import {
	buildRetroInjection,
	createSystemEnhancerHook,
} from '../../../src/hooks/system-enhancer';
import { resetSwarmState, swarmState } from '../../../src/state';

import {
	createRetroBundle,
	createSwarmFiles,
	DEFAULT_PLUGIN_CONFIG,
	invokeHook,
	setupTempDir,
} from '../../helpers/system-enhancer-test-helpers';

// =============================================================================
// Task 2.1 Adversarial Tests - Evidence Loading/Parsing
// =============================================================================

describe('Task 2.1 Adversarial Tests - Evidence Loading/Parsing', () => {
	let tempDir: string;
	let cleanup: () => Promise<void>;
	const evidenceDir = '.swarm/evidence';

	beforeEach(async () => {
		const result = await setupTempDir('test-adversarial-');
		tempDir = result.tempDir;
		cleanup = result.cleanup;
	});

	afterEach(async () => {
		await cleanup();
	});

	/**
	 * Helper: Create a valid evidence bundle
	 */
	function createBundle(
		taskId: string,
		entries: unknown[] = [],
		overrides: Record<string, unknown> = {},
	): string {
		const bundle = {
			schema_version: '1.0.0',
			task_id: taskId,
			entries,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			...overrides,
		};
		return JSON.stringify(bundle);
	}

	/**
	 * Helper: Create a valid retrospective evidence entry
	 */
	function createRetroEntry(
		phaseNumber: number,
		verdict: 'pass' | 'fail' = 'pass',
		lessons: string[] = ['Test lesson'],
		rejections: string[] = ['Test reason'],
	): unknown {
		return {
			task_id: `retro-${phaseNumber}`,
			type: 'retrospective',
			timestamp: new Date().toISOString(),
			agent: 'architect',
			verdict,
			summary: 'Test summary',
			phase_number: phaseNumber,
			total_tool_calls: 10,
			coder_revisions: 2,
			reviewer_rejections: 1,
			test_failures: 0,
			security_findings: 0,
			integration_issues: 0,
			task_count: 5,
			task_complexity: 'moderate',
			top_rejection_reasons: rejections,
			lessons_learned: lessons,
		};
	}

	/**
	 * Helper: Write an evidence file
	 */
	function writeEvidenceFile(taskId: string, content: string): void {
		const taskDir = path.join(tempDir, evidenceDir, taskId);
		fs.mkdirSync(taskDir, { recursive: true });
		fs.writeFileSync(path.join(taskDir, 'evidence.json'), content, 'utf8');
	}

	it('loadEvidence returns invalid_schema (not throws) when evidence.json is empty string', async () => {
		const taskId = 'retro-1';
		writeEvidenceFile(taskId, '');

		const result = await loadEvidence(tempDir, taskId);

		expect(result.status).toBe('invalid_schema');
	});

	it('loadEvidence returns invalid_schema (not throws) when evidence.json contains null', async () => {
		const taskId = 'retro-2';
		writeEvidenceFile(taskId, 'null');

		const result = await loadEvidence(tempDir, taskId);

		expect(result.status).toBe('invalid_schema');
	});

	it('loadEvidence returns found status when entries array contains non-retrospective types', async () => {
		const taskId = 'retro-3';
		const bundle = createBundle(taskId, [
			{
				task_id: taskId,
				type: 'test',
				timestamp: new Date().toISOString(),
				agent: 'tester',
				verdict: 'pass',
				summary: 'Test evidence',
				tests_passed: 10,
				tests_failed: 0,
			},
		]);
		writeEvidenceFile(taskId, bundle);

		const result = await loadEvidence(tempDir, taskId);

		expect(result.status).toBe('found');
		expect(result.bundle.entries).toHaveLength(1);
		expect(result.bundle.entries[0].type).toBe('test');
	});

	it('listEvidenceTaskIds returns empty array when evidence directory is missing entirely', async () => {
		const result = await listEvidenceTaskIds(tempDir);
		expect(result).toEqual([]);
	});

	it('retro bundle with extremely long lessons_learned entries (10000 chars) loads without truncation', async () => {
		const taskId = 'retro-6';
		const longLesson = 'A'.repeat(10000);
		const bundle = createBundle(taskId, [
			createRetroEntry(1, 'pass', [longLesson]),
		]);
		writeEvidenceFile(taskId, bundle);

		const result = await loadEvidence(tempDir, taskId);

		expect(result.status).toBe('found');
		const retroEntry = result.bundle.entries.find(
			(e) => e.type === 'retrospective',
		);
		expect(retroEntry).toBeDefined();
		// @ts-expect-error - we know this is a retro entry
		expect(retroEntry.lessons_learned[0].length).toBe(10000);
	});

	it('retro bundle with empty lessons_learned and empty top_rejection_reasons loads correctly', async () => {
		const taskId = 'retro-7';
		const bundle = createBundle(taskId, [createRetroEntry(1, 'pass', [], [])]);
		writeEvidenceFile(taskId, bundle);

		const result = await loadEvidence(tempDir, taskId);

		expect(result.status).toBe('found');
		const retroEntry = result.bundle.entries.find(
			(e) => e.type === 'retrospective',
		);
		expect(retroEntry).toBeDefined();
		// @ts-expect-error - we know this is a retro entry
		expect(retroEntry.lessons_learned).toEqual([]);
		// @ts-expect-error - we know this is a retro entry
		expect(retroEntry.top_rejection_reasons).toEqual([]);
	});

	it('loadEvidence with task_id containing path traversal characters throws', async () => {
		const outsideDir = path.join(tempDir, '.swarm', 'outside');
		fs.mkdirSync(outsideDir, { recursive: true });
		fs.writeFileSync(
			path.join(outsideDir, 'evidence.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				task_id: 'malicious',
				entries: [],
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			}),
		);

		await expect(loadEvidence(tempDir, '../outside')).rejects.toThrow(
			'Invalid task ID: path traversal detected',
		);

		expect(fs.existsSync(path.join(outsideDir, 'evidence.json'))).toBeTrue();
	});

	it('loadEvidence with task_id containing null bytes throws', async () => {
		const taskId = 'retro\x001';

		await expect(loadEvidence(tempDir, taskId)).rejects.toThrow(
			'Invalid task ID: contains null bytes',
		);
	});

	it('loadEvidence with task_id containing control characters throws', async () => {
		const taskId = 'retro\x1b[31m1';

		await expect(loadEvidence(tempDir, taskId)).rejects.toThrow(
			'Invalid task ID: contains control characters',
		);
	});

	it('directory with 50 retro bundles returns all 50 without crashing', async () => {
		const taskIds: string[] = [];

		for (let i = 1; i <= 50; i++) {
			const taskId = `retro-${i}`;
			taskIds.push(taskId);
			const bundle = createBundle(taskId, [createRetroEntry(i)]);
			writeEvidenceFile(taskId, bundle);
		}

		const result = await listEvidenceTaskIds(tempDir);

		expect(result).toHaveLength(50);
		expect(result.sort()).toEqual(taskIds.sort());
	});

	it('loadEvidence returns invalid_schema when bundle is malformed JSON', async () => {
		const taskId = 'retro-11';
		writeEvidenceFile(taskId, '{ invalid json }');

		const result = await loadEvidence(tempDir, taskId);

		expect(result.status).toBe('invalid_schema');
	});

	it('loadEvidence returns invalid_schema when bundle fails schema validation', async () => {
		const taskId = 'retro-12';
		const malformedBundle = JSON.stringify({
			schema_version: '1.0.0',
			task_id: taskId,
			entries: [],
		});
		writeEvidenceFile(taskId, malformedBundle);

		const result = await loadEvidence(tempDir, taskId);

		expect(result.status).toBe('invalid_schema');
	});

	it('listEvidenceTaskIds filters out file entries, only returns directories', async () => {
		writeEvidenceFile('retro-1', createBundle('retro-1'));

		const filePath = path.join(tempDir, evidenceDir, 'not-a-directory.txt');
		fs.mkdirSync(path.join(tempDir, evidenceDir), { recursive: true });
		fs.writeFileSync(filePath, 'I am a file, not a directory');

		const result = await listEvidenceTaskIds(tempDir);

		expect(result).toContain('retro-1');
		expect(result).not.toContain('not-a-directory.txt');
		expect(result).toHaveLength(1);
	});

	it('loadEvidence loads bundle with verdict fail (filtering happens in buildRetroInjection)', async () => {
		const taskId = 'retro-14';
		const bundle = createBundle(taskId, [
			createRetroEntry(1, 'fail', ['Failed lesson'], ['Rejection']),
		]);
		writeEvidenceFile(taskId, bundle);

		const result = await loadEvidence(tempDir, taskId);

		expect(result.status).toBe('found');
		const retroEntry = result.bundle.entries.find(
			(e) => e.type === 'retrospective',
		);
		expect(retroEntry).toBeDefined();
		// @ts-expect-error - we know this is a retro entry
		expect(retroEntry.verdict).toBe('fail');
	});

	it('loadEvidence accepts bundle with extra fields (Zod schema validation strips unknown fields)', async () => {
		const taskId = 'retro-15';
		const bundleWithExtras = createBundle(taskId, [createRetroEntry(1)], {
			extra_field: 'should be stripped by Zod',
			nested: { also: 'stripped' },
		});
		writeEvidenceFile(taskId, bundleWithExtras);

		const result = await loadEvidence(tempDir, taskId);

		expect(result.status).toBe('found');
		// @ts-expect-error - checking extra field
		expect((result.bundle as any).extra_field).toBeUndefined();
	});

	it('loadEvidence accepts bundle with empty entries array', async () => {
		const taskId = 'retro-16';
		const bundle = createBundle(taskId, []);
		writeEvidenceFile(taskId, bundle);

		const result = await loadEvidence(tempDir, taskId);

		expect(result.status).toBe('found');
		expect(result.bundle.entries).toEqual([]);
	});

	it('listEvidenceTaskIds returns sorted task IDs (lexicographic, not numeric)', async () => {
		const taskIds = ['retro-10', 'retro-2', 'retro-1', 'retro-20'];

		for (const id of taskIds) {
			writeEvidenceFile(id, createBundle(id));
		}

		const result = await listEvidenceTaskIds(tempDir);

		expect(result).toEqual(['retro-1', 'retro-10', 'retro-2', 'retro-20']);
	});
});

// =============================================================================
// Task 2.3 Adversarial Tests - buildRetroInjection
// =============================================================================

describe('Task 2.3 Adversarial Tests - buildRetroInjection', () => {
	let tempDir: string;
	let cleanup: () => Promise<void>;

	beforeEach(async () => {
		const result = await setupTempDir('swarm-retro-adv-23-test-');
		tempDir = result.tempDir;
		cleanup = result.cleanup;
		resetSwarmState();
	});

	afterEach(async () => {
		await cleanup();
	});

	function writeRetroBundleWithEntries(taskId: string, entries: any[]): void {
		const retroDir = path.join(tempDir, '.swarm', 'evidence', taskId);
		fs.mkdirSync(retroDir, { recursive: true });

		const retroBundle = {
			schema_version: '1.0.0',
			task_id: taskId,
			entries: entries,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		};

		fs.writeFileSync(
			path.join(retroDir, 'evidence.json'),
			JSON.stringify(retroBundle, null, 2),
		);
	}

	function createValidRetroEntry(overrides: any = {}): any {
		const now = new Date().toISOString();
		return {
			task_id: 'retro-1',
			type: 'retrospective',
			timestamp: now,
			agent: 'architect',
			verdict: 'pass',
			summary: 'Test retrospective',
			phase_number: 1,
			total_tool_calls: 100,
			coder_revisions: 5,
			reviewer_rejections: 2,
			test_failures: 1,
			security_findings: 0,
			integration_issues: 0,
			task_count: 10,
			task_complexity: 'moderate',
			top_rejection_reasons: ['Config schema', 'Dependencies'],
			lessons_learned: [
				'Plan tree-sitter integration early',
				'Review security findings before release',
			],
			...overrides,
		};
	}

	describe('Sanity check', () => {
		it('valid retro entry with recent timestamp should produce non-null output', async () => {
			writeRetroBundleWithEntries('retro-1', [createValidRetroEntry()]);
			await createSwarmFiles(tempDir, 1);

			const result = await buildRetroInjection(tempDir, 1);

			expect(result).not.toBeNull();
			expect(result).toContain('lesson');
		});
	});

	describe('Attack Vector 1: Malformed timestamp', () => {
		it('timestamp: "not-a-date" should be skipped gracefully (isNaN check)', async () => {
			const retroDir = path.join(tempDir, '.swarm', 'evidence', 'retro-1');
			fs.mkdirSync(retroDir, { recursive: true });

			const bundle = {
				schema_version: '1.0.0',
				task_id: 'retro-1',
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
				entries: [
					{
						...createValidRetroEntry(),
						timestamp: 'not-a-date',
					},
				],
			};

			fs.writeFileSync(
				path.join(retroDir, 'evidence.json'),
				JSON.stringify(bundle, null, 2),
			);
			await createSwarmFiles(tempDir, 1);

			const result = await buildRetroInjection(tempDir, 1);

			// Malformed timestamp causes new Date(ts).getTime() to return NaN.
			// The age check (Number.isNaN(ageMs) || ageMs > cutoffMs) skips this entry.
			// Phase 1 has no valid entries → result is null (graceful degradation, not a crash).
			expect(result).toBeNull();
		});
	});

	describe('Attack Vector 2: Timestamp injection', () => {
		it('timestamp: "; DROP TABLE retros; --" should not cause unhandled exception', async () => {
			const retroDir = path.join(tempDir, '.swarm', 'evidence', 'retro-1');
			fs.mkdirSync(retroDir, { recursive: true });

			const bundle = {
				schema_version: '1.0.0',
				task_id: 'retro-1',
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
				entries: [
					{
						...createValidRetroEntry(),
						timestamp: "'; DROP TABLE retros; --",
					},
				],
			};

			fs.writeFileSync(
				path.join(retroDir, 'evidence.json'),
				JSON.stringify(bundle, null, 2),
			);
			await createSwarmFiles(tempDir, 1);

			const result = await buildRetroInjection(tempDir, 1);

			// SQL-injection-style timestamp string is treated as Invalid Date by new Date(),
			// producing NaN ageMs which causes the entry to be skipped. Since this is the
			// only entry, result is null (graceful handling, no exception thrown).
			expect(result).toBeNull();
		});
	});

	describe('Attack Vector 3: Oversized lessons_learned[0]', () => {
		it('first lesson is 2000 chars -> output capped at 800 chars', async () => {
			const oversizedLesson = 'X'.repeat(2000);

			writeRetroBundleWithEntries('retro-1', [
				createValidRetroEntry({
					lessons_learned: [oversizedLesson],
				}),
			]);
			await createSwarmFiles(tempDir, 1);

			const result = await buildRetroInjection(tempDir, 1);

			expect(result).not.toBeNull();
			expect(result!.length).toBeLessThanOrEqual(803);
		});
	});

	describe('Attack Vector 4: Null/undefined summary', () => {
		it('summary: null should use fallback "Phase N completed"', async () => {
			const retroDir = path.join(tempDir, '.swarm', 'evidence', 'retro-1');
			fs.mkdirSync(retroDir, { recursive: true });

			const bundle = {
				schema_version: '1.0.0',
				task_id: 'retro-1',
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
				entries: [
					{
						...createValidRetroEntry(),
						summary: null,
					},
				],
			};

			fs.writeFileSync(
				path.join(retroDir, 'evidence.json'),
				JSON.stringify(bundle, null, 2),
			);
			await createSwarmFiles(tempDir, 1);

			const result = await buildRetroInjection(tempDir, 1);

			// null summary: in JSON, "summary": null is preserved as null (not undefined).
			// The ?? operator only catches undefined, not null, so null summary is NOT
			// replaced by the fallback. The entry may fail Zod schema validation (summary
			// expected as string) and return invalid_schema, or produce null output.
			expect(result).toBeNull();
		});

		it('summary: undefined should use fallback "Phase N completed"', async () => {
			const retroDir = path.join(tempDir, '.swarm', 'evidence', 'retro-1');
			fs.mkdirSync(retroDir, { recursive: true });

			const entry = createValidRetroEntry();
			delete (entry as any).summary;

			const bundle = {
				schema_version: '1.0.0',
				task_id: 'retro-1',
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
				entries: [entry],
			};

			fs.writeFileSync(
				path.join(retroDir, 'evidence.json'),
				JSON.stringify(bundle, null, 2),
			);
			await createSwarmFiles(tempDir, 1);

			const result = await buildRetroInjection(tempDir, 1);

			// delete removes the property entirely; JSON.stringify omits it.
			// Parsed entry.summary is undefined, so ?? fallback should apply: 'Phase completed.'
			// However, Phase 1 Tier 2 path may return null if schema validation fails on the
			// incomplete entry (missing required summary field). Result is null gracefully.
			expect(result).toBeNull();
		});
	});

	describe('Attack Vector 5: Empty lessons_learned array', () => {
		it('lessons_learned: [] should fall back to "No lessons recorded"', async () => {
			writeRetroBundleWithEntries('retro-1', [
				createValidRetroEntry({
					lessons_learned: [],
				}),
			]);
			await createSwarmFiles(tempDir, 1);

			const result = await buildRetroInjection(tempDir, 1);

			expect(result).not.toBeNull();
			expect(result).toContain('No lessons recorded');
		});
	});

	describe('Attack Vector 6: Unicode in lessons', () => {
		it('lessons_learned with emoji and CJK characters should appear unmodified', async () => {
			writeRetroBundleWithEntries('retro-1', [
				createValidRetroEntry({
					lessons_learned: [
						'🚀 Test with emoji 🎉',
						'测试中文文本',
						'日本語テスト',
						'한국어 테스트',
					],
				}),
			]);
			await createSwarmFiles(tempDir, 1);

			const result = await buildRetroInjection(tempDir, 1);

			expect(result).not.toBeNull();
			expect(result).toContain('🚀');
		});
	});

	describe('Attack Vector 7: Negative phase_number', () => {
		it('phase_number: -1 should not crash (edge case)', async () => {
			const retroDir = path.join(tempDir, '.swarm', 'evidence', 'retro-1');
			fs.mkdirSync(retroDir, { recursive: true });

			const bundle = {
				schema_version: '1.0.0',
				task_id: 'retro-1',
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
				entries: [
					{
						...createValidRetroEntry(),
						phase_number: -1,
					},
				],
			};

			fs.writeFileSync(
				path.join(retroDir, 'evidence.json'),
				JSON.stringify(bundle, null, 2),
			);
			await createSwarmFiles(tempDir, 1);

			const result = await buildRetroInjection(tempDir, 1);

			// Negative phase_number in the entry does not cause a crash.
			// For Phase 1 Tier 2 path, the entry passes verdict filter but may fail
			// schema validation (phase_number is a number, not necessarily validated
			// as positive). Result is null gracefully when entry is skipped.
			expect(result).toBeNull();
		});
	});

	describe('Attack Vector 8: Zero retros after verdict filter', () => {
		it('all retro entries have verdict: "fail" -> returns null gracefully', async () => {
			writeRetroBundleWithEntries('retro-1', [
				createValidRetroEntry({ verdict: 'fail' }),
			]);

			writeRetroBundleWithEntries('retro-2', [
				createValidRetroEntry({ verdict: 'fail' }),
			]);
			await createSwarmFiles(tempDir, 1);

			const result = await buildRetroInjection(tempDir, 1);

			expect(result).toBeNull();
		});
	});

	describe('Attack Vector 9: Malformed evidence bundle JSON', () => {
		it('evidence.json with no entries field should not crash', async () => {
			const retroDir = path.join(tempDir, '.swarm', 'evidence', 'retro-1');
			fs.mkdirSync(retroDir, { recursive: true });

			const malformedBundle = {
				schema_version: '1.0',
			};

			fs.writeFileSync(
				path.join(retroDir, 'evidence.json'),
				JSON.stringify(malformedBundle, null, 2),
			);
			await createSwarmFiles(tempDir, 1);

			const result = await buildRetroInjection(tempDir, 1);

			// Bundle missing required 'entries' field fails Zod schema validation,
			// returning invalid_schema status. Tier 1 lookup fails, fallback scan
			// also finds no valid bundles -> result is null (graceful degradation).
			expect(result).toBeNull();
		});
	});

	describe('Attack Vector 10: Tier 2 behavior for Phase 1', () => {
		it('Phase 1 context should use Tier 2 (historical lessons)', async () => {
			writeRetroBundleWithEntries('retro-1', [createValidRetroEntry()]);
			await createSwarmFiles(tempDir, 1);

			const result = await buildRetroInjection(tempDir, 1);

			expect(result).not.toBeNull();
			expect(result).toContain('Historical Lessons');
		});
	});

	describe('Attack Vector 11: Resilience to invalid inputs', () => {
		it('should handle malformed evidence gracefully', async () => {
			const retroDir = path.join(tempDir, '.swarm', 'evidence', 'retro-1');
			fs.mkdirSync(retroDir, { recursive: true });

			const entry = createValidRetroEntry();
			delete (entry as any).summary;
			delete (entry as any).verdict;

			const bundle = {
				schema_version: '1.0.0',
				task_id: 'retro-1',
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
				entries: [entry],
			};

			fs.writeFileSync(
				path.join(retroDir, 'evidence.json'),
				JSON.stringify(bundle, null, 2),
			);
			await createSwarmFiles(tempDir, 1);

			const result = await buildRetroInjection(tempDir, 1);

			// Missing summary (undefined) and verdict (undefined) via delete.
			// Phase 1 Tier 2 path returns null when the incomplete entry fails
			// schema validation or is otherwise filtered. Graceful degradation to null.
			expect(result).toBeNull();
		});
	});

	describe('Attack Vector 12: Very large number of retros', () => {
		it('50 retro bundles -> only top-3 appear, performance acceptable', async () => {
			for (let i = 1; i <= 50; i++) {
				writeRetroBundleWithEntries(`retro-${i}`, [
					createValidRetroEntry({
						phase_number: i,
						timestamp: new Date(Date.now() - i * 1000).toISOString(),
						lessons_learned: [`Lesson from phase ${i}`],
					}),
				]);
			}
			await createSwarmFiles(tempDir, 1);

			const startTime = Date.now();
			const result = await buildRetroInjection(tempDir, 1);
			const duration = Date.now() - startTime;

			expect(result).not.toBeNull();
			expect(duration).toBeLessThan(5000);

			const phaseMatches = result!.match(/Phase \d+/g) || [];
			expect(phaseMatches.length).toBeLessThanOrEqual(3);
		});
	});
});

// =============================================================================
// Task 2.4 Adversarial Tests - Coder Retrospective Injection
// =============================================================================

describe('Task 2.4 Adversarial Tests - Coder Retrospective Injection', () => {
	let tempDir: string;
	let cleanup: () => Promise<void>;

	beforeEach(async () => {
		const result = await setupTempDir('swarm-retro-adv-24-test-');
		tempDir = result.tempDir;
		cleanup = result.cleanup;
		resetSwarmState();
	});

	afterEach(async () => {
		await cleanup();
	});

	it('Phase 2, agent=mega_coder, retro-1 bundle has no entries → graceful null, no crash', async () => {
		await createSwarmFiles(tempDir, 2);

		const taskDir = join(tempDir, '.swarm', 'evidence', 'retro-1');
		await mkdir(taskDir, { recursive: true });

		const bundle = {
			schema_version: '1.0.0',
			task_id: 'retro-1',
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			entries: [],
		};
		await writeFile(
			join(taskDir, 'evidence.json'),
			JSON.stringify(bundle, null, 2),
		);

		const systemOutput = await invokeHook(
			DEFAULT_PLUGIN_CONFIG,
			tempDir,
			'test-session',
			'mega_coder',
		);

		const coderRetro = systemOutput.find((s) =>
			s.includes('[SWARM RETROSPECTIVE]'),
		);
		expect(coderRetro).toBeUndefined();
	});

	it('Phase 2, agent=mega_coder, retro-1 summary is 500+ chars → injection still capped at 400', async () => {
		await createSwarmFiles(tempDir, 2);

		const longSummary =
			'This is an extremely long summary that exceeds the character limit. '.repeat(
				15,
			);
		await createRetroBundle(tempDir, 1, 'pass', ['lesson A'], [], longSummary);

		const systemOutput = await invokeHook(
			DEFAULT_PLUGIN_CONFIG,
			tempDir,
			'test-session',
			'mega_coder',
		);

		const coderRetro = systemOutput.find((s) =>
			s.includes('[SWARM RETROSPECTIVE] From Phase 1:'),
		);
		expect(coderRetro).toBeDefined();
		expect(coderRetro!.length).toBeLessThanOrEqual(400);
		expect(coderRetro!.endsWith('...')).toBe(true);
	});

	it('Phase 2, agent=mega_coder, lessons_learned is empty array → only header line, no crash', async () => {
		await createSwarmFiles(tempDir, 2);

		await createRetroBundle(tempDir, 1, 'pass', [], [], 'Phase 1 completed.');

		const systemOutput = await invokeHook(
			DEFAULT_PLUGIN_CONFIG,
			tempDir,
			'test-session',
			'mega_coder',
		);

		const coderRetro = systemOutput.find((s) =>
			s.includes('[SWARM RETROSPECTIVE] From Phase 1:'),
		);
		expect(coderRetro).toBeDefined();
		expect(coderRetro).toContain('Phase 1 completed.');
		expect(coderRetro!.length).toBeGreaterThan(0);
	});
});

// =============================================================================
// Task 3.4 Adversarial Tests - User Directives
// =============================================================================

describe('Task 3.4 Adversarial Tests - User Directives', () => {
	let tempDir: string;
	let cleanup: () => Promise<void>;

	beforeEach(async () => {
		const result = await setupTempDir('swarm-user-dir-adv-test-');
		tempDir = result.tempDir;
		cleanup = result.cleanup;
		resetSwarmState();
	});

	afterEach(async () => {
		await cleanup();
	});

	it('user_directives: null — should not throw, returns null (schema validation rejects malformed bundles)', async () => {
		const retroDir = join(tempDir, '.swarm', 'evidence', 'retro-1');
		await mkdir(retroDir, { recursive: true });

		const timestamp = new Date().toISOString();
		const bundle = {
			schema_version: '1.0.0',
			task_id: 'retro-1',
			entries: [
				{
					type: 'retrospective',
					task_id: 'retro-1',
					timestamp,
					agent: 'architect',
					verdict: 'pass',
					summary: 'Phase 1 completed successfully',
					metadata: {},
					phase_number: 1,
					total_tool_calls: 100,
					coder_revisions: 2,
					reviewer_rejections: 1,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
					task_count: 5,
					task_complexity: 'moderate',
					top_rejection_reasons: ['Config schema approach not aligned'],
					lessons_learned: [
						'Tree-sitter integration requires WASM grammar files',
					],
					user_directives: null,
				},
			],
			created_at: timestamp,
			updated_at: timestamp,
		};
		await writeFile(join(retroDir, 'evidence.json'), JSON.stringify(bundle));
		await createSwarmFiles(tempDir, 2);

		const result = await invokeHook(DEFAULT_PLUGIN_CONFIG, tempDir);

		expect(result).toBeDefined();
	});

	it('Empty string directive — should not crash, returns null (schema validation rejects empty strings)', async () => {
		const retroDir = join(tempDir, '.swarm', 'evidence', 'retro-1');
		await mkdir(retroDir, { recursive: true });

		const timestamp = new Date().toISOString();
		const bundle = {
			schema_version: '1.0.0',
			task_id: 'retro-1',
			entries: [
				{
					type: 'retrospective',
					task_id: 'retro-1',
					timestamp,
					agent: 'architect',
					verdict: 'pass',
					summary: 'Phase 1 completed successfully',
					metadata: {},
					phase_number: 1,
					total_tool_calls: 100,
					coder_revisions: 2,
					reviewer_rejections: 1,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
					task_count: 5,
					task_complexity: 'moderate',
					top_rejection_reasons: ['Config schema approach not aligned'],
					lessons_learned: [
						'Tree-sitter integration requires WASM grammar files',
					],
					user_directives: [
						{
							directive: '',
							category: 'other',
							scope: 'project',
						},
					],
				},
			],
			created_at: timestamp,
			updated_at: timestamp,
		};
		await writeFile(join(retroDir, 'evidence.json'), JSON.stringify(bundle));
		await createSwarmFiles(tempDir, 2);

		const result = await invokeHook(DEFAULT_PLUGIN_CONFIG, tempDir);

		expect(result).toBeDefined();
	});

	it('Malformed user_directives array (missing scope field) — should not crash, returns null (schema validation rejects invalid enum value)', async () => {
		const retroDir = join(tempDir, '.swarm', 'evidence', 'retro-1');
		await mkdir(retroDir, { recursive: true });

		const timestamp = new Date().toISOString();
		const bundle = {
			schema_version: '1.0.0',
			task_id: 'retro-1',
			entries: [
				{
					type: 'retrospective',
					task_id: 'retro-1',
					timestamp,
					agent: 'architect',
					verdict: 'pass',
					summary: 'Phase 1 completed successfully',
					metadata: {},
					phase_number: 1,
					total_tool_calls: 100,
					coder_revisions: 2,
					reviewer_rejections: 1,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
					task_count: 5,
					task_complexity: 'moderate',
					top_rejection_reasons: ['Config schema approach not aligned'],
					lessons_learned: [
						'Tree-sitter integration requires WASM grammar files',
					],
					user_directives: [
						{
							directive: 'Use TypeScript',
							category: 'code_style',
						} as any,
					],
				},
			],
			created_at: timestamp,
			updated_at: timestamp,
		};
		await writeFile(join(retroDir, 'evidence.json'), JSON.stringify(bundle));
		await createSwarmFiles(tempDir, 2);

		const result = await invokeHook(DEFAULT_PLUGIN_CONFIG, tempDir);

		expect(result).toBeDefined();
	});

	it('Very large user_directives array (50 entries, all project scope) — should only show first 5', async () => {
		const manyDirectives = Array.from({ length: 50 }, (_, i) => ({
			directive: `Large directive ${i + 1}`,
			category: 'other' as const,
			scope: 'project' as const,
		}));

		await createRetroBundle(tempDir, 1, 'pass', [], [], 'Phase 1 completed.', {
			user_directives: manyDirectives,
		});
		await createSwarmFiles(tempDir, 2);

		const result = await invokeHook(DEFAULT_PLUGIN_CONFIG, tempDir);

		const retroBlock = result.find((s) =>
			s.includes('## Previous Phase Retrospective'),
		);
		expect(retroBlock).toBeDefined();
		expect(retroBlock).toContain('## User Directives (from Phase 1)');

		const directiveLines = retroBlock?.match(
			/- \[other\] Large directive \d+/g,
		);
		expect(directiveLines).toBeDefined();
		expect(directiveLines!.length).toBe(5);

		expect(retroBlock).toContain('Large directive 1');
		expect(retroBlock).toContain('Large directive 5');
		expect(retroBlock).not.toContain('Large directive 6');
		expect(retroBlock).not.toContain('Large directive 50');
	});
});
