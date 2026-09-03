/**
 * Integration test for issue #629 — agent for skill improver with very few
 * requests.
 *
 * Configures a cheap architect model alongside an expensive skill_improver
 * with max_calls_per_day=10, runs skill_improve, asserts a proposal file is
 * written and the quota is decremented. Also verifies that draft_skills mode
 * emits SKILL.md proposals via the same pipeline.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { resolveSwarmKnowledgePath } from '../../src/hooks/knowledge-store';
import type { SwarmKnowledgeEntry } from '../../src/hooks/knowledge-types';
import { runSkillImprover } from '../../src/services/skill-improver';
import { resolveQuotaPath } from '../../src/services/skill-improver-quota';
import { createIsolatedTestEnv } from '../helpers/isolated-test-env';
import { createSafeTestDir } from '../helpers/safe-test-dir';

let tmp: string;
let cleanupEnv: () => void;
beforeEach(() => {
	mock.restore();
	const isolatedEnv = createIsolatedTestEnv();
	tmp = isolatedEnv.configDir;
	cleanupEnv = isolatedEnv.cleanup;
});
afterEach(() => {
	mock.restore();
	cleanupEnv();
});

/**
 * Injected clock (issue #2478): every runSkillImprover call below pins its
 * `now` to this fixed UTC day via distinct per-call offsets.
 *
 * Why per-call injection instead of a freezeClock spy: a live clock lets a
 * UTC-midnight rollover between the sequential quota calls reset
 * `calls_used` (getQuotaState's date-mismatch rollover) and flip the
 * quota-exhaustion assertions — the one genuine live-clock hazard in this
 * file. A global toISOString spy, however, makes every proposal share one
 * `timestampSlug(now)` filename, so consecutive successful runs overwrite
 * each other's proposals. Per-call `now` values on a single UTC day close
 * the rollover window while keeping proposal slugs distinct.
 */
const FIXED_DAY_MS = Date.parse('2026-09-02T00:00:00.000Z');
const fixedNow = (secondsOffset: number): Date =>
	new Date(FIXED_DAY_MS + secondsOffset * 1_000);

async function seedMatureKnowledge(directory: string = tmp): Promise<void> {
	await mkdir(path.join(directory, '.swarm'), { recursive: true });
	const e: SwarmKnowledgeEntry = {
		id: '11111111-1111-4111-9111-111111111111',
		tier: 'swarm',
		lesson:
			'always declare scope before delegating any source-modifying task to coder',
		category: 'process',
		tags: ['scope'],
		scope: 'global',
		confidence: 0.95,
		status: 'established',
		confirmed_by: [
			{
				phase_number: 1,
				confirmed_at: new Date().toISOString(),
				project_name: 't',
			},
			{
				phase_number: 2,
				confirmed_at: new Date().toISOString(),
				project_name: 't',
			},
		],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		project_name: 't',
		triggers: ['coder delegation'],
		required_actions: ['call declare_scope'],
		applies_to_agents: ['coder'],
		directive_priority: 'critical',
	};
	await writeFile(
		resolveSwarmKnowledgePath(directory),
		JSON.stringify(e) + '\n',
		'utf-8',
	);
}

describe('issue #629 — low-frequency expensive skill_improver', () => {
	it('writes proposal markdown and decrements quota under default config', async () => {
		await seedMatureKnowledge();
		// This suite exercises quota/proposal behavior. Approval-gated writes are
		// covered separately by the skill-improver approval-integrity tests.
		const config = {
			enabled: true,
			model: 'openrouter/expensive-model',
			fallback_models: ['openrouter/cheaper-fallback'],
			max_calls_per_day: 10,
			trigger: 'manual' as const,
			targets: ['skills', 'spec', 'architect_prompt', 'knowledge'] as Array<
				'skills' | 'spec' | 'architect_prompt' | 'knowledge'
			>,
			write_mode: 'proposal' as const,
			require_user_approval: false,
			quota_window: 'utc' as const,
			allow_deterministic_fallback: true,
		};
		const r = await runSkillImprover({
			directory: tmp,
			config,
			now: fixedNow(0),
		});
		expect(r.ran).toBe(true);
		expect(r.proposalPath).toContain(
			path.join('.swarm', 'skill-improver', 'proposals'),
		);
		expect(existsSync(r.proposalPath!)).toBe(true);
		// proposal mentions the configured model
		expect(readFileSync(r.proposalPath!, 'utf-8')).toContain(
			'openrouter/expensive-model',
		);
		expect(r.quota.calls_used).toBe(1);
		expect(r.quota.max_calls).toBe(10);
		// quota state file persists
		expect(existsSync(resolveQuotaPath(tmp))).toBe(true);
	});

	it('caps at the configured max (10/day) and refuses further runs', async () => {
		await seedMatureKnowledge();
		const config = {
			enabled: true,
			model: 'openrouter/expensive-model',
			fallback_models: [] as string[],
			max_calls_per_day: 2,
			trigger: 'manual' as const,
			targets: ['skills'] as Array<
				'skills' | 'spec' | 'architect_prompt' | 'knowledge'
			>,
			write_mode: 'proposal' as const,
			require_user_approval: false,
			quota_window: 'utc' as const,
			allow_deterministic_fallback: true,
		};
		const r1 = await runSkillImprover({
			directory: tmp,
			config,
			now: fixedNow(0),
		});
		const r2 = await runSkillImprover({
			directory: tmp,
			config,
			now: fixedNow(1),
		});
		const r3 = await runSkillImprover({
			directory: tmp,
			config,
			now: fixedNow(2),
		});
		expect(r1.ran).toBe(true);
		expect(r2.ran).toBe(true);
		expect(r3.ran).toBe(false);
		expect(r3.reason).toMatch(/quota/i);
		// Even when blocked, no partial proposal is written for the failed run.
		const fs = await import('node:fs/promises');
		const proposals = await fs.readdir(
			path.join(tmp, '.swarm', 'skill-improver', 'proposals'),
		);
		expect(proposals.length).toBe(2); // only the 2 successful runs
	});

	it('draft_skills mode writes SKILL.md proposals via skill_generate', async () => {
		await seedMatureKnowledge();
		const config = {
			enabled: true,
			model: 'openrouter/expensive-model',
			fallback_models: [] as string[],
			max_calls_per_day: 10,
			trigger: 'manual' as const,
			targets: ['skills'] as Array<
				'skills' | 'spec' | 'architect_prompt' | 'knowledge'
			>,
			write_mode: 'draft_skills' as const,
			require_user_approval: false,
			quota_window: 'utc' as const,
			allow_deterministic_fallback: true,
		};
		const r = await runSkillImprover({
			directory: tmp,
			config,
			mode: 'draft_skills',
			now: fixedNow(0),
		});
		expect(r.ran).toBe(true);
		expect(r.draftSkillsWritten?.length ?? 0).toBeGreaterThan(0);
		// Active SKILL.md files were NOT written — only proposals
		expect(existsSync(path.join(tmp, '.opencode', 'skills', 'generated'))).toBe(
			false,
		);
		expect(existsSync(path.join(tmp, '.swarm', 'skills', 'proposals'))).toBe(
			true,
		);
	});

	it('does not mutate any source files (default proposal-only)', async () => {
		await seedMatureKnowledge();
		const before = readFileSync(resolveSwarmKnowledgePath(tmp), 'utf-8');
		const config = {
			enabled: true,
			model: 'openrouter/expensive-model',
			fallback_models: [] as string[],
			max_calls_per_day: 10,
			trigger: 'manual' as const,
			targets: ['knowledge'] as Array<
				'skills' | 'spec' | 'architect_prompt' | 'knowledge'
			>,
			write_mode: 'proposal' as const,
			require_user_approval: false,
			quota_window: 'utc' as const,
			allow_deterministic_fallback: true,
		};
		await runSkillImprover({ directory: tmp, config, now: fixedNow(0) });
		const after = readFileSync(resolveSwarmKnowledgePath(tmp), 'utf-8');
		expect(after).toBe(before);
	});

	it('quota state is per-directory: exhausting one root never suppresses another (issue #2478 batch-order independence)', async () => {
		// Two independent project roots (realpath-canonical via
		// createSafeTestDir). Root A burns its entire daily quota; root B
		// must still run through the same registered runSkillImprover path.
		// This pins the per-directory quota-file isolation invariant: a
		// merge_group integration batch-mate — or any other project sharing
		// the process/filesystem — cannot suppress this suite's execution by
		// consuming quota elsewhere (the failure class issue #2396 was
		// filed under, later root-caused to a merge-combination test
		// regression; this test guards the quota-isolation property the
		// original theory assumed was broken).
		const rootA = createSafeTestDir('issue-629-projA-');
		const rootB = createSafeTestDir('issue-629-projB-');
		try {
			await seedMatureKnowledge(rootA.dir);
			await seedMatureKnowledge(rootB.dir);
			const config = {
				enabled: true,
				model: 'openrouter/expensive-model',
				fallback_models: [] as string[],
				max_calls_per_day: 1,
				trigger: 'manual' as const,
				targets: ['skills'] as Array<
					'skills' | 'spec' | 'architect_prompt' | 'knowledge'
				>,
				write_mode: 'proposal' as const,
				require_user_approval: false,
				quota_window: 'utc' as const,
				allow_deterministic_fallback: true,
			};
			const a1 = await runSkillImprover({
				directory: rootA.dir,
				config,
				now: fixedNow(0),
			});
			const a2 = await runSkillImprover({
				directory: rootA.dir,
				config,
				now: fixedNow(1),
			});
			const b1 = await runSkillImprover({
				directory: rootB.dir,
				config,
				now: fixedNow(2),
			});
			expect(a1.ran).toBe(true);
			expect(a2.ran).toBe(false);
			expect(a2.reason).toMatch(/quota/i);
			expect(b1.ran).toBe(true);
			// Each root carries its own quota file; B's reflects only its own
			// single run.
			const quotaB = JSON.parse(
				readFileSync(resolveQuotaPath(rootB.dir), 'utf-8'),
			) as { calls_used: number; max_calls: number };
			expect(quotaB.calls_used).toBe(1);
			expect(quotaB.max_calls).toBe(1);
		} finally {
			rootA.cleanup();
			rootB.cleanup();
		}
	});
});
