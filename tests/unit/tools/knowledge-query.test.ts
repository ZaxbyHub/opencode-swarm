/**
 * Verification tests for knowledge_query tool
 * Covers tier filtering, status/category/score filters, formatted output, and architect-only access assumptions
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
import { rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types';
import { knowledge_query } from '../../../src/tools/knowledge-query';

describe('knowledge-query tool verification tests', () => {
	let tmpDir: string;
	let originalCwd: string;

	beforeEach(async () => {
		// Create a temporary directory for each test
		tmpDir = await fs.realpath(
			await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-query-test-')),
		);
		// Ensure .swarm/ directory exists
		await fs.mkdir(path.join(tmpDir, '.swarm'), { recursive: true });
		// Save original cwd and change to tmpDir for tests (createSwarmTool falls back to cwd)
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
	// We only mock resolveHiveKnowledgePath - readKnowledge and resolveSwarmKnowledgePath
	// should remain as real functions so swarm-tier tests work correctly.
	beforeAll(() => {
		mock.module('../../../src/hooks/knowledge-store.js', () => ({
			resolveHiveKnowledgePath: () =>
				path.join(tmpDir, '.swarm', 'shared-learnings.jsonl'),
		}));
	});

	// Helper to write knowledge file
	function writeSwarmKnowledge(entries: SwarmKnowledgeEntry[]): void {
		const swarmPath = path.join(tmpDir, '.swarm', 'knowledge.jsonl');
		writeFileSync(
			swarmPath,
			entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
			'utf-8',
		);
	}

	// ========== GROUP 1: knowledge_query ToolDefinition ==========
	describe('Group 1: knowledge_query ToolDefinition', () => {
		it('knowledge_query is defined (not null/undefined)', () => {
			expect(knowledge_query).toBeDefined();
			expect(knowledge_query).not.toBeNull();
			expect(knowledge_query).not.toBeUndefined();
		});

		it('Has description property (non-empty string)', () => {
			expect(knowledge_query.description).toBeDefined();
			expect(typeof knowledge_query.description).toBe('string');
			expect(knowledge_query.description.length).toBeGreaterThan(0);
		});

		it('Has args property', () => {
			expect(knowledge_query.args).toBeDefined();
			expect(typeof knowledge_query.args).toBe('object');
		});

		it('Has execute function', () => {
			expect(knowledge_query.execute).toBeDefined();
			expect(typeof knowledge_query.execute).toBe('function');
		});

		it('Description mentions tier and hive', () => {
			expect(knowledge_query.description.toLowerCase()).toContain('tier');
			expect(knowledge_query.description.toLowerCase()).toContain('hive');
		});

		it('Description mentions formatted output', () => {
			expect(knowledge_query.description.toLowerCase()).toContain('format');
		});

		it('Description mentions filter options', () => {
			expect(knowledge_query.description.toLowerCase()).toContain('filter');
		});
	});

	// ========== GROUP 2: Tier filtering ==========
	describe('Group 2: Tier filtering', () => {
		it('Returns no results message when no knowledge files exist', async () => {
			// Don't create any knowledge files - explicitly test empty directory
			const result = await knowledge_query.execute({ tier: 'swarm' });
			expect(result).toContain("No knowledge entries found for tier 'swarm'");
		});

		it('Returns results from swarm knowledge.jsonl when it exists', async () => {
			const swarmData: SwarmKnowledgeEntry = {
				id: 'swarm-test-1',
				tier: 'swarm',
				lesson: 'Test swarm lesson',
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
			writeSwarmKnowledge([swarmData]);

			const result = await knowledge_query.execute({ tier: 'swarm' });

			expect(result).toContain('[SWARM]');
			expect(result).toContain('swarm-test-1');
			expect(result).toContain('Test swarm lesson');
		});

		it('Returns swarm-tier formatted output correctly', async () => {
			const swarmData: SwarmKnowledgeEntry = {
				id: 'swarm-uuid-123',
				tier: 'swarm',
				lesson: 'Always validate user input',
				category: 'security',
				tags: ['validation', 'security'],
				scope: 'global',
				confidence: 0.85,
				status: 'established',
				confirmed_by: [
					{
						phase_number: 1,
						confirmed_at: '2024-01-01T00:00:00Z',
						project_name: 'project-a',
					},
					{
						phase_number: 3,
						confirmed_at: '2024-02-01T00:00:00Z',
						project_name: 'project-b',
					},
				],
				retrieval_outcomes: {
					applied_count: 5,
					succeeded_after_count: 4,
					failed_after_count: 1,
				},
				schema_version: 1,
				created_at: '2024-01-01T00:00:00Z',
				updated_at: '2024-01-01T00:00:00Z',
				project_name: 'my-project',
			};
			writeSwarmKnowledge([swarmData]);

			const result = await knowledge_query.execute({ tier: 'swarm' });

			expect(result).toContain('[SWARM] swarm-uuid-123');
			expect(result).toContain('Lesson: Always validate user input');
			expect(result).toContain('Category: security');
			expect(result).toContain('Status: established');
			expect(result).toContain('Confidence: 0.85');
			expect(result).toContain('Confirmed by: 2 phase(s)');
			expect(result).toContain('Project: my-project');
		});

		it('Handles tier filter for hive only (no hive file)', async () => {
			const result = await knowledge_query.execute({ tier: 'hive' });
			expect(result).toContain("No knowledge entries found for tier 'hive'");
		});

		it('Normalizes tier input to lowercase', async () => {
			const swarmData: SwarmKnowledgeEntry = {
				id: 'test-id',
				tier: 'swarm',
				lesson: 'Test',
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
				project_name: 'test',
			};
			writeSwarmKnowledge([swarmData]);

			// Use uppercase tier
			const result = await knowledge_query.execute({ tier: 'SWARM' });

			expect(result).toContain('test-id');
		});
	});

	// ========== GROUP 3: Status filtering ==========
	describe('Group 3: Status filtering', () => {
		it('Applies status filter correctly - returns only matching status', async () => {
			const swarmData1: SwarmKnowledgeEntry = {
				id: 'entry-1',
				tier: 'swarm',
				lesson: 'Candidate lesson',
				category: 'process',
				tags: [],
				scope: 'global',
				confidence: 0.5,
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
			const swarmData2: SwarmKnowledgeEntry = {
				id: 'entry-2',
				tier: 'swarm',
				lesson: 'Established lesson',
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
			writeSwarmKnowledge([swarmData1, swarmData2]);

			const result = await knowledge_query.execute({
				tier: 'swarm',
				status: 'established',
			});

			expect(result).toContain('entry-2');
			expect(result).not.toContain('entry-1');
		});

		it('Applies promoted status filter correctly', async () => {
			const swarmData: SwarmKnowledgeEntry = {
				id: 'promoted-entry',
				tier: 'swarm',
				lesson: 'Promoted lesson',
				category: 'process',
				tags: [],
				scope: 'global',
				confidence: 0.95,
				status: 'promoted',
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
			writeSwarmKnowledge([swarmData]);

			const result = await knowledge_query.execute({
				tier: 'swarm',
				status: 'promoted',
			});

			expect(result).toContain('promoted-entry');
			expect(result).toContain('Status filter: promoted');
		});

		it('Normalizes status input to lowercase', async () => {
			const swarmData: SwarmKnowledgeEntry = {
				id: 'test-status',
				tier: 'swarm',
				lesson: 'Test',
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
				project_name: 'test',
			};
			writeSwarmKnowledge([swarmData]);

			const result = await knowledge_query.execute({
				tier: 'swarm',
				status: 'ESTABLISHED',
			});

			expect(result).toContain('test-status');
			expect(result).toContain('Status filter: established');
		});

		it('Status filter included in output message', async () => {
			// No files - query for a status that won't match anything
			const result = await knowledge_query.execute({
				tier: 'swarm',
				status: 'established',
			});

			// When no results, filter info is in the "No knowledge entries" message
			expect(result).toContain('status=established');
		});
	});

	// ========== GROUP 4: Category filtering ==========
	describe('Group 4: Category filtering', () => {
		it('Applies category filter correctly', async () => {
			const swarmData1: SwarmKnowledgeEntry = {
				id: 'entry-security',
				tier: 'swarm',
				lesson: 'Security lesson',
				category: 'security',
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
				project_name: 'test-project',
			};
			const swarmData2: SwarmKnowledgeEntry = {
				id: 'entry-process',
				tier: 'swarm',
				lesson: 'Process lesson',
				category: 'process',
				tags: [],
				scope: 'global',
				confidence: 0.9,
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
			writeSwarmKnowledge([swarmData1, swarmData2]);

			const result = await knowledge_query.execute({
				tier: 'swarm',
				category: 'security',
			});

			expect(result).toContain('entry-security');
			expect(result).not.toContain('entry-process');
		});

		it('Applies all valid categories correctly', async () => {
			const categories = [
				'process',
				'architecture',
				'tooling',
				'security',
				'testing',
				'debugging',
				'performance',
				'integration',
				'todo',
				'other',
			] as const;

			for (const cat of categories) {
				const swarmData: SwarmKnowledgeEntry = {
					id: `entry-${cat}`,
					tier: 'swarm',
					lesson: `${cat} lesson`,
					category: cat,
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
				writeSwarmKnowledge([swarmData]);

				const result = await knowledge_query.execute({
					tier: 'swarm',
					category: cat,
				});

				expect(result).toContain(`entry-${cat}`);
				expect(result).toContain(`Category filter: ${cat}`);
			}
		});

		it('Normalizes category input to lowercase', async () => {
			const swarmData: SwarmKnowledgeEntry = {
				id: 'test-cat',
				tier: 'swarm',
				lesson: 'Test',
				category: 'security',
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
				project_name: 'test',
			};
			writeSwarmKnowledge([swarmData]);

			const result = await knowledge_query.execute({
				tier: 'swarm',
				category: 'SECURITY',
			});

			expect(result).toContain('test-cat');
		});

		it('Category filter included in output message', async () => {
			const result = await knowledge_query.execute({
				tier: 'swarm',
				category: 'security',
			});

			// When no results, filter info is in the "No knowledge entries" message
			expect(result).toContain('category=security');
		});
	});

	// ========== GROUP 5: Score filtering (min_score) ==========
	describe('Group 5: Score filtering (min_score)', () => {
		it('Applies min_score filter correctly - returns entries with confidence >= min_score', async () => {
			const swarmData1: SwarmKnowledgeEntry = {
				id: 'entry-low',
				tier: 'swarm',
				lesson: 'Low confidence',
				category: 'process',
				tags: [],
				scope: 'global',
				confidence: 0.3,
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
			const swarmData2: SwarmKnowledgeEntry = {
				id: 'entry-high',
				tier: 'swarm',
				lesson: 'High confidence',
				category: 'process',
				tags: [],
				scope: 'global',
				confidence: 0.9,
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
			writeSwarmKnowledge([swarmData1, swarmData2]);

			const result = await knowledge_query.execute({
				tier: 'swarm',
				min_score: 0.5,
			});

			expect(result).toContain('entry-high');
			expect(result).not.toContain('entry-low');
		});

		it('Applies min_score 0.0 to return all entries', async () => {
			const swarmData1: SwarmKnowledgeEntry = {
				id: 'entry-1',
				tier: 'swarm',
				lesson: 'Low confidence',
				category: 'process',
				tags: [],
				scope: 'global',
				confidence: 0.1,
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
			const swarmData2: SwarmKnowledgeEntry = {
				id: 'entry-2',
				tier: 'swarm',
				lesson: 'High confidence',
				category: 'process',
				tags: [],
				scope: 'global',
				confidence: 0.9,
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
			writeSwarmKnowledge([swarmData1, swarmData2]);

			const result = await knowledge_query.execute({
				tier: 'swarm',
				min_score: 0.0,
			});

			expect(result).toContain('entry-1');
			expect(result).toContain('entry-2');
		});

		it('Applies min_score 1.0 to return only perfect confidence entries', async () => {
			const swarmData1: SwarmKnowledgeEntry = {
				id: 'entry-imperfect',
				tier: 'swarm',
				lesson: 'Almost perfect',
				category: 'process',
				tags: [],
				scope: 'global',
				confidence: 0.99,
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
			const swarmData2: SwarmKnowledgeEntry = {
				id: 'entry-perfect',
				tier: 'swarm',
				lesson: 'Perfect confidence',
				category: 'process',
				tags: [],
				scope: 'global',
				confidence: 1.0,
				status: 'promoted',
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
			writeSwarmKnowledge([swarmData1, swarmData2]);

			const result = await knowledge_query.execute({
				tier: 'swarm',
				min_score: 1.0,
			});

			expect(result).toContain('entry-perfect');
			expect(result).not.toContain('entry-imperfect');
		});

		it('Min score filter included in output message', async () => {
			const result = await knowledge_query.execute({
				tier: 'swarm',
				min_score: 0.7,
			});

			// When no results, filter info is in the "No knowledge entries" message
			expect(result).toContain('min_score=0.7');
		});
	});

	// ========== GROUP 6: Limit handling ==========
	describe('Group 6: Limit handling', () => {
		it('Applies limit correctly', async () => {
			const entries: SwarmKnowledgeEntry[] = Array.from(
				{ length: 20 },
				(_, i) => ({
					id: `entry-${i}`,
					tier: 'swarm' as const,
					lesson: `Lesson ${i}`,
					category: 'process' as const,
					tags: [],
					scope: 'global',
					confidence: 0.8,
					status: 'established' as const,
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
				}),
			);
			writeSwarmKnowledge(entries);

			const result = await knowledge_query.execute({ tier: 'swarm', limit: 5 });

			// Should show only 5 entries but indicate total
			expect(result).toContain('5 of 20 shown');
			expect(result).toContain('Limit: 5');
		});

		it('Default limit is 10', async () => {
			const entries: SwarmKnowledgeEntry[] = Array.from(
				{ length: 15 },
				(_, i) => ({
					id: `entry-${i}`,
					tier: 'swarm' as const,
					lesson: `Lesson ${i}`,
					category: 'process' as const,
					tags: [],
					scope: 'global',
					confidence: 0.8,
					status: 'established' as const,
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
				}),
			);
			writeSwarmKnowledge(entries);

			const result = await knowledge_query.execute({ tier: 'swarm' });

			// Default limit is 10
			expect(result).toContain('10 of 15 shown');
			expect(result).toContain('Limit: 10');
		});

		it('Limit is capped at 100', async () => {
			const entries: SwarmKnowledgeEntry[] = Array.from(
				{ length: 150 },
				(_, i) => ({
					id: `entry-${i}`,
					tier: 'swarm' as const,
					lesson: `Lesson ${i}`,
					category: 'process' as const,
					tags: [],
					scope: 'global',
					confidence: 0.8,
					status: 'established' as const,
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
				}),
			);
			writeSwarmKnowledge(entries);

			const result = await knowledge_query.execute({
				tier: 'swarm',
				limit: 150,
			});

			// Should be capped at 100
			expect(result).toContain('100 of 150 shown');
		});
	});

	// ========== GROUP 7: Combined filters ==========
	describe('Group 7: Combined filters', () => {
		it('Multiple filters combine correctly (AND logic)', async () => {
			const entries: SwarmKnowledgeEntry[] = [
				{
					id: 'match-all',
					tier: 'swarm',
					lesson: 'Matches all',
					category: 'security',
					tags: [],
					scope: 'global',
					confidence: 0.9,
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
				},
				{
					id: 'wrong-status',
					tier: 'swarm',
					lesson: 'Wrong status',
					category: 'security',
					tags: [],
					scope: 'global',
					confidence: 0.9,
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
				},
				{
					id: 'wrong-category',
					tier: 'swarm',
					lesson: 'Wrong category',
					category: 'process',
					tags: [],
					scope: 'global',
					confidence: 0.9,
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
				},
				{
					id: 'wrong-score',
					tier: 'swarm',
					lesson: 'Wrong score',
					category: 'security',
					tags: [],
					scope: 'global',
					confidence: 0.3,
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
				},
			];
			writeSwarmKnowledge(entries);

			const result = await knowledge_query.execute({
				tier: 'swarm',
				status: 'established',
				category: 'security',
				min_score: 0.5,
			});

			expect(result).toContain('match-all');
			expect(result).not.toContain('wrong-status');
			expect(result).not.toContain('wrong-category');
			expect(result).not.toContain('wrong-score');
		});

		it('All filter information included in output message', async () => {
			const result = await knowledge_query.execute({
				tier: 'swarm',
				status: 'established',
				category: 'security',
				min_score: 0.7,
			});

			// When no results, filter info is in the "No knowledge entries" message
			expect(result).toContain('status=established');
			expect(result).toContain('category=security');
			expect(result).toContain('min_score=0.7');
		});
	});

	// ========== GROUP 8: Formatted output ==========
	describe('Group 8: Formatted output', () => {
		it('Output includes results header', async () => {
			const swarmData: SwarmKnowledgeEntry = {
				id: 'test-output',
				tier: 'swarm',
				lesson: 'Test lesson',
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
				project_name: 'test',
			};
			writeSwarmKnowledge([swarmData]);

			const result = await knowledge_query.execute({ tier: 'swarm' });

			expect(result).toContain('=== Knowledge Query Results');
		});

		it('Output includes summary section', async () => {
			const swarmData: SwarmKnowledgeEntry = {
				id: 'summary-test',
				tier: 'swarm',
				lesson: 'Test',
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
				project_name: 'test',
			};
			writeSwarmKnowledge([swarmData]);

			const result = await knowledge_query.execute({ tier: 'swarm' });

			expect(result).toContain('---');
			expect(result).toContain('Total matched:');
			expect(result).toContain('Tier:');
			expect(result).toContain('Limit:');
		});

		it('Output shows correct count when under limit', async () => {
			const entries: SwarmKnowledgeEntry[] = Array.from(
				{ length: 3 },
				(_, i) => ({
					id: `entry-${i}`,
					tier: 'swarm' as const,
					lesson: `Lesson ${i}`,
					category: 'process' as const,
					tags: [],
					scope: 'global',
					confidence: 0.8,
					status: 'established' as const,
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
				}),
			);
			writeSwarmKnowledge(entries);

			const result = await knowledge_query.execute({
				tier: 'swarm',
				limit: 10,
			});

			// Should show "3 of 3 shown" when under limit
			expect(result).toContain('3 of 3 shown');
		});

		it('Long lessons are truncated in output', async () => {
			const longLesson = 'A'.repeat(300);
			const swarmData: SwarmKnowledgeEntry = {
				id: 'long-lesson',
				tier: 'swarm',
				lesson: longLesson,
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
				project_name: 'test',
			};
			writeSwarmKnowledge([swarmData]);

			const result = await knowledge_query.execute({ tier: 'swarm' });

			// Should contain truncated lesson (max 200 chars)
			expect(result).toContain('...');
		});

		it('Hive tier returns no results when no hive file exists', async () => {
			const result = await knowledge_query.execute({ tier: 'hive' });
			expect(result).toContain("No knowledge entries found for tier 'hive'");
		});
	});

	// ========== GROUP 9: Architect-only access assumptions ==========
	describe('Group 9: Architect-only access assumptions', () => {
		it('Tool is available in the tool registry', () => {
			// This verifies the tool is properly exported and registered
			expect(knowledge_query).toBeDefined();
		});

		it('Execute function accepts args (architect context)', async () => {
			// The execute function is architect-specific
			expect(knowledge_query.execute).toBeDefined();
			// Should work with args - uses process.cwd() as fallback
			const result = await knowledge_query.execute({ tier: 'swarm' });
			expect(typeof result).toBe('string');
		});

		it('Tool reads from .swarm/ directory (project-specific knowledge)', async () => {
			const swarmData: SwarmKnowledgeEntry = {
				id: 'project-knowledge',
				tier: 'swarm',
				lesson: 'Project specific lesson',
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
			writeSwarmKnowledge([swarmData]);

			const result = await knowledge_query.execute({ tier: 'swarm' });

			// The tool reads from the provided directory's .swarm/ subdirectory
			expect(result).toContain('project-knowledge');
		});

		it('Tool can access hive (global/shared) knowledge', async () => {
			// Hive knowledge is read from a global location, not project-specific
			// When no hive file exists, it returns empty results
			const result = await knowledge_query.execute({ tier: 'hive' });
			// This verifies the tool attempts to read hive knowledge
			expect(result).toContain("No knowledge entries found for tier 'hive'");
		});
	});
});
