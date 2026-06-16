/**
 * Verification tests for knowledge_add tool
 * Covers valid lesson creation, validation errors, near-duplicate detection, and auto_generated flag
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { knowledge_add } from '../../../src/tools/knowledge-add';

describe('knowledge_add tool verification tests', () => {
	let tmpDir: string;
	let originalCwd: string;

	beforeEach(async () => {
		// Create a temporary directory for each test
		tmpDir = await fs.realpath(
			await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-add-test-')),
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
	});

	// Helper to read knowledge.jsonl and parse entries
	function readKnowledgeEntries(): Array<Record<string, unknown>> {
		const knowledgePath = path.join(tmpDir, '.swarm', 'knowledge.jsonl');
		try {
			const content = readFileSync(knowledgePath, 'utf-8');
			return content
				.trim()
				.split('\n')
				.filter((line) => line.length > 0)
				.map((line) => JSON.parse(line));
		} catch {
			return [];
		}
	}

	// Change 4 (Layer-5 actionability gate): a lesson only becomes ACTIVE when it
	// carries >=1 predicate field AND >=1 scope field. Success-path tests supply
	// these via the spread below; the quarantine path has its own describe block.
	const V3_FIELDS = {
		applies_to_agents: ['coder'],
		required_actions: ['apply this lesson when relevant'],
	};

	// ========== Test 1: Valid lesson is created ==========
	describe('Valid lesson is created', () => {
		it('Returns success=true and includes an id for valid lesson', async () => {
			const result = await knowledge_add.execute(
				{
					lesson: 'This is a valid lesson with more than fifteen characters',
					category: 'process',
					...V3_FIELDS,
					tags: ['testing', 'validation'],
				},
				tmpDir,
			);

			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.id).toBeDefined();
			expect(typeof parsed.id).toBe('string');
			expect(parsed.id.length).toBeGreaterThan(0);
			expect(parsed.category).toBe('process');
		});

		it('Lesson is stored in knowledge.jsonl', async () => {
			const lessonText =
				'Lesson text that is definitely longer than fifteen chars';
			const result = await knowledge_add.execute(
				{
					lesson: lessonText,
					category: 'security',
					...V3_FIELDS,
					tags: ['auth', 'security'],
				},
				tmpDir,
			);

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);

			const entries = readKnowledgeEntries();
			expect(entries).toHaveLength(1);
			expect(entries[0].lesson).toBe(lessonText);
			expect(entries[0].category).toBe('security');
			expect(entries[0].tags).toEqual(['auth', 'security']);
		});

		it('Entry has correct structure with all required fields', async () => {
			await knowledge_add.execute(
				{
					lesson: 'A properly formed lesson entry with sufficient length',
					category: 'tooling',
					...V3_FIELDS,
					tags: ['eslint', 'linting'],
					scope: 'global',
				},
				tmpDir,
			);

			const entries = readKnowledgeEntries();
			expect(entries).toHaveLength(1);

			const entry = entries[0];
			expect(entry.id).toBeDefined();
			expect(entry.tier).toBe('swarm');
			expect(entry.lesson).toBe(
				'A properly formed lesson entry with sufficient length',
			);
			expect(entry.category).toBe('tooling');
			expect(entry.tags).toEqual(['eslint', 'linting']);
			expect(entry.scope).toBe('global');
			expect(entry.confidence).toBe(0.5);
			expect(entry.status).toBe('candidate');
			expect(entry.confirmed_by).toEqual([]);
			expect(entry.schema_version).toBe(1);
			expect(entry.created_at).toBeDefined();
			expect(entry.updated_at).toBeDefined();
		});
	});

	// ========== Test 2: Short lesson rejected ==========
	describe('Short lesson rejected', () => {
		it('Rejects lesson with less than 15 characters', async () => {
			const result = await knowledge_add.execute(
				{
					lesson: 'too short',
					category: 'process',
					...V3_FIELDS,
				},
				tmpDir,
			);

			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('15');
			expect(parsed.error).toContain('280');
		});

		it('Rejects empty string lesson', async () => {
			const result = await knowledge_add.execute(
				{
					lesson: '',
					category: 'process',
					...V3_FIELDS,
				},
				tmpDir,
			);

			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
		});

		it('Rejects lesson with exactly 14 characters', async () => {
			const result = await knowledge_add.execute(
				{
					lesson: '12345678901234', // 14 chars
					category: 'process',
					...V3_FIELDS,
				},
				tmpDir,
			);

			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
		});

		it('Accepts lesson with exactly 15 characters', async () => {
			const result = await knowledge_add.execute(
				{
					lesson: '123456789012345', // 15 chars
					category: 'process',
					...V3_FIELDS,
				},
				tmpDir,
			);

			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
		});
	});

	// ========== Test 3: Invalid category rejected ==========
	describe('Invalid category rejected', () => {
		it('Rejects invalid category string', async () => {
			const result = await knowledge_add.execute(
				{
					lesson: 'A valid length lesson text for testing purposes here',
					category: 'invalid_category',
				},
				tmpDir,
			);

			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('category');
		});

		it('Rejects empty category', async () => {
			const result = await knowledge_add.execute(
				{
					lesson: 'A valid length lesson text for testing purposes here',
					category: '',
				},
				tmpDir,
			);

			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
		});

		it('Accepts all valid categories', async () => {
			const lessonsByCategory: Array<{ category: string; lesson: string }> = [
				{
					category: 'process',
					lesson: 'Follow consistent code review workflows across the team',
				},
				{
					category: 'architecture',
					lesson: 'Use hexagonal architecture patterns for domain isolation',
				},
				{
					category: 'tooling',
					lesson: 'Configure biome with strict import sorting rules',
				},
				{
					category: 'security',
					lesson: 'Sanitize all user input before database queries',
				},
				{
					category: 'testing',
					lesson: 'Write integration tests for critical data flows',
				},
				{
					category: 'debugging',
					lesson: 'Use structured logging with correlation IDs for tracing',
				},
				{
					category: 'performance',
					lesson: 'Profile database queries before adding new indexes',
				},
				{
					category: 'integration',
					lesson: 'Use contract testing between microservice boundaries',
				},
				{
					category: 'todo',
					lesson:
						'Remember to add error handling to the payment flow before release',
				},
				{
					category: 'other',
					lesson: 'Commit messages should reference ticket numbers',
				},
			];

			for (const { category, lesson } of lessonsByCategory) {
				const result = await knowledge_add.execute(
					{
						lesson,
						category,
						...V3_FIELDS,
					},
					tmpDir,
				);

				const parsed = JSON.parse(result);
				expect(parsed.success).toBe(true);
				expect(parsed.category).toBe(category);
			}

			// Verify all 10 entries were stored (none rejected as near-duplicates)
			const entries = readKnowledgeEntries();
			expect(entries).toHaveLength(10);
		});
	});

	// ========== Test 4: Near-duplicate reinforces existing ID ==========
	describe('Near-duplicate reinforces existing ID', () => {
		it('returns existing ID and reinforces when adding near-duplicate lesson', async () => {
			// First add a valid lesson
			const firstResult = await knowledge_add.execute(
				{
					lesson: 'Always validate user input before processing',
					category: 'security',
					...V3_FIELDS,
					tags: ['validation', 'security'],
				},
				tmpDir,
			);

			const firstParsed = JSON.parse(firstResult);
			expect(firstParsed.success).toBe(true);
			const firstId = firstParsed.id;

			// Try to add a near-duplicate (very similar text)
			const duplicateResult = await knowledge_add.execute(
				{
					lesson: 'Always validate user input before processing in the system',
					category: 'security',
					...V3_FIELDS,
					tags: ['validation'],
				},
				tmpDir,
			);

			const duplicateParsed = JSON.parse(duplicateResult);

			expect(duplicateParsed.success).toBe(true);
			expect(duplicateParsed.id).toBe(firstId);
			expect(duplicateParsed.reinforced).toBe(true);
			expect(duplicateParsed.message).toContain('duplicate');

			const entries = readKnowledgeEntries();
			expect(entries).toHaveLength(1);
			expect(entries[0].confirmed_by).toEqual([
				expect.objectContaining({
					phase_number: 1,
					project_name: '',
				}),
			]);
			expect(entries[0].confidence).toBe(0.7);
		});

		it('Adds a sufficiently different lesson successfully', async () => {
			// First add a valid lesson
			const firstResult = await knowledge_add.execute(
				{
					lesson: 'Use TypeScript for better type safety',
					category: 'tooling',
					...V3_FIELDS,
				},
				tmpDir,
			);

			const firstParsed = JSON.parse(firstResult);
			expect(firstParsed.success).toBe(true);

			// Add a different lesson
			const secondResult = await knowledge_add.execute(
				{
					lesson: 'Write unit tests to catch regressions early',
					category: 'testing',
					...V3_FIELDS,
				},
				tmpDir,
			);

			const secondParsed = JSON.parse(secondResult);
			expect(secondParsed.success).toBe(true);
			expect(secondParsed.id).not.toBe(firstParsed.id);
		});

		it('Only one entry exists after near-duplicate is reinforced', async () => {
			// First add a valid lesson
			await knowledge_add.execute(
				{
					lesson: 'Always validate user inputs before processing them',
					category: 'security',
					...V3_FIELDS,
				},
				tmpDir,
			);

			// Try to add exact duplicate (Jaccard = 1.0, well above 0.6 threshold)
			await knowledge_add.execute(
				{
					lesson: 'Always validate user inputs before processing them',
					category: 'security',
					...V3_FIELDS,
				},
				tmpDir,
			);

			const entries = readKnowledgeEntries();
			expect(entries).toHaveLength(1);
		});

		it('does not append duplicate confirmations when re-adding in the same phase', async () => {
			const firstResult = await knowledge_add.execute(
				{
					lesson: 'Always validate user inputs before processing them',
					category: 'security',
					...V3_FIELDS,
				},
				tmpDir,
			);
			const firstId = JSON.parse(firstResult).id;

			await knowledge_add.execute(
				{
					lesson: 'Always validate user inputs before processing them',
					category: 'security',
					...V3_FIELDS,
				},
				tmpDir,
			);
			const duplicateResult = await knowledge_add.execute(
				{
					lesson: 'Always validate user inputs before processing them',
					category: 'security',
					...V3_FIELDS,
				},
				tmpDir,
			);
			const duplicateParsed = JSON.parse(duplicateResult);

			expect(duplicateParsed.success).toBe(true);
			expect(duplicateParsed.id).toBe(firstId);
			expect(duplicateParsed.reinforced).toBe(false);
			expect(duplicateParsed.idempotent).toBe(true);

			const entries = readKnowledgeEntries();
			expect(entries).toHaveLength(1);
			expect(entries[0].confirmed_by).toHaveLength(1);
		});

		it('does not reinforce or mutate inactive near-duplicate entries', async () => {
			const knowledgePath = path.join(tmpDir, '.swarm', 'knowledge.jsonl');
			const archivedEntry = {
				id: 'archived-id',
				tier: 'swarm',
				lesson: 'Always validate user input before processing',
				category: 'security',
				tags: ['validation'],
				scope: 'global',
				confidence: 0.7,
				status: 'archived',
				confirmed_by: [
					{
						phase_number: 1,
						confirmed_at: '2026-01-01T00:00:00.000Z',
						project_name: '',
					},
				],
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 2,
				created_at: '2026-01-01T00:00:00.000Z',
				updated_at: '2026-01-01T00:00:00.000Z',
				project_name: '',
				auto_generated: false,
				phases_alive: 9,
			};
			await fs.writeFile(knowledgePath, `${JSON.stringify(archivedEntry)}\n`);

			const result = await knowledge_add.execute(
				{
					lesson: 'Always validate user input before processing in the system',
					category: 'security',
					...V3_FIELDS,
				},
				tmpDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.id).toBe('archived-id');
			expect(parsed.message).toBe('near-duplicate of inactive existing entry');

			const entries = readKnowledgeEntries();
			expect(entries).toHaveLength(1);
			expect(entries[0].status).toBe('archived');
			expect(entries[0].confirmed_by).toHaveLength(1);
			expect(entries[0].phases_alive).toBe(9);
		});
	});

	// ========== Test 5: auto_generated is false ==========
	describe('auto_generated is false', () => {
		it('Stores entry with auto_generated set to false', async () => {
			await knowledge_add.execute(
				{
					lesson: 'Manual knowledge entries should have auto_generated false',
					category: 'process',
					...V3_FIELDS,
					tags: ['manual', 'test'],
				},
				tmpDir,
			);

			const entries = readKnowledgeEntries();
			expect(entries).toHaveLength(1);
			expect(entries[0].auto_generated).toBe(false);
		});

		it('auto_generated is explicitly false (not undefined or null)', async () => {
			await knowledge_add.execute(
				{
					lesson: 'Explicitly false auto_generated should be stored correctly',
					category: 'architecture',
					...V3_FIELDS,
				},
				tmpDir,
			);

			const entries = readKnowledgeEntries();
			expect(entries).toHaveLength(1);
			// Verify it's explicitly false, not just falsy
			expect(entries[0].auto_generated).toBe(false);
			expect(typeof entries[0].auto_generated).toBe('boolean');
		});

		it('hive_eligible is also set to false', async () => {
			await knowledge_add.execute(
				{
					lesson: 'Both auto_generated and hive_eligible should be false',
					category: 'tooling',
					...V3_FIELDS,
				},
				tmpDir,
			);

			const entries = readKnowledgeEntries();
			expect(entries).toHaveLength(1);
			expect(entries[0].auto_generated).toBe(false);
			expect(entries[0].hive_eligible).toBe(false);
		});
	});

	// ========== Change 4: Layer-5 actionability gate ==========
	describe('Layer-5 actionability gate (Change 4)', () => {
		function readUnactionable(): Array<Record<string, unknown>> {
			const p = path.join(tmpDir, '.swarm', 'knowledge-unactionable.jsonl');
			try {
				const content = readFileSync(p, 'utf-8');
				return content
					.trim()
					.split('\n')
					.filter((line) => line.length > 0)
					.map((line) => JSON.parse(line));
			} catch {
				return [];
			}
		}

		it('quarantines a lesson without predicate+scope fields (not stored, queued, hint returned)', async () => {
			const result = await knowledge_add.execute(
				{
					lesson: 'A prose lesson without any actionability fields at all',
					category: 'process',
				},
				tmpDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.quarantined).toBe(true);
			expect(parsed.hint).toContain('applies_to_agents');

			// Not in the active store; preserved in the unactionable queue.
			expect(readKnowledgeEntries()).toHaveLength(0);
			const queued = readUnactionable();
			expect(queued).toHaveLength(1);
			expect(queued[0].status).toBe('quarantined_unactionable');
		});

		it('does NOT quarantine when predicate + scope are provided (control)', async () => {
			const result = await knowledge_add.execute(
				{
					lesson: 'A lesson that carries full actionability metadata fields',
					category: 'process',
					applies_to_tools: ['edit'],
					forbidden_actions: ['edit generated files directly'],
				},
				tmpDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
			expect(readKnowledgeEntries()).toHaveLength(1);
			expect(readUnactionable()).toHaveLength(0);
		});

		it('rejects malformed actionability fields (shape validation)', async () => {
			const result = await knowledge_add.execute(
				{
					lesson:
						'A lesson with a malformed agents field that must be rejected',
					category: 'process',
					applies_to_agents: ['not a valid agent name!!!'],
					required_actions: ['do the thing'],
				},
				tmpDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(String(parsed.error)).toContain('actionability');
			expect(readKnowledgeEntries()).toHaveLength(0);
		});
	});
});
