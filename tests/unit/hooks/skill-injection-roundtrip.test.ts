/**
 * Tests for `injectSkillsIntoDelegation` — regression guards, the
 * SKILL_COMPLIANCE round-trip, and the gate→injection handoff.
 *
 * Part of the issue #1770 test suite (split for FR-006 ≤500-line cap). Sibling
 * files:
 *   - skill-injection-skip-and-none.test.ts   (skip/no-op + SKILLS:none + error)
 *   - skill-injection-qualified.test.ts        (qualified-injection mechanics)
 *
 * This file holds the issue's headline coverage: the regression guard pinning
 * the corrected attribution, the end-to-end SKILL_COMPLIANCE round-trip
 * (inject → transform-scan → joined compliance entry), and the real
 * gate→injection handoff.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { stripKnownSwarmPrefix } from '../../../src/config/schema';
import type { MessageWithParts } from '../../../src/hooks/knowledge-types';
import {
	injectSkillsIntoDelegation,
	type RecommendedSkill,
	type SkillInjectionResult,
} from '../../../src/hooks/skill-injection';
import {
	parseDelegationArgs,
	skillPropagationGateBefore,
	skillPropagationTransformScan,
} from '../../../src/hooks/skill-propagation-gate';
import { readSkillUsageEntries } from '../../../src/hooks/skill-usage-log';

// =============================================================================
// Helpers
// =============================================================================

function createTempSwarmDir(): string {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spinj-rt-'));
	fs.mkdirSync(path.join(tmpDir, '.swarm'));
	return tmpDir;
}

function createMockSkill(
	rootDir: string,
	treeRelativeSkillPath: string,
	description = 'Mock skill for testing.',
): void {
	const abs = path.join(rootDir, treeRelativeSkillPath);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(
		abs,
		`---\nname: ${path.basename(path.dirname(treeRelativeSkillPath))}\ndescription: ${description}\n---\n# ${path.basename(path.dirname(treeRelativeSkillPath))}\n`,
	);
}

function makeRecommended(
	skillPath: string,
	score: number,
	usageCount = 0,
): RecommendedSkill {
	return { skillPath, score, usageCount };
}

function readUsageLog(directory: string): string[] {
	const logPath = path.join(directory, '.swarm', 'skill-usage.jsonl');
	if (!fs.existsSync(logPath)) return [];
	return fs
		.readFileSync(logPath, 'utf-8')
		.split('\n')
		.filter((l) => l.trim().length > 0);
}

// =============================================================================
// Tests
// =============================================================================

describe('injectSkillsIntoDelegation — regression + round-trip', () => {
	let tmpDir: string;
	let sessionID: string;

	beforeEach(() => {
		tmpDir = createTempSwarmDir();
		sessionID = `spinj-rt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	describe('regression guard — the pre-fix bug does not recur', () => {
		it('NEVER records with agentName === architect or taskID === injection (the legacy bug)', () => {
			createMockSkill(
				tmpDir,
				'.claude/skills/writing-tests/SKILL.md',
				'Test writing.',
			);
			// Pass the architect as the targetAgent arg (as the buggy inline block would have done
			// by reading input.agent). The function must STILL record with whatever targetAgent it's
			// given — but the CALL SITE in src/index.ts now passes parseDelegationArgs().targetAgent,
			// NOT input.agent. This test pins the function's contract: it records targetAgent verbatim.
			const args = { prompt: 'do work' };

			injectSkillsIntoDelegation(
				tmpDir,
				args,
				[makeRecommended('.claude/skills/writing-tests/SKILL.md', 0.8)],
				'coder',
				sessionID,
			);

			const entry = JSON.parse(readUsageLog(tmpDir)[0]);
			// The function records whatever targetAgent it's given. The CALL SITE fix is what
			// prevents 'architect' from being passed. This assertion documents the function-level
			// contract: it does not override targetAgent with a hardcoded 'architect'.
			expect(entry.agentName).toBe('coder');
			expect(entry.taskID).not.toBe('injection');
		});

		it('call-site canonicalization: swarm-prefixed target (mega_coder) records as canonical base (coder)', () => {
			// Mirrors the src/index.ts call-site expression:
			//   stripKnownSwarmPrefix(parseDelegationArgs(input.args)?.targetAgent ?? '')
			// Here we exercise the canonicalization directly: passing the
			// swarm-prefixed name through stripKnownSwarmPrefix yields the
			// canonical base, matching the gate's site 4a attribution.
			createMockSkill(tmpDir, '.claude/skills/canon/SKILL.md', 'Canon.');
			const args = {
				subagent_type: 'mega_coder',
				prompt: 'taskId: c-1\ndo work',
			};
			const parsedTarget = parseDelegationArgs(args)?.targetAgent ?? '';
			const canonicalTarget =
				stripKnownSwarmPrefix(parsedTarget) || 'architect';

			injectSkillsIntoDelegation(
				tmpDir,
				args,
				[makeRecommended('.claude/skills/canon/SKILL.md', 0.9)],
				canonicalTarget,
				sessionID,
			);

			const entry = JSON.parse(readUsageLog(tmpDir)[0]);
			expect(entry.agentName).toBe('coder');
			expect(entry.agentName).not.toBe('mega_coder');
		});

		it('call-site fallback: when parseDelegationArgs returns null, targetAgent falls back to delegator', () => {
			// Mirrors the src/index.ts fallback: when parseDelegationArgs(input.args)
			// returns null (e.g. args missing both subagent_type and prompt),
			// `?.targetAgent ?? ''` yields '', stripKnownSwarmPrefix('') yields '',
			// and `|| String(input.agent)` yields the delegator. The function then
			// returns early (its own parseDelegationArgs(args) call returns null),
			// so no recording happens. This test documents that contract.
			const args: Record<string, unknown> = {}; // no subagent_type, no prompt
			const parsedTarget = parseDelegationArgs(args)?.targetAgent ?? '';
			const canonicalTarget =
				stripKnownSwarmPrefix(parsedTarget) || 'architect';

			const result = injectSkillsIntoDelegation(
				tmpDir,
				args,
				[makeRecommended('.claude/skills/fallback/SKILL.md', 0.9)],
				canonicalTarget,
				sessionID,
			);
			expect(result.injected).toBe(false);
			expect(readUsageLog(tmpDir)).toEqual([]);
		});
	});

	describe('SKILL_COMPLIANCE round-trip — the issue #1770 headline', () => {
		it('injected usage entry joins to a later reviewer compliance verdict via the transform-scan resolver', async () => {
			// This is the test the issue explicitly asks for: verify the
			// SKILL_COMPLIANCE verdict round-trip end-to-end.
			//   1. Architect delegates to coder (no SKILLS) → injection records
			//      a 'not_checked' entry with agentName=coder + real taskID.
			//   2. Later, reviewer emits SKILL_COMPLIANCE: COMPLIANT for the
			//      same skill path. transform-scan resolves the taskID from
			//      the latest non-reviewer delegation entry and records a
			//      'compliant' entry with agentName=reviewer.
			//   3. Both entries land in the same skill's usage history.
			createMockSkill(
				tmpDir,
				'.claude/skills/writing-tests/SKILL.md',
				'Test writing conventions.',
			);
			const skillPath = '.claude/skills/writing-tests/SKILL.md';

			// Step 1: simulate the architect delegation + injection.
			const args = { prompt: 'taskId: round-trip-1\n\nWrite the tests.' };
			const injectResult: SkillInjectionResult = injectSkillsIntoDelegation(
				tmpDir,
				args,
				[makeRecommended(skillPath, 0.85)],
				'coder',
				sessionID,
			);
			expect(injectResult.injected).toBe(true);

			const afterInject = readSkillUsageEntries(tmpDir, { sessionID });
			expect(afterInject.length).toBe(1);
			expect(afterInject[0].agentName).toBe('coder');
			expect(afterInject[0].taskID).toBe('round-trip-1');
			expect(afterInject[0].complianceVerdict).toBe('not_checked');

			// Step 2: simulate the reviewer verdict message.
			const messages: MessageWithParts[] = [
				{
					info: { role: 'assistant', agent: 'reviewer', sessionID },
					parts: [
						{
							type: 'text',
							text: `SKILLS_USED_BY_CODER: file:${skillPath}\nSKILL_COMPLIANCE: COMPLIANT — followed the test-writing conventions.`,
						},
					],
				},
			];

			await skillPropagationTransformScan(tmpDir, { messages }, sessionID);

			// Step 3: the compliance entry joins to the same skill history.
			const afterReview = readSkillUsageEntries(tmpDir, { sessionID });
			expect(afterReview.length).toBe(2);

			const complianceEntry = afterReview.find(
				(e) => e.complianceVerdict === 'compliant',
			);
			expect(complianceEntry).toBeDefined();
			expect(complianceEntry!.agentName).toBe('reviewer');
			expect(complianceEntry!.skillPath).toBe(skillPath);
			// The resolver must have resolved the taskID from the injection entry
			// (latest non-reviewer delegation). With the legacy 'injection' sentinel
			// this only worked by coincidence; with the real taskID 'round-trip-1'
			// it works by correct attribution.
			expect(complianceEntry!.taskID).toBe('round-trip-1');
		});

		it('round-trip still works when the prompt has NO task marker (auto-injected fallback)', async () => {
			// Guards the critic's Item 2: when extractTaskIdFromPrompt returns
			// 'unknown', the function records 'auto-injected' (NOT 'unknown') so
			// the resolver guard `resolvedTaskID !== 'unknown'` continues to fire.
			createMockSkill(
				tmpDir,
				'.claude/skills/no-marker-skill/SKILL.md',
				'No marker skill.',
			);
			const skillPath = '.claude/skills/no-marker-skill/SKILL.md';

			const args = { prompt: 'Write the tests.' };
			injectSkillsIntoDelegation(
				tmpDir,
				args,
				[makeRecommended(skillPath, 0.9)],
				'coder',
				sessionID,
			);

			const afterInject = readSkillUsageEntries(tmpDir, { sessionID });
			expect(afterInject[0].taskID).toBe('auto-injected');
			expect(afterInject[0].taskID).not.toBe('unknown');

			// Reviewer verdict WITHOUT an explicit TASK: line → resolver must
			// fall back to latestDelegation.taskID = 'auto-injected'.
			const messages: MessageWithParts[] = [
				{
					info: { role: 'assistant', agent: 'reviewer', sessionID },
					parts: [
						{
							type: 'text',
							text: `SKILLS_USED_BY_CODER: file:${skillPath}\nSKILL_COMPLIANCE: VIOLATED — did not follow the skill.`,
						},
					],
				},
			];
			await skillPropagationTransformScan(tmpDir, { messages }, sessionID);

			const afterReview = readSkillUsageEntries(tmpDir, { sessionID });
			const violated = afterReview.find(
				(e) => e.complianceVerdict === 'violated',
			);
			expect(violated).toBeDefined();
			// The fallback taskID 'auto-injected' (non-'unknown') must propagate.
			expect(violated!.taskID).toBe('auto-injected');
		});
	});

	describe('gate → injection handoff (full integration)', () => {
		it('recommendedSkills from skillPropagationGateBefore feed injectSkillsIntoDelegation and produce a usage entry', async () => {
			// This test exercises the REAL handoff that src/index.ts performs:
			//   const skillResult = await skillPropagationGateBefore(...);
			//   injectSkillsIntoDelegation(..., skillResult.recommendedSkills, ...);
			// It replaces the parallel-reimplementation "full integration" test
			// in the old skill-injection.test.ts (which used simulateSkillInjection).
			createMockSkill(
				tmpDir,
				'.claude/skills/handoff-skill/SKILL.md',
				'Handoff skill.',
			);

			// Gate sees a delegation with NO SKILLS field → warning path returns
			// recommendedSkills: scored (gate.ts:1116 short-circuits only when
			// SKILLS is present-and-non-none; absent SKILLS falls through to 1157).
			// Cold-start score is low (context-only), so we use `makeRecommended`
			// to lift it above the 0.5 injection threshold — exactly as a richer
			// project with usage history would.
			const gateInput = {
				tool: 'Task',
				agent: 'architect',
				sessionID,
				args: {
					subagent_type: 'mega_coder',
					prompt: 'taskId: handoff-1\nDo the work.',
				},
			};

			const gateResult = await skillPropagationGateBefore(tmpDir, gateInput, {
				enabled: true,
			});
			expect(gateResult.recommendedSkills).toBeDefined();
			expect(gateResult.recommendedSkills!.length).toBeGreaterThan(0);

			// Lift the cold-start scores above the 0.5 threshold (simulates a
			// project with real usage history; the gate's pure-context score
			// is 0.05 here). This is the same shape the gate returns.
			const recommended = gateResult.recommendedSkills!.map((s) => ({
				...s,
				score: Math.max(s.score, 0.8),
			}));

			// Feed those recommendedSkills into the injection function with
			// a FRESH prompt that has no SKILLS field (simulating the next
			// delegation where the architect forgot to specify skills).
			const nextArgs = {
				subagent_type: 'mega_coder',
				prompt: 'taskId: handoff-2\nDo different work.',
			};
			const result = injectSkillsIntoDelegation(
				tmpDir,
				nextArgs,
				recommended,
				'coder',
				sessionID,
			);

			expect(result.injected).toBe(true);
			expect(nextArgs.prompt).toContain(
				'SKILLS: file:.claude/skills/handoff-skill/SKILL.md',
			);

			// The usage entry from THIS injection uses handoff-2 (the new prompt's taskID).
			const entries = readSkillUsageEntries(tmpDir, { sessionID });
			const injectionEntry = entries.find((e) => e.taskID === 'handoff-2');
			expect(injectionEntry).toBeDefined();
			expect(injectionEntry!.agentName).toBe('coder');
			expect(injectionEntry!.complianceVerdict).toBe('not_checked');
		});
	});
});
