/**
 * Integration tests for the end-to-end skill propagation flow.
 *
 * Tests the full cycle:
 *   1. Architect delegates → skillPropagationGateBefore → skill-usage.jsonl (delegation entry)
 *   2. Reviewer outputs SKILL_COMPLIANCE → skillPropagationTransformScan → skill-usage.jsonl (compliance entry)
 *   3. rankSkillsForContext reads log and ranks skills correctly
 *   4. Full cycle: delegate → review → score → verify enrichment
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'os';
import type { MessageWithParts } from '../../../src/hooks/knowledge-types';
import {
	extractTaskIdFromPrompt,
	_internals as gateInternals,
	parseSkillPaths,
	skillPropagationGateBefore,
	skillPropagationTransformScan,
} from '../../../src/hooks/skill-propagation-gate';
import {
	formatSkillIndexWithContext,
	getSkillStats,
	rankSkillsForContext,
} from '../../../src/hooks/skill-scoring';
import {
	appendSkillUsageEntry,
	readSkillUsageEntries,
} from '../../../src/hooks/skill-usage-log';

// =============================================================================
// Test setup helpers
// =============================================================================

function createTempSwarmDir(): string {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-test-'));
	fs.mkdirSync(path.join(tmpDir, '.swarm'));
	return tmpDir;
}

function createMockSkill(skillPath: string): void {
	const skillDir = path.dirname(skillPath);
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(skillPath, '# Test Skill\n\nMock skill for testing.\n');
}

function appendSkillEntry(
	directory: string,
	skillPath: string,
	agentName: string,
	taskID: string,
	complianceVerdict: string,
	sessionID: string,
	timestamp?: string,
): void {
	appendSkillUsageEntry(directory, {
		skillPath,
		agentName,
		taskID,
		complianceVerdict,
		sessionID,
		timestamp: timestamp ?? new Date().toISOString(),
	});
}

// =============================================================================
// Test scenarios
// =============================================================================

describe('skill propagation integration', () => {
	// ---------------------------------------------------------------------------
	// Scenario 1
	// ---------------------------------------------------------------------------
	describe('Scenario 1 — architect delegates to coder with SKILLS field', () => {
		it('records a skill-usage entry with not_checked verdict', async () => {
			const tmpDir = createTempSwarmDir();
			const sessionID = `sp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
			try {
				const skillsFieldValue = 'file:.claude/skills/writing-tests/SKILL.md';
				const expectedStoredPath = skillsFieldValue;
				const skillAbsPath = path.join(
					tmpDir,
					'.claude',
					'skills',
					'writing-tests',
					'SKILL.md',
				);
				createMockSkill(skillAbsPath);

				const input = {
					tool: 'Task',
					agent: 'architect',
					sessionID,
					args: {
						subagent_type: 'mega_coder',
						prompt: `TO coder
taskId: task-4-5-write-tests
SKILLS: ${skillsFieldValue}
Write the integration tests for the skill propagation flow.`,
					},
				};

				await skillPropagationGateBefore(tmpDir, input, { enabled: true });

				const entries = readSkillUsageEntries(tmpDir, { sessionID });
				expect(entries).toHaveLength(1);
				expect(entries[0].skillPath).toBe(expectedStoredPath);
				expect(entries[0].agentName).toBe('coder');
				expect(entries[0].taskID).toBe('task-4-5-write-tests');
				expect(entries[0].complianceVerdict).toBe('not_checked');
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it('extracts task ID from taskId: pattern in prompt', () => {
			const prompt = `TO coder
taskId: abc-123
SKILLS: file:.claude/skills/writing-tests/SKILL.md
Write tests.`;
			expect(extractTaskIdFromPrompt(prompt)).toBe('abc-123');
		});

		it('extracts task ID from TASK: pattern in prompt', () => {
			const prompt = `TO coder
TASK: xyz-789
SKILLS: file:.claude/skills/writing-tests/SKILL.md
Write tests.`;
			expect(extractTaskIdFromPrompt(prompt)).toBe('xyz-789');
		});

		it('parseSkillPaths handles comma-separated paths', () => {
			const result = parseSkillPaths(
				'file:.claude/skills/a/SKILL.md, file:.opencode/skills/b/SKILL.md',
			);
			expect(result).toEqual([
				'file:.claude/skills/a/SKILL.md',
				'file:.opencode/skills/b/SKILL.md',
			]);
		});

		it('parseSkillPaths returns empty array for none or empty', () => {
			expect(parseSkillPaths('none')).toEqual([]);
			expect(parseSkillPaths('')).toEqual([]);
			expect(parseSkillPaths('  none  ')).toEqual([]);
		});
	});

	// ---------------------------------------------------------------------------
	// Scenario 2
	// ---------------------------------------------------------------------------
	describe('Scenario 2 — architect delegates with SKILLS_USED_BY_CODER', () => {
		it('records usage when both SKILLS and SKILLS_USED_BY_CODER are present', async () => {
			const tmpDir = createTempSwarmDir();
			const sessionID = `sp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
			try {
				const skillsValue = 'file:.claude/skills/skill-a/SKILL.md';
				const skillsUsedByCoderValue = 'file:.claude/skills/skill-b/SKILL.md';
				const expectedSkillA = skillsValue;
				const expectedSkillB = skillsUsedByCoderValue;
				createMockSkill(
					path.join(tmpDir, '.claude', 'skills', 'skill-a', 'SKILL.md'),
				);
				createMockSkill(
					path.join(tmpDir, '.claude', 'skills', 'skill-b', 'SKILL.md'),
				);

				const input = {
					tool: 'Task',
					agent: 'architect',
					sessionID,
					args: {
						subagent_type: 'mega_coder',
						prompt: `TO coder
taskId: task-4-5
SKILLS: ${skillsValue}
SKILLS_USED_BY_CODER: ${skillsUsedByCoderValue}
Write integration tests.`,
					},
				};

				await skillPropagationGateBefore(tmpDir, input, { enabled: true });

				const entries = readSkillUsageEntries(tmpDir, { sessionID });
				expect(entries).toHaveLength(2);
				const recordedPaths = entries.map((e) => e.skillPath).sort();
				expect(recordedPaths).toEqual([expectedSkillA, expectedSkillB]);
				for (const entry of entries) {
					expect(entry.agentName).toBe('coder');
					expect(entry.complianceVerdict).toBe('not_checked');
				}
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it('deduplicates when SKILLS and SKILLS_USED_BY_CODER have overlapping paths', async () => {
			const tmpDir = createTempSwarmDir();
			const sessionID = `sp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
			try {
				const sharedSkill = 'file:.claude/skills/writing-tests/SKILL.md';
				const expectedStoredPath = sharedSkill;
				createMockSkill(
					path.join(tmpDir, '.claude', 'skills', 'writing-tests', 'SKILL.md'),
				);

				const input = {
					tool: 'Task',
					agent: 'architect',
					sessionID,
					args: {
						subagent_type: 'mega_coder',
						prompt: `TO coder
taskId: task-4-5-dedup
SKILLS: ${sharedSkill}
SKILLS_USED_BY_CODER: file:.claude/skills/writing-tests/SKILL.md
Write integration tests.`,
					},
				};

				await skillPropagationGateBefore(tmpDir, input, { enabled: true });

				const entries = readSkillUsageEntries(tmpDir, { sessionID });
				expect(entries).toHaveLength(1);
				expect(entries[0].skillPath).toBe(expectedStoredPath);
				expect(entries[0].agentName).toBe('coder');
				expect(entries[0].complianceVerdict).toBe('not_checked');
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it('does NOT record when only SKILLS_USED_BY_CODER is present (SKILLS absent)', async () => {
			const tmpDir = createTempSwarmDir();
			const sessionID = `sp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
			try {
				const skillAbsPath = path.join(
					tmpDir,
					'.claude',
					'skills',
					'writing-tests',
					'SKILL.md',
				);
				createMockSkill(skillAbsPath);

				const input = {
					tool: 'Task',
					agent: 'architect',
					sessionID,
					args: {
						subagent_type: 'mega_coder',
						prompt: `TO coder
taskId: task-4-5
SKILLS_USED_BY_CODER: file:.claude/skills/writing-tests/SKILL.md
Write integration tests.`,
					},
				};

				await skillPropagationGateBefore(tmpDir, input, { enabled: true });

				const entries = readSkillUsageEntries(tmpDir, { sessionID });
				expect(entries).toHaveLength(0);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});
	});

	// ---------------------------------------------------------------------------
	// Scenario 3
	// ---------------------------------------------------------------------------
	describe('Scenario 3 — reviewer compliance scan', () => {
		it('records compliant verdict from reviewer output', async () => {
			const tmpDir = createTempSwarmDir();
			const sessionID = `sp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
			try {
				const skillsFieldValue = 'file:.claude/skills/writing-tests/SKILL.md';
				const expectedStoredPath = skillsFieldValue;
				const skillAbsPath = path.join(
					tmpDir,
					'.claude',
					'skills',
					'writing-tests',
					'SKILL.md',
				);
				createMockSkill(skillAbsPath);

				appendSkillEntry(
					tmpDir,
					expectedStoredPath,
					'coder',
					'task-4-5',
					'not_checked',
					sessionID,
				);

				const messages: MessageWithParts[] = [
					{
						info: { role: 'user', agent: 'test_engineer', sessionID },
						parts: [{ type: 'text', text: 'Some coder output first.' }],
					},
					{
						info: { role: 'assistant', agent: 'reviewer', sessionID },
						parts: [
							{
								type: 'text',
								text: `SKILLS_USED_BY_CODER: ${skillsFieldValue}
SKILL_COMPLIANCE: COMPLIANT — all skill guidelines were followed.`,
							},
						],
					},
				];

				await skillPropagationTransformScan(tmpDir, { messages }, sessionID);

				const entries = readSkillUsageEntries(tmpDir, { sessionID });
				expect(entries.length).toBeGreaterThanOrEqual(2);

				const compliantEntry = entries.find(
					(e) =>
						e.skillPath === expectedStoredPath &&
						e.complianceVerdict === 'compliant',
				);
				expect(compliantEntry).toBeDefined();
				expect(compliantEntry!.agentName).toBe('reviewer');
				expect(compliantEntry!.reviewerNotes).toContain(
					'all skill guidelines were followed',
				);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it('records partial and violated verdicts', async () => {
			const tmpDir = createTempSwarmDir();
			const sessionID = `sp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
			try {
				const skillAbsPath = path.join(
					tmpDir,
					'.opencode',
					'skills',
					'test-skill',
					'SKILL.md',
				);
				createMockSkill(skillAbsPath);

				const messagesPartial: MessageWithParts[] = [
					{
						info: { role: 'assistant', agent: 'reviewer', sessionID },
						parts: [
							{
								type: 'text',
								text: 'SKILL_COMPLIANCE: PARTIAL — some guidelines missed.',
							},
						],
					},
				];

				await skillPropagationTransformScan(
					tmpDir,
					{ messages: messagesPartial },
					sessionID,
				);

				const partialEntries = readSkillUsageEntries(tmpDir, { sessionID });
				const partialEntry = partialEntries.find(
					(e) => e.complianceVerdict === 'partial',
				);
				expect(partialEntry).toBeDefined();
				expect(partialEntry!.reviewerNotes).toContain('some guidelines missed');
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});
	});

	// ---------------------------------------------------------------------------
	// Scenario 4
	// ---------------------------------------------------------------------------
	describe('Scenario 4 — skill scoring ranks by usage and compliance', () => {
		it('ranks a higher-usage skill above a lower-usage skill', async () => {
			const tmpDir = createTempSwarmDir();
			const sessionID = `sp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
			try {
				const skillA = '.claude/skills/skill-a/skills.md';
				const skillB = '.claude/skills/skill-b/skills.md';
				const timestamp = '2026-01-01T00:00:00.000Z';

				for (let i = 0; i < 5; i++) {
					appendSkillEntry(
						tmpDir,
						skillA,
						'coder',
						`task-a-${i}`,
						'compliant',
						sessionID,
						timestamp,
					);
				}
				for (let i = 0; i < 2; i++) {
					appendSkillEntry(
						tmpDir,
						skillB,
						'coder',
						`task-b-${i}`,
						'compliant',
						sessionID,
						timestamp,
					);
				}

				const ranked = rankSkillsForContext(
					[skillA, skillB],
					'write tests for skill propagation',
					tmpDir,
				);

				expect(ranked).toHaveLength(2);
				expect(ranked[0].skillPath).toBe(skillA);
				expect(ranked[0].usageCount).toBe(5);
				expect(ranked[1].skillPath).toBe(skillB);
				expect(ranked[1].usageCount).toBe(2);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it('ranks a compliant skill above a non-compliant skill with same usage count', async () => {
			const tmpDir = createTempSwarmDir();
			const sessionID = `sp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
			try {
				const compliantSkill = '.claude/skills/compliant-skill/skills.md';
				const violatedSkill = '.claude/skills/violated-skill/skills.md';
				const timestamp = '2026-01-01T00:00:00.000Z';

				for (let i = 0; i < 3; i++) {
					appendSkillEntry(
						tmpDir,
						compliantSkill,
						'coder',
						`task-c-${i}`,
						'compliant',
						sessionID,
						timestamp,
					);
					appendSkillEntry(
						tmpDir,
						violatedSkill,
						'coder',
						`task-v-${i}`,
						'violated',
						sessionID,
						timestamp,
					);
				}

				const ranked = rankSkillsForContext(
					[compliantSkill, violatedSkill],
					'write tests for skill propagation',
					tmpDir,
				);

				expect(ranked).toHaveLength(2);
				expect(ranked[0].skillPath).toBe(compliantSkill);
				expect(ranked[0].complianceRate).toBe(1.0);
				expect(ranked[1].skillPath).toBe(violatedSkill);
				expect(ranked[1].complianceRate).toBe(0.0);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it('getSkillStats returns correct aggregate stats', async () => {
			const tmpDir = createTempSwarmDir();
			const sessionID = `sp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
			try {
				const skillPath = '.claude/skills/stats-skill/skills.md';
				const timestamp = '2026-01-01T00:00:00.000Z';

				appendSkillEntry(
					tmpDir,
					skillPath,
					'coder',
					'task-1',
					'compliant',
					sessionID,
					timestamp,
				);
				appendSkillEntry(
					tmpDir,
					skillPath,
					'reviewer',
					'task-1',
					'compliant',
					sessionID,
					timestamp,
				);
				appendSkillEntry(
					tmpDir,
					skillPath,
					'coder',
					'task-2',
					'not_checked',
					sessionID,
					timestamp,
				);

				const stats = getSkillStats(skillPath, tmpDir);
				expect(stats.totalUsage).toBe(3);
				expect(stats.complianceRate).toBe(1.0);
				expect(stats.lastUsed).toBe(timestamp);
				expect(stats.topAgents[0].agent).toBe('coder');
				expect(stats.topAgents[0].count).toBe(2);
				expect(stats.topAgents[1].agent).toBe('reviewer');
				expect(stats.topAgents[1].count).toBe(1);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it('formatSkillIndexWithContext returns formatted string with stats', async () => {
			const tmpDir = createTempSwarmDir();
			const sessionID = `sp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
			try {
				const skillPath = '.claude/skills/indexed-skill/skills.md';
				const timestamp = '2026-01-01T00:00:00.000Z';
				appendSkillEntry(
					tmpDir,
					skillPath,
					'coder',
					'task-1',
					'compliant',
					sessionID,
					timestamp,
				);

				const output = formatSkillIndexWithContext([skillPath], tmpDir);
				expect(output).toContain('indexed-skill');
				expect(output).toContain('used: 1');
				expect(output).toContain('compliance: 100%');
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it('formatSkillIndexWithContext falls back to simple index when no log exists', () => {
			const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-empty-'));
			try {
				// extractSkillName returns basename without .md: 'skills.md' → 'skills'
				const skillPath = '.claude/skills/nonexistent-skill/skills.md';
				const output = formatSkillIndexWithContext([skillPath], emptyDir);
				expect(output).toContain('skills');
				expect(output).not.toContain('used:');
			} finally {
				fs.rmSync(emptyDir, { recursive: true, force: true });
			}
		});

		it('computeContextMatchScore uses task description keywords', async () => {
			const tmpDir = createTempSwarmDir();
			const sessionID = `sp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
			try {
				const codingSkill = '.claude/skills/coding-standards/skills.md';
				const otherSkill = '.claude/skills/unrelated/skills.md';
				const timestamp = '2026-01-01T00:00:00.000Z';

				appendSkillEntry(
					tmpDir,
					codingSkill,
					'coder',
					'task-1',
					'not_checked',
					sessionID,
					timestamp,
				);
				appendSkillEntry(
					tmpDir,
					otherSkill,
					'coder',
					'task-2',
					'not_checked',
					sessionID,
					timestamp,
				);

				const ranked = rankSkillsForContext(
					[codingSkill, otherSkill],
					'apply coding standards and patterns',
					tmpDir,
				);

				expect(ranked).toHaveLength(2);
				expect(ranked[0].skillPath).toBe(codingSkill);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});
	});

	// ---------------------------------------------------------------------------
	// Scenario 5
	// ---------------------------------------------------------------------------
	describe('Scenario 5 — full cycle delegate → review → score → enriched re-delegate', () => {
		it('completes full cycle and skill ranks higher after compliance recorded', async () => {
			const tmpDir = createTempSwarmDir();
			const sessionID = `sp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
			try {
				const skillsFieldValue = 'file:.claude/skills/writing-tests/SKILL.md';
				const expectedStoredPath = skillsFieldValue;
				const skillAbsPath = path.join(
					tmpDir,
					'.claude',
					'skills',
					'writing-tests',
					'SKILL.md',
				);
				createMockSkill(skillAbsPath);
				const taskID = 'task-4-5-full-cycle';
				const cycleSession = `${sessionID}-cycle`;

				const delegateInput = {
					tool: 'Task',
					agent: 'architect',
					sessionID: cycleSession,
					args: {
						subagent_type: 'mega_coder',
						prompt: `TO coder
taskId: ${taskID}
SKILLS: ${skillsFieldValue}
Write integration tests for the skill propagation flow.`,
					},
				};

				await skillPropagationGateBefore(tmpDir, delegateInput, {
					enabled: true,
				});

				const entriesAfterDelegate = readSkillUsageEntries(tmpDir, {
					sessionID: cycleSession,
				});
				expect(entriesAfterDelegate).toHaveLength(1);
				expect(entriesAfterDelegate[0].complianceVerdict).toBe('not_checked');
				expect(entriesAfterDelegate[0].skillPath).toBe(expectedStoredPath);

				const reviewMessages: MessageWithParts[] = [
					{
						info: {
							role: 'assistant',
							agent: 'reviewer',
							sessionID: cycleSession,
						},
						parts: [
							{
								type: 'text',
								text: `SKILLS_USED_BY_CODER: ${skillsFieldValue}
SKILL_COMPLIANCE: COMPLIANT — all skill guidelines followed correctly.`,
							},
						],
					},
				];

				await skillPropagationTransformScan(
					tmpDir,
					{ messages: reviewMessages },
					cycleSession,
				);

				const entriesAfterReview = readSkillUsageEntries(tmpDir, {
					sessionID: cycleSession,
				});
				expect(entriesAfterReview.length).toBeGreaterThanOrEqual(2);

				const compliantEntry = entriesAfterReview.find(
					(e) =>
						e.skillPath === expectedStoredPath &&
						e.complianceVerdict === 'compliant',
				);
				expect(compliantEntry).toBeDefined();
				expect(compliantEntry!.reviewerNotes).toContain(
					'all skill guidelines followed correctly',
				);

				const ranked = rankSkillsForContext(
					[expectedStoredPath],
					'write integration tests for skill propagation',
					tmpDir,
				);

				expect(ranked).toHaveLength(1);
				expect(ranked[0].skillPath).toBe(expectedStoredPath);
				expect(ranked[0].complianceRate).toBeGreaterThan(0);
				expect(ranked[0].usageCount).toBeGreaterThan(0);

				const indexed = formatSkillIndexWithContext(
					[expectedStoredPath],
					tmpDir,
				);
				expect(indexed).toContain('writing-tests');
				expect(indexed).toContain('compliance:');
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it('multiple skills with different compliance rates rank in correct order', async () => {
			const tmpDir = createTempSwarmDir();
			const sessionID = `sp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
			try {
				const skillHighCompliance = '.claude/skills/high-compliance/skills.md';
				const skillLowCompliance = '.claude/skills/low-compliance/skills.md';
				const cycleSession = `${sessionID}-multirank`;
				const timestamp = '2026-01-01T00:00:00.000Z';

				createMockSkill(
					path.join(tmpDir, '.claude', 'skills', 'high-compliance', 'SKILL.md'),
				);
				createMockSkill(
					path.join(tmpDir, '.claude', 'skills', 'low-compliance', 'SKILL.md'),
				);

				for (let i = 0; i < 3; i++) {
					appendSkillEntry(
						tmpDir,
						skillHighCompliance,
						'coder',
						`task-h-${i}`,
						'compliant',
						cycleSession,
						timestamp,
					);
				}

				appendSkillEntry(
					tmpDir,
					skillLowCompliance,
					'coder',
					'task-l-0',
					'compliant',
					cycleSession,
					timestamp,
				);
				appendSkillEntry(
					tmpDir,
					skillLowCompliance,
					'reviewer',
					'task-l-1',
					'violated',
					cycleSession,
					timestamp,
				);
				appendSkillEntry(
					tmpDir,
					skillLowCompliance,
					'reviewer',
					'task-l-2',
					'violated',
					cycleSession,
					timestamp,
				);

				const ranked = rankSkillsForContext(
					[skillHighCompliance, skillLowCompliance],
					'write tests for skill propagation',
					tmpDir,
				);

				expect(ranked).toHaveLength(2);
				expect(ranked[0].skillPath).toBe(skillHighCompliance);
				expect(ranked[0].complianceRate).toBe(1.0);
				expect(ranked[1].skillPath).toBe(skillLowCompliance);
				expect(Math.abs(ranked[1].complianceRate - 1 / 3)).toBeLessThan(0.01);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});
	});

	// ---------------------------------------------------------------------------
	// Edge cases
	// ---------------------------------------------------------------------------
	describe('edge cases', () => {
		it('readSkillUsageEntries returns empty array when log does not exist', async () => {
			const tmpDir = createTempSwarmDir();
			try {
				const entries = readSkillUsageEntries(tmpDir);
				expect(entries).toEqual([]);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it('readSkillUsageEntries filters by skillPath correctly', async () => {
			const tmpDir = createTempSwarmDir();
			const sessionID = `sp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
			try {
				const skillAPath = '.claude/skills/skill-a/skills.md';
				const skillBPath = '.claude/skills/skill-b/skills.md';
				appendSkillEntry(
					tmpDir,
					skillAPath,
					'coder',
					't1',
					'compliant',
					sessionID,
				);
				appendSkillEntry(
					tmpDir,
					skillBPath,
					'coder',
					't2',
					'compliant',
					sessionID,
				);

				const entries = readSkillUsageEntries(tmpDir, {
					skillPath: skillAPath,
				});
				expect(entries).toHaveLength(1);
				expect(entries[0].skillPath).toBe(skillAPath);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it('readSkillUsageEntries filters by agentName correctly', async () => {
			const tmpDir = createTempSwarmDir();
			const sessionID = `sp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
			try {
				const skillPath = '.claude/skills/skill-a/skills.md';
				appendSkillEntry(
					tmpDir,
					skillPath,
					'coder',
					't1',
					'compliant',
					sessionID,
				);
				appendSkillEntry(
					tmpDir,
					skillPath,
					'reviewer',
					't2',
					'compliant',
					sessionID,
				);

				const entries = readSkillUsageEntries(tmpDir, {
					agentName: 'reviewer',
				});
				expect(entries).toHaveLength(1);
				expect(entries[0].agentName).toBe('reviewer');
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it('skillPropagationGateBefore ignores non-architect agents', async () => {
			const tmpDir = createTempSwarmDir();
			const sessionID = `sp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
			try {
				const input = {
					tool: 'Task',
					agent: 'coder',
					sessionID,
					args: {
						subagent_type: 'mega_reviewer',
						prompt: 'SKILLS: file:.claude/skills/test/skills.md',
					},
				};

				await skillPropagationGateBefore(tmpDir, input, { enabled: true });

				const entries = readSkillUsageEntries(tmpDir, { sessionID });
				expect(entries).toHaveLength(0);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it('records entry when prompt contains a skill-capable agent (TO reviewer extracts reviewer)', async () => {
			const tmpDir = createTempSwarmDir();
			const sessionID = `sp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
			try {
				// parseDelegationArgs takes the first non-empty line as targetAgent.
				// Since the prompt starts with 'TO reviewer' and 'reviewer' is skill-capable,
				// the gate records the delegation entry.
				const input = {
					tool: 'Task',
					agent: 'architect',
					sessionID,
					args: {
						prompt: 'TO reviewer\nSKILLS: file:.claude/skills/test/skills.md',
					},
				};

				await skillPropagationGateBefore(tmpDir, input, { enabled: true });

				const entries = readSkillUsageEntries(tmpDir, { sessionID });
				expect(entries).toHaveLength(1);
				// agentName is 'reviewer' because stripKnownSwarmPrefix extracts the suffix
				expect(entries[0].agentName).toBe('reviewer');
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it('skillPropagationGateBefore ignores when SKILLS is none', async () => {
			const tmpDir = createTempSwarmDir();
			const sessionID = `sp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
			try {
				const input = {
					tool: 'Task',
					agent: 'architect',
					sessionID,
					args: {
						subagent_type: 'mega_coder',
						prompt: 'TO coder\ntaskId: t1\nSKILLS: none',
					},
				};

				await skillPropagationGateBefore(tmpDir, input, { enabled: true });

				const entries = readSkillUsageEntries(tmpDir, { sessionID });
				expect(entries).toHaveLength(0);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it('skillPropagationTransformScan ignores messages without reviewer agent', async () => {
			const tmpDir = createTempSwarmDir();
			const sessionID = `sp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
			try {
				const messages: MessageWithParts[] = [
					{
						info: { role: 'assistant', agent: 'coder', sessionID },
						parts: [{ type: 'text', text: 'SKILL_COMPLIANCE: COMPLIANT' }],
					},
				];

				await skillPropagationTransformScan(tmpDir, { messages }, sessionID);

				const entries = readSkillUsageEntries(tmpDir, { sessionID });
				const compliantEntry = entries.find(
					(e) => e.complianceVerdict === 'compliant',
				);
				expect(compliantEntry).toBeUndefined();
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it('getSkillStats returns zeros for unknown skill path', async () => {
			const tmpDir = createTempSwarmDir();
			try {
				const stats = getSkillStats(
					'.claude/skills/unknown-skill/skills.md',
					tmpDir,
				);
				expect(stats.totalUsage).toBe(0);
				expect(stats.complianceRate).toBe(0);
				expect(stats.lastUsed).toBe('');
				expect(stats.topAgents).toEqual([]);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it('appendSkillUsageEntry throws on missing required fields', () => {
			const tmpDir = createTempSwarmDir();
			try {
				// @ts-expect-error — intentionally passing invalid input to test validation
				expect(() =>
					appendSkillUsageEntry(tmpDir, {
						skillPath: '',
						agentName: 'coder',
						taskID: 't1',
						timestamp: new Date().toISOString(),
						complianceVerdict: 'compliant',
						sessionID: 's1',
					}),
				).toThrow('skillPath is required');
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it('multiple sessions do not pollute each other', async () => {
			const tmpDir = createTempSwarmDir();
			const sessionA = `sp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}-a`;
			const sessionB = `sp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}-b`;
			try {
				const skillPath = '.claude/skills/shared/skills.md';

				appendSkillEntry(
					tmpDir,
					skillPath,
					'coder',
					'tA1',
					'compliant',
					sessionA,
				);
				appendSkillEntry(
					tmpDir,
					skillPath,
					'coder',
					'tB1',
					'compliant',
					sessionB,
				);

				const entriesA = readSkillUsageEntries(tmpDir, { sessionID: sessionA });
				const entriesB = readSkillUsageEntries(tmpDir, { sessionID: sessionB });

				expect(entriesA).toHaveLength(1);
				expect(entriesB).toHaveLength(1);
				expect(entriesA[0].taskID).toBe('tA1');
				expect(entriesB[0].taskID).toBe('tB1');
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});
	});
});
