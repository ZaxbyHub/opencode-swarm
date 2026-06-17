/**
 * Integration test: full skill-feedback learning loop pipeline.
 *
 * Verifies the complete learning cycle:
 *   1. Seed mature knowledge entries in .swarm/knowledge.jsonl
 *   2. Generate a skill from them via generateSkills() (active mode, explicit IDs)
 *   3. Record compliant and/or violated skill-usage entries
 *   4. Run applySkillUsageFeedback() to bridge usage → knowledge confidence
 *   5. Read knowledge back and verify confidence changed
 *   6. Regenerate skill and verify updated content
 *
 * Uses real implementations — NO mocks.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	appendKnowledge,
	readKnowledge,
	resolveSwarmKnowledgePath,
} from '../../src/hooks/knowledge-store';
import type { SwarmKnowledgeEntry } from '../../src/hooks/knowledge-types';
import {
	appendSkillUsageEntry,
	applySkillUsageFeedback,
} from '../../src/hooks/skill-usage-log';
import {
	generateSkills,
	listSkills,
	regenerateSkill,
} from '../../src/services/skill-generator';

// ---------------------------------------------------------------------------
// Test slug
// ---------------------------------------------------------------------------
const TEST_SLUG = 'scope-declaration-guard';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeKnowledgeEntry(
	id: string,
	lesson: string,
	confidence: number,
): SwarmKnowledgeEntry {
	return {
		id,
		tier: 'swarm',
		lesson,
		category: 'process',
		tags: ['scope', 'delegation'],
		scope: 'global',
		confidence,
		status: 'established',
		confirmed_by: [
			{
				phase_number: 1,
				confirmed_at: '2026-01-01T00:00:00Z',
				project_name: 'test',
			},
			{
				phase_number: 2,
				confirmed_at: '2026-01-02T00:00:00Z',
				project_name: 'test',
			},
		],
		retrieval_outcomes: {
			applied_count: 2,
			succeeded_after_count: 2,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: '2026-01-01T00:00:00Z',
		updated_at: '2026-01-01T00:00:00Z',
		project_name: 'test',
	};
}

const ENTRY_A_ID = 'aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee';
const ENTRY_B_ID = 'bbbbbbbb-cccc-4ddd-eeee-ffffffffffff';

/** Seed two knowledge entries that share tags so clustering can group them. */
async function seedKnowledge(
	tmp: string,
	confidenceA: number,
	confidenceB: number,
): Promise<void> {
	const kp = resolveSwarmKnowledgePath(tmp);
	await appendKnowledge(
		kp,
		makeKnowledgeEntry(
			ENTRY_A_ID,
			'always declare scope before coder delegation to prevent scope bypass',
			confidenceA,
		),
	);
	await appendKnowledge(
		kp,
		makeKnowledgeEntry(
			ENTRY_B_ID,
			'verify scope containment before delegating coding tasks to subagents',
			confidenceB,
		),
	);
}

/** Helper: read knowledge by ID from .swarm/knowledge.jsonl. */
async function readEntryById(
	tmp: string,
	id: string,
): Promise<SwarmKnowledgeEntry | undefined> {
	const kp = resolveSwarmKnowledgePath(tmp);
	const entries = await readKnowledge<SwarmKnowledgeEntry>(kp);
	return entries.find((e) => e.id === id);
}

/** Generate the test skill in active mode with explicit knowledge IDs. */
async function generateTestSkill(tmp: string): Promise<void> {
	const result = await generateSkills({
		directory: tmp,
		mode: 'active',
		slug: TEST_SLUG,
		sourceKnowledgeIds: [ENTRY_A_ID, ENTRY_B_ID],
	});
	expect(result.written.length).toBeGreaterThanOrEqual(1);
	expect(result.skipped.length).toBe(0);
}

/** Repo-relative path used in skill-usage entries. */
const SKILL_PATH = `.opencode/skills/generated/${TEST_SLUG}/SKILL.md`;

/** Append a single skill-usage entry (compliant or violated). */
function recordUsage(
	tmp: string,
	verdict: 'compliant' | 'violated',
	taskID: string,
	sessionID: string,
): void {
	appendSkillUsageEntry(tmp, {
		skillPath: SKILL_PATH,
		agentName: 'mega_coder',
		taskID,
		timestamp: new Date().toISOString(),
		complianceVerdict: verdict,
		sessionID,
	});
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-skill-loop-'));
	// Ensure the .swarm and .opencode/skills/generated directories exist
	fs.mkdirSync(path.join(tmp, '.swarm'), { recursive: true });
	fs.mkdirSync(path.join(tmp, '.opencode', 'skills', 'generated'), {
		recursive: true,
	});
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('skill-feedback learning loop', () => {
	it('happy path: compliant usage boosts confidence by +0.05', async () => {
		// 1. Seed knowledge
		await seedKnowledge(tmp, 0.8, 0.8);

		// 2. Generate skill
		await generateTestSkill(tmp);

		// 3. Verify skill exists
		const skills = await listSkills(tmp);
		expect(skills.active.some((s) => s.slug === TEST_SLUG)).toBe(true);

		// 4. Record compliant usage
		recordUsage(tmp, 'compliant', '1.1', 'session-happy-001');

		// 5. Run feedback bridge
		const feedback = await applySkillUsageFeedback(tmp);
		expect(feedback.processed).toBeGreaterThanOrEqual(1);
		expect(feedback.bumps).toBeGreaterThanOrEqual(1);

		// 6. Verify confidence increased
		const entryA = await readEntryById(tmp, ENTRY_A_ID);
		expect(entryA).toBeDefined();
		expect(entryA!.confidence).toBeCloseTo(0.85, 10); // 0.8 + 0.05

		const entryB = await readEntryById(tmp, ENTRY_B_ID);
		expect(entryB).toBeDefined();
		expect(entryB!.confidence).toBeCloseTo(0.85, 10); // 0.8 + 0.05
	});

	it('violation decay: more violations than compliant decreases confidence by -0.1', async () => {
		// 1. Seed knowledge
		await seedKnowledge(tmp, 0.8, 0.8);

		// 2. Generate skill
		await generateTestSkill(tmp);

		// 3. Record 1 compliant + 2 violations → violations win → decay
		recordUsage(tmp, 'compliant', '1.1', 'session-violation-001');
		recordUsage(tmp, 'violated', '1.2', 'session-violation-001');
		recordUsage(tmp, 'violated', '1.3', 'session-violation-001');

		// 4. Run feedback bridge
		const feedback = await applySkillUsageFeedback(tmp);
		expect(feedback.processed).toBeGreaterThanOrEqual(1);

		// 5. Verify confidence decreased (net: 1 compliant, 2 violations → violations > compliant → -0.1)
		const entryA = await readEntryById(tmp, ENTRY_A_ID);
		expect(entryA).toBeDefined();
		expect(entryA!.confidence).toBeCloseTo(0.7, 10); // 0.8 - 0.1

		const entryB = await readEntryById(tmp, ENTRY_B_ID);
		expect(entryB).toBeDefined();
		expect(entryB!.confidence).toBeCloseTo(0.7, 10); // 0.8 - 0.1
	});

	it('regeneration: skill remains valid after confidence update', async () => {
		// 1. Seed knowledge
		await seedKnowledge(tmp, 0.8, 0.8);

		// 2. Generate skill
		await generateTestSkill(tmp);

		// 3. Record compliant usage and apply feedback
		recordUsage(tmp, 'compliant', '1.1', 'session-regen-001');
		await applySkillUsageFeedback(tmp);

		// 4. Verify confidence was updated
		const entryA = await readEntryById(tmp, ENTRY_A_ID);
		expect(entryA!.confidence).toBeCloseTo(0.85, 10);

		// 5. Regenerate skill
		const regenResult = await regenerateSkill(tmp, TEST_SLUG);
		expect(regenResult.regenerated).toBe(true);
		expect(regenResult.entryCount).toBeGreaterThanOrEqual(1);

		// 6. Verify the regenerated skill still exists and contains frontmatter
		const skillFilePath = path.join(
			tmp,
			'.opencode',
			'skills',
			'generated',
			TEST_SLUG,
			'SKILL.md',
		);
		expect(fs.existsSync(skillFilePath)).toBe(true);

		const content = fs.readFileSync(skillFilePath, 'utf-8');
		expect(content).toContain('generated_from_knowledge:');
		expect(content).toContain(ENTRY_A_ID);
		expect(content).toContain('generated by opencode-swarm skill-generator');
	});

	it('dedup aggregation: 2 compliant + 1 violation → compliant wins → +0.05', async () => {
		// 1. Seed knowledge
		await seedKnowledge(tmp, 0.8, 0.8);

		// 2. Generate skill
		await generateTestSkill(tmp);

		// 3. Record multiple usages: 2 compliant, 1 violation
		recordUsage(tmp, 'compliant', '2.1', 'session-dedup-001');
		recordUsage(tmp, 'compliant', '2.2', 'session-dedup-001');
		recordUsage(tmp, 'violated', '2.3', 'session-dedup-001');

		// 4. Run feedback bridge
		const feedback = await applySkillUsageFeedback(tmp);
		expect(feedback.processed).toBeGreaterThanOrEqual(1);

		// 5. Net effect: compliant (2) > violation (1) → +0.05
		const entryA = await readEntryById(tmp, ENTRY_A_ID);
		expect(entryA).toBeDefined();
		expect(entryA!.confidence).toBeCloseTo(0.85, 10); // 0.8 + 0.05

		const entryB = await readEntryById(tmp, ENTRY_B_ID);
		expect(entryB).toBeDefined();
		expect(entryB!.confidence).toBeCloseTo(0.85, 10); // 0.8 + 0.05
	});

	it('fail-open: applySkillUsageFeedback does not throw on missing/corrupt files', async () => {
		// Use an empty tmp dir — no knowledge.jsonl, no skill-usage.jsonl, no skill files
		// Should NOT throw — all paths are fail-open
		const feedback = await applySkillUsageFeedback(tmp);
		expect(feedback.processed).toBe(0);
		expect(feedback.bumps).toBe(0);
	});

	it('confidence clamping — floor: decay stops at 0.1', async () => {
		// 1. Seed with confidence at the floor
		await seedKnowledge(tmp, 0.1, 0.1);

		// 2. Generate skill
		await generateTestSkill(tmp);

		// 3. Record violation → decay
		recordUsage(tmp, 'violated', '3.1', 'session-clamp-001');
		await applySkillUsageFeedback(tmp);

		// Floor: 0.1 - 0.1 = 0.0 → clamped to 0.1
		const entryA = await readEntryById(tmp, ENTRY_A_ID);
		expect(entryA).toBeDefined();
		expect(entryA!.confidence).toBe(0.1);

		const entryB = await readEntryById(tmp, ENTRY_B_ID);
		expect(entryB).toBeDefined();
		expect(entryB!.confidence).toBe(0.1);
	});

	it('confidence clamping — ceiling: boost stops at 1.0', async () => {
		// 1. Seed with confidence at the ceiling
		await seedKnowledge(tmp, 1.0, 1.0);

		// 2. Generate skill
		await generateTestSkill(tmp);

		// 3. Record compliant → boost
		recordUsage(tmp, 'compliant', '3.2', 'session-clamp-002');
		await applySkillUsageFeedback(tmp);

		// Ceiling: 1.0 + 0.05 → clamped to 1.0
		const entryA = await readEntryById(tmp, ENTRY_A_ID);
		expect(entryA).toBeDefined();
		expect(entryA!.confidence).toBe(1.0);

		const entryB = await readEntryById(tmp, ENTRY_B_ID);
		expect(entryB).toBeDefined();
		expect(entryB!.confidence).toBe(1.0);
	});

	it('end-to-end pipeline: knowledge → skill → usage → feedback → regeneration', async () => {
		// Phase 1: Seed knowledge
		await seedKnowledge(tmp, 0.85, 0.85);

		// Phase 2: Generate skill from knowledge
		const genResult = await generateSkills({
			directory: tmp,
			mode: 'active',
			slug: TEST_SLUG,
			sourceKnowledgeIds: [ENTRY_A_ID, ENTRY_B_ID],
		});
		expect(genResult.written.length).toBeGreaterThanOrEqual(1);

		// Phase 3: Verify skill has correct frontmatter with source IDs
		const skillFilePath = path.join(
			tmp,
			'.opencode',
			'skills',
			'generated',
			TEST_SLUG,
			'SKILL.md',
		);
		const content = fs.readFileSync(skillFilePath, 'utf-8');
		expect(content).toContain(ENTRY_A_ID);
		expect(content).toContain(ENTRY_B_ID);

		// Phase 4: Record mixed usage across two sessions
		recordUsage(tmp, 'compliant', '4.1', 'session-e2e-001');
		recordUsage(tmp, 'compliant', '4.2', 'session-e2e-001');
		recordUsage(tmp, 'violated', '4.3', 'session-e2e-002');

		// Phase 5: Run feedback bridge
		const feedback = await applySkillUsageFeedback(tmp);
		expect(feedback.bumps).toBeGreaterThanOrEqual(1);

		// Phase 6: Verify confidence updated (2 compliant > 1 violation → +0.05)
		const entryA = await readEntryById(tmp, ENTRY_A_ID);
		expect(entryA!.confidence).toBeCloseTo(0.9, 10); // 0.85 + 0.05

		// Phase 7: Regenerate skill with updated knowledge
		const regenResult = await regenerateSkill(tmp, TEST_SLUG);
		expect(regenResult.regenerated).toBe(true);
		expect(regenResult.entryCount).toBeGreaterThanOrEqual(1);

		// Phase 8: Verify regenerated skill reflects updated confidence
		const regeneratedContent = fs.readFileSync(skillFilePath, 'utf-8');
		expect(regeneratedContent).toContain('generated_from_knowledge:');
		expect(regeneratedContent).toContain(ENTRY_A_ID);
		expect(regeneratedContent).toContain(ENTRY_B_ID);
	});
});
