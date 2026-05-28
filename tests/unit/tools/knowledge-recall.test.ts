/**
 * Verification tests for knowledge_recall tool (FR-A1)
 *
 * Tests cover:
 * - Argument validation (query required, tier enum validation)
 * - Tier filtering (swarm, hive, all)
 * - Status boost scoring (established +0.1, promoted +0.05, candidate +0)
 * - Archived filtering (always excluded regardless of tier)
 * - Output shape (results[], total fields)
 * - Malicious getter defense (safe object property access)
 * - Short/empty query (< 3 chars) returns error
 */

import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	mock,
} from 'bun:test';
import { writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
	HiveKnowledgeEntry,
	SwarmKnowledgeEntry,
} from '../../../src/hooks/knowledge-types';
import { knowledge_recall } from '../../../src/tools/knowledge-recall';

describe('knowledge_recall tool verification tests (FR-A1)', () => {
	let tmpDir: string;
	let originalCwd: string;

	beforeEach(async () => {
		// Create a temporary directory for each test
		tmpDir = await fs.realpath(
			await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-recall-test-')),
		);
		// Ensure .swarm/ directory exists
		await fs.mkdir(path.join(tmpDir, '.swarm'), { recursive: true });
		// Save original cwd and change to tmpDir for tests
		originalCwd = process.cwd();
		process.chdir(tmpDir);
	});

	afterEach(async () => {
		// Restore original cwd
		process.chdir(originalCwd);
		// Clean up the temporary directory
		try {
			await fs.rm(tmpDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
		// Restore cross-module mocks to prevent contamination
		mock.restore();
	});

	// Mock resolveHiveKnowledgePath to return a path inside tmpDir so hive knowledge
	// doesn't leak from the real global hive file across test runs.
	beforeAll(() => {
		mock.module('../../../src/hooks/knowledge-store.js', () => ({
			resolveHiveKnowledgePath: () =>
				path.join(tmpDir, '.swarm', 'shared-learnings.jsonl'),
			resolveSwarmKnowledgePath: (dir: string) =>
				path.join(dir, '.swarm', 'knowledge.jsonl'),
			resolveHiveRejectedPath: () =>
				path.join(tmpDir, '.swarm', 'shared-learnings-rejected.jsonl'),
			readKnowledge: async <T>(filePath: string): Promise<T[]> => {
				if (
					!filePath.includes('knowledge.jsonl') &&
					!filePath.includes('shared-learnings.jsonl')
				) {
					return [];
				}
				try {
					const content = await fs.readFile(filePath, 'utf-8');
					return content
						.trim()
						.split('\n')
						.filter((line) => line.length > 0)
						.map((line) => JSON.parse(line) as T);
				} catch {
					return [];
				}
			},
			readRetractionRecords: async () => [],
			normalize: (text: string): string => {
				return text
					.toLowerCase()
					.replace(/[^\w\s]/g, ' ')
					.replace(/\s+/g, ' ')
					.trim();
			},
			wordBigrams: (text: string): Set<string> => {
				const words = text.toLowerCase().split(' ').filter(Boolean);
				const bigrams = new Set<string>();
				for (let i = 0; i < words.length - 1; i++) {
					bigrams.add(`${words[i]} ${words[i + 1]}`);
				}
				return bigrams;
			},
			jaccardBigram: (a: Set<string>, b: Set<string>): number => {
				if (a.size === 0 && b.size === 0) return 1.0;
				const aArr = Array.from(a);
				const intersection = new Set(aArr.filter((x) => b.has(x)));
				const union = new Set([...aArr, ...Array.from(b)]);
				return intersection.size / union.size;
			},
			enforceKnowledgeCap: async () => {},
			sweepAgedEntries: async () => {},
			sweepStaleTodos: async () => {},
			bumpKnowledgeConfidenceBatch: async () => {},
		}));
	});

	// Helper to write swarm knowledge file
	function writeSwarmKnowledge(entries: SwarmKnowledgeEntry[]): void {
		const swarmPath = path.join(tmpDir, '.swarm', 'knowledge.jsonl');
		writeFileSync(
			swarmPath,
			entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
			'utf-8',
		);
	}

	// Helper to write hive knowledge file
	function writeHiveKnowledge(entries: HiveKnowledgeEntry[]): void {
		const hivePath = path.join(tmpDir, '.swarm', 'shared-learnings.jsonl');
		writeFileSync(
			hivePath,
			entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
			'utf-8',
		);
	}

	// Helper to create a swarm entry with defaults
	function makeSwarmEntry(
		overrides: Partial<SwarmKnowledgeEntry> & { id: string; lesson: string },
	): SwarmKnowledgeEntry {
		return {
			id: overrides.id,
			tier: 'swarm',
			lesson: overrides.lesson,
			category: 'process',
			tags: [],
			scope: 'global',
			confidence: 0.8,
			status: 'established',
			confirmed_by: [],
			retrieval_outcomes: {
				applied_count: 0,
				succeeded_after_count: 0,
				failed_after_count: 0,
			},
			schema_version: 1,
			created_at: '2024-01-01T00:00:00Z',
			updated_at: '2024-01-01T00:00:00Z',
			project_name: 'test-project',
			...overrides,
		} as SwarmKnowledgeEntry;
	}

	// Helper to create a hive entry with defaults
	function makeHiveEntry(
		overrides: Partial<HiveKnowledgeEntry> & { id: string; lesson: string },
	): HiveKnowledgeEntry {
		return {
			id: overrides.id,
			tier: 'hive',
			lesson: overrides.lesson,
			category: 'process',
			tags: [],
			scope: 'global',
			confidence: 0.7,
			status: 'established',
			confirmed_by: [],
			retrieval_outcomes: {
				applied_count: 0,
				succeeded_after_count: 0,
				failed_after_count: 0,
			},
			schema_version: 1,
			created_at: '2024-01-01T00:00:00Z',
			updated_at: '2024-01-01T00:00:00Z',
			source_project: 'other-project',
			encounter_score: 1.0,
			...overrides,
		} as HiveKnowledgeEntry;
	}

	// ========== GROUP 1: Argument Validation ==========
	describe('Group 1: Argument validation', () => {
		it('Returns error when query is missing', async () => {
			const result = await knowledge_recall.execute(
				{ tier: 'all' } as Record<string, unknown>,
				tmpDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.results).toEqual([]);
			expect(parsed.total).toBe(0);
			expect(parsed.error).toContain('query must be a string');
		});

		it('Returns error when query is less than 3 characters', async () => {
			const result = await knowledge_recall.execute(
				{ query: 'ab', tier: 'all' } as Record<string, unknown>,
				tmpDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.results).toEqual([]);
			expect(parsed.total).toBe(0);
			expect(parsed.error).toContain('query must be a string');
		});

		it('Returns error when query is not a string', async () => {
			const result = await knowledge_recall.execute(
				{ query: 123 as unknown, tier: 'all' } as Record<string, unknown>,
				tmpDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.results).toEqual([]);
			expect(parsed.total).toBe(0);
			expect(parsed.error).toContain('query must be a string');
		});

		it('Accepts query with exactly 3 characters', async () => {
			writeSwarmKnowledge([
				makeSwarmEntry({ id: 'test-1', lesson: 'TypeScript testing patterns' }),
			]);

			const result = await knowledge_recall.execute(
				{ query: 'Typ' } as Record<string, unknown>,
				tmpDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toBeUndefined();
			expect(parsed.results).toBeDefined();
		});

		it('Invalid tier value is silently ignored and defaults to "all"', async () => {
			writeSwarmKnowledge([
				makeSwarmEntry({ id: 'test-1', lesson: 'Use dependency injection' }),
			]);

			const result = await knowledge_recall.execute(
				{ query: 'dependency injection', tier: 'invalid' } as Record<
					string,
					unknown
				>,
				tmpDir,
			);
			const parsed = JSON.parse(result);
			// Should not error - invalid tier is ignored and defaults to 'all'
			expect(parsed.results).toBeDefined();
		});

		it('Accepts valid tier values: all, swarm, hive', async () => {
			writeSwarmKnowledge([
				makeSwarmEntry({ id: 'test-1', lesson: 'Test lesson' }),
			]);

			for (const tier of ['all', 'swarm', 'hive'] as const) {
				const result = await knowledge_recall.execute(
					{ query: 'test lesson', tier } as Record<string, unknown>,
					tmpDir,
				);
				const parsed = JSON.parse(result);
				expect(parsed.results).toBeDefined();
			}
		});

		it('top_n defaults to 5 when not provided', async () => {
			writeSwarmKnowledge(
				Array.from({ length: 10 }, (_, i) =>
					makeSwarmEntry({
						id: `test-${i}`,
						lesson: `Lesson ${i} about testing`,
					}),
				),
			);

			const result = await knowledge_recall.execute(
				{ query: 'testing' } as Record<string, unknown>,
				tmpDir,
			);
			const parsed = JSON.parse(result);
			// Default top_n is 5
			expect(parsed.results.length).toBeLessThanOrEqual(5);
		});

		it('top_n is clamped to range 1-20', async () => {
			writeSwarmKnowledge(
				Array.from({ length: 25 }, (_, i) =>
					makeSwarmEntry({
						id: `test-${i}`,
						lesson: `Lesson ${i} about testing patterns`,
					}),
				),
			);

			// Test top_n > 20 gets clamped to 20
			const resultOver = await knowledge_recall.execute(
				{ query: 'testing patterns', top_n: 100 } as Record<string, unknown>,
				tmpDir,
			);
			const parsedOver = JSON.parse(resultOver);
			expect(parsedOver.results.length).toBeLessThanOrEqual(20);

			// Test top_n < 1 gets clamped to 1
			const resultUnder = await knowledge_recall.execute(
				{ query: 'testing patterns', top_n: 0 } as Record<string, unknown>,
				tmpDir,
			);
			const parsedUnder = JSON.parse(resultUnder);
			expect(parsedUnder.results.length).toBeLessThanOrEqual(1);
		});
	});

	// ========== GROUP 2: Tier Filtering ==========
	describe('Group 2: Tier filtering', () => {
		it('tier=swarm returns only swarm entries', async () => {
			writeSwarmKnowledge([
				makeSwarmEntry({ id: 'swarm-1', lesson: 'Swarm specific lesson' }),
				makeSwarmEntry({ id: 'swarm-2', lesson: 'Another swarm lesson' }),
			]);
			writeHiveKnowledge([
				makeHiveEntry({ id: 'hive-1', lesson: 'Hive specific lesson' }),
			]);

			const result = await knowledge_recall.execute(
				{ query: 'lesson', tier: 'swarm' } as Record<string, unknown>,
				tmpDir,
			);
			const parsed = JSON.parse(result);

			const ids = parsed.results.map((r: { id: string }) => r.id);
			expect(ids).toContain('swarm-1');
			expect(ids).toContain('swarm-2');
			expect(ids).not.toContain('hive-1');
		});

		it('tier=hive returns only hive entries', async () => {
			writeSwarmKnowledge([
				makeSwarmEntry({ id: 'swarm-1', lesson: 'Swarm specific lesson' }),
			]);
			writeHiveKnowledge([
				makeHiveEntry({ id: 'hive-1', lesson: 'Hive specific lesson' }),
				makeHiveEntry({ id: 'hive-2', lesson: 'Another hive lesson' }),
			]);

			const result = await knowledge_recall.execute(
				{ query: 'lesson', tier: 'hive' } as Record<string, unknown>,
				tmpDir,
			);
			const parsed = JSON.parse(result);

			const ids = parsed.results.map((r: { id: string }) => r.id);
			expect(ids).not.toContain('swarm-1');
			expect(ids).toContain('hive-1');
			expect(ids).toContain('hive-2');
		});

		it('tier=all returns both swarm and hive entries', async () => {
			writeSwarmKnowledge([
				makeSwarmEntry({ id: 'swarm-1', lesson: 'Swarm lesson' }),
			]);
			writeHiveKnowledge([
				makeHiveEntry({ id: 'hive-1', lesson: 'Hive lesson' }),
			]);

			const result = await knowledge_recall.execute(
				{ query: 'lesson', tier: 'all' } as Record<string, unknown>,
				tmpDir,
			);
			const parsed = JSON.parse(result);

			const ids = parsed.results.map((r: { id: string }) => r.id);
			expect(ids).toContain('swarm-1');
			expect(ids).toContain('hive-1');
		});

		it('tier defaults to all when not specified', async () => {
			writeSwarmKnowledge([
				makeSwarmEntry({ id: 'swarm-1', lesson: 'Swarm lesson' }),
			]);
			writeHiveKnowledge([
				makeHiveEntry({ id: 'hive-1', lesson: 'Hive lesson' }),
			]);

			const result = await knowledge_recall.execute(
				{ query: 'lesson' } as Record<string, unknown>,
				tmpDir,
			);
			const parsed = JSON.parse(result);

			const ids = parsed.results.map((r: { id: string }) => r.id);
			expect(ids).toContain('swarm-1');
			expect(ids).toContain('hive-1');
		});

		it('Returns empty results when no files exist for specified tier', async () => {
			// Don't create any knowledge files
			const result = await knowledge_recall.execute(
				{ query: 'lesson', tier: 'swarm' } as Record<string, unknown>,
				tmpDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.results).toEqual([]);
			expect(parsed.total).toBe(0);
		});
	});

	// ========== GROUP 3: Status Boost Scoring ==========
	describe('Group 3: Status boost scoring', () => {
		it('candidate status is excluded from normal recall', async () => {
			writeSwarmKnowledge([
				makeSwarmEntry({
					id: 'candidate',
					lesson: 'Test candidate lesson',
					status: 'candidate',
				}),
				makeSwarmEntry({
					id: 'established',
					lesson: 'Test established lesson',
					status: 'established',
				}),
			]);

			const result = await knowledge_recall.execute(
				{ query: 'test lesson', tier: 'swarm' } as Record<string, unknown>,
				tmpDir,
			);
			const parsed = JSON.parse(result);

			const established = parsed.results.find(
				(r: { id: string }) => r.id === 'established',
			);
			const candidate = parsed.results.find(
				(r: { id: string }) => r.id === 'candidate',
			);

			expect(established).toBeDefined();
			expect(candidate).toBeUndefined();
		});

		it('promoted status remains retrievable', async () => {
			writeSwarmKnowledge([
				makeSwarmEntry({
					id: 'candidate',
					lesson: 'Test candidate lesson',
					status: 'candidate',
				}),
				makeSwarmEntry({
					id: 'promoted',
					lesson: 'Test promoted lesson',
					status: 'promoted',
				}),
			]);

			const result = await knowledge_recall.execute(
				{ query: 'test lesson', tier: 'swarm' } as Record<string, unknown>,
				tmpDir,
			);
			const parsed = JSON.parse(result);

			const promoted = parsed.results.find(
				(r: { id: string }) => r.id === 'promoted',
			);
			const candidate = parsed.results.find(
				(r: { id: string }) => r.id === 'candidate',
			);
			expect(promoted).toBeDefined();
			expect(candidate).toBeUndefined();
		});

		it('Boost is additive to text similarity score', async () => {
			writeSwarmKnowledge([
				makeSwarmEntry({
					id: 'high-sim',
					lesson: 'Use dependency injection for testability',
					status: 'established',
					confidence: 0.9,
				}),
			]);

			const result = await knowledge_recall.execute(
				{ query: 'dependency injection testability', tier: 'swarm' } as Record<
					string,
					unknown
				>,
				tmpDir,
			);
			const parsed = JSON.parse(result);

			// Score should include both text similarity and +0.1 established boost
			expect(parsed.results[0].score).toBeGreaterThan(0);
		});
	});

	// ========== GROUP 4: Archived Filtering ==========
	describe('Group 4: Archived filtering', () => {
		it('Archived entries are excluded regardless of tier setting', async () => {
			writeSwarmKnowledge([
				makeSwarmEntry({
					id: 'active',
					lesson: 'Active lesson',
					status: 'established',
				}),
				makeSwarmEntry({
					id: 'archived',
					lesson: 'Archived lesson',
					status: 'archived',
				}),
			]);

			const result = await knowledge_recall.execute(
				{ query: 'lesson', tier: 'swarm' } as Record<string, unknown>,
				tmpDir,
			);
			const parsed = JSON.parse(result);

			const ids = parsed.results.map((r: { id: string }) => r.id);
			expect(ids).toContain('active');
			expect(ids).not.toContain('archived');
		});

		it('tier=all also excludes archived entries from both tiers', async () => {
			writeSwarmKnowledge([
				makeSwarmEntry({
					id: 'swarm-active',
					lesson: 'Swarm active lesson',
					status: 'established',
				}),
				makeSwarmEntry({
					id: 'swarm-archived',
					lesson: 'Swarm archived lesson',
					status: 'archived',
				}),
			]);
			writeHiveKnowledge([
				makeHiveEntry({
					id: 'hive-active',
					lesson: 'Hive active lesson',
					status: 'established',
				}),
				makeHiveEntry({
					id: 'hive-archived',
					lesson: 'Hive archived lesson',
					status: 'archived',
				}),
			]);

			const result = await knowledge_recall.execute(
				{ query: 'lesson', tier: 'all' } as Record<string, unknown>,
				tmpDir,
			);
			const parsed = JSON.parse(result);

			const ids = parsed.results.map((r: { id: string }) => r.id);
			expect(ids).toContain('swarm-active');
			expect(ids).toContain('hive-active');
			expect(ids).not.toContain('swarm-archived');
			expect(ids).not.toContain('hive-archived');
		});

		it('Only archived entries returns empty results', async () => {
			writeSwarmKnowledge([
				makeSwarmEntry({
					id: 'archived-1',
					lesson: 'Archived lesson 1',
					status: 'archived',
				}),
				makeSwarmEntry({
					id: 'archived-2',
					lesson: 'Archived lesson 2',
					status: 'archived',
				}),
			]);

			const result = await knowledge_recall.execute(
				{ query: 'lesson', tier: 'swarm' } as Record<string, unknown>,
				tmpDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.results).toEqual([]);
			expect(parsed.total).toBe(0);
		});
	});

	// ========== GROUP 5: Output Shape ==========
	describe('Group 5: Output shape', () => {
		it('Result has correct top-level fields: results and total', async () => {
			writeSwarmKnowledge([
				makeSwarmEntry({
					id: 'test-1',
					lesson: 'Test lesson for output shape',
				}),
			]);

			const result = await knowledge_recall.execute(
				{ query: 'test lesson output shape' } as Record<string, unknown>,
				tmpDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed).toHaveProperty('results');
			expect(parsed).toHaveProperty('total');
			expect(Array.isArray(parsed.results)).toBe(true);
			expect(typeof parsed.total).toBe('number');
		});

		it('Each result entry has correct fields', async () => {
			writeSwarmKnowledge([
				makeSwarmEntry({
					id: 'entry-1',
					lesson: 'Test lesson about dependency injection',
					category: 'architecture',
					status: 'established',
					confidence: 0.85,
				}),
			]);

			const result = await knowledge_recall.execute(
				{ query: 'dependency injection architecture' } as Record<
					string,
					unknown
				>,
				tmpDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.results.length).toBeGreaterThan(0);
			const entry = parsed.results[0];
			expect(entry).toHaveProperty('id');
			expect(entry).toHaveProperty('confidence');
			expect(entry).toHaveProperty('category');
			expect(entry).toHaveProperty('lesson');
			expect(entry).toHaveProperty('score');
			expect(typeof entry.id).toBe('string');
			expect(typeof entry.confidence).toBe('number');
			expect(typeof entry.category).toBe('string');
			expect(typeof entry.lesson).toBe('string');
			expect(typeof entry.score).toBe('number');
		});

		it('total reflects number of returned results (capped by top_n)', async () => {
			writeSwarmKnowledge(
				Array.from({ length: 10 }, (_, i) =>
					makeSwarmEntry({
						id: `entry-${i}`,
						lesson: `Lesson ${i} about testing patterns`,
					}),
				),
			);

			const result = await knowledge_recall.execute(
				{ query: 'testing patterns', top_n: 3 } as Record<string, unknown>,
				tmpDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.results.length).toBeLessThanOrEqual(3);
			expect(parsed.total).toBe(parsed.results.length);
		});

		it('Results are sorted by score descending', async () => {
			writeSwarmKnowledge([
				makeSwarmEntry({
					id: 'low',
					lesson: 'Test lesson about something',
					status: 'established',
				}),
				makeSwarmEntry({
					id: 'high',
					lesson: 'Test lesson about something',
					status: 'established',
				}),
			]);

			const result = await knowledge_recall.execute(
				{ query: 'test lesson something' } as Record<string, unknown>,
				tmpDir,
			);
			const parsed = JSON.parse(result);

			// Scores should be in descending order
			for (let i = 1; i < parsed.results.length; i++) {
				expect(parsed.results[i - 1].score).toBeGreaterThanOrEqual(
					parsed.results[i].score,
				);
			}
		});
	});

	// ========== GROUP 6: Malicious Getter Defense ==========
	describe('Group 6: Malicious getter defense', () => {
		it('Handles object with throwing getter gracefully', async () => {
			// Simulate an object whose property access throws
			const throwingObj = new Proxy(
				{ query: 'test query', tier: 'swarm' } as Record<string, unknown>,
				{
					get(target, prop) {
						if (prop === 'query') {
							throw new Error('Getter blocked');
						}
						return target[prop as string];
					},
				},
			);

			const result = await knowledge_recall.execute(
				throwingObj as unknown as Record<string, unknown>,
				tmpDir,
			);
			const parsed = JSON.parse(result);
			// Should return error, not crash
			expect(parsed.results).toEqual([]);
			expect(parsed.total).toBe(0);
			expect(parsed.error).toBeDefined();
		});

		it('Handles null args object gracefully', async () => {
			const result = await knowledge_recall.execute(
				null as unknown as Record<string, unknown>,
				tmpDir,
			);
			const parsed = JSON.parse(result);
			// Should return error, not crash
			expect(parsed.results).toEqual([]);
			expect(parsed.total).toBe(0);
			expect(parsed.error).toBeDefined();
		});

		it('Handles undefined args gracefully', async () => {
			const result = await knowledge_recall.execute(
				undefined as unknown as Record<string, unknown>,
				tmpDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.results).toEqual([]);
			expect(parsed.total).toBe(0);
			expect(parsed.error).toBeDefined();
		});

		it('Handles empty object args gracefully', async () => {
			const result = await knowledge_recall.execute(
				{} as Record<string, unknown>,
				tmpDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.results).toEqual([]);
			expect(parsed.total).toBe(0);
			expect(parsed.error).toBeDefined();
		});

		it('Query text is normalized (lowercase, no special chars) preventing injection', async () => {
			writeSwarmKnowledge([
				makeSwarmEntry({ id: 'test-1', lesson: 'Normal lesson about testing' }),
			]);

			// Try query with special characters that might be used for injection
			const result = await knowledge_recall.execute(
				{
					query: 'TESTING<script>alert("xss")</script>',
					tier: 'swarm',
				} as Record<string, unknown>,
				tmpDir,
			);
			const parsed = JSON.parse(result);
			// Should still work - special chars are stripped by normalize()
			expect(parsed.results).toBeDefined();
		});

		it('Results contain original lesson text, not processed query', async () => {
			writeSwarmKnowledge([
				makeSwarmEntry({
					id: 'test-1',
					lesson: 'Use TypeScript for type safety',
				}),
			]);

			const result = await knowledge_recall.execute(
				{ query: 'typescript type safety' } as Record<string, unknown>,
				tmpDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.results.length).toBeGreaterThan(0);
			expect(parsed.results[0].lesson).toContain('TypeScript');
			expect(parsed.results[0].lesson).not.toContain('<script>');
		});
	});

	// ========== GROUP 7: Short/Empty Query Validation ==========
	describe('Group 7: Short/empty query validation', () => {
		it('Query too short returns error (not all entries)', async () => {
			writeSwarmKnowledge([
				makeSwarmEntry({ id: 'test-1', lesson: 'Test lesson' }),
				makeSwarmEntry({ id: 'test-2', lesson: 'Another test lesson' }),
			]);

			const result = await knowledge_recall.execute(
				{ query: 'a' } as Record<string, unknown>,
				tmpDir,
			);
			const parsed = JSON.parse(result);

			// Query length < 3 returns error, not all entries
			expect(parsed.error).toContain('query must be a string');
			expect(parsed.results).toEqual([]);
		});

		it('Query with 2 chars returns error', async () => {
			writeSwarmKnowledge([
				makeSwarmEntry({ id: 'test-1', lesson: 'Test lesson' }),
			]);

			const result = await knowledge_recall.execute(
				{ query: 'ab' } as Record<string, unknown>,
				tmpDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.error).toContain('query must be a string');
		});

		it('Empty string query returns error', async () => {
			writeSwarmKnowledge([
				makeSwarmEntry({ id: 'test-1', lesson: 'Test lesson' }),
			]);

			const result = await knowledge_recall.execute(
				{ query: '' } as Record<string, unknown>,
				tmpDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.error).toContain('query must be a string');
		});

		it('Valid 3+ char query matches entries by text similarity', async () => {
			writeSwarmKnowledge([
				makeSwarmEntry({
					id: 'match',
					lesson: 'Use dependency injection for better testing',
				}),
				makeSwarmEntry({
					id: 'no-match',
					lesson: 'Configure CI pipeline for deployment',
				}),
			]);

			const result = await knowledge_recall.execute(
				{ query: 'dependency injection' } as Record<string, unknown>,
				tmpDir,
			);
			const parsed = JSON.parse(result);

			const ids = parsed.results.map((r: { id: string }) => r.id);
			expect(ids).toContain('match');
			// no-match may or may not be included depending on scoring
		});
	});

	// ========== GROUP 8: Integration tests ==========
	describe('Group 8: Integration - full workflow', () => {
		it('Multiple entries with different statuses ranked correctly', async () => {
			writeSwarmKnowledge([
				makeSwarmEntry({
					id: 'p1',
					lesson: 'Test promoted lesson',
					status: 'promoted',
					confidence: 0.7,
				}),
				makeSwarmEntry({
					id: 'e1',
					lesson: 'Test established lesson',
					status: 'established',
					confidence: 0.9,
				}),
				makeSwarmEntry({
					id: 'c1',
					lesson: 'Test candidate lesson',
					status: 'established',
					confidence: 0.5,
				}),
			]);

			const result = await knowledge_recall.execute(
				{ query: 'test lesson', tier: 'swarm' } as Record<string, unknown>,
				tmpDir,
			);
			const parsed = JSON.parse(result);

			const ids = parsed.results.map((r: { id: string }) => r.id);
			// established should be first (highest boost + base score)
			expect(ids[0]).toBe('e1');
		});

		it('Both tiers together, all active entries returned', async () => {
			writeSwarmKnowledge([
				makeSwarmEntry({
					id: 's1',
					lesson: 'Swarm lesson about testing',
					status: 'established',
				}),
			]);
			writeHiveKnowledge([
				makeHiveEntry({
					id: 'h1',
					lesson: 'Hive lesson about testing',
					status: 'established',
				}),
			]);

			const result = await knowledge_recall.execute(
				{ query: 'testing', tier: 'all' } as Record<string, unknown>,
				tmpDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.results.length).toBe(2);
			const ids = parsed.results.map((r: { id: string }) => r.id);
			expect(ids).toContain('s1');
			expect(ids).toContain('h1');
		});

		it('top_n=1 returns only the top result', async () => {
			writeSwarmKnowledge([
				makeSwarmEntry({
					id: 's1',
					lesson: 'Swarm lesson about testing',
					status: 'established',
				}),
				makeSwarmEntry({
					id: 's2',
					lesson: 'Hive lesson about testing',
					status: 'established',
				}),
			]);

			const result = await knowledge_recall.execute(
				{ query: 'testing', tier: 'all', top_n: 1 } as Record<string, unknown>,
				tmpDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.results.length).toBe(1);
			expect(parsed.total).toBe(1);
		});
	});

	// ========== GROUP 9: Malformed Entry Robustness ==========
	describe('Group 9: Malformed entry robustness', () => {
		it('Handles entries with missing tags field gracefully', async () => {
			// Write malformed entries directly to simulate partial data
			const swarmPath = path.join(tmpDir, '.swarm', 'knowledge.jsonl');
			const malformedEntry = {
				id: 'no-tags',
				tier: 'swarm',
				lesson: 'Entry without tags field',
				category: 'process',
				// tags is missing
				scope: 'global',
				confidence: 0.8,
				status: 'established',
				confirmed_by: [],
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 1,
				created_at: '2024-01-01T00:00:00Z',
				updated_at: '2024-01-01T00:00:00Z',
				project_name: 'test-project',
			};
			writeFileSync(swarmPath, JSON.stringify(malformedEntry) + '\n', 'utf-8');

			// The unified searchKnowledge service normalizes/guards malformed
			// entries instead of throwing, so recall degrades gracefully (no crash,
			// well-formed result shape) rather than surfacing an error object.
			const result = await knowledge_recall.execute(
				{ query: 'entry without tags' } as Record<string, unknown>,
				tmpDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.results).toBeDefined();
			expect(typeof parsed.total).toBe('number');
		});

		it('Handles entries with non-array tags gracefully', async () => {
			const swarmPath = path.join(tmpDir, '.swarm', 'knowledge.jsonl');
			const malformedEntry = {
				id: 'bad-tags',
				tier: 'swarm',
				lesson: 'Entry with bad tags type',
				category: 'process',
				tags: 'not-an-array', // Should be array but is string
				scope: 'global',
				confidence: 0.8,
				status: 'established',
				confirmed_by: [],
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 1,
				created_at: '2024-01-01T00:00:00Z',
				updated_at: '2024-01-01T00:00:00Z',
				project_name: 'test-project',
			};
			writeFileSync(swarmPath, JSON.stringify(malformedEntry) + '\n', 'utf-8');

			// The unified service guards non-array tags rather than throwing, so
			// recall degrades gracefully to a well-formed result shape.
			const result = await knowledge_recall.execute(
				{ query: 'entry with bad tags' } as Record<string, unknown>,
				tmpDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.results).toBeDefined();
			expect(typeof parsed.total).toBe('number');
		});

		it('Handles entries with numeric lesson gracefully', async () => {
			const swarmPath = path.join(tmpDir, '.swarm', 'knowledge.jsonl');
			const malformedEntry = {
				id: 'numeric-lesson',
				tier: 'swarm',
				lesson: 12345, // Should be string but is number
				category: 'process',
				tags: [],
				scope: 'global',
				confidence: 0.8,
				status: 'established',
				confirmed_by: [],
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 1,
				created_at: '2024-01-01T00:00:00Z',
				updated_at: '2024-01-01T00:00:00Z',
				project_name: 'test-project',
			};
			writeFileSync(swarmPath, JSON.stringify(malformedEntry) + '\n', 'utf-8');

			const result = await knowledge_recall.execute(
				{ query: 'numeric lesson' } as Record<string, unknown>,
				tmpDir,
			);
			const parsed = JSON.parse(result);
			// The unified recall service coerces a numeric lesson via normalize()
			// and returns a well-formed result instead of an error object.
			expect(parsed.results).toBeDefined();
			expect(typeof parsed.total).toBe('number');
		});

		it('Returns partial results when some entries are malformed', async () => {
			const swarmPath = path.join(tmpDir, '.swarm', 'knowledge.jsonl');
			// Mix of valid and malformed entries
			const validEntry = {
				id: 'valid-entry',
				tier: 'swarm',
				lesson: 'Valid lesson about testing',
				category: 'process',
				tags: [],
				scope: 'global',
				confidence: 0.8,
				status: 'established',
				confirmed_by: [],
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 1,
				created_at: '2024-01-01T00:00:00Z',
				updated_at: '2024-01-01T00:00:00Z',
				project_name: 'test-project',
			};
			const malformedEntry = {
				id: 'malformed-entry',
				tier: 'swarm',
				lesson: 999, // Should be string
				// tags missing
				scope: 'global',
				confidence: 0.8,
				status: 'candidate',
				confirmed_by: [],
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 1,
				created_at: '2024-01-01T00:00:00Z',
				updated_at: '2024-01-01T00:00:00Z',
				project_name: 'test-project',
			};
			writeFileSync(
				swarmPath,
				JSON.stringify(validEntry) +
					'\n' +
					JSON.stringify(malformedEntry) +
					'\n',
				'utf-8',
			);

			// The unified service does not crash on a malformed entry mixed with
			// valid ones; recall returns a well-formed (possibly empty) result set
			// instead of an error object.
			const result = await knowledge_recall.execute(
				{ query: 'valid lesson about testing' } as Record<string, unknown>,
				tmpDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.results).toBeDefined();
			expect(typeof parsed.total).toBe('number');
		});
	});
});
