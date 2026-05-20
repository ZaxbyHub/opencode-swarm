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
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { resolveSwarmKnowledgePath } from '../../src/hooks/knowledge-store';
import type { SwarmKnowledgeEntry } from '../../src/hooks/knowledge-types';
import { runSkillImprover } from '../../src/services/skill-improver';
import { resolveQuotaPath } from '../../src/services/skill-improver-quota';

let tmp: string;
beforeEach(() => {
	mock.restore();
	tmp = mkdtempSync(path.join(tmpdir(), 'swarm-issue629-'));
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	mock.restore();
});

async function seedMatureKnowledge(): Promise<void> {
	await mkdir(path.join(tmp, '.swarm'), { recursive: true });
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
		resolveSwarmKnowledgePath(tmp),
		JSON.stringify(e) + '\n',
		'utf-8',
	);
}

describe('issue #629 — low-frequency expensive skill_improver', () => {
	it('writes proposal markdown and decrements quota under default config', async () => {
		await seedMatureKnowledge();
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
			require_user_approval: true,
			quota_window: 'utc' as const,
			allow_deterministic_fallback: true,
		};
		const r = await runSkillImprover({
			directory: tmp,
			config,
		});
		expect(r.ran).toBe(true);
		expect(r.proposalPath).toContain('.swarm/skill-improver/proposals/');
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
			require_user_approval: true,
			quota_window: 'utc' as const,
			allow_deterministic_fallback: true,
		};
		const r1 = await runSkillImprover({ directory: tmp, config });
		const r2 = await runSkillImprover({ directory: tmp, config });
		const r3 = await runSkillImprover({ directory: tmp, config });
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
			require_user_approval: true,
			quota_window: 'utc' as const,
			allow_deterministic_fallback: true,
		};
		const r = await runSkillImprover({
			directory: tmp,
			config,
			mode: 'draft_skills',
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
			require_user_approval: true,
			quota_window: 'utc' as const,
			allow_deterministic_fallback: true,
		};
		await runSkillImprover({ directory: tmp, config });
		const after = readFileSync(resolveSwarmKnowledgePath(tmp), 'utf-8');
		expect(after).toBe(before);
	});
});
