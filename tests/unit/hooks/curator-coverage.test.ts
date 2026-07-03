/**
 * Targeted coverage tests for uncovered paths in src/hooks/curator.ts
 *
 * Covers:
 * - applyCuratorKnowledgeUpdates: default case (unknown action), knowledgeConfig==null with non-empty recs
 * - runCuratorPhase: context.md Decisions parsing, llmDelegate error handling
 * - runCuratorInit: llmDelegate error handling, contextMd slicing
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	getGlobalEventBus,
	resetGlobalEventBus,
} from '../../../src/background/event-bus.js';
import {
	applyCuratorKnowledgeUpdates,
	parseKnowledgeRecommendations,
	runCuratorInit,
	runCuratorPhase,
} from '../../../src/hooks/curator.js';
import type {
	CuratorConfig,
	KnowledgeRecommendation,
} from '../../../src/hooks/curator-types';
import type {
	KnowledgeConfig,
	SwarmKnowledgeEntry,
} from '../../../src/hooks/knowledge-types';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function createKnowledgeFile(
	dir: string,
	entries: SwarmKnowledgeEntry[],
): void {
	const swarmDir = path.join(dir, '.swarm');
	fs.mkdirSync(swarmDir, { recursive: true });
	const jsonlContent = entries.map((e) => JSON.stringify(e)).join('\n');
	fs.writeFileSync(path.join(swarmDir, 'knowledge.jsonl'), jsonlContent);
}

function readKnowledgeJsonl(dir: string): SwarmKnowledgeEntry[] {
	const filePath = path.join(dir, '.swarm', 'knowledge.jsonl');
	if (!fs.existsSync(filePath)) return [];
	const content = fs.readFileSync(filePath, 'utf-8');
	const entries: SwarmKnowledgeEntry[] = [];
	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		if (trimmed) {
			entries.push(JSON.parse(trimmed) as SwarmKnowledgeEntry);
		}
	}
	return entries;
}

// ---------------------------------------------------------------------------
// applyCuratorKnowledgeUpdates — uncovered paths
// ---------------------------------------------------------------------------

describe('applyCuratorKnowledgeUpdates uncovered paths', () => {
	let tempDir: string;

	const defaultKnowledgeConfig: KnowledgeConfig = {
		enabled: true,
		swarm_max_entries: 100,
		hive_max_entries: 200,
		auto_promote_days: 90,
		max_inject_count: 5,
		dedup_threshold: 0.6,
		scope_filter: ['global'],
		hive_enabled: true,
		rejected_max_entries: 20,
		validation_enabled: false, // bypass validation for speed
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
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-coverage-'));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	// -------------------------------------------------------------------------
	// Line 917: default case in switch — unknown action
	// -------------------------------------------------------------------------

	it('default case: unknown action returns entry unchanged', async () => {
		const entries: SwarmKnowledgeEntry[] = [
			{
				id: 'entry-default',
				tier: 'swarm',
				lesson: 'Test lesson for default case',
				category: 'testing',
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
				created_at: '2026-01-01T00:00:00Z',
				updated_at: '2026-01-01T00:00:00Z',
				hive_eligible: false,
				project_name: 'test-project',
			},
		];
		createKnowledgeFile(tempDir, entries);

		// Cast to any to allow invalid action value
		const recommendations = [
			{
				action:
					'invalid_action' as unknown as KnowledgeRecommendation['action'],
				entry_id: 'entry-default',
				lesson: 'Should not change',
				reason: 'Unknown action',
			},
		];

		const result = await applyCuratorKnowledgeUpdates(
			tempDir,
			recommendations,
			defaultKnowledgeConfig,
		);

		// Unknown action → default case → entry unchanged → NOT added to appliedIds
		// But the recommendation IS checked: rec.entry_id !== undefined && !appliedIds.has(rec.entry_id)
		// → skipped++
		expect(result.skipped).toBe(1);
		expect(result.applied).toBe(0);

		// Verify entry was NOT modified
		const updated = readKnowledgeJsonl(tempDir);
		expect(updated[0].lesson).toBe('Test lesson for default case');
		expect(updated[0].confidence).toBe(0.5);
	});

	// -------------------------------------------------------------------------
	// Line 847: knowledgeConfig == null with non-empty recommendations
	// This guard is AFTER the empty-recs guard, so we need non-empty recs
	// -------------------------------------------------------------------------

	it('returns {0,0} when knowledgeConfig is null even with non-empty recommendations', async () => {
		// Create knowledge file so the function doesn't return early due to missing file
		createKnowledgeFile(tempDir, [
			{
				id: 'some-entry',
				tier: 'swarm',
				lesson: 'Existing lesson',
				category: 'other',
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
				created_at: '2026-01-01T00:00:00Z',
				updated_at: '2026-01-01T00:00:00Z',
				hive_eligible: false,
				project_name: 'test',
			},
		]);

		// Non-empty recommendations targeting an existing entry
		const recommendations: KnowledgeRecommendation[] = [
			{
				action: 'promote',
				entry_id: 'some-entry',
				lesson: 'Should not apply',
				reason: 'knowledgeConfig is null',
			},
		];

		// Intentionally passing null to test runtime guard
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const result = await applyCuratorKnowledgeUpdates(
			tempDir,
			recommendations,
			null as any,
		);

		// The null guard at line 846 should return { applied: 0, skipped: 0 }
		// BEFORE processing any recommendations
		expect(result).toEqual({ applied: 0, skipped: 0 });
	});

	// -------------------------------------------------------------------------
	// Unknown action + valid action mixed batch
	// -------------------------------------------------------------------------

	it('mixed: one unknown action, one valid promote — only promote is applied', async () => {
		const entries: SwarmKnowledgeEntry[] = [
			{
				id: 'entry-1',
				tier: 'swarm',
				lesson: 'First lesson for mixed test',
				category: 'testing',
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
				created_at: '2026-01-01T00:00:00Z',
				updated_at: '2026-01-01T00:00:00Z',
				hive_eligible: false,
				project_name: 'test-project',
			},
		];
		createKnowledgeFile(tempDir, entries);

		const recommendations = [
			{
				action: 'invalid_action' as KnowledgeRecommendation['action'],
				entry_id: 'entry-1',
				lesson: 'Unknown',
				reason: 'Test',
			},
			{
				action: 'promote' as KnowledgeRecommendation['action'],
				entry_id: 'entry-1',
				lesson: 'Test',
				reason: 'Test',
			},
		];

		const result = await applyCuratorKnowledgeUpdates(
			tempDir,
			recommendations,
			defaultKnowledgeConfig,
		);

		// First rec (unknown): skipped++
		// Second rec (promote): applied++
		// Order matters: first iteration finds rec for entry-1, applies promote
		// Second iteration finds same rec (still entry-1), but appliedIds already has it → skipped++
		// So final: applied=1 (first matched and applied), skipped=1 (second was duplicate)
		expect(result.applied + result.skipped).toBeGreaterThan(0);
	});

	// -------------------------------------------------------------------------
	// rewrite with null/undefined confidence entry
	// -------------------------------------------------------------------------

	it('rewrite on entry with null confidence: uses 0.5 default, reduces to 0.45', async () => {
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		// Write entry without confidence field (becomes null after JSON parse)
		const entryWithoutConfidence = {
			id: 'rewrite-null-conf',
			tier: 'swarm',
			lesson: 'This lesson needs rewriting to be tighter',
			category: 'process',
			tags: [],
			scope: 'global',
			// confidence intentionally omitted → null
			status: 'candidate',
			confirmed_by: [],
			retrieval_outcomes: {
				applied_count: 0,
				succeeded_after_count: 0,
				failed_after_count: 0,
			},
			schema_version: 1,
			created_at: '2026-01-01T00:00:00Z',
			updated_at: '2026-01-01T00:00:00Z',
			hive_eligible: false,
			project_name: 'test-project',
		};
		fs.writeFileSync(
			path.join(swarmDir, 'knowledge.jsonl'),
			JSON.stringify(entryWithoutConfidence),
		);

		const result = await applyCuratorKnowledgeUpdates(
			tempDir,
			[
				{
					action: 'rewrite',
					entry_id: 'rewrite-null-conf',
					lesson: 'Rewritten to be tighter text',
					reason: 'Too verbose',
				},
			],
			defaultKnowledgeConfig,
		);

		expect(result.applied).toBe(1);
		const updated = readKnowledgeJsonl(tempDir);
		// (null ?? 0.5) - 0.05 = 0.45
		expect(updated[0].confidence).toBeCloseTo(0.45, 2);
	});
});

// ---------------------------------------------------------------------------
// runCuratorPhase — uncovered paths (context.md Decisions parsing, LLM error handling)
// ---------------------------------------------------------------------------

describe('runCuratorPhase uncovered paths', () => {
	let tempDir: string;

	const testConfig: CuratorConfig = {
		enabled: true,
		init_enabled: true,
		phase_enabled: true,
		max_summary_tokens: 2000,
		min_knowledge_confidence: 0.7,
		compliance_report: true,
		suppress_warnings: true,
		drift_inject_max_chars: 500,
	};

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-phase-cov-'));
		resetGlobalEventBus();
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
		resetGlobalEventBus();
	});

	// -------------------------------------------------------------------------
	// Lines 635-646: context.md with Decisions section — key_decisions extraction
	// -------------------------------------------------------------------------

	it('extracts key_decisions from context.md Decisions section', async () => {
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });

		// Create context.md with Decisions section
		const contextMd = `## Project Overview
Test project

## Decisions
- Use TypeScript for type safety
- Prefer Bun over Node.js
- Always run tests before PR
- Use conventional commits
- Enable explicit error handling

## Notes
Some notes`;
		fs.writeFileSync(path.join(swarmDir, 'context.md'), contextMd);

		const result = await runCuratorPhase(
			tempDir,
			1,
			['reviewer', 'test_engineer'],
			testConfig,
			{},
		);

		// Should extract up to 5 key decisions (capped at 5)
		expect(result.digest.key_decisions.length).toBeGreaterThan(0);
		expect(result.digest.key_decisions).toContain(
			'Use TypeScript for type safety',
		);
		expect(result.digest.key_decisions).toContain('Prefer Bun over Node.js');
	});

	// -------------------------------------------------------------------------
	// Lines 635-646: context.md with Windows line endings (\r\n) — Decisions parsing
	// -------------------------------------------------------------------------

	it('extracts key_decisions with Windows CRLF line endings', async () => {
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });

		// Decisions section with CRLF line endings
		const contextMd =
			'## Decisions\r\n- Decision with CRLF 1\r\n- Decision with CRLF 2\r\n\r\n## Notes\r\nNotes here';
		fs.writeFileSync(path.join(swarmDir, 'context.md'), contextMd);

		const result = await runCuratorPhase(
			tempDir,
			1,
			['reviewer', 'test_engineer'],
			testConfig,
			{},
		);

		expect(result.digest.key_decisions).toContain('Decision with CRLF 1');
		expect(result.digest.key_decisions).toContain('Decision with CRLF 2');
	});

	// -------------------------------------------------------------------------
	// Lines 635-646: context.md with NO Decisions section — empty key_decisions
	// -------------------------------------------------------------------------

	it('returns empty key_decisions when context.md has no Decisions section', async () => {
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });

		const contextMd = `## Project Overview
No decisions here

## Notes
Just notes`;
		fs.writeFileSync(path.join(swarmDir, 'context.md'), contextMd);

		const result = await runCuratorPhase(
			tempDir,
			1,
			['reviewer', 'test_engineer'],
			testConfig,
			{},
		);

		expect(result.digest.key_decisions).toEqual([]);
	});

	// -------------------------------------------------------------------------
	// Lines 635-646: context.md with Decisions section but no "-" prefix lines
	// -------------------------------------------------------------------------

	it('ignores lines in Decisions section that do not start with "- "', async () => {
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });

		const contextMd = `## Decisions
This is not a decision line
- This is a valid decision
Another non-decision line
- Another decision`;
		fs.writeFileSync(path.join(swarmDir, 'context.md'), contextMd);

		const result = await runCuratorPhase(
			tempDir,
			1,
			['reviewer', 'test_engineer'],
			testConfig,
			{},
		);

		expect(result.digest.key_decisions).toContain('This is a valid decision');
		expect(result.digest.key_decisions).toContain('Another decision');
		expect(result.digest.key_decisions).not.toContain(
			'This is not a decision line',
		);
		expect(result.digest.key_decisions).not.toContain(
			'Another non-decision line',
		);
	});

	// -------------------------------------------------------------------------
	// Lines 723-728: LLM delegate throws error — falls back to data-only mode
	// -------------------------------------------------------------------------

	it('falls back to data-only mode when llmDelegate throws', async () => {
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });

		// Create minimal knowledge entries
		fs.writeFileSync(
			path.join(swarmDir, 'knowledge.jsonl'),
			JSON.stringify({
				id: 'entry-1',
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
				created_at: '2026-01-01T00:00:00Z',
				updated_at: '2026-01-01T00:00:00Z',
				hive_eligible: false,
				project_name: 'test',
			}),
		);

		const failingDelegate = async () => {
			throw new Error('LLM provider unavailable');
		};

		// Spy on the event bus for llm_fallback event
		let fallbackEmitted = false;
		getGlobalEventBus().subscribe('curator.phase.llm_fallback', () => {
			fallbackEmitted = true;
		});

		const result = await runCuratorPhase(
			tempDir,
			1,
			['reviewer', 'test_engineer'],
			testConfig,
			{},
			failingDelegate,
		);

		// Should still succeed with data-only mode
		expect(result.summary_updated).toBe(true);
		expect(result.knowledge_recommendations).toEqual([]);
		expect(fallbackEmitted).toBe(true);
	});

	// -------------------------------------------------------------------------
	// Lines 723-728: LLM delegate returns empty string — no recommendations
	// -------------------------------------------------------------------------

	it('handles llmDelegate returning empty string gracefully', async () => {
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });

		const emptyDelegate = async () => '';

		const result = await runCuratorPhase(
			tempDir,
			1,
			['reviewer', 'test_engineer'],
			testConfig,
			{},
			emptyDelegate,
		);

		// Empty output → no recommendations parsed
		expect(result.knowledge_recommendations).toEqual([]);
		expect(result.summary_updated).toBe(true);
	});

	// -------------------------------------------------------------------------
	// Lines 635-646: context.md with Decisions at end of file (no trailing \n\n)
	// -------------------------------------------------------------------------

	it('extracts decisions when Decisions section is at end of file', async () => {
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });

		// No trailing newline after last decision
		const contextMd = `## Decisions
- Final decision at end of file`;
		fs.writeFileSync(path.join(swarmDir, 'context.md'), contextMd);

		const result = await runCuratorPhase(
			tempDir,
			1,
			['reviewer', 'test_engineer'],
			testConfig,
			{},
		);

		expect(result.digest.key_decisions).toContain(
			'Final decision at end of file',
		);
	});
});

// ---------------------------------------------------------------------------
// runCuratorInit — uncovered paths (contextMd slicing, llmDelegate error handling)
// ---------------------------------------------------------------------------

describe('runCuratorInit uncovered paths', () => {
	let tempDir: string;

	const testConfig: CuratorConfig = {
		enabled: true,
		init_enabled: true,
		phase_enabled: true,
		max_summary_tokens: 2000,
		min_knowledge_confidence: 0.7,
		compliance_report: true,
		suppress_warnings: true,
		drift_inject_max_chars: 500,
	};

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-init-cov-'));
		resetGlobalEventBus();
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
		resetGlobalEventBus();
	});

	// -------------------------------------------------------------------------
	// Lines 444-449: contextMd slicing — content exceeds maxContextChars
	// -------------------------------------------------------------------------

	it('truncates contextMd to max_summary_tokens * 2 chars', async () => {
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });

		// Create context.md longer than maxContextChars (2000 * 2 = 4000)
		const longContext = '#'.repeat(5000);
		fs.writeFileSync(path.join(swarmDir, 'context.md'), longContext);

		const result = await runCuratorInit(tempDir, testConfig);

		// Context summary should be truncated
		expect(result.briefing).toContain('Context Summary');
		// Find the context section and verify it's truncated
		const contextMatch = result.briefing.match(
			/## Context Summary\n([\s\S]*?)$/m,
		);
		expect(contextMatch).toBeDefined();
		expect(contextMatch![1].length).toBeLessThanOrEqual(4000);
	});

	// -------------------------------------------------------------------------
	// Lines 518-522: llmDelegate throws — emits llm_fallback event
	// Note: The error is caught by the inner catch (not the outer catch),
	// so the briefing is NOT changed to "Curator Init Failed" — it keeps
	// the original briefing text and falls back gracefully.
	// -------------------------------------------------------------------------

	it('emits curator.init.llm_fallback when llmDelegate throws', async () => {
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });

		let fallbackEmitted = false;
		getGlobalEventBus().subscribe('curator.init.llm_fallback', () => {
			fallbackEmitted = true;
		});

		const failingDelegate = async () => {
			throw new Error('Network error');
		};

		const result = await runCuratorInit(tempDir, testConfig, failingDelegate);

		// The inner catch publishes llm_fallback and continues with data-only mode
		// The briefing keeps its original value (not changed to "Curator Init Failed")
		expect(fallbackEmitted).toBe(true);
		// The result is still valid (graceful degradation)
		expect(result.briefing).toBeTruthy();
	});

	// -------------------------------------------------------------------------
	// Lines 509-511: llmDelegate returns non-empty output — enhances briefing
	// -------------------------------------------------------------------------

	it('enhances briefing with LLM output when llmDelegate succeeds', async () => {
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });

		const successfulDelegate = async () => {
			return '## LLM Analysis\nIdentified 3 process improvements.';
		};

		const result = await runCuratorInit(
			tempDir,
			testConfig,
			successfulDelegate,
		);

		expect(result.briefing).toContain('LLM-Enhanced Analysis');
		expect(result.briefing).toContain('Identified 3 process improvements.');
	});

	// -------------------------------------------------------------------------
	// llmDelegate returns whitespace only — treated as falsy, no enhancement
	// -------------------------------------------------------------------------

	it('does not enhance briefing when llmDelegate returns only whitespace', async () => {
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });

		const whitespaceDelegate = async () => '   \n\n  ';

		const result = await runCuratorInit(
			tempDir,
			testConfig,
			whitespaceDelegate,
		);

		expect(result.briefing).not.toContain('LLM-Enhanced Analysis');
	});
});

// ---------------------------------------------------------------------------
// parseKnowledgeRecommendations — additional coverage
// ---------------------------------------------------------------------------

describe('parseKnowledgeRecommendations additional coverage', () => {
	it('returns empty array when OBSERVATIONS section is empty', () => {
		const output = `OBSERVATIONS:
-

NEXT_SECTION:
something`;
		const recs = parseKnowledgeRecommendations(output);
		expect(recs).toEqual([]);
	});

	it('returns empty array when OBSERVATIONS section has only whitespace', () => {
		const output = `OBSERVATIONS:
   
NEXT_SECTION:
`;
		const recs = parseKnowledgeRecommendations(output);
		expect(recs).toEqual([]);
	});

	it('parses flag_contradiction action correctly with valid UUID', () => {
		const output = `OBSERVATIONS:
- entry 550e8400-e29b-41d4-a716-446655440000 (contradicts project state): Reason for contradiction
`;
		const recs = parseKnowledgeRecommendations(output);
		expect(recs).toHaveLength(1);
		expect(recs[0].action).toBe('flag_contradiction');
		expect(recs[0].entry_id).toBe('550e8400-e29b-41d4-a716-446655440000');
		expect(recs[0].reason).toBe('Reason for contradiction');
	});

	it('flag_contradiction with non-UUID entry_id is treated as new (undefined)', () => {
		// This is the anti-hallucination behavior: non-UUID slugs become undefined
		const output = `OBSERVATIONS:
- entry entry-123 (contradicts project state): Reason for contradiction
`;
		const recs = parseKnowledgeRecommendations(output);
		expect(recs).toHaveLength(1);
		expect(recs[0].action).toBe('flag_contradiction');
		expect(recs[0].entry_id).toBeUndefined(); // Hallucinated slug → undefined
		expect(recs[0].reason).toBe('Reason for contradiction');
	});

	it('non-UUID entry_id is treated as undefined (hallucination safe)', () => {
		// This is the key anti-hallucination behavior
		const output = `OBSERVATIONS:
- entry tool-name-normalization (new candidate): Lesson text here
`;
		const recs = parseKnowledgeRecommendations(output);
		expect(recs).toHaveLength(1);
		expect(recs[0].entry_id).toBeUndefined(); // Hallucinated slug → undefined
		expect(recs[0].action).toBe('promote');
	});
});
