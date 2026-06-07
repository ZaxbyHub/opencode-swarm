import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import {
	appendKnowledge,
	appendRejectedLesson,
	computeConfidence,
	computeOutcomeSignal,
	findNearDuplicate,
	inferTags,
	jaccardBigram,
	normalize,
	normalizeEntry,
	readKnowledge,
	readRejectedLessons,
	resolveHiveKnowledgePath,
	resolveHiveRejectedPath,
	resolveSwarmKnowledgePath,
	resolveSwarmRejectedPath,
	rewriteKnowledge,
	wordBigrams,
} from '../../../src/hooks/knowledge-store.js';
import type { RejectedLesson } from '../../../src/hooks/knowledge-types.js';

describe('knowledge-store', () => {
	describe('Path resolvers', () => {
		it('resolveHiveKnowledgePath returns win32 path', () => {
			const spy = spyOn(process, 'platform', 'get').mockReturnValue('win32');
			const result = resolveHiveKnowledgePath();
			expect(result).toMatch(/opencode-swarm/);
			expect(result).toMatch(/Data/);
			expect(result).toMatch(/shared-learnings.jsonl/);
			spy.mockRestore();
		});

		it('resolveHiveKnowledgePath returns darwin path', () => {
			const spy = spyOn(process, 'platform', 'get').mockReturnValue('darwin');
			const result = resolveHiveKnowledgePath();
			expect(result).toMatch(/Library/);
			expect(result).toMatch(/Application Support/);
			expect(result).toMatch(/opencode-swarm/);
			spy.mockRestore();
		});

		it('resolveHiveKnowledgePath returns linux path', () => {
			const spy = spyOn(process, 'platform', 'get').mockReturnValue('linux');
			const result = resolveHiveKnowledgePath();
			expect(result).toMatch(/opencode-swarm/);
			expect(
				result.match(/\.local\/share/) || result.match(/opencode-swarm/),
			).toBeTruthy();
			spy.mockRestore();
		});
	});

	describe('readKnowledge', () => {
		it('returns empty array when file does not exist', async () => {
			const nonExistentPath = path.join(os.tmpdir(), 'does-not-exist.jsonl');
			const result = await readKnowledge(nonExistentPath);
			expect(result).toEqual([]);
		});

		it('skips corrupted JSONL lines and returns valid entries', async () => {
			const tempPath = path.join(
				os.tmpdir(),
				`test-corrupt-${Date.now()}.jsonl`,
			);
			const content =
				JSON.stringify({ id: 1, text: 'valid1' }) +
				'\n' +
				'{ invalid json here' +
				'\n' +
				JSON.stringify({ id: 2, text: 'valid2' }) +
				'\n';
			await fs.promises.writeFile(tempPath, content, 'utf-8');

			const result = await readKnowledge(tempPath);
			expect(result).toHaveLength(2);
			expect(result[0]).toEqual({ id: 1, text: 'valid1' });
			expect(result[1]).toEqual({ id: 2, text: 'valid2' });

			await fs.promises.unlink(tempPath);
		});
	});

	describe('appendKnowledge', () => {
		it('creates missing directory and appends entry', async () => {
			const deepPath = path.join(
				os.tmpdir(),
				`test-deep-${Date.now()}`,
				'nested',
				'dir',
				'file.jsonl',
			);
			const entry = { id: 'test', message: 'test entry' };

			await appendKnowledge(deepPath, entry);

			// Verify directory exists
			const dirExists = fs.existsSync(path.dirname(deepPath));
			expect(dirExists).toBe(true);

			// Verify file content
			const content = await fs.promises.readFile(deepPath, 'utf-8');
			const parsed = JSON.parse(content.trim());
			expect(parsed).toEqual(entry);

			// Cleanup
			const baseDir = path.join(os.tmpdir(), `test-deep-${Date.now()}`);
			await fs.promises.rm(baseDir, { recursive: true, force: true });
		});
	});

	describe('rewriteKnowledge', () => {
		it('writes all entries as JSONL', async () => {
			const tempDir = path.join(os.tmpdir(), `test-rewrite-dir-${Date.now()}`);
			fs.mkdirSync(tempDir, { recursive: true });
			const tempPath = path.join(tempDir, `test-rewrite-${Date.now()}.jsonl`);
			const entries = [
				{ id: 1, text: 'entry1' },
				{ id: 2, text: 'entry2' },
				{ id: 3, text: 'entry3' },
			];

			await rewriteKnowledge(tempPath, entries);

			const content = await fs.promises.readFile(tempPath, 'utf-8');
			const lines = content.trim().split('\n');

			expect(lines).toHaveLength(3);
			expect(JSON.parse(lines[0])).toEqual({ id: 1, text: 'entry1' });
			expect(JSON.parse(lines[1])).toEqual({ id: 2, text: 'entry2' });
			expect(JSON.parse(lines[2])).toEqual({ id: 3, text: 'entry3' });

			await fs.promises.rm(tempDir, { recursive: true });
		});
	});

	describe('appendRejectedLesson', () => {
		it('enforces FIFO cap at 20 entries', async () => {
			const testDir = path.join(os.tmpdir(), `test-rejected-${Date.now()}`);
			fs.mkdirSync(testDir, { recursive: true });

			// Create 20 initial lessons
			const initialLessons: RejectedLesson[] = [];
			for (let i = 1; i <= 20; i++) {
				initialLessons.push({
					id: `lesson-${i}`,
					lesson: `rejected lesson ${i}`,
					rejection_reason: 'test',
					rejected_at: new Date(Date.now() + i).toISOString(),
					rejection_layer: 1,
				});
			}

			// Write initial 20 lessons
			const filePath = resolveSwarmRejectedPath(testDir);
			await rewriteKnowledge(filePath, initialLessons);

			// Append 21st lesson
			const newLesson: RejectedLesson = {
				id: 'lesson-21',
				lesson: 'rejected lesson 21 (newest)',
				rejection_reason: 'test',
				rejected_at: new Date(Date.now() + 21).toISOString(),
				rejection_layer: 1,
			};
			await appendRejectedLesson(testDir, newLesson);

			// Read back and verify
			const finalLessons = await readRejectedLessons(testDir);
			expect(finalLessons).toHaveLength(20);

			// Verify oldest entry (lesson 1) was dropped
			expect(finalLessons[0].lesson).not.toBe('rejected lesson 1');

			// Verify newest entry is the one we just appended
			expect(finalLessons[19].lesson).toBe('rejected lesson 21 (newest)');

			// Cleanup
			await fs.promises.rm(testDir, { recursive: true, force: true });
		});
	});

	describe('findNearDuplicate', () => {
		it('finds exact duplicate (similarity = 1.0)', () => {
			const candidate = 'always validate inputs before processing';
			const entries = [
				{ id: 1, lesson: 'always validate inputs before processing' },
				{ id: 2, lesson: 'different lesson text' },
			];

			const result = findNearDuplicate(candidate, entries, 0.6);
			expect(result).toBeDefined();
			expect(result?.lesson).toBe('always validate inputs before processing');
		});

		it('finds near-duplicate above 0.6 threshold', () => {
			const candidate = 'always validate inputs before processing anything';
			const entries = [
				{ id: 1, lesson: 'always validate inputs before processing' },
				{ id: 2, lesson: 'different lesson text' },
			];

			const result = findNearDuplicate(candidate, entries, 0.6);
			expect(result).toBeDefined();
			expect(result?.lesson).toBe('always validate inputs before processing');
		});

		it('returns undefined when no match below threshold', () => {
			const candidate = 'use vitest for testing';
			const entries = [
				{ id: 1, lesson: 'docker containerization best practices' },
				{ id: 2, lesson: 'git workflow strategies' },
			];

			const result = findNearDuplicate(candidate, entries, 0.6);
			expect(result).toBeUndefined();
		});
	});

	describe('normalize', () => {
		it('normalizes text to lowercase, collapses whitespace, strips punctuation', () => {
			const input = 'Hello, World! This is a TEST.';
			const result = normalize(input);
			expect(result).toBe('hello world this is a test');
		});
	});

	describe('normalizeEntry — null retrieval_outcomes', () => {
		it('backfills v2 counters when retrieval_outcomes is null (was previously skipped)', () => {
			// Legacy entries on disk may have retrieval_outcomes: null.
			// Pre-fix, normalizeEntry's `if (ro && typeof ro === 'object')` skipped
			// the backfill silently — entries surfaced with null counters that
			// downstream code (computeOutcomeSignal, ranking) couldn't read.
			const raw = {
				id: 'legacy-null',
				lesson: 'older entry whose outcomes column is null',
				tags: ['legacy'],
				retrieval_outcomes: null,
			};
			const normalized = normalizeEntry(raw as unknown as typeof raw) as {
				retrieval_outcomes: Record<string, number>;
			};
			expect(normalized.retrieval_outcomes).toBeDefined();
			expect(typeof normalized.retrieval_outcomes).toBe('object');
			expect(normalized.retrieval_outcomes.shown_count).toBe(0);
			expect(normalized.retrieval_outcomes.applied_explicit_count).toBe(0);
			expect(normalized.retrieval_outcomes.ignored_count).toBe(0);
			expect(normalized.retrieval_outcomes.contradicted_count).toBe(0);
			expect(normalized.retrieval_outcomes.succeeded_after_shown_count).toBe(0);
			expect(normalized.retrieval_outcomes.failed_after_shown_count).toBe(0);
		});

		it('treats a non-object retrieval_outcomes (e.g. number) as null and backfills', () => {
			const raw = {
				id: 'legacy-bad-shape',
				lesson: 'older entry with retrieval_outcomes set to a number',
				retrieval_outcomes: 42,
			};
			const normalized = normalizeEntry(raw as unknown as typeof raw) as {
				retrieval_outcomes: Record<string, number>;
			};
			expect(typeof normalized.retrieval_outcomes).toBe('object');
			expect(normalized.retrieval_outcomes.shown_count).toBe(0);
		});
	});

	describe('inferTags', () => {
		it('infers testing and typescript tags', () => {
			const lesson = 'use vitest for testing TypeScript';
			const tags = inferTags(lesson);
			expect(tags).toContain('testing');
			expect(tags).toContain('typescript');
		});
	});

	describe('computeConfidence', () => {
		it('returns 0.5 for 0 confirmations and autoGenerated=true', () => {
			const result = computeConfidence(0, true);
			expect(result).toBe(0.5);
		});

		it('returns 0.9 for 3 confirmations and autoGenerated=false', () => {
			const result = computeConfidence(3, false);
			expect(result).toBe(0.9);
		});

		it('returns 0.7 for 1 confirmation and autoGenerated=false', () => {
			const result = computeConfidence(1, false);
			expect(result).toBe(0.7);
		});
	});

	describe('computeOutcomeSignal', () => {
		it('returns 0 (neutral) when there are no outcomes or no evidence', () => {
			expect(computeOutcomeSignal(undefined)).toBe(0);
			expect(
				computeOutcomeSignal({
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				}),
			).toBe(0);
		});

		it('is positive when applied/succeeded outcomes dominate', () => {
			const signal = computeOutcomeSignal({
				applied_count: 0,
				succeeded_after_count: 0,
				failed_after_count: 0,
				applied_explicit_count: 6,
				succeeded_after_shown_count: 4,
			});
			// (10 - 0) / (10 + 4) ≈ 0.714
			expect(signal).toBeGreaterThan(0.6);
			expect(signal).toBeLessThanOrEqual(1);
		});

		it('is negative when ignored/contradicted/failed outcomes dominate', () => {
			const signal = computeOutcomeSignal({
				applied_count: 0,
				succeeded_after_count: 0,
				failed_after_count: 0,
				ignored_count: 3,
				contradicted_count: 2,
				violated_count: 1,
				failed_after_shown_count: 2,
			});
			expect(signal).toBeLessThan(-0.3);
			expect(signal).toBeGreaterThanOrEqual(-1);
		});

		it('ignores the frozen v1 applied_count when deriving the signal', () => {
			// Legacy applied_count must NOT count as a positive (v2 contract).
			const signal = computeOutcomeSignal({
				applied_count: 100,
				succeeded_after_count: 0,
				failed_after_count: 0,
			});
			expect(signal).toBe(0);
		});

		it('pulls low-evidence entries toward 0 via Laplace smoothing', () => {
			// A single positive is heavily damped: 1 / (1 + 4) = 0.2, not 1.0.
			const onePositive = computeOutcomeSignal({
				applied_count: 0,
				succeeded_after_count: 0,
				failed_after_count: 0,
				applied_explicit_count: 1,
			});
			expect(onePositive).toBeCloseTo(0.2, 5);
			// More corroborating evidence yields a stronger signal.
			const manyPositive = computeOutcomeSignal({
				applied_count: 0,
				succeeded_after_count: 0,
				failed_after_count: 0,
				applied_explicit_count: 20,
			});
			expect(manyPositive).toBeGreaterThan(onePositive);
		});
	});

	describe('wordBigrams and jaccardBigram', () => {
		it('generates word bigrams from text', () => {
			const text = 'hello world test';
			const bigrams = wordBigrams(text);
			expect(bigrams).toBeInstanceOf(Set);
			expect(bigrams.has('hello world')).toBe(true);
			expect(bigrams.has('world test')).toBe(true);
			expect(bigrams.size).toBe(2);
		});

		it('computes jaccard similarity between bigram sets', () => {
			const set1 = new Set(['hello world', 'world test']);
			const set2 = new Set(['hello world', 'world test', 'test done']);
			const similarity = jaccardBigram(set1, set2);
			expect(similarity).toBe(2 / 3); // 2 intersection / 3 union
		});
	});

	describe('Additional path resolvers', () => {
		it('resolveSwarmKnowledgePath returns correct path', () => {
			const result = resolveSwarmKnowledgePath('/test/project');
			expect(result).toMatch(/\.swarm/);
			expect(result).toMatch(/knowledge.jsonl/);
		});

		it('resolveSwarmRejectedPath returns correct path', () => {
			const result = resolveSwarmRejectedPath('/test/project');
			expect(result).toMatch(/\.swarm/);
			expect(result).toMatch(/knowledge-rejected.jsonl/);
		});

		it('resolveHiveRejectedPath returns path in same dir as hive knowledge', () => {
			const hivePath = resolveHiveKnowledgePath();
			const rejectedPath = resolveHiveRejectedPath();
			const hiveDir = path.dirname(hivePath);
			const rejectedDir = path.dirname(rejectedPath);
			expect(rejectedDir).toBe(hiveDir);
			expect(rejectedPath).toMatch(/shared-learnings-rejected.jsonl/);
		});
	});

	describe('Malformed entry handling (FR-F2)', () => {
		it('Entry with missing id field — graceful degradation, entry is returned', async () => {
			const tempPath = path.join(
				os.tmpdir(),
				`test-missing-id-${Date.now()}.jsonl`,
			);
			// normalizeEntry is a pass-through normalizer; it does NOT validate id
			const content =
				JSON.stringify({
					lesson: 'this lesson has no id field',
					retrieval_outcomes: {},
				}) + '\n';
			await fs.promises.writeFile(tempPath, content, 'utf-8');

			const result = await readKnowledge<{ id: string; lesson: string }>(
				tempPath,
			);
			// Entry is returned as-is (graceful degradation); id validation is not performed by readKnowledge
			expect(result).toHaveLength(1);
			expect(result[0]).toHaveProperty('lesson', 'this lesson has no id field');

			await fs.promises.unlink(tempPath);
		});

		it('Entry with missing lesson field — graceful degradation, entry is returned', async () => {
			const tempPath = path.join(
				os.tmpdir(),
				`test-missing-lesson-${Date.now()}.jsonl`,
			);
			// normalizeEntry is a pass-through normalizer; it does NOT validate lesson
			const content =
				JSON.stringify({
					id: 'test-id-123',
					category: 'testing',
					retrieval_outcomes: {},
				}) + '\n';
			await fs.promises.writeFile(tempPath, content, 'utf-8');

			const result = await readKnowledge<{ id: string; lesson: string }>(
				tempPath,
			);
			// Entry is returned as-is (graceful degradation); lesson validation is not performed by readKnowledge
			expect(result).toHaveLength(1);
			expect(result[0]).toHaveProperty('id', 'test-id-123');

			await fs.promises.unlink(tempPath);
		});

		it('Entry with lesson too short (under 15 chars) — graceful degradation, entry is returned', async () => {
			const tempPath = path.join(
				os.tmpdir(),
				`test-short-lesson-${Date.now()}.jsonl`,
			);
			const shortLesson = 'too short'; // 11 chars
			// normalizeEntry does NOT check lesson length
			const content =
				JSON.stringify({
					id: 'test-id-456',
					lesson: shortLesson,
					retrieval_outcomes: {},
				}) + '\n';
			await fs.promises.writeFile(tempPath, content, 'utf-8');

			const result = await readKnowledge<{ id: string; lesson: string }>(
				tempPath,
			);
			// Entry is returned as-is (graceful degradation); lesson length is not validated by readKnowledge
			expect(result).toHaveLength(1);
			expect(result[0]).toHaveProperty('lesson', shortLesson);

			await fs.promises.unlink(tempPath);
		});

		it('Entry with wrong confidence type (string instead of number) — graceful degradation, entry is returned', async () => {
			const tempPath = path.join(
				os.tmpdir(),
				`test-bad-confidence-${Date.now()}.jsonl`,
			);
			// normalizeEntry does NOT check confidence type
			const content =
				JSON.stringify({
					id: 'test-id-789',
					lesson: 'a valid lesson that is long enough for validation',
					confidence: 'high',
					retrieval_outcomes: {},
				}) + '\n';
			await fs.promises.writeFile(tempPath, content, 'utf-8');

			const result = await readKnowledge<{
				id: string;
				lesson: string;
				confidence: number;
			}>(tempPath);
			// Entry is returned as-is (graceful degradation); confidence type is not validated by readKnowledge
			expect(result).toHaveLength(1);
			expect(result[0]).toHaveProperty('confidence', 'high');

			await fs.promises.unlink(tempPath);
		});

		it('Entry with extra unknown field — should be preserved (JSONL is schema-flexible)', async () => {
			const tempPath = path.join(
				os.tmpdir(),
				`test-extra-field-${Date.now()}.jsonl`,
			);
			const content =
				JSON.stringify({
					id: 'test-id-extra',
					lesson: 'a valid lesson with an extra unknown field for testing',
					category: 'testing',
					tags: ['test'],
					scope: 'global',
					confidence: 0.8,
					status: 'established',
					confirmed_by: [],
					retrieval_outcomes: {},
					schema_version: 2,
					created_at: '2024-01-01T00:00:00.000Z',
					updated_at: '2024-01-01T00:00:00.000Z',
					tier: 'swarm',
					project_name: 'test-project',
					unknown_extra_field: 'this should be preserved',
				}) + '\n';
			await fs.promises.writeFile(tempPath, content, 'utf-8');

			const result = await readKnowledge<Record<string, unknown>>(tempPath);
			expect(result).toHaveLength(1);
			// Unknown fields should be preserved since JSONL is schema-flexible
			expect(result[0]).toHaveProperty('unknown_extra_field');
			expect(result[0]['unknown_extra_field']).toBe('this should be preserved');

			await fs.promises.unlink(tempPath);
		});
	});
});
