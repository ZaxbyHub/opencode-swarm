/**
 * Tests that skill_improver actually dispatches the LLM delegate when one is
 * provided, and that quota / source-tagging policies are honoured.
 *
 * The factory in src/hooks/skill-improver-llm-factory.ts requires a wired
 * OpenCode client to return a real delegate; in unit tests we inject a fake
 * delegate via `req.delegate` and assert dispatch happens.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
	readKnowledge,
	resolveSwarmKnowledgePath,
} from '../../../src/hooks/knowledge-store';
import type {
	KnowledgeEntryBase,
	SwarmKnowledgeEntry,
} from '../../../src/hooks/knowledge-types';
import { resolveUnactionablePath } from '../../../src/hooks/knowledge-validator';
import { runSkillImprover } from '../../../src/services/skill-improver';
import {
	getQuotaState,
	resolveQuotaPath,
} from '../../../src/services/skill-improver-quota';

let tmp: string;
beforeEach(() => {
	mock.restore();
	tmp = mkdtempSync(path.join(tmpdir(), 'swarm-skill-llm-'));
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	mock.restore();
});

const cfg = {
	enabled: true,
	model: 'openrouter/expensive-model',
	fallback_models: [] as string[],
	max_calls_per_day: 5,
	trigger: 'manual' as const,
	targets: ['skills'] as Array<
		'skills' | 'spec' | 'architect_prompt' | 'knowledge'
	>,
	write_mode: 'proposal' as const,
	require_user_approval: true,
	quota_window: 'utc' as const,
	allow_deterministic_fallback: true,
};

async function seedKnowledge(): Promise<void> {
	await mkdir(path.join(tmp, '.swarm'), { recursive: true });
	const e: SwarmKnowledgeEntry = {
		id: '11111111-1111-4111-9111-111111111111',
		tier: 'swarm',
		lesson: 'always declare scope before coder delegation',
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
	};
	await writeFile(
		resolveSwarmKnowledgePath(tmp),
		JSON.stringify(e) + '\n',
		'utf-8',
	);
}

async function seedGeneratedSkill(
	slug: string,
	sourceId: string,
): Promise<void> {
	const skillDir = path.join(tmp, '.opencode', 'skills', 'generated', slug);
	await mkdir(skillDir, { recursive: true });
	const skillMd = `---
name: ${slug}
description: "seeded skill"
generated_from_knowledge:
  - ${sourceId}
source_knowledge_ids:
  - ${sourceId}
generated_at: 2000-01-01T00:00:00.000Z
confidence: 0.90
status: active
---

# Seeded Skill
`;
	await writeFile(path.join(skillDir, 'SKILL.md'), skillMd, 'utf-8');
}

async function seedUnactionableRecord(): Promise<void> {
	await mkdir(path.join(tmp, '.swarm'), { recursive: true });
	const now = new Date().toISOString();
	const record: KnowledgeEntryBase & {
		status: 'quarantined_unactionable';
		project_name: string;
		unactionable_reason: string;
		quarantined_at: string;
	} = {
		id: '33333333-3333-4333-9333-333333333333',
		tier: 'swarm',
		lesson: 'always run focused tests before declaring a release ready',
		category: 'process',
		tags: ['testing'],
		scope: 'global',
		confidence: 0.5,
		status: 'quarantined_unactionable',
		confirmed_by: [],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: now,
		updated_at: now,
		project_name: 't',
		unactionable_reason: 'missing_predicate_and_scope',
		quarantined_at: now,
	};
	await writeFile(
		resolveUnactionablePath(tmp),
		`${JSON.stringify(record)}\n`,
		'utf-8',
	);
}

describe('skill_improver LLM dispatch', () => {
	it('invokes the injected delegate and tags proposal source: llm', async () => {
		await seedKnowledge();
		let delegateCalled = false;
		let lastSystemPrompt = '';
		let lastUserPrompt = '';
		const delegate = async (sys: string, user: string): Promise<string> => {
			delegateCalled = true;
			lastSystemPrompt = sys;
			lastUserPrompt = user;
			return [
				'## Inventory snapshot',
				'(LLM-derived inventory analysis here)',
				'',
				'## Repeated ignored or violated directives',
				'- 11111111-1111-4111-9111-111111111111 — repeatedly ignored on coder delegation',
				'',
				'## Concrete recommendations',
				'- Compile this directive into a generated SKILL.md',
				'',
				'## Optional cluster suggestions for new draft skills',
				'',
				'## Risks and known limitations',
				'- LLM may hallucinate trigger phrases',
			].join('\n');
		};

		const r = await runSkillImprover({
			directory: tmp,
			config: cfg,
			delegate,
		});

		expect(delegateCalled).toBe(true);
		expect(r.ran).toBe(true);
		expect(r.source).toBe('llm');
		// system prompt must mention skill_improver targets
		expect(lastSystemPrompt).toContain('skill_improver');
		// user prompt must include the inventory of known mature candidates
		expect(lastUserPrompt).toContain('11111111-1111-4111-9111-111111111111');

		const body = readFileSync(r.proposalPath!, 'utf-8');
		expect(body).toContain('source: llm');
		expect(body).toContain('LLM-derived inventory');
		expect(body).not.toContain('deterministic_fallback');
	});

	it('includes stale active skill signals derived from frontmatter metadata', async () => {
		await seedKnowledge();
		await seedGeneratedSkill(
			'scope-skill',
			'11111111-1111-4111-9111-111111111111',
		);
		let lastUserPrompt = '';
		const delegate = async (_sys: string, user: string): Promise<string> => {
			lastUserPrompt = user;
			return '## Inventory snapshot\nok';
		};

		const r = await runSkillImprover({
			directory: tmp,
			config: cfg,
			delegate,
		});

		expect(r.ran).toBe(true);
		expect(lastUserPrompt).toContain('stale_active_skills: 1');
		expect(lastUserPrompt).toContain('scope-skill');
		expect(lastUserPrompt).toContain('updated_after_generation');
	});

	it('uses request mode in the LLM prompt instead of raw config write_mode', async () => {
		await seedKnowledge();
		let lastSystemPrompt = '';
		const delegate = async (sys: string): Promise<string> => {
			lastSystemPrompt = sys;
			return '## Inventory snapshot\nLLM proposal mode review';
		};

		const r = await runSkillImprover({
			directory: tmp,
			config: { ...cfg, write_mode: 'draft_skills' },
			targets: ['skills', 'knowledge'],
			mode: 'proposal',
			delegate,
		});

		expect(r.ran).toBe(true);
		expect(lastSystemPrompt).toContain('Mode: proposal');
		expect(lastSystemPrompt).not.toContain('Mode: draft_skills');
		expect(existsSync(path.join(tmp, '.swarm', 'skills', 'proposals'))).toBe(
			false,
		);
	});

	it('refuses pre-flight (no quota touched) when no delegate and fallback disabled', async () => {
		const r = await runSkillImprover({
			directory: tmp,
			config: { ...cfg, allow_deterministic_fallback: false },
			// no delegate, no client
		});
		expect(r.ran).toBe(false);
		expect(r.reason).toMatch(/no_llm_client/);
		// Quota must NOT have been reserved
		const state = await getQuotaState(tmp, {
			maxCalls: cfg.max_calls_per_day,
			window: 'utc',
		});
		expect(state.calls_used).toBe(0);
	});

	it('aborts before quota or fallback proposal side effects when signal is already aborted', async () => {
		const controller = new AbortController();
		controller.abort();

		const r = await runSkillImprover({
			directory: tmp,
			config: { ...cfg, allow_deterministic_fallback: true },
			signal: controller.signal,
		});

		expect(r.ran).toBe(false);
		expect(r.reason).toContain('aborted');
		const state = await getQuotaState(tmp, {
			maxCalls: cfg.max_calls_per_day,
			window: 'utc',
		});
		expect(state.calls_used).toBe(0);
		expect(
			existsSync(path.join(tmp, '.swarm', 'skill-improver', 'proposals')),
		).toBe(false);
	});

	it('does not write a proposal when aborted after an LLM response', async () => {
		const controller = new AbortController();
		const delegate = async (): Promise<string> => {
			controller.abort();
			return '## Inventory snapshot\nlate abort after model response';
		};

		const r = await runSkillImprover({
			directory: tmp,
			config: cfg,
			delegate,
			signal: controller.signal,
		});

		expect(r.ran).toBe(false);
		expect(r.reason).toContain('aborted');
		const state = await getQuotaState(tmp, {
			maxCalls: cfg.max_calls_per_day,
			window: 'utc',
		});
		expect(state.calls_used).toBe(1);
		expect(
			existsSync(path.join(tmp, '.swarm', 'skill-improver', 'proposals')),
		).toBe(false);
	});

	it('falls back to deterministic body when delegate undefined and fallback enabled', async () => {
		const r = await runSkillImprover({
			directory: tmp,
			config: { ...cfg, allow_deterministic_fallback: true },
			// no delegate — simulates no OpenCode client
		});
		expect(r.ran).toBe(true);
		expect(r.source).toBe('deterministic_fallback');
		const body = readFileSync(r.proposalPath!, 'utf-8');
		expect(body).toContain('source: deterministic_fallback');
		expect(body).toContain('deterministic fallback');
	});

	it('LLM call failure consumes the slot (anti-flake policy)', async () => {
		const delegate = async () => {
			throw new Error('connection reset by peer');
		};
		const r = await runSkillImprover({
			directory: tmp,
			config: cfg,
			delegate,
		});
		expect(r.ran).toBe(false);
		expect(r.reason).toMatch(/llm_call_failed/);
		expect(r.quota.calls_used).toBe(1);
	});

	it('empty LLM response counts as failure (slot consumed)', async () => {
		const delegate = async () => '   \n  \n';
		const r = await runSkillImprover({
			directory: tmp,
			config: cfg,
			delegate,
		});
		expect(r.ran).toBe(false);
		expect(r.reason).toMatch(/empty LLM response/);
		expect(r.quota.calls_used).toBe(1);
	});

	it('quota exhaustion blocks dispatch and writes nothing', async () => {
		const delegate = async () => '## Inventory snapshot\nok';
		const tight = { ...cfg, max_calls_per_day: 2 };
		await runSkillImprover({ directory: tmp, config: tight, delegate });
		await runSkillImprover({ directory: tmp, config: tight, delegate });
		const r3 = await runSkillImprover({
			directory: tmp,
			config: tight,
			delegate,
		});
		expect(r3.ran).toBe(false);
		expect(r3.reason).toMatch(/quota/i);
		// Two proposals should exist, not three
		const fs = await import('node:fs/promises');
		const proposals = await fs.readdir(
			path.join(tmp, '.swarm', 'skill-improver', 'proposals'),
		);
		expect(proposals.length).toBe(2);
	});

	it('does not pre-emptively reserve quota when enabled is false', async () => {
		const r = await runSkillImprover({
			directory: tmp,
			config: { ...cfg, enabled: false },
		});
		expect(r.ran).toBe(false);
		// quota file may exist or not; either way calls_used must be 0
		const state = await getQuotaState(tmp, {
			maxCalls: cfg.max_calls_per_day,
			window: 'utc',
		});
		expect(state.calls_used).toBe(0);
	});

	it('uses the dedicated knowledge enrichment quota for unactionable hardening', async () => {
		await seedUnactionableRecord();
		let calls = 0;
		const delegate = async (_sys: string, user: string): Promise<string> => {
			calls += 1;
			if (user.includes('Convert this prose lesson')) {
				return JSON.stringify({
					applies_to_agents: ['reviewer'],
					required_actions: ['run focused tests before declaring ready'],
					triggers: ['release ready'],
					directive_priority: 'high',
				});
			}
			return '## Inventory snapshot\nquota split regression';
		};

		const r = await runSkillImprover({
			directory: tmp,
			config: { ...cfg, max_calls_per_day: 1 },
			delegate,
			enrichmentQuota: { maxCalls: 3, window: 'utc' },
		});

		expect(r.ran).toBe(true);
		expect(calls).toBe(2);
		expect(r.unactionableHardening).toEqual({
			hardened: 1,
			retired: 0,
			remaining: 0,
		});
		const skillQuota = await getQuotaState(tmp, {
			maxCalls: 1,
			window: 'utc',
		});
		expect(skillQuota.calls_used).toBe(1);
		const enrichmentQuota = await getQuotaState(tmp, {
			maxCalls: 3,
			window: 'utc',
			scope: 'knowledge-enrichment',
		});
		expect(enrichmentQuota.calls_used).toBe(1);
		expect(existsSync(resolveQuotaPath(tmp))).toBe(true);
		expect(existsSync(resolveQuotaPath(tmp, 'knowledge-enrichment'))).toBe(
			true,
		);
		const active = await readKnowledge<SwarmKnowledgeEntry>(
			resolveSwarmKnowledgePath(tmp),
		);
		expect(active).toHaveLength(1);
		expect(active[0].status).toBe('candidate');
		expect(active[0].required_actions).toEqual([
			'run focused tests before declaring ready',
		]);
		const queue = await readKnowledge(resolveUnactionablePath(tmp));
		expect(queue).toHaveLength(0);
	});
});
